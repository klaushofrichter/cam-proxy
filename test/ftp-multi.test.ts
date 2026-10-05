// One FTP server for every camera (spec 2026-10-05-multi-camera-host-design §7):
// each camera's user puts its clips under its own id; a login from another
// address than the camera's is refused (530), logged and audited.
import { Client } from 'basic-ftp';
import { execFile } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { Readable } from 'stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listClips } from '../src/catalog/clips';
import { freePort, until } from './helpers/proxy';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';

const run = promisify(execFile);
const FTP_PW = 'ftp-secret-'.padEnd(24, 'z');
let sims: Sim[];
let p: Awaited<ReturnType<typeof startMultiProxy>>;
let ftpPort = 0;
let clip: Buffer;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-ftpmulti-'));
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'c.mp4')]);
  clip = readFileSync(join(dir, 'c.mp4'));
  sims = await startSims(2);
  ftpPort = await freePort();
  const passive = await freePort();
  p = await startMultiProxy(sims, {
    // A third camera at another address (never reachable here): its user may only log in from there.
    extra: [{ id: 'cam9', host: '192.0.2.9', ftp: { enabled: true } }],
    settings: { ftp: { enabled: true, port: ftpPort, passive: `${passive}-${passive + 29}`, publicHost: '127.0.0.1', tls: true, stream: 'sub' } },
    env: { CAMPROXY_FTP_PASSWORD: FTP_PW },
  });
}, 60_000);
afterAll(async () => {
  await p.proxy.stop();
  await Promise.all(sims.map((s) => s.close()));
});

async function login(user: string): Promise<Client> {
  const c = new Client(5000);
  try {
    await c.access({ host: '127.0.0.1', port: ftpPort, user, password: FTP_PW, secure: true, secureOptions: { rejectUnauthorized: false } });
  } catch (err) {
    c.close();
    throw err;
  }
  return c;
}

describe('one FTP server, a user per camera', () => {
  it("an upload as cam4 is cam4's clip, not cam3's", async () => {
    const c = await login('cam4');
    await c.ensureDir('/2026/10/05');
    await c.uploadFrom(Readable.from([clip]), 'Yard_00_20261005120000.mp4');
    c.close();
    await until(() => listClips(p.proxy.catalog, 'cam4', 0, Date.now() + 86_400_000).length === 1, 15_000);
    expect(listClips(p.proxy.catalog, 'cam3', 0, Date.now() + 86_400_000)).toEqual([]);
  });

  it('a login from another address than the camera is refused and audited', async () => {
    await expect(login('cam9')).rejects.toThrow(/530/);
    await until(() => !!p.proxy.audit.find((r) => r.event.action === 'ftp-login-refused', 10), 5000);
    const r = p.proxy.audit.find((x) => x.event.action === 'ftp-login-refused', 10)!;
    expect(r.labels).toEqual({ camera: 'cam9' });
    expect(r.event.outcome).toBe('failure');
    expect(r.message).toContain('192.0.2.9');
  });
});
