import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FaultSpec } from 'cam-sim';
import { auditText, lastAudit, managedAdminToken } from './helpers/onboarding';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// GET/PUT /api/cameras/:cam/settings(/:section) (spec 2026-10-30-camera-onboarding-design §4.8):
// cams's settings model, whole-object writes, re-read, audited.
const AUDIT_TOKEN = 'audit-token-'.padEnd(40, 'z');
// A partial write's resets show at once (cams's sim helper does the same).
const STRICT: FaultSpec = { name: 'settings.strictPartial' };

async function setup(faults: FaultSpec[] = []) {
  const s = await startSim({ faults: [STRICT, ...faults] });
  const dir = mkdtempSync(join(tmpdir(), 'calls-settings-'));
  const managed = managedAdminToken(dir);
  const p = await startProxy(s, { dir, env: { CAMPROXY_AUDIT_TOKEN: AUDIT_TOKEN } });
  await until(() => p.proxy.cameras.get('cam1')!.status.state().online, 10_000);
  return { s, p, managed, close: async () => (await p.proxy.stop(), await s.close()) };
}

let x: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  x = await setup();
}, 30_000);
afterAll(async () => x?.close());

const running = () => x.s.sim.engine.settings.running as Record<string, any>;
const setCalls = () => x.s.sim.engine.counters.setCalls as string[];
const put = (section: string, body: unknown, t = ADMIN_TOKEN, base = x.p.base) => request(base).put(`/api/cameras/cam1/settings/${section}`).set(auth(t)).send(body as object);
const get = (path = '', t?: string) => request(x.p.base).get(`/api/cameras/cam1/settings${path}`).set(auth(t));

describe('camera settings for clients', () => {
  it('reads both sections with a client token', async () => {
    const r = await get().expect(200);
    expect(r.body.detection).toMatchObject({ recording: expect.any(Boolean), motionRecording: expect.any(String), motionSensitivity: expect.any(Number) });
    expect(r.body.image).toMatchObject({ dayNight: expect.any(String), flip: { vertical: expect.any(Boolean), mirror: expect.any(Boolean) } });
    expect((await get('/image').expect(200)).body).toEqual(r.body.image);
    expect((await get('/detection').expect(200)).body).toEqual(r.body.detection);
  });

  it('refuses a write with a client token (403 admin_only) and allows a managed admin token', async () => {
    const n = setCalls().length;
    const r = await put('image', { dayNight: 'color' }, CLIENT_TOKEN);
    expect([r.status, r.body.error]).toEqual([403, 'admin_only']);
    expect(setCalls().length).toBe(n);
    const m = await put('image', { dayNight: 'color' }, x.managed);
    expect(m.status).toBe(200);
    expect(lastAudit(x.p.dir, 'camera-settings')!.user.name).toBe('token:cams');
  });

  it('answers 401 to the audit token and to none', async () => {
    expect((await get('', AUDIT_TOKEN)).status).toBe(401);
    expect((await put('image', { dayNight: 'color' }, AUDIT_TOKEN)).status).toBe(401);
    expect((await request(x.p.base).put('/api/cameras/cam1/settings/image').send({ dayNight: 'color' })).status).toBe(401);
  });

  it('writes the whole object and re-reads it', async () => {
    const before = JSON.parse(JSON.stringify(running().Isp));
    const r = await put('image', { flip: { vertical: !before.rotation } });
    expect(r.status).toBe(200);
    expect(r.body.fields).toEqual({ flip: { ok: true } });
    expect(r.body.settings.flip.vertical).toBe(!before.rotation);
    expect(running().Isp).toEqual({ ...before, rotation: before.rotation ? 0 : 1 });
    expect((await get('/image')).body.flip.vertical).toBe(!before.rotation);
  });

  // cams's settingsRoutes: keys it was not asked to change stay as they were.
  it('keeps keys it was not asked to change (rotation, watermark, stay_time, schedules)', async () => {
    const before = JSON.parse(JSON.stringify(running()));
    expect((await put('image', { dayNight: 'blackwhite' })).status).toBe(200);
    expect((await put('image', { osd: { namePosition: 'Upper Left' } })).status).toBe(200);
    expect((await put('image', { spotlight: { brightness: 40 } })).status).toBe(200);
    expect((await put('detection', { ai: { person: { sensitivity: 80 } } })).status).toBe(200);
    expect((await put('detection', { recording: false })).status).toBe(200);
    const S = running();
    expect(S.Isp).toEqual({ ...before.Isp, dayNight: 'Black&White' });
    expect(S.Osd).toEqual({ ...before.Osd, osdChannel: { ...before.Osd.osdChannel, pos: 'Upper Left' } });
    expect(S.WhiteLed).toEqual({ ...before.WhiteLed, bright: 40 });
    expect(S.AiAlarm.people).toEqual({ ...before.AiAlarm.people, sensitivity: 80 });
    expect(S.AiAlarm.vehicle).toEqual(before.AiAlarm.vehicle);
    expect(S.Rec).toEqual({ ...before.Rec, enable: 0 });
    expect(S.MdAlarm).toEqual(before.MdAlarm);
    expect((await put('detection', { recording: true })).status).toBe(200);
  });

  it('applies several changes to one camera object in one Set', async () => {
    const n = setCalls().length;
    const r = await put('detection', { recording: false, motionRecording: 'off', ai: { vehicle: { record: 'off' } } });
    expect(r.status).toBe(200);
    expect(r.body.fields).toEqual({ recording: { ok: true }, motionRecording: { ok: true }, 'ai.vehicle.record': { ok: true } });
    expect(setCalls().slice(n)).toEqual(['SetRecV20']);
    expect((await put('detection', { recording: true, motionRecording: 'on', ai: { vehicle: { record: 'on' } } })).status).toBe(200);
  });

  it('serializes two writers on one camera', async () => {
    const isp = running().Isp;
    const mirror = !isp.mirroring;
    const dayNight = isp.dayNight === 'Color' ? 'auto' : 'color';
    const [a, b] = await Promise.all([put('image', { flip: { mirror } }), put('image', { dayNight })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const img = (await get('/image')).body;
    expect([img.flip.mirror, img.dayNight]).toEqual([mirror, dayNight]);
  });

  it('logs out after a write', async () => {
    const w = x.p.proxy.cameras.get('cam1')!;
    const spy = vi.spyOn(w.client, 'logout');
    try {
      expect((await put('image', { dayNight: 'auto' })).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await put('image', { dayNight: 'color' })).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('audits camera-settings with section, patch and fields, never a password', async () => {
    expect((await put('image', { spotlight: { brightness: 55 } })).status).toBe(200);
    const a = lastAudit(x.p.dir, 'camera-settings')!;
    expect(a).toMatchObject({ event: { action: 'camera-settings', category: ['configuration'], type: ['change'], outcome: 'success' }, user: { name: 'admin' } });
    expect(a.cam_proxy).toMatchObject({ section: 'image', patch: { spotlight: { brightness: 55 } }, fields: { spotlight: 'ok' }, unexpected: [], requestedBy: 'token' });
    expect(auditText(x.p.dir)).not.toContain(x.s.password);
    expect(auditText(x.p.dir)).not.toContain(ADMIN_TOKEN);
  });

  it.each([
    ['detection', { motionSensitivity: 99 }],
    ['detection', { ai: { cat: {} } }],
    ['image', { osd: { name: 'Porch' } }],
    ['image', { dayNight: 'Purple' }],
    ['image', { extra: 1 }],
  ])('answers 400 invalid with details for %s %j, before calling the camera', async (section, body) => {
    const n = setCalls().length;
    const audits = auditText(x.p.dir).split('"camera-settings"').length;
    const r = await put(section, body);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'invalid', details: expect.any(Array) });
    expect(setCalls().length).toBe(n);
    // The refusal is audited (section and field names only), nothing was written.
    expect(auditText(x.p.dir).split('"camera-settings"').length).toBe(audits + 1);
    expect(lastAudit(x.p.dir, 'camera-settings')).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'invalid' }, cam_proxy: { section, sent: false } });
  });

  it('answers 404 for an unknown section and an unknown camera', async () => {
    expect([(await put('encoding', {})).status, (await put('encoding', {})).body.error]).toEqual([404, 'not_found']);
    expect((await get('/encoding')).status).toBe(404);
    expect((await request(x.p.base).get('/api/cameras/nope/settings').set(auth())).status).toBe(404);
  });
});

describe('a camera that does not keep a write', () => {
  it('answers 207 with not_applied when the camera ignores a write', async () => {
    const y = await setup([{ name: 'settings.ignore', cmds: ['SetIsp'] }]);
    try {
      const v = !(y.s.sim.engine.settings.running as Record<string, any>).Isp.rotation;
      const r = await put('image', { flip: { vertical: v } }, ADMIN_TOKEN, y.p.base);
      expect(r.status).toBe(207);
      expect(r.body.fields.flip).toEqual({ ok: false, error: 'not_applied' });
      expect(lastAudit(y.p.dir, 'camera-settings')).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'not_applied' }, cam_proxy: { fields: { flip: 'not_applied' } } });
    } finally {
      await y.close();
    }
  }, 30_000);

  it('answers 207 with camera_rejected when the camera refuses one command', async () => {
    const y = await setup([{ name: 'settings.fail', cmds: ['SetOsd'] }]);
    try {
      const r = await put('image', { dayNight: 'color', osd: { namePosition: 'Upper Left' } }, ADMIN_TOKEN, y.p.base);
      expect(r.status).toBe(207);
      expect(r.body.fields).toEqual({ dayNight: { ok: true }, osd: { ok: false, error: 'camera_rejected' } });
      expect(r.body.settings.dayNight).toBe('color');
      expect(lastAudit(y.p.dir, 'camera-settings')).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'camera_rejected' } });
      expect(JSON.stringify(r.body)).not.toMatch(/rspCode|SetOsd/);
    } finally {
      await y.close();
    }
  }, 30_000);

  it('maps an offline camera to 503 and audits the refusal', async () => {
    const y = await setup();
    try {
      await y.s.close();
      const w = y.p.proxy.cameras.get('cam1')!;
      await w.status.checkNow();
      await w.status.checkNow();
      expect([(await request(y.p.base).get('/api/cameras/cam1/settings').set(auth())).status]).toEqual([503]);
      const r = await put('image', { dayNight: 'color' }, ADMIN_TOKEN, y.p.base);
      expect([r.status, r.body.error]).toEqual([503, 'camera_offline']);
      expect(lastAudit(y.p.dir, 'camera-settings')).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'camera_offline' }, cam_proxy: { section: 'image', sent: false } });
    } finally {
      await y.p.proxy.stop();
    }
  }, 30_000);
});
