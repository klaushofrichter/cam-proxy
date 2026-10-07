import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { configRevision, getPath } from '../src/config/load';
import { DEFAULTS } from '../src/config/defaults';
import { writeKeyFile } from '../src/fleet/keyfile';
import { writePrivateJson } from '../src/fleet/private-file';
import type { Envelope } from '../src/fleet/protocol';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { strict, why } from './helpers/contract';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// The P3 commands wired into the proxy (plan P3 Task 10): off by default,
// run once allowed locally, a local settings edit reported early.
const bodyOf = (r: { msg: Envelope }) => r.msg.body as Record<string, any>;
const P3 = ['config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.name.set', 'proxy.restart'];

describe('P3 through the proxy', () => {
  let sim: Awaited<ReturnType<typeof startSim>>;
  let fake: FakeAdmin;
  let p: Awaited<ReturnType<typeof startProxy>>;
  const exit = vi.fn();
  const setPolicy = (o: Record<string, unknown>) => writePrivateJson(join(p.dir, 'data', 'admin', 'policy.json'), { v: 1, changedAt: Date.now(), changedBy: 'local', consent: 3, ...o });
  const done = async (command: string, args: Record<string, unknown>) => {
    const { cmdId } = fake.sendCommand(command, args);
    await until(() => fake.results(cmdId).some((r) => bodyOf(r).phase === 'done'), 15_000);
    return bodyOf(fake.results(cmdId).find((r) => bodyOf(r).phase === 'done')!);
  };
  const audits = (action: string) => p.proxy.audit.list({ actions: [action], limit: 50 }).records as Record<string, any>[];
  beforeAll(async () => {
    sim = await startSim();
    fake = await startFakeAdmin();
    fake.welcomeHeartbeatS = 3600;
    fake.nextInS = 3600;
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-p3-'));
    writeKeyFile(join(dir, 'data', 'admin', 'key.json'), fake.keyFile());
    p = await startProxy(sim, { dir, settings: { camsAdmin: { url: fake.url } }, proxy: { exit, restartTimeoutMs: 2000, camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200, changeCheckMs: 100 } } } });
    await until(() => fake.open() === 1 && fake.heartbeats().length >= 1, 10_000);
  }, 60_000);
  afterAll(async () => {
    await p?.proxy.stop();
    await fake?.close();
    await sim?.close();
  });

  it('every P3 command is off by default: not_allowed, nothing changed; the heartbeat allows nothing', async () => {
    const before = configRevision(p.proxy.loaded);
    for (const [c, a] of [['config.get', { v: 1 }], ['config.set', { v: 1, dryRun: false, baseRevision: before, set: { 'sse.pingS': 7 } }], ['camera.action', { v: 1, camera: 'cam1', action: 'camera-test' }], ['camera.name.set', { v: 1, camera: 'cam1', name: 'x' }], ['proxy.restart', { v: 1 }]] as const) {
      expect(await done(c, a as Record<string, unknown>), c).toMatchObject({ status: 'refused', code: 'not_allowed' });
    }
    expect(configRevision(p.proxy.loaded)).toBe(before);
    expect((fake.heartbeats().at(-1)!.msg.body as Record<string, any>).proxy.commands.allow).toEqual([]);
    expect(exit).not.toHaveBeenCalled();
  });
  it('allowed locally: config.get, then config.set dry run and apply change the setting live; admin-command and config-change records', async () => {
    setPolicy({ allow: ['config.get', 'config.set', 'config.rollback', 'camera.action:camera-test'] });
    const get = await done('config.get', { v: 1 });
    expect(get).toMatchObject({ status: 'ok', result: { revision: configRevision(p.proxy.loaded), cameras: ['cam1'] } });
    expect(strict('commands/config.get.result')(get.result), why(strict('commands/config.get.result'))).toBe(true);
    const dry = await done('config.set', { v: 1, dryRun: true, baseRevision: get.result.revision, set: { 'sse.pingS': 7 } });
    expect(dry).toMatchObject({ status: 'ok', result: { dryRun: true, changes: [{ path: 'sse.pingS', to: 7 }] } });
    expect(strict('commands/config.set.result')(dry.result), why(strict('commands/config.set.result'))).toBe(true);
    const apply = await done('config.set', { v: 1, dryRun: false, baseRevision: get.result.revision, set: { 'sse.pingS': 7 } });
    expect(apply).toMatchObject({ status: 'ok', result: { dryRun: false } });
    expect(getPath(p.proxy.loaded.config, 'sse.pingS')).toBe(7);
    expect(p.proxy.running.sse.pingS).toBe(7);
    expect(audits('config-change')[0]).toMatchObject({ user: { name: 'cams-admin' }, cam_proxy: { cmdId: apply.cmdId, actor: expect.any(String) } });
    expect(audits('admin-command').some((r) => r.cam_proxy?.cmdId === apply.cmdId)).toBe(true);
    const cam = await done('camera.action', { v: 1, camera: 'cam1', action: 'camera-test' });
    expect(cam).toMatchObject({ status: 'ok', result: { httpStatus: 200 } });
    const back = await done('config.rollback', { v: 1, dryRun: false, cmdId: apply.cmdId });
    expect(back).toMatchObject({ status: 'ok', result: { of: apply.cmdId } });
    expect(p.proxy.running.sse.pingS).toBe(DEFAULTS.sse.pingS);
  });
  it('the heartbeat lists a P3 entry once allowed (allow ∩ implemented)', async () => {
    const n = fake.heartbeats().length;
    await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ sse: { maxClients: 41 } }).expect(200);
    await until(() => fake.heartbeats().length > n, 5_000);
    expect((fake.heartbeats().at(-1)!.msg.body as Record<string, any>).proxy.commands.allow).toEqual(['config.get', 'config.set', 'config.rollback', 'camera.action:camera-test']);
  });
  it('R3-12: a local settings edit sends an early heartbeat with the new configRevision', async () => {
    const n = fake.heartbeats().length;
    await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ sse: { maxClients: 42 } }).expect(200);
    await until(() => fake.heartbeats().length > n, 5_000);
    expect((fake.heartbeats().at(-1)!.msg.body as Record<string, any>).proxy.configRevision).toBe(configRevision(p.proxy.loaded));
  });
  it('proxy.restart: done ok first, then the proxy restarts (exit called once)', async () => {
    setPolicy({ allow: ['proxy.restart'] });
    const r = await done('proxy.restart', { v: 1 });
    expect(r).toMatchObject({ status: 'ok', result: { restartAt: expect.any(Number) } });
    await until(() => exit.mock.calls.length === 1, 15_000);
    expect(P3.length).toBe(6);
  }, 30_000);
});
