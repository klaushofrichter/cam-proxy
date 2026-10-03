import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import type { Check } from '../src/inventory/runner';
import { minuteOf, minutePath } from '../src/stills/store';

const AUDIT_TOKEN = 'audit-token-'.padEnd(40, 'z');
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim, { env: { CAMPROXY_AUDIT_TOKEN: AUDIT_TOKEN } });
});
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});
const admin = () => auth(ADMIN_TOKEN);
const lines = (text: string) => text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const report = async (id: string) => (await request(p.base).get(`/control/inventory/runs/${id}`).set(admin())).body;
const finished = (id: string) => until(async () => (await report(id)).outcome !== 'running');

describe('inventory API', () => {
  it('starts a stills inventory (202), then serves the report and the list', async () => {
    const r = await request(p.base).post('/control/actions/inventory').set(admin()).send({ kind: 'stills' });
    expect(r.status).toBe(202);
    expect(r.body.runId).toMatch(/^stills-\d{1,15}-[0-9a-f]{6}$/);
    await finished(r.body.runId);
    const rep = await report(r.body.runId);
    expect(rep).toMatchObject({ runId: r.body.runId, kind: 'stills', camera: 'cam1', outcome: 'ok', requestedBy: 'token' });
    expect(rep.counts).toHaveProperty('missingSeconds');
    const list = await request(p.base).get('/control/inventory').set(admin());
    expect(list.status).toBe(200);
    expect(list.body.running).toBeNull();
    expect(list.body.runs.stills[0]).toMatchObject({ runId: r.body.runId, outcome: 'ok' });
    expect(list.body.runs.stills[0]).not.toHaveProperty('items');
  });

  it('writes one inventory record per run, and no control-action for the start', async () => {
    const r = await request(p.base).post('/control/actions/inventory').set(admin()).send({ kind: 'stills' });
    await finished(r.body.runId);
    const recs = lines((await request(p.base).get('/control/audit?action=inventory,control-action').set(admin())).text);
    const mine = recs.filter((x) => x.cam_proxy?.runId === r.body.runId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ event: { action: 'inventory', category: ['host'], type: ['info'], outcome: 'success' }, user: { name: 'admin' }, cam_proxy: { kind: 'stills', outcome: 'ok' } });
    expect(recs.some((x) => x.event.action === 'control-action' && x.cam_proxy?.action === 'inventory')).toBe(false);
  });

  // #106 review (task 3): the generic session and config paths, for these routes.
  it('a session needs X-CamProxy-UI to start, repair or cancel; refused, nothing starts', async () => {
    const login = await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const before = (await request(p.base).get('/control/inventory').set(admin())).body.runs.stills.length;
    for (const [path, body] of [['inventory', { kind: 'stills' }], ['inventory-repair', { kind: 'clips', runId: 'clips-1-abcdef' }], ['inventory-cancel', {}]] as const) {
      const no = await request(p.base).post(`/control/actions/${path}`).set('Cookie', cookie).send(body);
      expect([path, no.status, no.body]).toEqual([path, 403, { error: 'csrf' }]);
    }
    const list = (await request(p.base).get('/control/inventory').set(admin())).body;
    expect(list.running).toBeNull();
    expect(list.runs.stills).toHaveLength(before);
    const ok = await request(p.base).post('/control/actions/inventory').set('Cookie', cookie).set('X-CamProxy-UI', '1').send({ kind: 'stills' });
    expect(ok.status).toBe(202);
    await finished(ok.body.runId);
    expect(await report(ok.body.runId)).toMatchObject({ outcome: 'ok', requestedBy: 'session' });
  });

  it('a settings change applies to the next run', async () => {
    const put = await request(p.base).put('/control/config').set(admin()).send({ retention: { stillsDays: 3 } });
    expect(put.status).toBe(200);
    try {
      const r = await request(p.base).post('/control/actions/inventory').set(admin()).send({ kind: 'stills' });
      await finished(r.body.runId);
      const rep = await report(r.body.runId);
      expect(rep.counts.stillsDays).toBe(3);
      expect(rep.window.retentionFrom).toBe(Math.floor((rep.startedAt - 3 * 86_400_000) / 86_400_000) * 86_400_000);
    } finally {
      expect((await request(p.base).delete('/control/config/retention.stillsDays').set(admin())).status).toBe(200);
    }
  });

  it('refuses an unknown or missing kind with 400', async () => {
    for (const body of [{ kind: 'nope' }, {}]) {
      const r = await request(p.base).post('/control/actions/inventory').set(admin()).send(body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'invalid', detail: 'kind is one of: stills, clips, events' });
    }
  });

  it('one at a time: 409 inventory_busy while one runs; cancel ends it with its partial counts', async () => {
    const inv = p.proxy.inventory;
    const real = inv.checks.stills;
    const blocking: Check = (ctx) =>
      new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ window: { from: null, to: 0, reason: 'empty' }, counts: { missingSeconds: 3 }, top: [], items: [], message: 'partial' })));
    inv.checks.stills = { label: 'Stills', run: blocking };
    try {
      const a = await request(p.base).post('/control/actions/inventory').set(admin()).send({ kind: 'stills' });
      expect(a.status).toBe(202);
      const b = await request(p.base).post('/control/actions/inventory').set(admin()).send({ kind: 'stills' });
      expect(b.status).toBe(409);
      expect(b.body).toMatchObject({ error: 'inventory_busy', runId: a.body.runId });
      expect((await request(p.base).get('/control/inventory').set(admin())).body.running).toMatchObject({ runId: a.body.runId, outcome: 'running' });
      const c = await request(p.base).post('/control/actions/inventory-cancel').set(admin());
      expect(c.status).toBe(200);
      expect(c.body).toEqual({ cancelled: true, runId: a.body.runId });
      await finished(a.body.runId);
      expect(await report(a.body.runId)).toMatchObject({ outcome: 'cancelled', cancelledBy: 'request', counts: { missingSeconds: 3 } });
    } finally {
      inv.checks.stills = real;
    }
    expect((await request(p.base).post('/control/actions/inventory-cancel').set(admin())).body).toEqual({ cancelled: false, runId: null });
  });

  it('answers 400 for a path-like run id and 404 for an unknown one', async () => {
    const bad = await request(p.base).get('/control/inventory/runs/..%2F..%2Fcatalog.sqlite').set(admin());
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid', detail: 'not a run id' });
    const none = await request(p.base).get('/control/inventory/runs/stills-1-abcdef').set(admin());
    expect(none.status).toBe(404);
    expect(none.body).toEqual({ error: 'not_found' });
  });

  it('is admin only: the client and the audit token get 403', async () => {
    for (const t of [CLIENT_TOKEN, AUDIT_TOKEN]) {
      expect((await request(p.base).get('/control/inventory').set(auth(t))).status).toBe(403);
      expect((await request(p.base).post('/control/actions/inventory').set(auth(t)).send({ kind: 'stills' })).status).toBe(403);
      expect((await request(p.base).post('/control/actions/inventory-repair').set(auth(t)).send({ kind: 'clips', runId: 'clips-1-abcdef' })).status).toBe(403);
    }
  });

  it('answers 503 stopping once the proxy is stopping', async () => {
    const own = await startProxy(sim);
    try {
      await own.proxy.inventory.stop();
      const r = await request(own.base).post('/control/actions/inventory').set(admin()).send({ kind: 'stills' });
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ error: 'stopping' });
    } finally {
      await own.proxy.stop();
    }
  });

  it('empties the repair\'s temp folder at startup, a directory in it too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-tmpclean-'));
    const tmp = join(dir, 'data', 'inventory', 'tmp');
    mkdirSync(join(tmp, 'sub'), { recursive: true });
    writeFileSync(join(tmp, 'sub', 'inner.part'), 'x');
    writeFileSync(join(tmp, 'left.part'), 'x');
    const own = await startProxy(sim, { dir });
    try {
      expect(existsSync(join(tmp, 'sub'))).toBe(false);
      expect(existsSync(join(tmp, 'left.part'))).toBe(false);
      expect(existsSync(tmp)).toBe(true);
    } finally {
      await own.proxy.stop();
    }
  });

  it('a stop mid-run cancels it as "stop"; its report and record are written before the catalog closes', async () => {
    const own = await startProxy(sim);
    const dataDir = join(own.dir, 'data');
    // A pack three minutes ago: the real check then reads the catalog (the clips) for its day.
    const m = minuteOf(Date.now()) - 3 * 60_000;
    const json = Buffer.from(JSON.stringify({ v: 1, minute: m, intervalS: 1, size: '64x36', quality: 5, slots: Array.from({ length: 60 }, (_, i) => [i * 10, 10]) }));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(json.length, 0);
    const pack = `${minutePath(dataDir, 'stills', 'cam1', m)}.pack`;
    mkdirSync(dirname(pack), { recursive: true });
    writeFileSync(pack, Buffer.concat([Buffer.alloc(600, 1), json, len, Buffer.from('CPK1')]));
    const real = own.proxy.inventory.checks.stills!;
    // Waits for the cancel, then a moment more, then runs the real check to its end: a closed catalog would fail it.
    const late: Check = (ctx) =>
      new Promise((resolve, reject) =>
        ctx.signal.addEventListener('abort', () => setTimeout(() => real.run({ ...ctx, signal: new AbortController().signal }).then(resolve, reject), 300)),
      );
    own.proxy.inventory.checks.stills = { label: 'Stills', run: late };
    const a = await request(own.base).post('/control/actions/inventory').set(admin()).send({ kind: 'stills' });
    expect(a.status).toBe(202);
    await own.proxy.stop();
    const rep = JSON.parse(readFileSync(join(dataDir, 'inventory', 'stills', `${a.body.runId}.json`), 'utf8'));
    expect(rep).toMatchObject({ runId: a.body.runId, outcome: 'cancelled', cancelledBy: 'stop' });
    expect(rep.message).toMatch(/^Stills inventory cancelled \(partial\): .* missing/);
    expect(rep.counts.packs).toBe(1);
    const recs = own.proxy.audit.list({ actions: ['inventory'] }).records;
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ event: { outcome: 'unknown' }, cam_proxy: { runId: a.body.runId, outcome: 'cancelled', cancelledBy: 'stop' } });
  });
});
