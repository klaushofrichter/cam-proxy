import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cameraHandlers, scrub, verifyFtp, verifyNtp, verifyPush, type CameraCommandDeps } from '../src/fleet/camera-commands';
import type { CommandBody } from '../src/fleet/command-check';
import type { Done, Handler } from '../src/fleet/commands';
import { NEVER_REMOTE_ACTIONS } from '../src/fleet/policy';
import type { PushResult } from '../src/tls/push';
import { strict, why } from './helpers/contract';
import { freePort, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// camera.action, camera.name.set, proxy.restart (plan P3 Task 9): the
// existing camera functions through performAction, re-read and compared,
// answers scrubbed. Against cam-sim (never the real camera).
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let h: Record<string, Handler>;
let deps: CameraCommandDeps;
const restartProcess = vi.fn();
const CMD = `cmd_${'5'.repeat(20)}`;
const body = (command: string): CommandBody => ({ proxyId: `prx_${'1'.repeat(20)}`, connId: `con_${'2'.repeat(20)}`, cmdId: CMD, exp: 0, actor: 'admin@example.org', command, args: {} });
const act = async (args: object) => (await h['camera.action']({ v: 1, ...args }, body('camera.action'))) as Done;
const resultOk = (r: Done, name: string) => {
  const v = strict(`commands/${name}.result`);
  expect(v(r.result), why(v)).toBe(true);
};

beforeAll(async () => {
  sim = await startSim();
  const ftpPort = await freePort();
  const passive = await freePort();
  p = await startProxy(sim, {
    settings: { ftp: { enabled: true, port: ftpPort, passive: `${passive}-${passive + 9}`, publicHost: '127.0.0.1', tls: true, stream: 'sub' }, ntp: { server: '192.0.2.123' } },
    env: { CAMPROXY_FTP_PASSWORD: 'ftp-secret-pw-123' },
  });
  await until(() => p.proxy.cameras.first().status.state().online, 30_000);
  deps = {
    actions: p.proxy.actions,
    cameraIds: () => p.proxy.running.cameraOrder,
    cameraName: { current: (c) => p.proxy.cameras.get(c)!.name(), write: (c, n) => p.proxy.cameras.get(c)!.writeName(n) },
    audit: p.proxy.audit,
    restartProcess,
    now: () => 1_000,
  };
  h = cameraHandlers(deps);
}, 60_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('camera.action', () => {
  it("camera-test: ok with the action's answer, httpStatus 200; the control-action record says cams-admin", async () => {
    const r = await act({ camera: 'cam1', action: 'camera-test' });
    expect(r).toMatchObject({ status: 'ok', action: 'camera-test', result: { action: 'camera-test', camera: 'cam1', httpStatus: 200, answer: expect.objectContaining({ online: true }) } });
    resultOk(r, 'camera.action');
    const rec = p.proxy.audit.list({ actions: ['control-action'], limit: 1 }).records[0] as Record<string, any>;
    expect(rec).toMatchObject({ user: { name: 'cams-admin' }, cam_proxy: { action: 'camera-test', result: 'ok', requestedBy: 'cams-admin', cmdId: CMD, actor: 'admin@example.org' } });
  });
  it('unknown camera → failed unknown_camera; a restarting one → failed camera_restarting', async () => {
    expect(await act({ camera: 'cam9', action: 'camera-test' })).toMatchObject({ status: 'failed', code: 'unknown_camera', action: 'camera-test' });
    const w = p.proxy.cameras.first();
    const phase = vi.spyOn(w, 'phase').mockReturnValue('restarting');
    try {
      expect(await act({ camera: 'cam1', action: 'camera-test' })).toMatchObject({ status: 'failed', code: 'camera_restarting' });
    } finally {
      phase.mockRestore();
    }
  });
  it('retention-run is always a dry run (the storage is never asked for a real run)', async () => {
    const spy = vi.spyOn(p.proxy.storage, 'run');
    const r = await act({ camera: null, action: 'retention-run' });
    expect(spy).toHaveBeenCalledWith({ dryRun: true });
    expect(r).toMatchObject({ status: 'ok', result: { camera: null, httpStatus: 200 } });
    spy.mockRestore();
  });
  it('a never-remote action reaching the handler (defense) fails not_allowed, nothing called; restart is one camera, never the host-wide restart', async () => {
    const calls = { find: vi.spyOn(deps.actions, 'findCamera'), proc: vi.spyOn(deps.actions, 'restartProcess'), all: vi.spyOn(deps.actions, 'restart'), clear: vi.spyOn(deps.actions.archive, 'clear') };
    for (const a of NEVER_REMOTE_ACTIONS) expect(await act({ camera: 'cam1', action: a }), a).toMatchObject({ status: 'failed', code: 'not_allowed' });
    expect(await act({ camera: null, action: 'restart' })).toMatchObject({ status: 'failed', code: 'invalid' });
    const one = vi.spyOn(deps.actions, 'restartCamera');
    expect(await act({ camera: 'cam1', action: 'restart' })).toMatchObject({ status: 'ok', result: { httpStatus: 202, answer: null } });
    expect(one).toHaveBeenCalledWith('cam1');
    for (const s of Object.values(calls)) expect(s).not.toHaveBeenCalled();
    await until(() => p.proxy.cameras.first().phase() !== 'restarting' && p.proxy.cameras.first().status.state().online, 30_000);
  }, 40_000);
  it('camera-ftp-setup against cam-sim: whole-object Set, re-read, verified true; the answer has no password', async () => {
    const r = await act({ camera: 'cam1', action: 'camera-ftp-setup' });
    expect(r).toMatchObject({ status: 'ok', result: { httpStatus: 200, verified: true, mismatch: [] }, changed: ['camera:cam1:camera-ftp-setup'] });
    expect(JSON.stringify(r.result)).not.toMatch(/password|ftp-secret-pw/i);
    expect(sim.sim.engine.settings.get('Ftp')).toMatchObject({ enable: 1, server: '127.0.0.1' });
    resultOk(r, 'camera.action');
    // camera-ftp-off is never remote (review M5): refused, the camera keeps uploading.
    expect(await act({ camera: 'cam1', action: 'camera-ftp-off' })).toMatchObject({ status: 'failed', code: 'not_allowed' });
    expect(sim.sim.engine.settings.get('Ftp')).toMatchObject({ enable: 1 });
  });
  it('camera-ntp-set: the camera takes ntp.server, verified; a failed outcome → verified false, mismatch [server]', async () => {
    const r = await act({ camera: 'cam1', action: 'camera-ntp-set' });
    expect(r).toMatchObject({ status: 'ok', result: { answer: { outcome: expect.stringMatching(/^(set|already)$/) }, verified: true, mismatch: [] } });
    expect(sim.sim.engine.settings.get('Ntp')).toMatchObject({ server: '192.0.2.123', enable: 1 });
    expect(verifyNtp({ outcome: 'failed' })).toEqual({ verified: false, mismatch: ['server'] });
    expect(verifyNtp({ outcome: 'unsupported' })).toEqual({ verified: false, mismatch: [] });
  });
  it('camera-cert-push: projected (no PEM), verified when the camera serves the pushed leaf', async () => {
    const full: PushResult = { outcome: 'pushed', served: 'SHA256:AA', servedPem: '-----BEGIN CERTIFICATE-----x', leaf: { certPem: '-----BEGIN CERTIFICATE-----c', keyPem: '-----BEGIN PRIVATE KEY-----k', fingerprint: 'SHA256:AA', notAfter: 1, names: ['n'], ips: ['192.0.2.1'] }, tookMs: 3 };
    const push = vi.spyOn(deps.actions.tls, 'pushNow').mockResolvedValue(full);
    try {
      const r = await act({ camera: 'cam1', action: 'camera-cert-push' });
      expect(JSON.stringify(r)).not.toMatch(/BEGIN|keyPem|certPem|servedPem/);
      expect(r).toMatchObject({ status: 'ok', result: { answer: { outcome: 'pushed', leaf: { fingerprint: 'SHA256:AA' } }, verified: true, mismatch: [] } });
      expect(push).toHaveBeenCalledWith('cam1', expect.objectContaining({ user: 'cams-admin', requestedBy: 'cams-admin', cmdId: CMD }));
    } finally {
      push.mockRestore();
    }
    expect(verifyPush({ outcome: 'pushed', served: 'SHA256:BB', leaf: { fingerprint: 'SHA256:AA' } })).toEqual({ verified: false, mismatch: ['served'] });
    expect(verifyPush({ outcome: 'refused', served: 'SHA256:BB' })).toEqual({ verified: false, mismatch: ['outcome'] });
  });
  it('an action error maps to its code; the answer is the error, scrubbed', async () => {
    const ntp = vi.spyOn(deps.actions, 'cameraNtp').mockResolvedValue(null);
    try {
      expect(await act({ camera: 'cam1', action: 'camera-ntp-set' })).toMatchObject({ status: 'failed', code: 'not_configured', result: { httpStatus: 409, answer: { error: 'not_configured' } } });
    } finally {
      ntp.mockRestore();
    }
  });
});

describe('scrub and verify', () => {
  it('scrub: drops pem/key/password/secret/token/cookie keys at any depth', () => {
    expect(scrub({ a: 1, keyPem: 'x', nested: [{ password: 'p', ok: true }], Token: 't', cookies: 'c', passwd: 'w', apiSecret: 's' })).toEqual({ a: 1, nested: [{ ok: true }] });
  });
  it('an answer over 16 KiB → answer null, clamped true', async () => {
    const big = vi.spyOn(deps.actions, 'checkCamera').mockResolvedValue({ blob: 'x'.repeat(1900), list: Array.from({ length: 20 }, () => 'y'.repeat(1000)) } as never);
    try {
      const r = await act({ camera: 'cam1', action: 'camera-test' });
      expect(r).toMatchObject({ status: 'ok', result: { answer: null, clamped: true } });
      resultOk(r, 'camera.action');
    } finally {
      big.mockRestore();
    }
  });
  it('verifyFtp: setup needs enable 1, the target server/port/tls/stream and the upload triggers; off needs enable 0', () => {
    const t = { server: '192.0.2.5', port: 21, tls: true, stream: 'sub' as const };
    const good = { enable: 1, server: '192.0.2.5', port: 21, onlyFtps: 1, streamType: 1, uploadOn: ['MD', 'AI_PEOPLE', 'AI_VEHICLE', 'AI_DOG_CAT'] };
    expect(verifyFtp('camera-ftp-setup', { ftp: good }, t)).toEqual({ verified: true, mismatch: [] });
    expect(verifyFtp('camera-ftp-setup', { ftp: { ...good, server: '192.0.2.6', uploadOn: ['MD'] } }, t)).toEqual({ verified: false, mismatch: ['server', 'uploadOn'] });
    expect(verifyFtp('camera-ftp-off', { ftp: { enable: 0 } })).toEqual({ verified: true, mismatch: [] });
    expect(verifyFtp('camera-ftp-off', { ftp: { enable: 1 } })).toEqual({ verified: false, mismatch: ['enable'] });
  });
});

describe('camera.name.set', () => {
  it('SetDevName through cameraName.write, re-read, verified; the camera-name record says cams-admin', async () => {
    const before = deps.cameraName.current('cam1');
    const r = (await h['camera.name.set']({ v: 1, camera: 'cam1', name: 'Front door' }, body('camera.name.set'))) as Done;
    expect(r).toMatchObject({ status: 'ok', result: { camera: 'cam1', requested: 'Front door', name: 'Front door', verified: true }, changed: ['camera:cam1:name'] });
    resultOk(r, 'camera.name.set');
    expect(p.proxy.audit.list({ actions: ['camera-name'], limit: 1 }).records[0]).toMatchObject({ user: { name: 'cams-admin' }, cam_proxy: { from: before, to: 'Front door', requestedBy: 'cams-admin', cmdId: CMD, actor: 'admin@example.org' } });
    await h['camera.name.set']({ v: 1, camera: 'cam1', name: before }, body('camera.name.set'));
  });
  it('invalid name → failed invalid_name (not asked); unknown camera → unknown_camera', async () => {
    expect(await h['camera.name.set']({ v: 1, camera: 'cam1', name: '   ' }, body('camera.name.set'))).toMatchObject({ status: 'failed', code: 'invalid_name' });
    expect(await h['camera.name.set']({ v: 1, camera: 'cam9', name: 'x' }, body('camera.name.set'))).toMatchObject({ status: 'failed', code: 'unknown_camera' });
  });
});

describe('proxy.restart', () => {
  it('answers restartAt; the restart is an after hook (never called by the handler itself)', async () => {
    const r = (await h['proxy.restart']({ v: 1 }, body('proxy.restart'))) as Done;
    expect(r).toMatchObject({ status: 'ok', result: { restartAt: 2_000 } });
    resultOk(r, 'proxy.restart');
    expect(restartProcess).not.toHaveBeenCalled();
    r.after!();
    expect(restartProcess).toHaveBeenCalledTimes(1);
  });
});
