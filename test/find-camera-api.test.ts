import dgram from 'dgram';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, CLIENT_TOKEN, startProxy } from './helpers/proxy';

// Spec 2026-10-04-pi-config-design §3, §4: Find camera and Use this address.

const SAMPLE = readFileSync(join(__dirname, 'fixtures', 'ws-discovery', 'reolink-probe-match.xml'), 'utf8');
const SECRETS = 'CAMPROXY_TOKENS=never-printed-token-aaaaaaaaaaaaaaaaaaaaaa\r\nCAMPROXY_ADMIN_TOKEN="x # y"\r\n';

let sim: Awaited<ReturnType<typeof startSim>>;
let fake: dgram.Socket;
let fakePort: number;
let answerWith = (id: string, rinfoAddress: string) => [SAMPLE.replace('{{RELATES_TO}}', id), SAMPLE.replace('{{RELATES_TO}}', id).replace(/192\.168\.1\.20/g, rinfoAddress).replace('ec71db000001</wsa:Address>', 'ec71db000002</wsa:Address>')];
beforeAll(async () => {
  sim = await startSim();
  fake = dgram.createSocket('udp4');
  fake.on('message', (msg, rinfo) => {
    const id = /<a:MessageID>([^<]+)</.exec(msg.toString())?.[1] ?? '';
    for (const a of answerWith(id, sim.camera.host.split(':')[0])) fake.send(a, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => fake.bind(0, '127.0.0.1', () => r()));
  fakePort = (fake.address() as { port: number }).port;
}, 30_000);
afterAll(async () => {
  fake.close();
  await sim.close();
});

const admin = () => auth(ADMIN_TOKEN);
const auditOf = async (base: string, action: string) => (await request(base).get(`/control/audit?action=${action}&after=&limit=50`).set(admin())).text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const start = async (env: Record<string, string> = {}) => startProxy(sim, { env, proxy: { discovery: { target: { address: '127.0.0.1', port: fakePort }, timeoutMs: 300 } } });

describe('POST /control/actions/find-camera', () => {
  it('lists the devices that answer, marks the current camera, and says the .env file is not set up', async () => {
    const p = await start();
    try {
      const r = await request(p.base).post('/control/actions/find-camera').set(admin());
      expect(r.status).toBe(200);
      expect(r.body.devices).toEqual(expect.arrayContaining([
        expect.objectContaining({ address: '192.168.1.20', name: 'RLC-1224A', model: 'RLC-1224A', current: false }),
        expect.objectContaining({ address: '127.0.0.1', current: true }),
      ]));
      expect(r.body.envFile).toEqual({ writable: false, reason: 'CAMPROXY_ENV_FILE is not set' });
      expect(r.body.tookMs).toBeGreaterThanOrEqual(250);
      const rec = (await auditOf(p.base, 'control-action')).at(-1);
      expect(rec.message).toBe('Control action find-camera: ok');
    } finally {
      await p.proxy.stop();
    }
  });

  it('is admin only, needs the CSRF header with a session, and is rate limited', async () => {
    const p = await start();
    try {
      expect((await request(p.base).post('/control/actions/find-camera').set(auth(CLIENT_TOKEN))).status).toBe(403);
      const login = await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      expect((await request(p.base).post('/control/actions/find-camera').set('Cookie', cookie)).status).toBe(403);
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) codes.push((await request(p.base).post('/control/actions/find-camera').set('Cookie', cookie).set('X-CamProxy-UI', '1')).status);
      expect(codes.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
      const limited = await request(p.base).post('/control/actions/find-camera').set(admin());
      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({ error: 'rate_limited' });
    } finally {
      await p.proxy.stop();
    }
  });
});

describe('POST /control/actions/camera-address', () => {
  it('without CAMPROXY_ENV_FILE: 409 not_available with the line to add by hand', async () => {
    const p = await start();
    try {
      const r = await request(p.base).post('/control/actions/camera-address').set(admin()).send({ host: '192.168.1.20' });
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ error: 'not_available', detail: 'CAMPROXY_ENV_FILE is not set', line: 'CAMERA_HOST=192.168.1.20' });
    } finally {
      await p.proxy.stop();
    }
  });

  it('refuses an invalid host and writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-envapi-'));
    writeFileSync(join(dir, '.env'), SECRETS);
    const p = await start({ CAMPROXY_ENV_FILE: join(dir, '.env') });
    try {
      for (const host of ['', 'http://x', 'a b', '1.2.3.4:0', 'x'.repeat(300), 7, 'h\nCAMPROXY_ADMIN_TOKEN=evil']) {
        const r = await request(p.base).post('/control/actions/camera-address').set(admin()).send({ host });
        expect(r.status).toBe(400);
        expect(r.body.error).toBe('invalid');
      }
      expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(SECRETS);
      expect(readdirSync(dir)).toEqual(['.env']);
    } finally {
      await p.proxy.stop();
    }
  });

  it('writes CAMERA_HOST into the file (other lines byte-for-byte), with a backup, audited; the file says writable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-envapi-'));
    const f = join(dir, '.env');
    writeFileSync(f, `${SECRETS}CAMERA_HOST=10.0.0.1\r\n`, { mode: 0o600 });
    const p = await start({ CAMPROXY_ENV_FILE: f });
    try {
      expect((await request(p.base).post('/control/actions/find-camera').set(admin())).body.envFile).toEqual({ writable: true, path: f });
      const r = await request(p.base).post('/control/actions/camera-address').set(admin()).send({ host: '192.168.1.20' });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ host: '192.168.1.20', previous: '10.0.0.1', key: 'CAMERA_HOST', backup: expect.stringMatching(/^\.env\.bak-\d{8}-\d{6}$/), restart: true });
      expect(readFileSync(f, 'utf8')).toBe(`${SECRETS}CAMERA_HOST=192.168.1.20\r\n`);
      expect(statSync(f).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, r.body.backup), 'utf8')).toBe(`${SECRETS}CAMERA_HOST=10.0.0.1\r\n`);
      const rec = (await auditOf(p.base, 'camera-address')).at(-1);
      expect(rec.event).toMatchObject({ action: 'camera-address', outcome: 'success' });
      expect(rec.message).toBe('Camera address set in .env: "10.0.0.1" → "192.168.1.20" (applies after a restart)');
      expect(rec.cam_proxy).toMatchObject({ from: '10.0.0.1', to: '192.168.1.20', key: 'CAMERA_HOST', backup: r.body.backup, requestedBy: 'token' });
      expect(JSON.stringify(rec)).not.toContain('never-printed-token');
      // No generic control-action record for it.
      expect((await auditOf(p.base, 'control-action')).some((x) => x.message.includes('camera-address'))).toBe(false);
    } finally {
      await p.proxy.stop();
    }
  });

  it('a path that fails the guard: 409 not_available, audited as a failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-envapi-'));
    writeFileSync(join(dir, 'secrets.txt'), SECRETS);
    const p = await start({ CAMPROXY_ENV_FILE: join(dir, 'secrets.txt') });
    try {
      const r = await request(p.base).post('/control/actions/camera-address').set(admin()).send({ host: '192.168.1.20' });
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: 'not_available', detail: 'CAMPROXY_ENV_FILE must name a .env file', line: 'CAMERA_HOST=192.168.1.20' });
      expect(readFileSync(join(dir, 'secrets.txt'), 'utf8')).toBe(SECRETS);
      const rec = (await auditOf(p.base, 'camera-address')).at(-1);
      expect(rec.event).toMatchObject({ action: 'camera-address', outcome: 'failure' });
    } finally {
      await p.proxy.stop();
    }
  });
});
