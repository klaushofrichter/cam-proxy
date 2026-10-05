import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLog } from '../src/audit/audit-log';
import { CameraError } from '../src/camera/client';
import { CameraReboot, type RebootDeps } from '../src/camera/reboot';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';

// Camera reboot (issue #83): POST /control/actions/camera-reboot.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const who = { requestedBy: 'token' as const, ip: '10.0.0.5', userAgent: 'test' };

function make(over: Partial<RebootDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reboot-audit-'));
  dirs.push(dir);
  const audit = new AuditLog({ dir, version: 'dev' });
  const checks: Array<{ ok: boolean; serial?: string }> = [];
  const deps: RebootDeps = {
    send: vi.fn(async () => ({ rspCode: 200 })),
    forgetToken: vi.fn(),
    serial: () => 'S1',
    // Each check takes the next scripted answer; then the camera keeps failing.
    check: vi.fn(async () => checks.shift() ?? { ok: false }),
    audit,
    pollMs: 5,
    ...over,
  };
  const r = new CameraReboot(deps);
  const records = () => audit.list({ actions: ['camera-reboot'], limit: 100 }).records.reverse();
  return { r, deps, audit, checks, records };
}

describe('CameraReboot', () => {
  it('answers 202 confirmed when the camera replies, forgets the token and records the request', async () => {
    const { r, deps, records } = make();
    expect(await r.request(who)).toEqual({ status: 202, confirmed: true });
    r.stop();
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.forgetToken).toHaveBeenCalledTimes(1);
    expect(records()[0]).toMatchObject({
      event: { category: ['host'], type: ['change'], action: 'camera-reboot', outcome: 'success' },
      user: { name: 'admin' }, source: { ip: '10.0.0.5' },
      cam_proxy: { confirmed: true, requestedBy: 'token', phase: 'requested' },
    });
  });

  it('answers 202 unconfirmed when the camera dropped the connection after receiving the request', async () => {
    const { r, records } = make({ send: async () => { throw new CameraError('camera_offline', 'camera unreachable (ECONNRESET)', true); } });
    expect(await r.request(who)).toEqual({ status: 202, confirmed: false });
    r.stop();
    expect(records()[0]).toMatchObject({ event: { outcome: 'unknown' }, cam_proxy: { confirmed: false, phase: 'requested' } });
    expect(r.state()).toMatchObject({ confirmed: false, phase: 'rebooting' });
  });

  it('answers 502 when the request never reached the camera, records a failure and starts no cooldown', async () => {
    const send = vi.fn(async () => { throw new CameraError('camera_offline', 'camera unreachable (ECONNREFUSED)'); });
    const { r, deps, records } = make({ send });
    expect(await r.request(who)).toMatchObject({ status: 502, error: 'camera_offline' });
    expect(await r.request(who)).toMatchObject({ status: 502 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(deps.forgetToken).not.toHaveBeenCalled();
    expect(r.state()).toBeNull();
    expect(records()[0]).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'camera_offline' }, cam_proxy: { phase: 'requested' } });
  });

  it('refuses another reboot within 120 s of the last one (429)', async () => {
    const t = { now: 1_000_000 };
    const { r, deps } = make({ now: () => t.now, check: async () => ({ ok: true, serial: 'S1' }) });
    expect((await r.request(who)).status).toBe(202);
    t.now += 119_000;
    expect(await r.request(who)).toEqual({ status: 429, retryAfterS: 1, inFlight: false });
    t.now += 1_000;
    expect((await r.request(who)).status).toBe(202);
    r.stop();
    expect(deps.send).toHaveBeenCalledTimes(2);
  });

  it('records the camera back after it was seen down, with the seconds it was away', async () => {
    const { r, checks, records } = make();
    checks.push({ ok: true, serial: 'S1' }, { ok: false }, { ok: false }, { ok: true, serial: 'S1' });
    await r.request(who);
    await until(() => r.state()?.phase === 'back', 2000);
    const back = records()[1];
    expect(back).toMatchObject({ event: { action: 'camera-reboot', outcome: 'success', type: ['end'] }, cam_proxy: { phase: 'back' } });
    expect(typeof (back.cam_proxy as { downSec: unknown }).downSec).toBe('number');
    expect(r.state()).toMatchObject({ phase: 'back', downSec: expect.any(Number) });
    r.stop();
  });

  it('takes a new serial number as back, even when no check saw the camera down', async () => {
    const { r, checks } = make();
    checks.push({ ok: true, serial: 'S1' }, { ok: true, serial: 'S2' });
    await r.request(who);
    await until(() => r.state()?.phase === 'back', 2000);
    r.stop();
  });

  it('records a failure when the camera is not back within the time limit', async () => {
    const { r, records } = make({ timeoutMs: 50 });
    await r.request(who);
    await until(() => r.state()?.phase === 'not-back', 2000);
    expect(records()[1]).toMatchObject({ event: { action: 'camera-reboot', outcome: 'failure' }, cam_proxy: { phase: 'not-back' } });
    r.stop();
  });
});

describe('POST /control/actions/camera-reboot', () => {
  let sim: Awaited<ReturnType<typeof startSim>>;
  beforeAll(async () => {
    // Long enough for a check to see the camera down; the serial changes anyway.
    sim = await startSim({ rebootMs: 1500 });
  });
  afterAll(async () => {
    await sim.close();
  });
  const AUDIT_TOKEN = 'audit-token-'.padEnd(40, 'z');

  it('refuses the client token and the audit token (403), and a session without the CSRF header', async () => {
    const p = await startProxy(sim, { env: { CAMPROXY_AUDIT_TOKEN: AUDIT_TOKEN } });
    try {
      expect((await request(p.base).post('/control/actions/camera-reboot').set(auth())).status).toBe(403);
      expect((await request(p.base).post('/control/actions/camera-reboot').set(auth(AUDIT_TOKEN))).status).toBe(403);
      const login = await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      expect((await request(p.base).post('/control/actions/camera-reboot').set('Cookie', cookie)).status).toBe(403);
      expect(sim.sim.engine.counters.reboots).toBe(0);
    } finally {
      await p.proxy.stop();
    }
  });

  it('reboots the camera: 202, the status says rebooting, the camera comes back and the intake re-subscribes', async () => {
    const p = await startProxy(sim);
    try {
      await until(() => p.proxy.intake.state().onvif === 'subscribed' && p.proxy.status.state().online);
      const before = sim.sim.engine.counters.reboots;
      const t0 = Date.now();
      const r = await request(p.base).post('/control/actions/camera-reboot').set(auth(ADMIN_TOKEN));
      // startSim's camera drops the connection on Reboot.
      expect([r.status, r.body]).toEqual([202, { confirmed: false }]);
      expect(sim.sim.engine.counters.reboots).toBe(before + 1);
      const st = await request(p.base).get('/control/status').set(auth(ADMIN_TOKEN));
      expect(st.body.camera.reboot).toMatchObject({ phase: 'rebooting', confirmed: false, requestedAt: expect.any(Number) });
      // Within the cooldown: refused, nothing sent.
      const again = await request(p.base).post('/control/actions/camera-reboot').set(auth(ADMIN_TOKEN));
      expect(again.status).toBe(429);
      expect(again.body).toMatchObject({ error: 'too_soon' });
      expect(sim.sim.engine.counters.reboots).toBe(before + 1);
      await until(() => p.proxy.audit.list({ actions: ['camera-reboot'] }).records.length === 2, 15000);
      const [back, req] = p.proxy.audit.list({ actions: ['camera-reboot'] }).records;
      expect(req).toMatchObject({ event: { category: ['host'], outcome: 'unknown' }, user: { name: 'admin' }, cam_proxy: { confirmed: false, requestedBy: 'token' } });
      expect(back).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { phase: 'back', downSec: expect.any(Number) } });
      expect((await request(p.base).get('/control/status').set(auth(ADMIN_TOKEN))).body.camera.reboot).toMatchObject({ phase: 'back' });
      // ONVIF went down with the camera and subscribed again on its own.
      await until(() => p.proxy.intake.state().onvif === 'subscribed' && p.proxy.intake.state().since > t0, 15000);
      // No generic control-action record for it.
      expect(p.proxy.audit.list({ actions: ['control-action'] }).records).toHaveLength(0);
    } finally {
      await p.proxy.stop();
    }
  }, 30000);

  it('answers 202 confirmed when the camera replies first, by session', async () => {
    const saved = { ...sim.sim.engine.rebootDefaults };
    sim.sim.engine.rebootDefaults = { ms: 300, dropsConnection: false };
    const p = await startProxy(sim);
    try {
      await until(() => p.proxy.status.state().online);
      const login = await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const r = await request(p.base).post('/control/actions/camera-reboot').set('Cookie', cookie).set('X-CamProxy-UI', '1');
      expect([r.status, r.body]).toEqual([202, { confirmed: true }]);
      expect(p.proxy.audit.list({ actions: ['camera-reboot'] }).records[0]).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { confirmed: true, requestedBy: 'session' } });
      await until(() => p.proxy.audit.list({ actions: ['camera-reboot'] }).records.length === 2, 15000);
    } finally {
      sim.sim.engine.rebootDefaults = saved;
      await p.proxy.stop();
    }
  }, 30000);

  it('answers 502 when nothing reached the camera', async () => {
    const dead = { ...sim, camera: { ...sim.camera, host: '127.0.0.1:1' } };
    const p = await startProxy(dead);
    try {
      const r = await request(p.base).post('/control/actions/camera-reboot').set(auth(ADMIN_TOKEN));
      expect(r.status).toBe(502);
      expect(r.body).toMatchObject({ error: 'camera_offline' });
      expect(p.proxy.audit.list({ actions: ['camera-reboot'] }).records[0]).toMatchObject({ event: { outcome: 'failure' } });
    } finally {
      await p.proxy.stop();
    }
  });
});
