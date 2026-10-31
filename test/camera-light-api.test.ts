import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FaultSpec } from 'cam-sim';
import { audits, auditText, lastAudit, managedAdminToken } from './helpers/onboarding';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// GET/PUT /api/cameras/:cam/light (spec 2026-10-30-camera-onboarding-design §4.8),
// cams's light routes (test/lightRoutes.test.ts) through the proxy.
async function setup(faults: FaultSpec[] = []) {
  const s = await startSim({ faults });
  const dir = mkdtempSync(join(tmpdir(), 'calls-light-'));
  const managed = managedAdminToken(dir);
  const p = await startProxy(s, { dir });
  await until(() => p.proxy.cameras.get('cam1')!.status.state().online, 10_000);
  return { s, p, managed, close: async () => (await p.proxy.stop(), await s.close()) };
}

let x: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  x = await setup();
}, 30_000);
afterAll(async () => x?.close());

const wl = () => (x.s.sim.engine.settings.running as Record<string, any>).WhiteLed;
const setCalls = () => x.s.sim.engine.counters.setCalls as string[];
const get = (base = x.p.base) => request(base).get('/api/cameras/cam1/light').set(auth());
const put = (body: unknown, t = ADMIN_TOKEN, base = x.p.base) => request(base).put('/api/cameras/cam1/light').set(auth(t)).send(body as object);

// Measured on cam1 2026-09-30: GetWhiteLed reports the new state about 1 s
// (on) or 3 s (off) after the switch (cams's lightRoutes test emulates it the same way).
function reportLate(sim: typeof x.s.sim, ms: { on: number; off: number }) {
  const store = sim.engine.settings;
  const set = store.set.bind(store);
  store.set = ((cmd: string, param: unknown, opts: unknown) => {
    const was = store.running.WhiteLed.state;
    const r = (set as (...a: unknown[]) => unknown)(cmd, param, opts);
    const now = store.running.WhiteLed.state;
    if (cmd === 'SetWhiteLed' && r === null && now !== was) {
      store.running.WhiteLed.state = was;
      setTimeout(() => (store.running.WhiteLed.state = now), now === 1 ? ms.on : ms.off);
    }
    return r;
  }) as typeof store.set;
}

describe('the camera light for clients', () => {
  it('reads the light as off with a client token', async () => {
    expect((await get().expect(200)).body).toEqual({ on: false });
  });

  it('switches the light on and off, writing the whole WhiteLed object, and audits it', async () => {
    const before = JSON.parse(JSON.stringify(wl()));
    const on = await put({ on: true });
    expect([on.status, on.body]).toEqual([200, { on: true }]);
    expect(wl()).toEqual({ ...before, state: 1 });
    expect((await get()).body).toEqual({ on: true });
    expect(lastAudit(x.p.dir, 'camera-light')).toMatchObject({ event: { category: ['configuration'], type: ['change'], outcome: 'success' }, user: { name: 'admin' }, cam_proxy: { from: false, to: true, requestedBy: 'token' } });
    const off = await put({ on: false }, x.managed);
    expect([off.status, off.body]).toEqual([200, { on: false }]);
    expect(wl()).toEqual(before);
    expect(lastAudit(x.p.dir, 'camera-light')).toMatchObject({ user: { name: 'token:cams' }, cam_proxy: { from: true, to: false } });
    expect(auditText(x.p.dir)).not.toContain(x.s.password);
  });

  it('does not write when the light is already as asked (audited as a no-op)', async () => {
    const n = setCalls().length;
    const a = audits(x.p.dir, 'camera-light').length;
    const r = await put({ on: false });
    expect([r.status, r.body]).toEqual([200, { on: false }]);
    expect(setCalls().length).toBe(n);
    expect(audits(x.p.dir, 'camera-light').length).toBe(a + 1);
    expect(lastAudit(x.p.dir, 'camera-light')).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { changed: false, sent: false } });
  });

  it('logs out after a write', async () => {
    const spy = vi.spyOn(x.p.proxy.cameras.get('cam1')!.client, 'logout');
    try {
      expect((await put({ on: true })).status).toBe(200);
      expect((await put({ on: false })).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('a client token on PUT is 403 admin_only', async () => {
    const n = setCalls().length;
    const r = await put({ on: true }, CLIENT_TOKEN);
    expect([r.status, r.body.error]).toEqual([403, 'admin_only']);
    expect(setCalls().length).toBe(n);
  });

  it.each([[{ on: 'yes' }], [{ on: true, x: 1 }], [{}], [[true]]])('answers 400 invalid to %j before calling the camera', async (body) => {
    const n = setCalls().length;
    const r = await put(body);
    expect([r.status, r.body.error]).toEqual([400, 'invalid']);
    expect(setCalls().length).toBe(n);
  });

  it('waits for the camera to report the new state', async () => {
    reportLate(x.s.sim, { on: 1000, off: 3000 });
    const n = setCalls().length;
    expect((await put({ on: true })).body).toEqual({ on: true });
    expect((await put({ on: false })).body).toEqual({ on: false });
    expect(setCalls().slice(n)).toEqual(['SetWhiteLed', 'SetWhiteLed']);
  }, 15_000);

  it('an unknown camera is 404', async () => {
    expect((await request(x.p.base).get('/api/cameras/nope/light').set(auth())).status).toBe(404);
  });
});

describe('a camera that does not switch', () => {
  it('reports a write the camera ignored as 502 not_applied after 5 s, audited as a failure', async () => {
    const y = await setup([{ name: 'settings.ignore', cmds: ['SetWhiteLed'] }]);
    try {
      const t0 = Date.now();
      const r = await put({ on: true }, ADMIN_TOKEN, y.p.base);
      expect([r.status, r.body]).toEqual([502, { error: 'not_applied', on: false }]);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(4500);
      expect(Date.now() - t0).toBeLessThan(8000);
      expect(lastAudit(y.p.dir, 'camera-light')).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'not_applied' }, cam_proxy: { from: false, to: true } });
    } finally {
      await y.close();
    }
  }, 30_000);

  it('reports a refused write as 502 camera_error', async () => {
    const y = await setup([{ name: 'settings.fail', cmds: ['SetWhiteLed'] }]);
    try {
      const r = await put({ on: true }, ADMIN_TOKEN, y.p.base);
      expect([r.status, r.body]).toEqual([502, { error: 'camera_error' }]);
    } finally {
      await y.close();
    }
  }, 30_000);

  it('maps an offline camera to 503', async () => {
    const y = await setup();
    try {
      await y.s.close();
      const w = y.p.proxy.cameras.get('cam1')!;
      await w.status.checkNow();
      await w.status.checkNow();
      expect((await get(y.p.base)).status).toBe(503);
      const r = await put({ on: true }, ADMIN_TOKEN, y.p.base);
      expect([r.status, r.body.error]).toEqual([503, 'camera_offline']);
    } finally {
      await y.p.proxy.stop();
    }
  }, 30_000);
});
