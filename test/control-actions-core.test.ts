import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { performAction, type ActionWho } from '../src/api/actions';
import type { PushResult } from '../src/tls/push';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';

// The actions as an Express-free core (plan P3 Task 8, R3-7): the route and
// cams-admin's camera.action share performAction.
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
const local: ActionWho = { user: 'admin', requestedBy: 'token', ip: '127.0.0.1' };
const camsAdmin: ActionWho = { user: 'cams-admin', requestedBy: 'cams-admin', cmdId: `cmd_${'7'.repeat(20)}`, actor: 'admin@example.org' };
beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
  await until(() => p.proxy.cameras.first().status.state().online);
}, 60_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('performAction', () => {
  it('answers what the route answers: camera-test, retention-run dry, restart one camera', async () => {
    const t = await performAction(p.proxy.actions, 'camera-test', 'cam1', {}, local);
    expect(t).toMatchObject({ status: 200, json: expect.objectContaining({ online: true }) });
    const route = await request(p.base).post('/control/actions/camera-test').set(auth(ADMIN_TOKEN));
    expect(route.status).toBe(200);
    expect(route.body).toMatchObject({ online: true, firmware: (t as { json: { firmware: unknown } }).json.firmware });
    const r = await performAction(p.proxy.actions, 'retention-run', null, { dryRun: true }, local);
    expect(r).toMatchObject({ status: 200, json: expect.objectContaining({ dryRun: true }) });
    expect(await performAction(p.proxy.actions, 'restart', 'cam1', {}, local)).toEqual({ status: 202 });
    await until(() => p.proxy.cameras.first().phase() !== 'restarting' && p.proxy.cameras.first().status.state().online, 30_000);
  }, 60_000);
  it('not_configured as a 409 outcome (no ntp.server, no ftp.publicHost)', async () => {
    expect(await performAction(p.proxy.actions, 'camera-ntp-set', 'cam1', {}, local)).toMatchObject({ status: 409, error: 'not_configured', detail: 'ntp.server is not set' });
    expect(await performAction(p.proxy.actions, 'camera-ftp-setup', 'cam1', {}, local)).toMatchObject({ status: 409, error: 'not_configured' });
  });
  it('the process restart is never in the core (the route keeps it); an unknown action is not_found', async () => {
    expect(await performAction(p.proxy.actions, 'restart-proxy', null, {}, local)).toMatchObject({ status: 404, error: 'not_found' });
    expect(await performAction(p.proxy.actions, 'frobnicate', 'cam1', {}, local)).toMatchObject({ status: 404, error: 'not_found' });
  });
  it('Push now never answers key material (security fix, R3-8)', async () => {
    const full: PushResult = { outcome: 'pushed', served: 'SHA256:AA', servedPem: '-----BEGIN CERTIFICATE-----x', leaf: { certPem: '-----BEGIN CERTIFICATE-----c', keyPem: '-----BEGIN PRIVATE KEY-----k', fingerprint: 'SHA256:AA', notAfter: 1, names: ['n'], ips: ['192.0.2.1'] }, tookMs: 3 };
    const o = await performAction({ ...p.proxy.actions, tls: { ...p.proxy.actions.tls, pushNow: async () => full } }, 'camera-cert-push', 'cam1', {}, local);
    expect(JSON.stringify(o)).not.toMatch(/BEGIN|keyPem|certPem|servedPem/);
    expect(o).toMatchObject({ status: 200, json: { outcome: 'pushed', leaf: { fingerprint: 'SHA256:AA' } } });
  });
  it('a cams-admin requester shows in the reboot record: user cams-admin, requestedBy cams-admin, the cmdId and actor; then too_soon with Retry-After', async () => {
    const o = await performAction(p.proxy.actions, 'camera-reboot', 'cam1', {}, camsAdmin);
    expect(o).toMatchObject({ status: 202, json: { confirmed: expect.any(Boolean) } });
    const rec = p.proxy.audit.list({ actions: ['camera-reboot'], limit: 5 }).records[0] as Record<string, any>;
    expect(rec).toMatchObject({ user: { name: 'cams-admin' }, cam_proxy: { requestedBy: 'cams-admin', cmdId: camsAdmin.cmdId, actor: 'admin@example.org' } });
    expect(rec.source).toBeUndefined();
    const again = await performAction(p.proxy.actions, 'camera-reboot', 'cam1', {}, local);
    expect(again).toMatchObject({ status: 429, error: 'too_soon', retryAfterS: expect.any(Number) });
    const route = await request(p.base).post('/control/actions/camera-reboot').set(auth(ADMIN_TOKEN));
    expect(route.status).toBe(429);
    expect(Number(route.headers['retry-after'])).toBeGreaterThan(0);
  }, 30_000);
});
