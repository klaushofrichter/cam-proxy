// The camera restarts after a SetEnc that changed its streams (RLC-1224A,
// CX820 and E1 Outdoor Pro, measured 2026-11-02: offline, back after 40–75 s
// with the change applied, 11 of 11). The encoding PUT waits for it and
// answers the re-read (it answered 502 camera_error before), or 504
// camera_restarting when it is not back in time; the status's streams follow
// the camera after any restart. cam-sim restarts the same way (encRestartMs).
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FaultSpec } from 'cam-sim';
import { ENC_RESTART } from '../src/api/camera-calls-api';
import { lastAudit } from './helpers/onboarding';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { E1_MODEL, startSim } from './helpers/sim';

const STRICT: FaultSpec = { name: 'settings.strictPartial' };
const DEFAULTS = { ...ENC_RESTART };

async function setup(encRestartMs: number) {
  const s = await startSim({ model: E1_MODEL, faults: [STRICT], encRestartMs });
  const dir = mkdtempSync(join(tmpdir(), 'enc-restart-'));
  const p = await startProxy(s, { dir, settings: { stills: { enabled: false } } });
  await until(() => p.proxy.cameras.get('cam1')!.status.state().online, 10_000);
  return { s, p, close: async () => (await p.proxy.stop(), await s.close()) };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const put = (x: Setup, body: object) => request(x.p.base).put('/api/cameras/cam1/settings/encoding').set(auth(ADMIN_TOKEN)).send(body);
const mainOf = async (x: Setup) => (await request(x.p.base).get('/api/cameras/cam1/status').set(auth())).body.streams?.main ?? null;

afterEach(() => Object.assign(ENC_RESTART, DEFAULTS));

describe('a camera that restarts after SetEnc', () => {
  let x: Setup;
  beforeAll(async () => {
    x = await setup(3_000);
  }, 30_000);
  afterAll(async () => x?.close());

  it('PUT waits for it and answers 200 with the re-read; the audit says it restarted and how long it took', async () => {
    Object.assign(ENC_RESTART, { pollMs: 250 });
    const r = await put(x, { main: { width: 2560, height: 1440, fps: 25, bitRate: 3072 } });
    expect(r.status).toBe(200);
    expect(r.body.fields).toEqual({ main: { ok: true } });
    expect(r.body.settings.main).toMatchObject({ width: 2560, height: 1440, fps: 25 });
    expect(r.body.restarted.ms).toBeGreaterThanOrEqual(2_000);
    expect(x.s.sim.engine.counters.reboots).toBe(1);
    const a = lastAudit(x.p.dir, 'camera-settings')!;
    expect(a).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { section: 'encoding', fields: { main: 'ok' }, sent: true, restarted: { ms: r.body.restarted.ms } } });
    expect(a.message).toMatch(/the camera restarted, back after \d+ s/);
  }, 30_000);

  it('the status shows the new main size', async () => {
    await until(async () => (await mainOf(x))?.width === 2560, 15_000);
    expect(await mainOf(x)).toEqual({ codec: 'h265', width: 2560, height: 1440, fps: 25 });
  }, 20_000);
});

describe('a camera that is not back in time', () => {
  let x: Setup;
  beforeAll(async () => {
    x = await setup(6_000);
  }, 30_000);
  afterAll(async () => x?.close());

  it('answers 504 camera_restarting (sent: true), audited as unknown, not as a failure; the camera reports camera_restarting meanwhile', async () => {
    Object.assign(ENC_RESTART, { maxMs: 1_500, pollMs: 250 });
    const w = x.p.proxy.cameras.get('cam1')!;
    const r = await put(x, { main: { width: 2304, height: 1296, fps: 15, bitRate: 2560 } });
    expect(r.status).toBe(504);
    expect(r.body).toMatchObject({ error: 'camera_restarting', sent: true });
    expect(r.body.detail).toMatch(/sent and the camera is restarting/);
    const a = lastAudit(x.p.dir, 'camera-settings')!;
    expect(a).toMatchObject({ event: { outcome: 'unknown' }, error: { message: 'camera_restarting' }, cam_proxy: { section: 'encoding', sent: true } });
    // The poller finds it offline (two missed checks): that is the restart, not a failure.
    await w.status.checkNow();
    await w.status.checkNow();
    expect(w.status.state()).toMatchObject({ online: false, error: 'camera_offline' });
    expect(w.error()).toBe('camera_restarting');
  }, 30_000);

  it('once it is back, the status shows the new main size (the cache was dropped on the 504 path)', async () => {
    const w = x.p.proxy.cameras.get('cam1')!;
    await until(() => w.status.state().online, 20_000);
    expect(w.error()).toBeNull();
    await until(async () => (await mainOf(x))?.width === 2304, 15_000);
  }, 40_000);
});

describe('any camera restart', () => {
  let x: Setup;
  beforeAll(async () => {
    x = await setup(0);
  }, 30_000);
  afterAll(async () => x?.close());

  it('the status streams follow a camera that restarted with other streams (not through the API)', async () => {
    expect(await mainOf(x)).toMatchObject({ width: 3840, height: 2160 });
    const e = x.s.sim.engine;
    // Changed on the camera itself (its web UI, say), then a restart.
    for (const s of [e.settings.saved, e.settings.running]) Object.assign(s.Enc.mainStream, { size: '2304*1296', width: 2304, height: 1296, frameRate: 15, bitRate: 2560 });
    expect(await mainOf(x)).toMatchObject({ width: 3840 }); // cached (10 min)
    await e.reboot({ ms: 7_000 });
    await until(async () => (await mainOf(x))?.width === 2304, 20_000);
  }, 45_000);
});
