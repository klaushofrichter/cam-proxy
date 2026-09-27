import { describe, it, expect, afterEach } from 'vitest';
import { Client } from 'basic-ftp';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { generate } from 'selfsigned';
import { FtpServer, type Upload } from '../src/clips/ftp-server';
import { freePort } from './helpers/proxy';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function setup(opts: { tls?: boolean; maxSessions?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'camproxy-ftp-'));
  const port = await freePort();
  const p0 = await freePort();
  let tls: { cert: string; key: string } | undefined;
  if (opts.tls) {
    const pems = await generate([{ name: 'commonName', value: 'cam-proxy' }], { keyType: 'ec' });
    tls = { cert: pems.cert, key: pems.private };
  }
  const server = new FtpServer({ port, host: '127.0.0.1', passive: [p0, p0 + 20], publicHost: '127.0.0.1', user: 'camera', password: 'ftp-pw', tls, root, maxSessions: opts.maxSessions });
  const uploads: Upload[] = [];
  server.on('upload', (u: Upload) => uploads.push(u));
  await server.start();
  cleanup.push(() => server.stop());
  const client = async (password = 'ftp-pw') => {
    const c = new Client(5000);
    cleanup.push(() => c.close());
    await c.access({ host: '127.0.0.1', port, user: 'camera', password, secure: !!opts.tls, secureOptions: { rejectUnauthorized: false } });
    return c;
  };
  return { root, port, server, uploads, client };
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

  it('limits concurrent sessions', async () => {
    const { client, port } = await setup({ maxSessions: 2 });
    await client();
    await client();
    const raw = await rawSession(port, false);
    expect(raw.greeting).toMatch(/^421/);
    raw.close();
  });

  it('stop() ends the sessions', async () => {
    const { client, server } = await setup();
    const c = await client();
    await server.stop();
    await expect(c.pwd()).rejects.toThrow();
    expect(existsSync).toBeTruthy();
  });
});

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
