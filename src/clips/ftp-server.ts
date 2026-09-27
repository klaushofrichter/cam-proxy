import { randomBytes, timingSafeEqual, createHash } from 'crypto';
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
  maxSessions?: number;
  log?: (line: string) => void; // command names and paths, never the password
}

const MAX_LINE = 4096;
const OPEN = new Set(['USER', 'PASS', 'AUTH', 'QUIT', 'SYST', 'FEAT', 'NOOP', 'PBSZ', 'PROT', 'OPTS']);
const KNOWN = new Set([...OPEN, 'PWD', 'XPWD', 'CWD', 'CDUP', 'MKD', 'XMKD', 'TYPE', 'MODE', 'STRU', 'PASV', 'EPSV', 'STOR', 'SIZE']);
const digest = (s: string) => createHash('sha256').update(s).digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

interface Session {
  stream: net.Socket; // the control connection (a TLSSocket after AUTH TLS)
  secure: boolean;
  prot: 'C' | 'P';
  user?: string;
  authed: boolean;
  cwd: string;
  closed: boolean;
  pasv?: { server: net.Server; conn: Promise<net.Socket> };
}

export class FtpServer extends EventEmitter {
  private server: net.Server | undefined;
  private readonly sessionsOpen = new Set<Session>();
  private readonly failures = new Map<string, number[]>();
  private readonly incoming: string;
  private secureContext: tls.SecureContext | undefined;
  private nextPassive: number;

  constructor(private readonly o: FtpServerOptions) {
    super();
    this.incoming = join(o.root, '.incoming');
    this.nextPassive = o.passive[0];
    if (o.tls) this.secureContext = tls.createSecureContext({ cert: o.tls.cert, key: o.tls.key });
  }

  sessions(): number {
    return this.sessionsOpen.size;
  }

  start(): Promise<number> {
    mkdirSync(this.incoming, { recursive: true });
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
      s.pasv?.server.close();
      s.stream.destroy();
    }
    this.sessionsOpen.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  private log(line: string): void {
    this.o.log?.(line);
  }

  private session(socket: net.Socket): void {
    if (this.sessionsOpen.size >= (this.o.maxSessions ?? 4)) {
      socket.end('421 Too many connections\r\n');
      return;
    }
    const s: Session = { stream: socket, secure: false, prot: 'C', authed: false, cwd: '/', closed: false };
    this.sessionsOpen.add(s);
    const ip = socket.remoteAddress ?? '';
    const reply = (line: string) => {
      if (!s.closed && !s.stream.destroyed) s.stream.write(`${line}\r\n`);
    };
    const close = () => {
      if (s.closed) return;
      s.closed = true;
      s.pasv?.server.close();
      this.sessionsOpen.delete(s);
    };

    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_LINE && buf.indexOf('\r\n') < 0) {
        s.stream.destroy();
        return;
      }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        void this.command(s, line, reply, ip, attach);
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
    socket.on('error', () => undefined);
    socket.on('close', close);
    reply('220 cam-proxy FTP ready');
  }

  private resolve(s: Session, arg: string, allowClamp: boolean): string | null {
    if (!arg || arg.length > 1024 || arg.includes('\0')) return null;
    if (!allowClamp && arg.split('/').includes('..')) return null;
    return posix.resolve(s.cwd, arg);
  }

  private failed(ip: string): boolean {
    const now = Date.now();
    const list = (this.failures.get(ip) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    this.failures.set(ip, list);
    return list.length > 5;
  }

  private async command(s: Session, line: string, reply: (l: string) => void, ip: string, attach: (st: net.Socket) => void): Promise<void> {
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
        if (s.user !== undefined && same(s.user, this.o.user) && same(arg, this.o.password)) {
          s.authed = true;
          return reply('230 Logged in');
        }
        if (this.failed(ip)) {
          reply('421 Too many failed logins');
          return void s.stream.end();
        }
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
    s.pasv?.server.close();
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
    const conn = new Promise<net.Socket>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no data connection')), 15_000);
      srv.once('connection', (sock: net.Socket) => {
        clearTimeout(t);
        srv.close();
        if (s.prot === 'P' && this.secureContext) resolve(new tls.TLSSocket(sock, { isServer: true, secureContext: this.secureContext }));
        else resolve(sock);
      });
    });
    conn.catch(() => undefined);
    s.pasv = { server: srv, conn };
    if (cmd === 'EPSV') return reply(`229 Entering Extended Passive Mode (|||${port}|)`);
    const host = (this.o.publicHost ?? (s.stream.localAddress ?? '127.0.0.1').replace(/^::ffff:/, '')).replace(/[^0-9.]/g, '');
    const parts = (/^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : '127.0.0.1').split('.');
    reply(`227 Entering Passive Mode (${parts.join(',')},${port >> 8},${port & 255})`);
  }

  private async store(s: Session, arg: string, reply: (l: string) => void): Promise<void> {
    const path = this.resolve(s, arg, false);
    if (!path || path === '/') return reply('550 Invalid path');
    if (!s.pasv) return reply('425 Use PASV first');
    if (this.o.tls && s.prot !== 'P') return reply('521 PROT P required');
    const pasv = s.pasv;
    s.pasv = undefined;
    reply('150 Ok to send data');
    let data: net.Socket;
    try {
      data = await pasv.conn;
    } catch {
      return reply('425 No data connection');
    }
    const tmpFile = join(this.incoming, randomBytes(8).toString('hex'));
    const out = createWriteStream(tmpFile);
    const max = this.o.maxBytes ?? 500 * 1024 * 1024;
    let bytes = 0;
    let ended = false;
    let failed = false;
    const fail = (code: string) => {
      if (failed) return;
      failed = true;
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
    data.pipe(out);
    data.on('close', () => {
      if (failed) return;
      if (!ended) return fail('426 Transfer aborted');
      out.on('finish', () => {
        // A cut-off upload closes the control connection too: only a session
        // still open after the data ends counts as complete.
        setTimeout(() => {
          if (s.closed) return fail('426 Session closed during transfer');
          reply('226 Transfer complete');
          this.emit('upload', { path, name: posix.basename(path), dir: posix.dirname(path), bytes, tmpFile } satisfies Upload);
        }, 50);
      });
      if (out.writableFinished) out.emit('finish');
    });
  }
}

