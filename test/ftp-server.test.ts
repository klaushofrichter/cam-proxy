import { describe, it, expect, afterEach } from 'vitest';
import { Client } from 'basic-ftp';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { generate } from 'selfsigned';
import { FtpServer, type FtpServerOptions, type Upload } from '../src/clips/ftp-server';
import { freePort } from './helpers/proxy';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup(opts: { tls?: boolean; maxSessions?: number; host?: string; publicHost?: string; timeouts?: FtpServerOptions['timeouts']; now?: () => number; lookup?: FtpServerOptions['lookup']; log?: FtpServerOptions['log']; accept?: FtpServerOptions['accept']; users?: FtpServerOptions['users'] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'camproxy-ftp-'));
  const port = await freePort();
  const p0 = await freePort();
  let tls: { cert: string; key: string } | undefined;
  if (opts.tls) {
    const pems = await generate([{ name: 'commonName', value: 'cam-proxy' }], { keyType: 'ec' });
    tls = { cert: pems.cert, key: pems.private };
  }
  const server = new FtpServer({ port, host: opts.host ?? '127.0.0.1', passive: [p0, p0 + 20], publicHost: 'publicHost' in opts ? opts.publicHost : '127.0.0.1', users: opts.users ?? (() => new Map([['camera', { cam: 'cam1' }]])), password: 'ftp-pw', tls, root, maxSessions: opts.maxSessions, timeouts: opts.timeouts, now: opts.now, lookup: opts.lookup, log: opts.log, accept: opts.accept });
  const uploads: Upload[] = [];
  const failures: string[] = [];
  server.on('upload', (u: Upload) => uploads.push(u));
  server.on('failed', (f: { reason: string }) => failures.push(f.reason));
  await server.start();
  cleanup.push(() => server.stop());
  const client = async (password = 'ftp-pw', user = 'camera') => {
    const c = new Client(5000);
    cleanup.push(() => c.close());
    try {
      await c.access({ host: '127.0.0.1', port, user, password, secure: !!opts.tls, secureOptions: { rejectUnauthorized: false } });
    } catch (err) {
      c.close(); // like the camera: a refused login ends the connection
      throw err;
    }
    return c;
  };
  return { root, port, server, uploads, failures, client };
}

describe('upload-only FTP server', () => {
  it('accepts a login and uploads into nested folders', async () => {
    const { client, uploads, root } = await setup();
    const c = await client();
    await c.ensureDir('/2026/09/27');
    await c.uploadFrom(Readable.from([Buffer.from('clip-bytes')]), 'Den_00_20260927140301.mp4');
    await new Promise((r) => setTimeout(r, 100));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ path: '/2026/09/27/Den_00_20260927140301.mp4', name: 'Den_00_20260927140301.mp4', dir: '/2026/09/27', bytes: 10 });
    expect(readFileSync(uploads[0].tmpFile, 'utf8')).toBe('clip-bytes');
    expect(uploads[0].tmpFile.startsWith(join(root, '.incoming'))).toBe(true);
  });

  it('works over explicit TLS, and refuses USER before AUTH TLS', async () => {
    const { client, uploads, port } = await setup({ tls: true });
    const c = await client();
    await c.uploadFrom(Readable.from([Buffer.from('x')]), 'a.mp4');
    await new Promise((r) => setTimeout(r, 100));
    expect(uploads).toHaveLength(1);
    const plain = new Client(5000);
    cleanup.push(() => plain.close());
    await expect(plain.access({ host: '127.0.0.1', port, user: 'camera', password: 'ftp-pw', secure: false })).rejects.toThrow(/530/);
  });

  it('refuses a wrong password and commands before login', async () => {
    const { client, port } = await setup();
    await expect(client('nope')).rejects.toThrow(/530/);
    const raw = await rawSession(port);
    expect(await raw.send('STOR x.mp4')).toMatch(/^530/);
    raw.close();
  });

  it('never writes outside its root, and refuses downloads and listings', async () => {
    const { client, uploads } = await setup();
    const c = await client();
    await expect(c.uploadFrom(Readable.from([Buffer.from('x')]), '../../escape.mp4')).rejects.toThrow(/550/);
    await expect(c.cd('/../../..')).resolves.toBeTruthy(); // clamps to /
    expect(await c.pwd()).toBe('/');
    await expect(c.downloadTo(new (require('stream').Writable)({ write: (_c: unknown, _e: unknown, cb: () => void) => cb() }), 'a.mp4')).rejects.toThrow(/502/);
    await expect(c.list()).rejects.toThrow(/502/);
    expect(uploads).toHaveLength(0);
  });

  it('closes a connection that sends an endless line, and answers unknown commands with 502', async () => {
    const { port } = await setup();
    const raw = await rawSession(port);
    expect(await raw.send('XYZZY')).toMatch(/^502/);
    raw.socket.write('A'.repeat(5000));
    await new Promise((r) => raw.socket.once('close', r));
    raw.close();
  });

  it('discards an upload cut off mid-transfer', async () => {
    const { client, uploads, root } = await setup();
    const c = await client();
    const endless = new Readable({ read() { this.push(Buffer.alloc(64 * 1024)); } });
    const up = c.uploadFrom(endless, 'cut.mp4').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 150));
    c.close(); // the camera loses power
    await up;
    await new Promise((r) => setTimeout(r, 300));
    expect(uploads).toHaveLength(0);
    expect(readdirSync(join(root, '.incoming'))).toHaveLength(0);
  });

  it('limits concurrent logged-in sessions', async () => {
    const { client } = await setup({ maxSessions: 2 });
    await client();
    await client();
    await expect(client()).rejects.toThrow(/421/);
  });

  it('stop() ends the sessions', async () => {
    const { client, server } = await setup();
    const c = await client();
    await server.stop();
    await expect(c.pwd()).rejects.toThrow();
    expect(existsSync).toBeTruthy();
  });
});

// Final review: the FTP server faces the LAN, not only the camera.
describe('FTP server hardening', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('idle connections that never log in cannot lock the camera out', async () => {
    const { client, port } = await setup({ timeouts: { preLoginMs: 200 } });
    const idle = [await rawSession(port), await rawSession(port)];
    // A third unauthenticated connection from the same address is refused…
    expect((await rawSession(port)).greeting).toMatch(/^421/);
    // …and the idle ones are closed after the pre-login timeout.
    await Promise.all(idle.map((r) => new Promise((res) => (r.socket.destroyed ? res(null) : r.socket.once('close', res)))));
    const c = await client();
    expect(await c.pwd()).toBe('/');
  });

  it('closes a logged-in session that stays idle', async () => {
    const { client } = await setup({ timeouts: { idleMs: 200 } });
    const c = await client();
    await wait(500);
    await expect(c.pwd()).rejects.toThrow();
  });

  it('fails an upload whose data connection stalls', async () => {
    const { client, uploads, failures, root } = await setup({ timeouts: { dataMs: 200 } });
    const c = await client();
    const stalled = new Readable({ read() {} }); // sends nothing, never ends
    stalled.push(Buffer.from('some'));
    await expect(c.uploadFrom(stalled, 'stall.mp4')).rejects.toThrow();
    await until(() => failures.length > 0);
    expect(failures).toEqual([expect.stringMatching(/^426/)]);
    expect(uploads).toHaveLength(0);
    expect(readdirSync(join(root, '.incoming'))).toHaveLength(0);
  });

  it('accepts the data connection only from the control connection’s address', async () => {
    const { uploads, port } = await setup({ host: '::' });
    const raw = await rawSession(port); // from 127.0.0.1
    await raw.send('USER camera');
    expect(await raw.send('PASS ftp-pw')).toMatch(/^230/);
    const pasv = await raw.send('PASV');
    const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(pasv)!;
    const dataPort = Number(m[5]) * 256 + Number(m[6]);
    // Another host (::1) races the camera to the passive port.
    const thief = net.connect(dataPort, '::1');
    thief.on('error', () => undefined); // the server resets it: that's the point
    await new Promise((r) => thief.once('connect', r));
    thief.end('evil bytes');
    const closed = new Promise((r) => thief.once('close', r));
    raw.socket.write('STOR Den_00_20260927140301.mp4\r\n');
    await closed;
    const good = net.connect(dataPort, '127.0.0.1');
    await new Promise((r) => good.once('connect', r));
    good.end('good bytes');
    await until(() => uploads.length === 1);
    expect(readFileSync(uploads[0].tmpFile, 'utf8')).toBe('good bytes');
    raw.close();
  });

  it('answers a local write error instead of crashing', async () => {
    const { client, uploads, failures, root } = await setup();
    const c = await client();
    chmodSync(join(root, '.incoming'), 0o500);
    cleanup.push(() => chmodSync(join(root, '.incoming'), 0o700));
    await expect(c.uploadFrom(Readable.from([Buffer.from('x'.repeat(1000))]), 'a.mp4')).rejects.toThrow();
    await until(() => failures.length > 0);
    expect(failures).toEqual([expect.stringMatching(/^451/)]);
    expect(uploads).toHaveLength(0);
  });

  it('stop() finishes even when a refused peer keeps its socket half-open', async () => {
    const { server, port } = await setup();
    await rawSession(port);
    await rawSession(port);
    const stubborn = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
    stubborn.on('end', () => undefined); // reads the 421 and the FIN, never closes its side
    await new Promise((r) => stubborn.once('connect', r));
    await wait(100);
    const stopped = await Promise.race([server.stop().then(() => 'stopped'), wait(2000).then(() => 'hung')]);
    expect(stopped).toBe('stopped');
    stubborn.destroy();
  });

  it('refuses logins from an address with 5 failures in the last minute, even with the right password', async () => {
    let now = Date.now();
    const { client } = await setup({ now: () => now });
    for (let i = 0; i < 5; i++) await expect(client('nope')).rejects.toThrow(/530/);
    await expect(client()).rejects.toThrow(/421/);
    now += 61_000;
    expect(await (await client()).pwd()).toBe('/');
  });

  it('announces the resolved address of a publicHost name in PASV', async () => {
    const { port } = await setup({ publicHost: 'cam-proxy.lan', lookup: async () => '10.1.2.3' });
    const raw = await rawSession(port);
    await raw.send('USER camera');
    await raw.send('PASS ftp-pw');
    expect(await raw.send('PASV')).toMatch(/\(10,1,2,3,\d+,\d+\)/);
    raw.close();
  });

  it('falls back to the control connection’s address when publicHost is not usable', async () => {
    const { port } = await setup({ publicHost: 'nowhere.invalid', lookup: async () => { throw new Error('ENOTFOUND'); } });
    const raw = await rawSession(port);
    await raw.send('USER camera');
    await raw.send('PASS ftp-pw');
    expect(await raw.send('PASV')).toMatch(/\(127,0,0,1,\d+,\d+\)/);
    raw.close();
  });

  // Issue #5: a publicHost name whose address changes (a DHCP lease, a new
  // Mac network) is looked up again, at most once a minute.
  it('looks the publicHost name up again after a minute', async () => {
    let now = 1_000_000;
    let address = '10.1.2.3';
    let lookups = 0;
    const { port } = await setup({ publicHost: 'cam-proxy.lan', now: () => now, lookup: async () => { lookups++; return address; } });
    const pasv = async () => {
      const raw = await rawSession(port);
      await raw.send('USER camera');
      await raw.send('PASS ftp-pw');
      const r = await raw.send('PASV');
      raw.close();
      return r;
    };
    expect(await pasv()).toMatch(/\(10,1,2,3,\d+,\d+\)/);
    address = '10.9.9.9';
    now += 30_000;
    expect(await pasv()).toMatch(/\(10,1,2,3,\d+,\d+\)/); // cached
    now += 31_000;
    expect(await pasv()).toMatch(/\(10,9,9,9,\d+,\d+\)/);
    expect(lookups).toBe(2);
  });

  // Review: a failed re-lookup keeps the last good address, and sessions
  // arriving together share one lookup.
  it('keeps the last good address when a later lookup fails, and shares one lookup', async () => {
    let now = 1_000_000;
    let fail = false;
    let lookups = 0;
    const { port } = await setup({
      publicHost: 'cam-proxy.lan',
      now: () => now,
      lookup: async () => {
        lookups++;
        await new Promise((r) => setTimeout(r, 30));
        if (fail) throw new Error('EAI_AGAIN');
        return '10.1.2.3';
      },
    });
    const pasv = async () => {
      const raw = await rawSession(port);
      await raw.send('USER camera');
      await raw.send('PASS ftp-pw');
      const r = await raw.send('PASV');
      raw.close();
      return r;
    };
    expect(await pasv()).toMatch(/\(10,1,2,3,\d+,\d+\)/);
    fail = true;
    now += 61_000;
    const before = lookups;
    const [a, b] = await Promise.all([pasv(), pasv()]);
    expect(a).toMatch(/\(10,1,2,3,\d+,\d+\)/);
    expect(b).toMatch(/\(10,1,2,3,\d+,\d+\)/);
    expect(lookups - before).toBe(1);
  });
});

// Issue #5 (deferred minors from the Plan 3 review).
describe('FTP server: deferred minors (#5)', () => {
  // Raw lines on a socket, reading replies as they come.
  function lines(sock: net.Socket) {
    let buf = '';
    const waiters: ((l: string) => void)[] = [];
    const got: string[] = [];
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const w = waiters.shift();
        if (w) w(l);
        else got.push(l);
      }
    });
    return () => (got.length ? Promise.resolve(got.shift()!) : new Promise<string>((r) => waiters.push(r)));
  }

  it('ignores commands sent in the same packet as AUTH TLS (no STARTTLS injection)', async () => {
    const { port } = await setup({ tls: true });
    const sock = net.connect(port, '127.0.0.1');
    const next = lines(sock);
    expect(await next()).toMatch(/^220/);
    sock.write('AUTH TLS\r\nUSER camera\r\n');
    expect(await next()).toMatch(/^234/);
    sock.removeAllListeners('data');
    const tls = await import('tls');
    const t = tls.connect({ socket: sock, rejectUnauthorized: false });
    await new Promise((r) => t.once('secureConnect', r));
    const tnext = lines(t);
    t.write('PASS ftp-pw\r\n');
    // The injected USER was never taken (no 331 for it arrives over TLS),
    // and the password alone doesn't log in.
    let reply = await tnext();
    if (/^331/.test(reply)) reply = await tnext();
    expect(reply).not.toMatch(/^230/);
    t.destroy();
  });

  it('runs a session’s commands one at a time: pipelined PASVs leave one listener', async () => {
    const { port } = await setup();
    const sock = net.connect(port, '127.0.0.1');
    const next = lines(sock);
    await next();
    sock.write('USER camera\r\nPASS ftp-pw\r\n');
    await next();
    expect(await next()).toMatch(/^230/);
    sock.write('PASV\r\nPASV\r\nPASV\r\n');
    const ports: number[] = [];
    for (let i = 0; i < 3; i++) {
      const m = /\((?:\d+,){4}(\d+),(\d+)\)/.exec(await next())!;
      ports.push(Number(m[1]) * 256 + Number(m[2]));
    }
    const open = async (p: number) =>
      new Promise<boolean>((r) => {
        const c = net.connect(p, '127.0.0.1', () => (c.destroy(), r(true)));
        c.on('error', () => r(false));
      });
    expect(await open(ports[0])).toBe(false);
    expect(await open(ports[1])).toBe(false);
    sock.destroy();
  });

  it('logs neither near-miss password lines nor long arguments', async () => {
    const log: string[] = [];
    const { port } = await setup({ log: (l) => log.push(l) });
    const sock = net.connect(port, '127.0.0.1');
    const next = lines(sock);
    await next();
    sock.write(' PASS hunter2-secret\r\n');
    await next();
    sock.write('PASS\thunter2-secret\r\n');
    await next();
    sock.write(`XYZ ${'a'.repeat(2000)}\r\n`);
    await next();
    sock.destroy();
    const all = log.join('\n');
    expect(all).not.toContain('hunter2');
    expect(Math.max(...log.map((l) => l.length))).toBeLessThanOrEqual(300);
  });

  it('refuses PROT P without a certificate', async () => {
    const { port } = await setup();
    const raw = await rawSession(port);
    expect(await raw.send('PROT P')).toMatch(/^536/);
    raw.close();
  });

  it('refuses STOR while the storage says no, before any data is sent', async () => {
    let ok = true;
    const { client, uploads } = await setup({ accept: () => ok });
    const c = await client();
    ok = false;
    await expect(c.uploadFrom(Readable.from([Buffer.from('x')]), 'a.mp4')).rejects.toThrow(/452/);
    ok = true;
    await c.uploadFrom(Readable.from([Buffer.from('x')]), 'b.mp4');
    await until(() => uploads.length === 1);
  });
});

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// A raw control connection for protocol edge cases.
async function rawSession(port: number, _wait = true) {
  const socket = net.connect(port, '127.0.0.1');
  let buf = '';
  const waiters: ((line: string) => void)[] = [];
  socket.setEncoding('utf8');
  socket.on('data', (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      waiters.shift()?.(line);
    }
  });
  const next = () => new Promise<string>((r) => waiters.push(r));
  const greeting = await next();
  return {
    socket,
    greeting,
    send: (cmd: string) => {
      socket.write(`${cmd}\r\n`);
      return next();
    },
    close: () => socket.destroy(),
  };
}

describe('a user per camera (spec 2026-10-05-multi-camera-host-design §7)', () => {
  it('each camera logs in as its own user; the upload names the camera', async () => {
    const { client, uploads } = await setup({ users: () => new Map([['cam3', { cam: 'cam3' }], ['cam4', { cam: 'cam4' }]]) });
    const c = await client('ftp-pw', 'cam4');
    await c.uploadFrom(Readable.from([Buffer.from('x')]), 'RecS02_20261005_120000_120010_0.mp4');
    await new Promise((r) => setTimeout(r, 100));
    expect(uploads.map((u) => ({ cam: u.cam, user: u.user }))).toEqual([{ cam: 'cam4', user: 'cam4' }]);
  });

  it('a login from another address is refused (530) and reported', async () => {
    const { client, server, uploads } = await setup({ users: () => new Map([['cam3', { cam: 'cam3', ip: '192.168.60.13' }]]) });
    const refused: unknown[] = [];
    server.on('refused', (r: unknown) => refused.push(r));
    await expect(client('ftp-pw', 'cam3')).rejects.toThrow(/530/);
    expect(refused).toEqual([{ user: 'cam3', ip: '127.0.0.1', expected: '192.168.60.13' }]);
    expect(uploads).toEqual([]);
  });

  it('an unknown user is refused like a wrong password', async () => {
    const { client } = await setup({ users: () => new Map([['cam3', { cam: 'cam3' }]]) });
    await expect(client('ftp-pw', 'cam9')).rejects.toThrow(/530/);
  });

  it('the session cap scales with the users: two sessions per camera (MP4 and JPEG)', async () => {
    const { client } = await setup({ users: () => new Map([['cam3', { cam: 'cam3' }], ['cam4', { cam: 'cam4' }], ['cam5', { cam: 'cam5' }]]) });
    for (let i = 0; i < 12; i++) await client('ftp-pw', ['cam3', 'cam4', 'cam5'][i % 3]);
    await expect(client('ftp-pw', 'cam3')).rejects.toThrow(/421/);
  });
});
