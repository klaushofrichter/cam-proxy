import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import type { PtzView } from 'cam-sim';
import { writePrivateJson } from '../src/fleet/private-file';
import { ReolinkClient } from '../src/camera/client';
import { listPositions } from '../src/catalog/ptz-positions';
import { E1_MODEL, startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { sseConnect } from './helpers/sse';

// The whole chain against cam-sim's E1 Outdoor Pro (spec
// 2026-10-30-ptz-capabilities-design §8.3), and a fixed camera beside it.
const MANAGED_CLIENT = randomBytes(32).toString('base64url');
const hashOf = (t: string) => `sha256:${createHash('sha256').update(t).digest('hex')}`;

let e1: Awaited<ReturnType<typeof startSim>>;
let fixed: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let pf: Awaited<ReturnType<typeof startProxy>>;
const view = (): PtzView => e1.sim.engine.ptz!.view();
const ptz = (path: string) => `/api/cameras/cam1/ptz${path}`;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  e1 = await startSim({ model: E1_MODEL });
  fixed = await startSim();
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-ptzint-'));
  writePrivateJson(join(dir, 'data', 'admin', 'tokens.json'), { v: 1, revision: 1, blocked: [], tokens: [{ id: `tok_${'1'.padStart(20, '0')}`, kind: 'client', hash: hashOf(MANAGED_CLIENT), label: 'cams client', retireAt: null }] });
  p = await startProxy(e1, { dir });
  pf = await startProxy(fixed);
  for (const x of [p, pf]) await until(async () => (await request(x.base).get('/api/cameras/cam1').set(auth())).body.capabilities != null, 15_000);
}, 60_000);
afterAll(async () => {
  await p.proxy.stop();
  await pf.proxy.stop();
  await e1.close();
  await fixed.close();
});

describe('PTZ against cam-sim E1-Outdoor-Pro', () => {
  it('GET /api/cameras/cam1 has the E1 capabilities; the fixed camera has none', async () => {
    const r = await request(p.base).get('/api/cameras/cam1').set(auth());
    expect(r.body.capabilities).toEqual({ schema: 1, ptz: { move: true, zoom: true, focus: true, speed: true, positions: { max: 20 } } });
    expect(r.body.features).toContain('ptz');
    const f = await request(pf.base).get('/api/cameras/cam1').set(auth());
    expect(f.body.capabilities).toEqual({ schema: 1, ptz: null });
    const m = await request(pf.base).post(ptz('/move')).set(auth()).send({ direction: 'left' });
    expect([m.status, m.body]).toEqual([404, { error: 'not_supported' }]);
  });

  it('a move turns the camera and stops by itself', async () => {
    const pan = view().pan;
    expect((await request(p.base).post(ptz('/move')).set(auth()).send({ direction: 'right', durationMs: 300 })).status).toBe(204);
    expect(view().moving).not.toBeNull();
    await until(() => view().moving === null, 1500);
    expect(view().pan).not.toBe(pan);
  });

  it('hold: moves every 250 ms keep it turning; stop ends it at once', async () => {
    for (let i = 0; i < 4; i++) {
      expect((await request(p.base).post(ptz('/move')).set(auth()).send({ direction: 'up', durationMs: 600 })).status).toBe(204);
      expect(view().moving).not.toBeNull();
      await settle(250);
    }
    expect(view().moving).not.toBeNull();
    expect((await request(p.base).post(ptz('/stop')).set(auth())).status).toBe(204);
    expect(view().moving).toBeNull();
  });

  it('zoom in changes the zoom', async () => {
    const z = view().zoom;
    expect((await request(p.base).post(ptz('/zoom')).set(auth()).send({ direction: 'in', durationMs: 600 })).status).toBe(204);
    await until(() => view().moving === null, 1500);
    expect(view().zoom).toBeGreaterThan(z);
  });

  it('a preset the camera refuses or ignores → 502 camera_error, no position stored', async () => {
    for (const name of ['settings.fail', 'settings.ignore'] as const) {
      e1.sim.engine.faults.set({ name, cmds: ['SetPtzPreset'] });
      const r = await request(p.base).post(ptz('/positions')).set(auth()).send({ name: 'Refused' });
      e1.sim.engine.faults.clear(name);
      expect([name, r.status, r.body]).toEqual([name, 502, { error: 'camera_error' }]);
      expect(listPositions(p.proxy.catalog, 'cam1')).toEqual([]);
    }
  });

  it('save, move away, go back', async () => {
    const s = await request(p.base).post(ptz('/positions')).set(auth()).send({ name: 'Gate' });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ name: 'Gate', home: true, state: 'ok' });
    const saved = view().presets.find((x) => x.name === 'Gate')!;
    expect(saved).toBeDefined();
    await request(p.base).post(ptz('/move')).set(auth()).send({ direction: 'left', durationMs: 500 });
    await until(() => view().moving === null, 1500);
    expect(view().pan).not.toBe(saved.pan);
    expect((await request(p.base).post(ptz(`/positions/${s.body.id}/go`)).set(auth())).status).toBe(204);
    await until(() => view().moving === null && view().pan === saved.pan, 5000);
    expect([view().pan, view().tilt, view().zoom]).toEqual([saved.pan, saved.tilt, saved.zoom]);
    expect((await request(p.base).delete(ptz(`/positions/${s.body.id}`)).set(auth())).status).toBe(204);
  });

  it('a foreign preset is never touched', async () => {
    const admin = new ReolinkClient({ id: 'x', host: e1.camera.host, protocol: 'http', user: 'admin', password: 'admin-pw' });
    await admin.command('SetPtzPreset', { PtzPreset: { channel: 0, enable: 1, id: 0, name: 'Garden' } });
    await admin.logout();
    const s = await request(p.base).post(ptz('/positions')).set(auth()).send({ name: 'Tree' });
    expect(s.status).toBe(201);
    expect(view().presets).toEqual(expect.arrayContaining([expect.objectContaining({ id: 0, name: 'Garden' }), expect.objectContaining({ id: 1, name: 'Tree' })]));
    expect((await request(p.base).delete(ptz(`/positions/${s.body.id}`)).set(auth())).status).toBe(204);
    expect(view().presets.map((x) => [x.id, x.name])).toEqual([[0, 'Garden']]);
  });

  it('a reset camera shows missing; go → 409 position_missing; save again → ok', async () => {
    const s = await request(p.base).post(ptz('/positions')).set(auth()).send({ name: 'Door' });
    expect(s.status).toBe(201);
    e1.sim.engine.reset({ ptz: true });
    expect((await request(p.base).post('/control/cameras/cam1/actions/restart').set(auth(ADMIN_TOKEN))).status).toBeLessThan(300);
    await until(async () => (await request(p.base).get('/api/cameras/cam1').set(auth())).body.online === true, 15_000);
    const l = await request(p.base).get(ptz('/positions')).set(auth());
    expect(l.body.positions.map((x: { state: string }) => x.state)).toEqual(['missing']);
    const g = await request(p.base).post(ptz(`/positions/${s.body.id}/go`)).set(auth());
    expect([g.status, g.body]).toEqual([409, { error: 'position_missing' }]);
    const r = await request(p.base).post(ptz(`/positions/${s.body.id}/save`)).set(auth());
    expect([r.status, r.body.state]).toEqual([200, 'ok']);
    expect((await request(p.base).delete(ptz(`/positions/${s.body.id}`)).set(auth())).status).toBe(204);
  }, 30_000);

  it('the stream sends ptz-positions on save', async () => {
    const sse = sseConnect(`${p.base}/api/stream?types=ptz-positions`, auth());
    try {
      await until(() => sse.status() === 200);
      const s = await request(p.base).post(ptz('/positions')).set(auth()).send({ name: 'Stream' });
      expect(s.status).toBe(201);
      await sse.until(() => sse.events.length >= 1);
      expect(sse.events[0]).toMatchObject({ event: 'ptz-positions', data: { cam: 'cam1' } });
      await request(p.base).delete(ptz(`/positions/${s.body.id}`)).set(auth());
    } finally {
      sse.close();
    }
  });

  it('a managed client token may move', async () => {
    expect((await request(p.base).post(ptz('/move')).set(auth(MANAGED_CLIENT)).send({ direction: 'down', durationMs: 100 })).status).toBe(204);
    await until(() => view().moving === null, 1500);
  });
});
