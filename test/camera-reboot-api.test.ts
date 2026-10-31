import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lastAudit, managedAdminToken } from './helpers/onboarding';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// POST /api/cameras/:cam/reboot (spec 2026-10-30-camera-onboarding-design §4.8):
// the camera-reboot action for cams's managed admin token.
const AUDIT_TOKEN = 'audit-token-'.padEnd(40, 'z');
let s: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let managed: string;
beforeAll(async () => {
  s = await startSim({ rebootMs: 300 });
  const dir = mkdtempSync(join(tmpdir(), 'calls-reboot-'));
  managed = managedAdminToken(dir);
  p = await startProxy(s, { dir, env: { CAMPROXY_AUDIT_TOKEN: AUDIT_TOKEN } });
  await until(() => p.proxy.cameras.get('cam1')!.status.state().online, 10_000);
}, 30_000);
afterAll(async () => {
  await p?.proxy.stop();
  await s?.close();
});

const reboots = () => s.sim.engine.counters.reboots;
const post = (body: unknown, t = managed) => request(p.base).post('/api/cameras/cam1/reboot').set(auth(t)).send(body as object);

describe('camera reboot for managed admin tokens', () => {
  it('refuses a client token (403 admin_only), the audit token and none (401)', async () => {
    const r = await post({ confirm: 'reboot' }, CLIENT_TOKEN);
    expect([r.status, r.body.error]).toEqual([403, 'admin_only']);
    expect((await post({ confirm: 'reboot' }, AUDIT_TOKEN)).status).toBe(401);
    expect((await request(p.base).post('/api/cameras/cam1/reboot').send({ confirm: 'reboot' })).status).toBe(401);
    expect(reboots()).toBe(0);
  });

  it.each([[{}], [{ confirm: 'reboot', x: 1 }], [{ confirm: 'yes' }], [['reboot']]])('answers 400 invalid to %j and sends no Reboot', async (body) => {
    const r = await post(body);
    expect([r.status, r.body.error]).toEqual([400, 'invalid']);
    expect(reboots()).toBe(0);
  });

  it('a managed admin token reboots: 202, audited by camera-reboot as token:cams', async () => {
    const r = await post({ confirm: 'reboot' });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ confirmed: expect.any(Boolean) });
    expect(reboots()).toBe(1);
    expect(lastAudit(p.dir, 'camera-reboot')).toMatchObject({ event: { action: 'camera-reboot' }, user: { name: 'token:cams' }, cam_proxy: { requestedBy: 'token', phase: 'requested' } });
  });

  it('a second call within the cooldown is 429 with Retry-After and the action\'s body', async () => {
    const r = await post({ confirm: 'reboot' }, ADMIN_TOKEN);
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.body).toEqual({ error: 'too_soon', detail: expect.stringMatching(/try again in \d+ s/) });
    expect(reboots()).toBe(1);
  });
});
