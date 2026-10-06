import { createHash, randomBytes } from 'crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { ALLOW_ENTRIES } from '../src/fleet/policy';
import { writePrivateJson } from '../src/fleet/private-file';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// The Status card's API (spec 2026-10-06-cams-admin-phase1-design §9.2):
// GET /control/admin, POST enroll / reconnect / unenroll; admin only, CSRF;
// audited without the code; no key material ever served.
const CODE = 'CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B';
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let fake: FakeAdmin;
const admin = auth(ADMIN_TOKEN);
const records = (action: string) => p.proxy.audit.list({ actions: [action], limit: 50 }).records as unknown as Record<string, unknown>[];
const auditText = () => readdirSync(join(p.dir, 'data', 'audit')).map((f) => readFileSync(join(p.dir, 'data', 'audit', f), 'utf8')).join('');

beforeAll(async () => {
  sim = await startSim();
  fake = await startFakeAdmin();
  fake.welcomeHeartbeatS = 1;
  p = await startProxy(sim, { proxy: { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200 } } } });
}, 30_000);
afterAll(async () => {
  await p.proxy.stop();
  await fake.close();
  await sim.close();
});

async function login(): Promise<string> {
  const r = await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
  return String(r.headers['set-cookie']).split(';')[0];
}

describe('GET /control/admin', () => {
  it('off: the card data, nothing else', async () => {
    const r = await request(p.base).get('/control/admin').set(admin).expect(200);
    expect(r.body).toMatchObject({ state: 'off', url: null, proxyId: null, fingerprint: null });
    expect(existsSync(join(p.dir, 'data', 'admin'))).toBe(false);
  });
  it('admin only', async () => {
    expect((await request(p.base).get('/control/admin')).status).toBe(401);
    expect((await request(p.base).get('/control/admin').set(auth())).status).toBe(403);
  });
});

describe('enroll, reconnect, unenroll', () => {
  it('a cookie session needs the CSRF header', async () => {
    const cookie = await login();
    const r = await request(p.base).post('/control/admin/enroll').set('Cookie', cookie).send({ url: fake.url, code: CODE });
    expect([r.status, r.body]).toEqual([403, { error: 'csrf' }]);
    expect(fake.enrollRequests).toHaveLength(0);
  });

  it('a wrong code: 400 invalid_code, audited as a failure without the code', async () => {
    const cookie = await login();
    const r = await request(p.base).post('/control/admin/enroll').set('Cookie', cookie).set('x-camproxy-ui', '1').send({ url: fake.url, code: CODE });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'invalid_code', message: expect.stringMatching(/refused the code/) });
    expect(records('admin-enroll')[0]).toMatchObject({ event: { outcome: 'failure' } });
    expect(existsSync(join(p.dir, 'data', 'admin', 'key.json'))).toBe(false);
    expect(p.proxy.camsAdmin.view().state).toBe('off');
  });

  it('bad input: 400 before anything is sent', async () => {
    const n = fake.enrollRequests.length;
    for (const body of [{}, { url: fake.url }, { url: 'http://192.168.1.10', code: CODE }, { url: fake.url, code: 'nope' }, { url: 7, code: CODE }]) {
      const r = await request(p.base).post('/control/admin/enroll').set(admin).send(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(fake.enrollRequests.length).toBe(n);
  });

  it('a good code: the key file, camsAdmin.url set, connected; audited with the fingerprint, never the code', async () => {
    fake.codes.add(CODE);
    const r = await request(p.base).post('/control/admin/enroll').set(admin).send({ url: fake.url, code: CODE.toLowerCase() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ url: fake.url, account: 'home', proxyId: expect.stringMatching(/^prx_/), fingerprint: expect.stringMatching(/^SHA256:/) });
    expect(JSON.stringify(r.body)).not.toMatch(/privateKey|MC4CAQAw/);
    expect(p.proxy.loaded.sources['camsAdmin.url']).toBe('override');
    await until(() => p.proxy.camsAdmin.view().state === 'connected');
    await until(() => fake.heartbeats().length >= 1);
    const rec = records('admin-enroll')[0];
    expect(rec).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { url: fake.url, proxyId: r.body.proxyId, fingerprint: r.body.fingerprint } });
    const text = auditText();
    expect(text).not.toMatch(/7Q2M|7q2m/);
    const g = (await request(p.base).get('/control/admin').set(admin)).body;
    expect(g).toMatchObject({ state: 'connected', lastHeartbeatAt: expect.any(Number) });
    expect(JSON.stringify(g)).not.toMatch(/privateKey|serverKeys/);
  });

  it('two enrollments at once: one goes on, the other is 409 busy', async () => {
    fake.codes.add(CODE);
    fake.enrollDelayMs = 300;
    try {
      const [a, b] = await Promise.all([0, 1].map(() => request(p.base).post('/control/admin/enroll').set(admin).send({ url: fake.url, code: CODE })));
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect([a.body.error, b.body.error]).toContain('busy');
    } finally {
      fake.enrollDelayMs = 0;
    }
    await until(() => p.proxy.camsAdmin.view().state === 'connected');
  });

  it('reconnect: a new connection at once', async () => {
    const n = fake.connections;
    await request(p.base).post('/control/admin/reconnect').set(admin).expect(200);
    await until(() => fake.connections === n + 1 && p.proxy.camsAdmin.view().state === 'connected');
  });

  it('unenroll: bye unenrolled, the key file gone, the URL cleared, audited', async () => {
    const r = await request(p.base).post('/control/admin/unenroll').set(admin);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'off', url: null });
    await until(() => fake.received.some((x) => x.msg.type === 'bye' && (x.msg.body as { reason: string }).reason === 'unenrolled'));
    expect(existsSync(join(p.dir, 'data', 'admin', 'key.json'))).toBe(false);
    expect(p.proxy.loaded.sources['camsAdmin.url']).toBe('default');
    expect(records('admin-unenroll')[0]).toMatchObject({ event: { outcome: 'success' } });
    await until(() => fake.open() === 0);
  });

  it('reconnect while off: 409', async () => {
    expect((await request(p.base).post('/control/admin/reconnect').set(admin)).status).toBe(409);
  });
});

// The command policy and managed tokens on the card (migration P2, Task 7):
// any admin narrows; only local admin rights widen (R2-3).
describe('allowed commands, pause and managed tokens', () => {
  const tok = () => randomBytes(32).toString('base64url');
  const hashOf = (t: string) => `sha256:${createHash('sha256').update(t).digest('hex')}`;
  const TOK = (n: number) => `tok_${String(n).padStart(20, '0')}`;
  const MANAGED_ADMIN = tok();
  const MANAGED_CLIENT = tok();
  let q: Awaited<ReturnType<typeof startProxy>>;
  const qRecords = (action: string) => q.proxy.audit.list({ actions: [action], limit: 50 }).records as unknown as Record<string, any>[];
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-policy-'));
    writePrivateJson(join(dir, 'data', 'admin', 'tokens.json'), {
      v: 1, revision: 4, blocked: [],
      tokens: [
        { id: TOK(1), kind: 'admin', hash: hashOf(MANAGED_ADMIN), label: 'cams cluster', retireAt: null },
        { id: TOK(2), kind: 'client', hash: hashOf(MANAGED_CLIENT), label: 'cams client', retireAt: null },
      ],
    });
    q = await startProxy(sim, { dir });
  });
  afterAll(async () => {
    await q?.proxy.stop();
  });
  const put = (t: string, allow: unknown) => request(q.base).put('/control/admin/commands').set(auth(t)).send({ allow });

  it('GET: off by default, every known entry with its sentence, the implemented ones, recent commands', async () => {
    const r = await request(q.base).get('/control/admin/commands').set(admin).expect(200);
    expect(r.body).toMatchObject({ enabled: true, paused: false, pauseReason: null, envName: null, allow: [], implemented: ['tokens.apply', 'tokens.apply.admin'], recent: [] });
    expect(r.body.known.map((k: { entry: string }) => k.entry)).toEqual([...ALLOW_ENTRIES]);
    for (const k of r.body.known) expect(k.text.length, k.entry).toBeGreaterThan(10);
    expect((await request(q.base).get('/control/admin/commands').set(auth())).status).toBe(403);
  });
  it('PUT with the local admin token widens; an unknown entry is 400; a managed admin token can only narrow (403 local_admin_only)', async () => {
    expect((await put(ADMIN_TOKEN, ['tokens.apply', 'tokens.apply.admin'])).status).toBe(200);
    expect((await put(ADMIN_TOKEN, ['frobnicate'])).body).toMatchObject({ error: 'invalid' });
    expect((await put(ADMIN_TOKEN, ['camera.action:find-camera'])).status).toBe(400);
    const w = await put(MANAGED_ADMIN, ['tokens.apply', 'tokens.apply.admin', 'config.get']);
    expect([w.status, w.body.error]).toEqual([403, 'local_admin_only']);
    expect((await put(MANAGED_ADMIN, ['tokens.apply'])).status).toBe(200);
    expect((await request(q.base).get('/control/admin/commands').set(admin)).body.allow).toEqual(['tokens.apply']);
    const recs = qRecords('admin-policy');
    expect(recs.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(recs[0])).toContain('token:cams cluster');
    expect(JSON.stringify(recs)).not.toContain(hashOf(MANAGED_ADMIN).slice(7, 23));
  });
  it('pause works with any admin rights; resume only with local ones', async () => {
    await request(q.base).post('/control/admin/commands/pause').set(auth(MANAGED_ADMIN)).send({ reason: 'incident 7' }).expect(200);
    expect((await request(q.base).get('/control/admin/commands').set(admin)).body).toMatchObject({ paused: true, pauseReason: 'incident 7' });
    expect((await request(q.base).post('/control/admin/commands/resume').set(auth(MANAGED_ADMIN))).status).toBe(403);
    await request(q.base).post('/control/admin/commands/resume').set(admin).expect(200);
    expect((await request(q.base).get('/control/admin/commands').set(admin)).body.paused).toBe(false);
  });
  it('tokens: listed without hashes beyond 8 hex; block with any admin, unblock with local rights only; one admin-token record each', async () => {
    const l = await request(q.base).get('/control/admin/tokens').set(admin).expect(200);
    expect(l.body).toMatchObject({ revision: 4, problem: null });
    expect(l.body.items.map((i: { id: string }) => i.id)).toEqual([TOK(1), TOK(2)]);
    expect(JSON.stringify(l.body)).not.toContain(hashOf(MANAGED_CLIENT).slice(15, 31));
    await request(q.base).post(`/control/admin/tokens/${TOK(2)}/block`).set(auth(MANAGED_ADMIN)).expect(200);
    expect((await request(q.base).get('/api/cameras').set(auth(MANAGED_CLIENT))).status).toBe(401);
    expect((await request(q.base).post(`/control/admin/tokens/${TOK(2)}/unblock`).set(auth(MANAGED_ADMIN))).status).toBe(403);
    await request(q.base).post(`/control/admin/tokens/${TOK(2)}/unblock`).set(admin).expect(200);
    expect((await request(q.base).post('/control/admin/tokens/nope/block').set(admin)).status).toBe(400);
    expect(qRecords('admin-token').map((r) => r.cam_proxy?.details?.op ?? r.details?.op ?? JSON.stringify(r).match(/"op":"(\w+)"/)?.[1])).toEqual(['unblock', 'block']);
  });
  it('a managed admin token blocking itself: blocked at once', async () => {
    await request(q.base).post(`/control/admin/tokens/${TOK(1)}/block`).set(auth(MANAGED_ADMIN)).expect(200);
    expect((await request(q.base).get('/control/admin/commands').set(auth(MANAGED_ADMIN))).status).toBe(401);
  });
});
