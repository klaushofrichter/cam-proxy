// Issue #70: PUT /control/secrets/google-vision-key, the Vision key set at
// runtime, kept in memory only, audited with the masked key.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { insertEvent } from '../src/catalog/events';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, startProxy } from './helpers/proxy';
import { startVisionMock, type VisionMock } from './helpers/vision-mock';

const ENV_KEY = 'AIzaSyEnvKey000000000aBcD';
const MANUAL = 'AIzaSyManualKey0000000wXyZ';
const SECOND = 'AIzaSySecondKey000000q9Rs';
const AUDIT_TOKEN = 'audit-token-'.padEnd(40, 'z');
const PATH = '/control/secrets/google-vision-key';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let mock: VisionMock;
const env = () => ({ CAMPROXY_GOOGLE_VISION_KEY: ENV_KEY, CAMPROXY_GOOGLE_VISION_URL: mock.url, CAMPROXY_AUDIT_TOKEN: AUDIT_TOKEN });
const admin = () => auth(ADMIN_TOKEN);
beforeAll(async () => {
  sim = await startSim();
  mock = await startVisionMock({ key: MANUAL });
  p = await startProxy(sim, { env: env() });
});
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
  await mock.close();
});

// Every file under a folder, as text (binary files too: a key would show).
function allText(dir: string): string {
  return readdirSync(dir).map((f) => {
    const full = join(dir, f);
    return statSync(full).isDirectory() ? allText(full) : readFileSync(full).toString('latin1');
  }).join('\n');
}
const auditDir = (dir: string) => join(dir, 'data', 'audit');
const auditRecords = (dir: string) => readdirSync(auditDir(dir)).sort().map((f) => readFileSync(join(auditDir(dir), f), 'utf8')).join('\n').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));

describe('PUT /control/secrets/google-vision-key', () => {
  it('refuses a missing, short, long or spaced key with 400 invalid, and changes nothing', async () => {
    for (const body of [{}, { key: 42 }, { key: 'A'.repeat(19) }, { key: 'A'.repeat(201) }, { key: 'AIzaSy with space 00000' }, { key: 'AIzaSyTab\t000000000000' }, { key: `${MANUAL}\n` }]) {
      const r = await request(p.base).put(PATH).set(admin()).send(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toBe('invalid');
    }
    expect((await request(p.base).put(PATH).set(admin()).set('Content-Type', 'application/json').send('[1]')).status).toBe(400);
    expect(p.proxy.analytics.state()[0]).toMatchObject({ keySource: 'env', keyMasked: 'AIza…aBcD' });
    // 20 and 200 characters are fine.
    expect((await request(p.base).put(PATH).set(admin()).send({ key: 'A'.repeat(20) })).status).toBe(200);
    expect((await request(p.base).put(PATH).set(admin()).send({ key: 'B'.repeat(200) })).status).toBe(200);
  });

  it('is admin only: client and audit tokens get 403, a session needs X-CamProxy-UI', async () => {
    expect((await request(p.base).put(PATH).send({ key: MANUAL })).status).toBe(401);
    expect((await request(p.base).put(PATH).set(auth(CLIENT_TOKEN)).send({ key: MANUAL })).status).toBe(403);
    expect((await request(p.base).put(PATH).set(auth(AUDIT_TOKEN)).send({ key: MANUAL })).status).toBe(403);
    const login = await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const no = await request(p.base).put(PATH).set('Cookie', cookie).send({ key: MANUAL });
    expect(no.status).toBe(403);
    expect(no.body).toEqual({ error: 'csrf' });
    const ok = await request(p.base).put(PATH).set('Cookie', cookie).set('X-CamProxy-UI', '1').send({ key: MANUAL });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ keySource: 'manual', keyMasked: 'AIza…wXyZ', replaced: 'manual' });
  });

  it('analysis calls use the new key at once; the answer and the state carry only the masked key', async () => {
    const r = await request(p.base).put(PATH).set(admin()).send({ key: SECOND });
    expect(r.body).toEqual({ keySource: 'manual', keyMasked: 'AIza…q9Rs', replaced: 'manual' });
    await request(p.base).put(PATH).set(admin()).send({ key: MANUAL });
    await request(p.base).put('/control/config').set(admin()).send({ analytics: { googleVision: { enabled: true, monthlyLimit: 10 } } });
    const st = (await request(p.base).get('/control/status').set(admin())).body;
    expect(st.analytics[0]).toMatchObject({ keySource: 'manual', keyMasked: 'AIza…wXyZ' });
    // A still for the event: the service reads it through the proxy's stills side,
    // which is off in unit tests, so the call goes through the service directly.
    const svc = p.proxy.analytics as unknown as { d: { readStill: (ts: number) => Promise<Buffer | undefined>; listStills: (a: number, b: number) => number[] } };
    const start = Date.now() - 5000;
    svc.d.readStill = async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    svc.d.listStills = () => [start + 1000];
    const before = mock.calls;
    const e = insertEvent(p.proxy.catalog, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: start, raw: null });
    p.proxy.analytics.onEvent(e);
    await p.proxy.analytics.idle();
    expect(mock.calls).toBe(before + 1);
    expect(mock.lastKeyHeader).toBe(MANUAL);
  });

  it('records secret-override with the masked key and what it replaced; the key appears in no file and no answer', async () => {
    const recs = auditRecords(p.dir).filter((r) => r.event.action === 'secret-override');
    expect(recs.length).toBeGreaterThanOrEqual(3);
    const last = recs[recs.length - 1];
    expect(last).toMatchObject({
      event: { action: 'secret-override', category: ['configuration'], type: ['change'], outcome: 'success' },
      user: { name: 'admin' },
      source: { ip: expect.any(String) },
      cam_proxy: { secret: 'CAMPROXY_GOOGLE_VISION_KEY', masked: 'AIza…wXyZ', replaced: 'manual' },
    });
    expect(recs[0].cam_proxy).toEqual({ secret: 'CAMPROXY_GOOGLE_VISION_KEY', masked: 'AAAA…AAAA', replaced: 'env' });
    expect(last.message).toContain('AIza…wXyZ');
    // No refused attempt (400) is recorded.
    expect(recs.every((r) => r.event.outcome === 'success')).toBe(true);

    const answers = await Promise.all(['/control/log?limit=500', '/control/config', '/control/status', '/control/analytics', '/control/stats'].map((u) => request(p.base).get(u).set(admin())));
    const audit = await request(p.base).get('/control/audit?limit=500').set(admin());
    for (const r of [...answers, audit]) {
      expect(r.status).toBe(200);
      for (const k of [MANUAL, SECOND]) expect(r.text).not.toContain(k);
    }
    for (const k of [MANUAL, SECOND, 'A'.repeat(20), 'B'.repeat(200)]) expect(allText(p.dir)).not.toContain(k);
  });

  it('a restart drops the manual key: back to the env key, and to none without one', async () => {
    await request(p.base).put(PATH).set(admin()).send({ key: MANUAL });
    await p.proxy.stop();
    p = await startProxy(sim, { dir: p.dir, env: env() });
    expect(p.proxy.analytics.state()[0]).toMatchObject({ keySource: 'env', keyMasked: 'AIza…aBcD' });
    const q = await startProxy(sim);
    try {
      expect(q.proxy.analytics.state()[0]).toMatchObject({ keySource: 'none', keyMasked: null });
      const r = await request(q.base).put(PATH).set(admin()).send({ key: MANUAL });
      expect(r.body).toEqual({ keySource: 'manual', keyMasked: 'AIza…wXyZ', replaced: 'none' });
    } finally {
      await q.proxy.stop();
    }
  });
});
