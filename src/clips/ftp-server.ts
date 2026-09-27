import { randomBytes, timingSafeEqual } from 'crypto';
import { lookup as dnsLookup } from 'dns/promises';
import { EventEmitter } from 'events';
import { createWriteStream, mkdirSync, unlinkSync } from 'fs';
import net from 'net';
import { join, posix } from 'path';
import tls from 'tls';

// A small upload-only FTP(S) server for the camera's clip uploads. It speaks
// what an uploader needs (login, explicit TLS, passive mode, folders, STOR)
// and nothing else: no downloads, listings, deletes or renames.

export interface Upload {
  path: string; // virtual path, e.g. /2026/09/27/Den_00_20260927140301.mp4
  name: string;
  dir: string;
  bytes: number;
  tmpFile: string; // the received file; the listener moves or deletes it
}

export interface FtpServerOptions {
  port: number;
  host?: string;
  passive: [number, number];
  publicHost?: string; // the address in PASV replies
  user: string;
  password: string;
  tls?: { cert: string; key: string }; // then TLS is required (AUTH TLS, PROT P)
  root: string; // uploads land in <root>/.incoming
  maxBytes?: number;
  maxSessions?: number; // logged-in sessions
  maxPreLoginPerIp?: number; // connections not logged in yet, per address
  timeouts?: { preLoginMs?: number; idleMs?: number; dataMs?: number };
  log?: (line: string) => void; // command names and paths, never the password
  now?: () => number;
  lookup?: (host: string) => Promise<string>; // publicHost name → IPv4
}

const MAX_LINE = 4096;
const FAILURE_WINDOW = 60_000;
const MAX_FAILURES = 5;
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const plainIp = (a: string | undefined) => (a ?? '').replace(/^::ffff:/, '');
const OPEN = new Set(['USER', 'PASS', 'AUTH', 'QUIT', 'SYST', 'FEAT', 'NOOP', 'PBSZ', 'PROT', 'OPTS']);
const KNOWN = new Set([...OPEN, 'PWD', 'XPWD', 'CWD', 'CDUP', 'MKD', 'XMKD', 'TYPE', 'MODE', 'STRU', 'PASV', 'EPSV', 'STOR', 'SIZE']);
// Constant time over the longer of the two (no hash: a password isn't stored).
function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  const n = Math.max(x.length, y.length, 1);
  const px = Buffer.alloc(n), py = Buffer.alloc(n);
  x.copy(px);
  y.copy(py);
  return timingSafeEqual(px, py) && x.length === y.length;
}

interface Session {
  stream: net.Socket; // the control connection (a TLSSocket after AUTH TLS)
  secure: boolean;
  prot: 'C' | 'P';
  user?: string;
  authed: boolean;
  cwd: string;
  closed: boolean;
  ip: string;
  busy: boolean; // a transfer runs: the control connection is quiet on purpose
  timer?: NodeJS.Timeout;
  end?: () => void; // leaves the session list and cleans up
  pasv?: { server: net.Server; conn: Promise<net.Socket> };
}

export class FtpServer extends EventEmitter {
  private server: net.Server | undefined;
  private readonly sessionsOpen = new Set<Session>();
  private readonly failures = new Map<string, number[]>();
  private readonly incoming: string;
  private secureContext: tls.SecureContext | undefined;
  private nextPassive: number;
  // Everything open, so stop() can end it all: control and data sockets
  // (refused ones too) and passive listeners.
  private readonly sockets = new Set<net.Socket>();
  private readonly passiveListeners = new Set<net.Server>();
  private pasvAddress: string | undefined;

  constructor(private readonly o: FtpServerOptions) {
    super();
    this.incoming = join(o.root, '.incoming');
    this.nextPassive = o.passive[0];
    if (o.tls) this.secureContext = tls.createSecureContext({ cert: o.tls.cert, key: o.tls.key });
  }

  listening(): boolean {
    return this.server?.listening ?? false;
  }

  sessions(): number {
    return this.sessionsOpen.size;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private track<T extends net.Socket>(sock: T): T {
    this.sockets.add(sock);
    sock.once('close', () => this.sockets.delete(sock));
    return sock;
  }

  // The IPv4 address PASV announces: publicHost (a name is resolved once), or
  // else the control connection's own address.
  private async resolvePublicHost(): Promise<void> {
    const h = this.o.publicHost;
    this.pasvAddress = undefined;
    if (!h) return;
    if (IPV4.test(h)) return void (this.pasvAddress = h);
    try {
      const a = await (this.o.lookup ?? (async (x: string) => (await dnsLookup(x, { family: 4 })).address))(h);
      if (IPV4.test(a)) this.pasvAddress = a;
    } catch {
      // below
    }
    if (!this.pasvAddress) this.log(`publicHost ${h} has no IPv4 address; PASV announces the connection's own address`);
  }

  async start(): Promise<number> {
    mkdirSync(this.incoming, { recursive: true });
    await this.resolvePublicHost();
    const server = net.createServer((socket) => this.session(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.o.port, this.o.host ?? '0.0.0.0', () => resolve((server.address() as net.AddressInfo).port));
    });
  }

  async stop(): Promise<void> {
    for (const s of this.sessionsOpen) {
      s.closed = true;
      clearTimeout(s.timer);
    }
    this.sessionsOpen.clear();
    for (const l of this.passiveListeners) l.close();
    this.passiveListeners.clear();
    for (const sock of this.sockets) sock.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  // Also emitted as 'command' (for diagnostics); the password is never in it.
  private log(line: string): void {
    this.o.log?.(line);
    this.emit('command', line);
  }

  private session(socket: net.Socket): void {
    this.track(socket);
    socket.on('error', () => undefined);
    const ip = plainIp(socket.remoteAddress);
    // Connections that haven't logged in are limited per address and time
    // out quickly, so nobody on the LAN can hold the camera's slots.
    const preLogin = [...this.sessionsOpen].filter((x) => !x.authed && x.ip === ip).length;
    if (preLogin >= (this.o.maxPreLoginPerIp ?? 2) || this.sessionsOpen.size >= (this.o.maxSessions ?? 4) + 8) {
      this.log(`refused ${ip}`);
      socket.end('421 Too many connections\r\n');
      setTimeout(() => socket.destroy(), 1000).unref();
      return;
    }
    this.log(`connect ${ip}`);
    const s: Session = { stream: socket, secure: false, prot: 'C', authed: false, cwd: '/', closed: false, ip, busy: false };
    this.sessionsOpen.add(s);
    const reply = (line: string) => {
      if (!s.closed && !s.stream.destroyed) s.stream.write(`${line}\r\n`);
    };
    const close = () => {
      if (s.closed) return;
      s.closed = true;
      clearTimeout(s.timer);
      if (s.pasv) (s.pasv.server.close(), this.passiveListeners.delete(s.pasv.server));
      this.sessionsOpen.delete(s);
    };
    s.end = close;
    s.stream.on('close', () => socket.destroy());

    let buf = '';
    const onData = (chunk: Buffer) => {
      this.arm(s);
      buf += chunk.toString('utf8');
      if (buf.length > MAX_LINE && buf.indexOf('\r\n') < 0) {
        s.stream.destroy();
        return;
      }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        void this.command(s, line, reply, attach);
      }
    };
    const attach = (stream: net.Socket) => {
      s.stream.off('data', onData);
      s.stream = stream;
      stream.on('data', onData);
      stream.on('error', () => undefined);
      stream.on('close', close);
    };
    socket.on('data', onData);
    socket.on('close', close);
    this.arm(s);
    reply('220 cam-proxy FTP ready');
  }

  // The control connection's timeout: short until login (the TLS handshake
  // included), longer when idle after it, none while a transfer runs.
  private arm(s: Session): void {
    clearTimeout(s.timer);
    if (s.closed || s.busy) return;
    const t = this.o.timeouts ?? {};
    const ms = s.authed ? (t.idleMs ?? 120_000) : (t.preLoginMs ?? 10_000);
    s.timer = setTimeout(() => {
      this.log(`timeout ${s.ip}`);
      if (!s.stream.destroyed) s.stream.end('421 Timeout\r\n');
      s.end?.(); // its slot is free at once, not when the peer closes
      setTimeout(() => s.stream.destroy(), 500).unref();
    }, ms);
    s.timer.unref();
  }

  private resolve(s: Session, arg: string, allowClamp: boolean): string | null {
    if (!arg || arg.length > 1024 || arg.includes('\0')) return null;
    if (!allowClamp && arg.split('/').includes('..')) return null;
    return posix.resolve(s.cwd, arg);
  }

  // Failed logins per address in the last minute (the map is pruned as it goes).
  private recentFailures(ip: string): number[] {
    const now = this.now();
    for (const [k, v] of this.failures) {
      const kept = v.filter((t) => now - t < FAILURE_WINDOW);
      if (kept.length) this.failures.set(k, kept);
      else this.failures.delete(k);
    }
    return this.failures.get(ip) ?? [];
  }

  private async command(s: Session, line: string, reply: (l: string) => void, attach: (st: net.Socket) => void): Promise<void> {
    const ip = s.ip;
    const sp = line.indexOf(' ');
    const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const arg = sp < 0 ? '' : line.slice(sp + 1);
    this.log(cmd === 'PASS' ? 'PASS ***' : `${cmd}${arg ? ` ${arg}` : ''}`);
    const needTls = !!this.o.tls;
    if (!KNOWN.has(cmd)) return reply('502 Command not implemented');
    if (!s.authed && !OPEN.has(cmd)) return reply('530 Please log in');

    switch (cmd) {
      case 'AUTH':
        if (!this.secureContext || arg.toUpperCase() !== 'TLS') return reply('504 AUTH TLS only (with a certificate configured)');
        reply('234 AUTH TLS OK');
        {
          const t = new tls.TLSSocket(s.stream, { isServer: true, secureContext: this.secureContext });
          t.once('secure', () => this.log(`tls ${t.getProtocol() ?? '?'} ${t.getCipher()?.name ?? '?'}`));
          t.on('error', (err) => this.log(`tls error: ${err.message}`));
          s.secure = true;
          attach(t);
        }
        return;
      case 'PBSZ':
        return reply('200 PBSZ=0');
      case 'PROT':
        if (arg.toUpperCase() === 'P') return (s.prot = 'P'), reply('200 Protection level P');
        if (needTls) return reply('536 PROT P required');
        return (s.prot = 'C'), reply('200 Protection level C');
      case 'USER':
        if (needTls && !s.secure) return reply('530 TLS required (AUTH TLS)');
        s.user = arg;
        return reply('331 Password required');
      case 'PASS':
        if (needTls && !s.secure) return reply('530 TLS required (AUTH TLS)');
        // An address with 5 failures in the last minute is refused before the
        // password is even compared.
        if (this.recentFailures(ip).length >= MAX_FAILURES) {
          reply('421 Too many failed logins, try later');
          return void s.stream.end();
        }
        if (s.user !== undefined && same(s.user, this.o.user) && same(arg, this.o.password)) {
          if ([...this.sessionsOpen].filter((x) => x.authed).length >= (this.o.maxSessions ?? 4)) {
            reply('421 Too many sessions');
            return void s.stream.end();
          }
          this.failures.delete(ip);
          s.authed = true;
          this.arm(s);
          return reply('230 Logged in');
        }
        this.failures.set(ip, [...this.recentFailures(ip), this.now()]);
        return reply('530 Login incorrect');
      case 'SYST':
        return reply('215 UNIX Type: L8');
      case 'FEAT':
        reply('211-Features');
        for (const f of ['AUTH TLS', 'PBSZ', 'PROT', 'EPSV', 'PASV', 'SIZE', 'UTF8']) reply(` ${f}`);
        return reply('211 End');
      case 'OPTS':
        return reply('200 OK');
      case 'NOOP':
        return reply('200 OK');
      case 'QUIT':
        reply('221 Bye');
        return void s.stream.end();
      case 'PWD':
      case 'XPWD':
        return reply(`257 "${s.cwd}"`);
      case 'CWD':
      case 'CDUP': {
        const p = this.resolve(s, cmd === 'CDUP' ? '..' : arg, true);
        if (!p) return reply('550 Invalid path');
        s.cwd = p;
        return reply('250 OK');
      }
      case 'MKD':
      case 'XMKD': {
        const p = this.resolve(s, arg, false);
        return p ? reply(`257 "${p}" created`) : reply('550 Invalid path');
      }
      case 'TYPE':
      case 'MODE':
      case 'STRU':
        return reply('200 OK');
      case 'PASV':
      case 'EPSV':
        return this.passive(s, cmd, reply);
      case 'STOR':
        return this.store(s, arg, reply);
      case 'SIZE':
        return reply('550 Not available');
      default:
        return reply('502 Command not implemented');
    }
  }

  private async passive(s: Session, cmd: string, reply: (l: string) => void): Promise<void> {
    if (s.pasv) (s.pasv.server.close(), this.passiveListeners.delete(s.pasv.server));
    const [lo, hi] = this.o.passive;
    let server: net.Server | undefined;
    let port = 0;
    for (let n = 0; n <= hi - lo && !server; n++) {
      const candidate = this.nextPassive;
      this.nextPassive = this.nextPassive >= hi ? lo : this.nextPassive + 1;
      const srv = net.createServer();
      const ok = await new Promise<boolean>((r) => {
        srv.once('error', () => r(false));
        srv.listen(candidate, this.o.host ?? '0.0.0.0', () => r(true));
      });
      if (ok) (server = srv), (port = candidate);
    }
    if (!server) return reply('425 No passive port free');
    const srv = server;
    this.passiveListeners.add(srv);
    const done = () => (srv.close(), this.passiveListeners.delete(srv));
    const conn = new Promise<net.Socket>((resolve, reject) => {
      const t = setTimeout(() => (done(), reject(new Error('no data connection'))), 15_000);
      t.unref();
      srv.on('connection', (sock: net.Socket) => {
        this.track(sock);
        sock.on('error', () => undefined);
        // Only the host of the control connection may send the data (no port
        // stealing by another machine racing to the passive port).
        if (plainIp(sock.remoteAddress) !== s.ip) {
          this.log(`data connection from ${plainIp(sock.remoteAddress)} refused (session ${s.ip})`);
          return void sock.destroy();
        }
        clearTimeout(t);
        done();
        if (s.prot === 'P' && this.secureContext) resolve(this.track(new tls.TLSSocket(sock, { isServer: true, secureContext: this.secureContext })));
        else resolve(sock);
      });
    });
    conn.catch(() => undefined);
    s.pasv = { server: srv, conn };
    if (cmd === 'EPSV') return reply(`229 Entering Extended Passive Mode (|||${port}|)`);
    const host = this.pasvAddress ?? plainIp(s.stream.localAddress);
    if (!IPV4.test(host)) return reply('425 No IPv4 address for PASV, use EPSV');
    reply(`227 Entering Passive Mode (${host.split('.').join(',')},${port >> 8},${port & 255})`);
  }

  private async store(s: Session, arg: string, reply: (l: string) => void): Promise<void> {
    const path = this.resolve(s, arg, false);
    if (!path || path === '/') return reply('550 Invalid path');
    if (!s.pasv) return reply('425 Use PASV first');
    if (this.o.tls && s.prot !== 'P') return reply('521 PROT P required');
    const pasv = s.pasv;
    s.pasv = undefined;
    reply('150 Ok to send data');
    s.busy = true;
    this.arm(s);
    let data: net.Socket;
    try {
      data = await pasv.conn;
    } catch {
      s.busy = false;
      this.arm(s);
      return reply('425 No data connection');
    }
    // A data connection that goes quiet fails the transfer.
    data.setTimeout(this.o.timeouts?.dataMs ?? 30_000, () => data.destroy());
    const tmpFile = join(this.incoming, randomBytes(8).toString('hex'));
    const out = createWriteStream(tmpFile);
    const max = this.o.maxBytes ?? 500 * 1024 * 1024;
    let bytes = 0;
    let ended = false;
    let failed = false;
    const fail = (code: string) => {
      if (failed) return;
      failed = true;
      s.busy = false;
      this.arm(s);
      data.destroy();
      out.destroy();
      try {
        unlinkSync(tmpFile);
      } catch {
        // not created
      }
      reply(code);
      this.emit('failed', { name: posix.basename(path), reason: code });
    };
    data.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > max) {
        data.destroy();
        fail('552 File too large');
      }
    });
    data.on('end', () => (ended = true));
    data.on('error', () => undefined);
    // Disk full, permissions, a failing card: the transfer fails, the process stays.
    out.on('error', (err) => {
      this.log(`write error: ${(err as NodeJS.ErrnoException).code ?? err.message}`);
      fail('451 Local error writing the file');
    });
    data.pipe(out);
    data.on('close', () => {
      if (failed) return;
      if (!ended) return fail('426 Transfer aborted');
      out.on('finish', () => {
        // A cut-off upload closes the control connection too: only a session
        // still open after the data ends counts as complete.
        setTimeout(() => {
          if (failed) return;
          if (s.closed) return fail('426 Session closed during transfer');
          s.busy = false;
          this.arm(s);
          reply('226 Transfer complete');
          this.emit('upload', { path, name: posix.basename(path), dir: posix.dirname(path), bytes, tmpFile } satisfies Upload);
        }, 50);
      });
      if (out.writableFinished) out.emit('finish');
    });
  }
}

