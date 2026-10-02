import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';
import type { Check } from '../src/inventory/runner';

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

  it('refuses an unknown or missing kind with 400', async () => {
    for (const body of [{ kind: 'nope' }, {}]) {
      const r = await request(p.base).post('/control/actions/inventory').set(admin()).send(body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'invalid', detail: 'kind is one of: stills' });
    }
  });

  it('one at a time: 409 inventory_busy while one runs; cancel ends it with its partial counts', async () => {
    const inv = p.proxy.inventory;
    const real = inv.checks.stills;
    const blocking: Check = (ctx) =>
      new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ window: { from: null, to: 0, reason: 'empty' }, counts: { missingSeconds: 3 }, top: [], items: [], message: 'partial' })));
    inv.checks.stills = blocking;
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
});
