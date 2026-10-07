import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configRevision } from '../src/config/load';
import { DEFAULTS } from '../src/config/defaults';
import { writeKeyFile } from '../src/fleet/keyfile';
import { writePrivateJson } from '../src/fleet/private-file';
import type { Envelope } from '../src/fleet/protocol';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { strict, why } from './helpers/contract';
import { startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// The P3 round trip against cam-sim (plan P3 Task 12; never the real
// camera): read, dry run, apply, roll back; rename the camera; set its NTP
// server. The allow entries are in this test's own policy file only.
const bodyOf = (r: { msg: Envelope }) => r.msg.body as Record<string, any>;
let sim: Awaited<ReturnType<typeof startSim>>;
let fake: FakeAdmin;
let p: Awaited<ReturnType<typeof startProxy>>;
const done = async (command: string, args: Record<string, unknown>) => {
  const { cmdId } = fake.sendCommand(command, args, { actor: 'admin@example.org' });
  await until(() => fake.results(cmdId).some((r) => bodyOf(r).phase === 'done'), 20_000);
  const b = bodyOf(fake.results(cmdId).find((r) => bodyOf(r).phase === 'done')!);
  if (b.status !== 'refused' && b.result && b.status === 'ok') {
    const v = strict(`commands/${command}.result`);
    expect(v(b.result), `${command}: ${why(v)}`).toBe(true);
  }
  return { cmdId, ...b } as Record<string, any> & { cmdId: string };
};
beforeAll(async () => {
  sim = await startSim();
  fake = await startFakeAdmin();
  fake.welcomeHeartbeatS = 1;
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-p3-rt-'));
  writeKeyFile(join(dir, 'data', 'admin', 'key.json'), fake.keyFile());
  writePrivateJson(join(dir, 'data', 'admin', 'policy.json'), { v: 1, allow: ['config.get', 'config.set', 'config.rollback', 'camera.name.set', 'camera.action:camera-ntp-set'], consent: 3, changedAt: 1, changedBy: 'local' });
  p = await startProxy(sim, { dir, settings: { camsAdmin: { url: fake.url }, ntp: { server: '192.0.2.123' } }, proxy: { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200 } } } });
  await until(() => fake.open() === 1 && p.proxy.cameras.first().status.state().online, 20_000);
}, 60_000);
afterAll(async () => {
  await p?.proxy.stop();
  await fake?.close();
  await sim?.close();
});

describe('the P3 round trip against cam-sim', () => {
  it('config.get → set dry run → apply (sse.pingS, live) → rollback; both config-change records', async () => {
    const get = await done('config.get', { v: 1 });
    expect(get).toMatchObject({ status: 'ok', result: { revision: configRevision(p.proxy.loaded) } });
    const dry = await done('config.set', { v: 1, dryRun: true, baseRevision: get.result.revision, set: { 'sse.pingS': 5 } });
    expect(dry).toMatchObject({ status: 'ok', result: { dryRun: true, changes: [{ path: 'sse.pingS', from: DEFAULTS.sse.pingS, to: 5 }] } });
    expect(p.proxy.running.sse.pingS).toBe(DEFAULTS.sse.pingS);
    const apply = await done('config.set', { v: 1, dryRun: false, baseRevision: get.result.revision, set: { 'sse.pingS': 5 } });
    expect(apply.status).toBe('ok');
    expect(p.proxy.running.sse.pingS).toBe(5);
    const back = await done('config.rollback', { v: 1, dryRun: false, cmdId: apply.cmdId });
    expect(back).toMatchObject({ status: 'ok', result: { of: apply.cmdId } });
    expect(p.proxy.running.sse.pingS).toBe(DEFAULTS.sse.pingS);
    const recs = p.proxy.audit.list({ actions: ['config-change'], limit: 10 }).records as Record<string, any>[];
    expect(recs.map((r) => r.cam_proxy.cmdId)).toEqual(expect.arrayContaining([apply.cmdId, back.cmdId]));
  });
  it("camera.name.set: the camera's own name as read back, verified; set back", async () => {
    const before = p.proxy.cameras.first().name();
    const r = await done('camera.name.set', { v: 1, camera: 'cam1', name: 'Garden gate' });
    expect(r).toMatchObject({ status: 'ok', result: { camera: 'cam1', requested: 'Garden gate', name: 'Garden gate', verified: true } });
    // cam-sim's own answer, read again.
    expect(await p.proxy.cameras.first().client.command('GetDevName', { channel: 0 })).toMatchObject({ DevName: { name: 'Garden gate' } });
    expect((await done('camera.name.set', { v: 1, camera: 'cam1', name: before })).status).toBe('ok');
  });
  it('camera-ntp-set: cam-sim takes the local ntp.server (whole-object Set, re-read), verified', async () => {
    sim.sim.engine.settings.running.Ntp = { ...sim.sim.engine.settings.get('Ntp'), server: 'pool.ntp.org' };
    const r = await done('camera.action', { v: 1, camera: 'cam1', action: 'camera-ntp-set' });
    expect(r).toMatchObject({ status: 'ok', result: { action: 'camera-ntp-set', camera: 'cam1', httpStatus: 200, answer: { outcome: 'set' }, verified: true, mismatch: [] } });
    expect(sim.sim.engine.settings.get('Ntp')).toMatchObject({ server: '192.0.2.123', enable: 1 });
  });
});
