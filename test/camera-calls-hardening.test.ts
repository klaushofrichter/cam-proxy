import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CameraError } from '../src/camera/client';
import { audits, auditText } from './helpers/onboarding';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// Final review of the camera calls (spec 2026-10-30-camera-onboarding-design §4.8):
// every change call leaves an audit trace, refusals included; reads share the
// camera (cache, one in flight) and are time-bounded.
let s: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  s = await startSim();
  const dir = mkdtempSync(join(tmpdir(), 'calls-hard-'));
  p = await startProxy(s, { dir });
  await until(() => p.proxy.cameras.get('cam1')!.status.state().online, 10_000);
}, 30_000);
afterAll(async () => {
  await p?.proxy.stop();
  await s?.close();
});
afterEach(() => vi.restoreAllMocks());

const w = () => p.proxy.cameras.get('cam1')!;
const putLight = (body: unknown) => request(p.base).put('/api/cameras/cam1/light').set(auth(ADMIN_TOKEN)).send(body as object);
const putSettings = (section: string, body: unknown) => request(p.base).put(`/api/cameras/cam1/settings/${section}`).set(auth(ADMIN_TOKEN)).send(body as object);
const last = (action: string) => audits(p.dir, action).at(-1)!;
const offlineFor = () => vi.spyOn(w().status, 'state').mockReturnValue({ online: false, since: 0, error: 'camera_offline' });

describe('the light: every PUT is audited', () => {
  it('a 400 invalid body', async () => {
    expect((await putLight({ on: 'yes' })).status).toBe(400);
    expect(last('camera-light')).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'invalid' }, cam_proxy: { requestedBy: 'token' } });
  });

  it('a 503 offline refusal', async () => {
    offlineFor();
    expect((await putLight({ on: true })).status).toBe(503);
    expect(last('camera-light')).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'camera_offline' }, cam_proxy: { to: true, sent: false } });
  });

  it('the no-op: already in that state', async () => {
    const n = audits(p.dir, 'camera-light').length;
    expect((await putLight({ on: false })).body).toEqual({ on: false });
    expect(audits(p.dir, 'camera-light')).toHaveLength(n + 1);
    expect(last('camera-light')).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { from: false, to: false, changed: false, sent: false } });
  });

  it('a camera failure after SetWhiteLed was sent: failure, the state unknown', async () => {
    const c = w().client;
    const real = c.command.bind(c);
    let reads = 0;
    vi.spyOn(c, 'command').mockImplementation((async (cmd: string, param?: object) => {
      if (cmd === 'GetWhiteLed' && ++reads > 1) throw new CameraError('camera_offline', 'dropped', true);
      return real(cmd, param);
    }) as typeof c.command);
    const r = await putLight({ on: true });
    expect([r.status, r.body.error]).toEqual([503, 'camera_offline']);
    expect(last('camera-light')).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'camera_offline' }, cam_proxy: { to: true, sent: true } });
    expect(last('camera-light').message).toMatch(/sent.*unknown/);
    vi.restoreAllMocks();
    expect((await putLight({ on: false })).status).toBe(200);
  });
});

describe('settings PUT: refusals are audited too', () => {
  it('400 invalid: the section and the field names, never the values', async () => {
    expect((await putSettings('image', { dayNight: 'Purple', extra: 'value-xyz' })).status).toBe(400);
    const a = last('camera-settings');
    expect(a).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'invalid' }, cam_proxy: { section: 'image', fieldNames: ['dayNight', 'extra'] } });
    expect(JSON.stringify(a)).not.toContain('value-xyz');
  });

  it('404 unknown section', async () => {
    expect((await putSettings('encoding', { x: 1 })).status).toBe(404);
    expect(last('camera-settings')).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'not_found' }, cam_proxy: { section: 'encoding' } });
  });

  it('503 offline', async () => {
    offlineFor();
    expect((await putSettings('image', { dayNight: 'color' })).status).toBe(503);
    expect(last('camera-settings')).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'camera_offline' }, cam_proxy: { section: 'image', fieldNames: ['dayNight'] } });
    expect(auditText(p.dir)).not.toContain(s.password);
  });
});

describe('reads share the camera', () => {
  it('settings GETs within 5 s answer from one read', async () => {
    const spy = vi.spyOn(w().client, 'command');
    const rs = await Promise.all(Array.from({ length: 5 }, () => request(p.base).get('/api/cameras/cam1/settings/image').set(auth())));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    await request(p.base).get('/api/cameras/cam1/settings').set(auth()).expect(200);
    expect(spy.mock.calls.filter(([c]) => c === 'GetIsp')).toHaveLength(1);
  });

  it('a settings write drops the cached read', async () => {
    await request(p.base).get('/api/cameras/cam1/settings/image').set(auth()).expect(200);
    const was = (await request(p.base).get('/api/cameras/cam1/settings/image').set(auth())).body.dayNight;
    const next = was === 'color' ? 'auto' : 'color';
    expect((await putSettings('image', { dayNight: next })).status).toBe(200);
    expect((await request(p.base).get('/api/cameras/cam1/settings/image').set(auth())).body.dayNight).toBe(next);
  });

  it('light GETs share one read', async () => {
    const spy = vi.spyOn(w().client, 'command');
    await Promise.all(Array.from({ length: 5 }, () => request(p.base).get('/api/cameras/cam1/light').set(auth()).expect(200)));
    expect(spy.mock.calls.filter(([c]) => c === 'GetWhiteLed').length).toBeLessThanOrEqual(1);
  });

  it('main snapshots: one in flight per camera, shared', async () => {
    const c = w().client;
    const real = c.snapshot.bind(c);
    let active = 0, most = 0;
    const spy = vi.spyOn(c, 'snapshot').mockImplementation(async () => {
      most = Math.max(most, ++active);
      try {
        await new Promise((r) => setTimeout(r, 300));
        return await real();
      } finally {
        active--;
      }
    });
    const rs = await Promise.all(Array.from({ length: 5 }, () => request(p.base).get('/api/cameras/cam1/snapshot.jpg').set(auth())));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(most).toBe(1);
    expect(spy.mock.calls.length).toBeLessThan(5);
  });
});

describe('reads are time-bounded', () => {
  it('a light or settings read the camera does not answer within 5 s is 504 camera_timeout', async () => {
    // A camera-changing call drops the camera's cached reads (here a no-op light switch).
    expect((await putLight({ on: false })).status).toBe(200);
    const c = w().client;
    const real = c.command.bind(c);
    vi.spyOn(c, 'command').mockImplementation(((cmd: string, param?: object) => (cmd === 'GetWhiteLed' || cmd === 'GetRecV20' ? new Promise(() => undefined) : real(cmd, param))) as typeof c.command);
    const [l, d] = await Promise.all([request(p.base).get('/api/cameras/cam1/light').set(auth()), request(p.base).get('/api/cameras/cam1/settings/detection').set(auth())]);
    expect([l.status, l.body.error]).toEqual([504, 'camera_timeout']);
    expect([d.status, d.body.error]).toEqual([504, 'camera_timeout']);
  }, 20_000);
});
