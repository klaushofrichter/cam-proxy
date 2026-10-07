import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Proxy } from '../src/proxy';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// Issue #199 against cam-sim: its RLC-1224A profile has overwrite 0 (as the
// real camera had until 2026-10-07), so the proxy warns; read-only, every
// few hundred ms here instead of 5 minutes.
let sim: Awaited<ReturnType<typeof startSim>>;
let proxy: Proxy;
let base: string;
const setsBefore = () => sim.sim.engine.counters.setCalls.length;
let sets0 = 0;

type Health = { camera: { sd?: Record<string, unknown> | null }; cameras: { camera: { sd?: unknown } }[]; items: { id: string; problem: boolean; warning?: boolean; text: string; value: unknown }[]; problemCount: number };
const health = async (): Promise<Health> => (await request(base).get('/api/local/health')).body;
const sdItem = (h: Health) => h.items.find((i) => i.id === 'sd');

beforeAll(async () => {
  sim = await startSim();
  ({ proxy, base } = await startProxy(sim, { proxy: { cameraSdCheckMs: 200 } }));
  sets0 = setsBefore();
  await until(async () => (await health()).camera.sd != null);
});

afterAll(async () => {
  await proxy?.stop();
  await sim?.close();
});

describe('the SD card in the health summary (cam-sim)', () => {
  it('camera.sd and cameras[0].camera.sd: the card as GetHddInfo says, overwrite off, recording on', async () => {
    const h = await health();
    const hdd = sim.sim.engine.sd.hddInfo()[0];
    expect(h.camera.sd).toMatchObject({ mounted: true, formatted: true, capacityMB: hdd.capacity, overwrite: false, recordingEnabled: true });
    expect(typeof h.camera.sd!.freeMB).toBe('number');
    expect(h.cameras[0].camera.sd).toEqual(h.camera.sd);
  });
  it('overwrite off: the sd item is a warning, not a problem', async () => {
    const h = await health();
    expect(sdItem(h)).toMatchObject({ value: 'overwrite_off', text: 'Overwrite is off: the camera stops recording to its SD card when it is full', problem: false, warning: true });
  });
  it('the same summary in /control/status', async () => {
    const r = await request(base).get('/control/status').set(auth(ADMIN_TOKEN));
    expect(r.body.health.camera.sd).toMatchObject({ overwrite: false });
  });
  it('metrics: the free bytes, the capacity and the overwrite flag', async () => {
    const text = (await request(base).get('/metrics').set(auth(ADMIN_TOKEN))).text;
    const hdd = sim.sim.engine.sd.hddInfo()[0];
    expect(text).toContain(`camproxy_camera_sd_capacity_bytes{cam="cam1"} ${hdd.capacity * 2 ** 20}`);
    expect(text).toMatch(/camproxy_camera_sd_free_bytes\{cam="cam1"\} \d+/);
    expect(text).toContain('camproxy_camera_sd_overwrite{cam="cam1"} 0');
  });
  it('overwrite switched on at the camera: the warning goes at the next read', async () => {
    const e = sim.sim.engine;
    e.settings.set('SetRecV20', { Rec: { ...e.settings.get('Rec'), overwrite: 1 } }, { strictPartial: false });
    await until(async () => sdItem(await health())?.value === 'ok');
    expect(sdItem(await health())).toMatchObject({ problem: false });
    expect(sdItem(await health())).not.toHaveProperty('warning');
  });
  it('recording switched off at the camera: a problem', async () => {
    const e = sim.sim.engine;
    e.settings.set('SetRecV20', { Rec: { ...e.settings.get('Rec'), enable: 0 } }, { strictPartial: false });
    await until(async () => sdItem(await health())?.value === 'recording_off');
    expect((await health()).problemCount).toBeGreaterThanOrEqual(1);
    e.settings.set('SetRecV20', { Rec: { ...e.settings.get('Rec'), enable: 1 } }, { strictPartial: false });
  });
  it('the newest SD recording is looked up once a clip arrived (the stalled check)', async () => {
    const now = Date.now();
    proxy.catalog.db.prepare('INSERT INTO clip_arrivals (cam, last_received) VALUES (?, ?) ON CONFLICT (cam) DO UPDATE SET last_received = excluded.last_received').run('cam1', now);
    await until(async () => (await health()).camera.sd?.checkedAt as number > now);
    const newest = (await proxy.cameras.first().recordings.list.range(now - 48 * 3600_000, Date.now(), 'main')).reduce<number | null>((m, r) => (m === null || r.end > m ? r.end : m), null);
    const sd = (await health()).camera.sd!;
    expect(sd.lastRecordingAt).toBe(newest);
    expect(sd.stalled).toBe(newest === null || now - newest > 3600_000);
  });
  it('only reads: no Set command reached the camera from the proxy', () => {
    // The two SetRecV20 above are the test's own, straight into the engine (not counted as camera API calls).
    expect(setsBefore()).toBe(sets0);
  });
});
