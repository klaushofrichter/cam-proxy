// Power-cycles through cams-admin (spec 2026-11-07-poe-switches-design,
// "Asking from a proxy", "Without cams-admin"): POST
// /control/cameras/:cam/actions/camera-powercycle asks cams-admin (event
// camera.power.cycle.request) and answers 202 {requestId}; without cams-admin
// it is refused. The camera's state follows camera.power.cycling/cycled. The
// switch is the mock in test/helpers, cams-admin the fake; the real switch is
// never contacted.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeKeyFile } from '../src/fleet/keyfile';
import { switchPasswordStore } from '../src/config/switch-passwords';
import type { Envelope } from '../src/fleet/protocol';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, CLIENT_TOKEN, startProxy, until } from './helpers/proxy';
import { startPoeSwitchMock, type PoeSwitchMock } from './helpers/poe-switch-mock';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { strict, why } from './helpers/contract';

describe('POST /control/actions/camera-powercycle', () => {
  const PASSWORD = 'switch-pw-never-shown-9137';
  const AUDIT_TOKEN = 'audit-token-'.padEnd(40, 'z');
  let sim: Awaited<ReturnType<typeof startSim>>;
  let sw: PoeSwitchMock;
  beforeAll(async () => {
    sim = await startSim();
    // PoE on port 8 (index 0) is the camera: off powers cam-sim down, on boots it.
    sw = await startPoeSwitchMock({
      password: PASSWORD,
      onPoe: (_i, on) => void (on ? sim.sim.engine.powerOn(300) : sim.sim.engine.powerOff()),
    });
  });
  afterAll(async () => {
    await sw.close();
    await sim.close();
  });
  const admin = () => auth(ADMIN_TOKEN);
  // A switch this proxy operates (by cams-admin's id), its password stored here.
  const SW = 'sw_test';
  const operated = async (offSeconds = 60) => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-powercycle-'));
    switchPasswordStore(join(dir, 'data')).set(SW, PASSWORD, sw.host);
    const p = await startProxy(sim, { dir });
    return { p, ctl: p.proxy.switches.get({ id: SW, model: 'sscpoe-web', host: sw.host, ports: 8, offSeconds }) };
  };
  const post = (base: string) => request(base).post('/control/actions/camera-powercycle').set(admin());

  it('409 power_cycle_needs_cams_admin without cams-admin; nothing reaches the switch', async () => {
    const p = await startProxy(sim);
    try {
      const calls = sw.calls.length;
      const r = await post(p.base);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: 'power_cycle_needs_cams_admin', detail: expect.stringContaining('cams-admin') });
      expect((await request(p.base).post('/control/cameras/cam1/actions/camera-powercycle').set(admin())).status).toBe(409);
      expect(sw.calls.length).toBe(calls);
      expect(p.proxy.audit.list({ actions: ['camera-powercycle', 'control-action'] }).records).toHaveLength(0);
      // The camera's power, as this proxy knows it: nothing from cams-admin.
      const g = await request(p.base).get('/control/cameras/cam1/power').set(admin());
      expect([g.status, g.body]).toEqual([200, { power: null, setAt: null, asked: null, result: null, canRequest: false, why: expect.stringContaining('cams-admin') }]);
      expect((await request(p.base).get('/control/cameras/cam9/power').set(admin())).status).toBe(404);
      expect((await request(p.base).get('/control/cameras/cam1/power').set(auth(CLIENT_TOKEN))).status).toBe(403);
    } finally {
      await p.proxy.stop();
    }
  });

  it('refuses the client and the audit token (403), and a session without the CSRF header', async () => {
    const p = await startProxy(sim, { env: { CAMPROXY_AUDIT_TOKEN: AUDIT_TOKEN } });
    try {
      const calls = sw.calls.length;
      expect((await request(p.base).post('/control/actions/camera-powercycle').set(auth(CLIENT_TOKEN))).status).toBe(403);
      expect((await request(p.base).post('/control/actions/camera-powercycle').set(auth(AUDIT_TOKEN))).status).toBe(403);
      const login = await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      expect((await request(p.base).post('/control/actions/camera-powercycle').set('Cookie', cookie)).status).toBe(403);
      expect(sw.calls.length).toBe(calls);
    } finally {
      await p.proxy.stop();
    }
  });

  it('through cams-admin: 202 {requestId}, one request event; the result and the cycle show; the cooldown is shared; the switch is never touched', async () => {
    const fake: FakeAdmin = await startFakeAdmin();
    fake.welcomeHeartbeatS = 1;
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-powercycle-'));
    writeKeyFile(join(dir, 'data', 'admin', 'key.json'), fake.keyFile());
    const p = await startProxy(sim, { dir, settings: { camsAdmin: { url: fake.url } }, proxy: { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200 } } } });
    const bodyOf = (r: { msg: Envelope }) => r.msg.body as Record<string, any>;
    const done = async (command: string, args: Record<string, unknown>) => {
      const { cmdId } = fake.sendCommand(command, { v: 1, ...args }, { actor: 'admin@example.org' });
      await until(() => fake.results(cmdId).some((r) => bodyOf(r).phase === 'done'), 15_000);
      return bodyOf(fake.results(cmdId).find((r) => bodyOf(r).phase === 'done')!);
    };
    const power = async () => (await request(p.base).get('/control/cameras/cam1/power').set(admin())).body;
    try {
      await until(() => fake.welcomed() === 1 && p.proxy.cameras.first().status.state().online, 20_000);
      const calls = sw.calls.length;
      // Connected, but no power record from cams-admin yet.
      expect((await post(p.base)).body.error).toBe('power_cycle_needs_cams_admin');
      expect(await power()).toMatchObject({ power: null, canRequest: false });
      expect(await done('camera.power.set', { camera: 'cam1', power: { kind: 'poe', switchName: 'Switch 2', port: 3, watts: 4.5, verifiedAt: Date.now() - 7200_000 } })).toMatchObject({ status: 'ok', result: {} });
      expect(await power()).toMatchObject({ power: { kind: 'poe', switchName: 'Switch 2', port: 3 }, canRequest: true, why: null });

      const r = await post(p.base);
      expect(r.status).toBe(202);
      expect(r.body).toEqual({ requestId: expect.stringMatching(/^pc_/) });
      const requestId = r.body.requestId as string;
      // A second press while it is open: refused, no second event.
      const again = await post(p.base);
      expect([again.status, again.body.error]).toEqual([429, 'in_flight']);
      expect(again.headers['retry-after']).toBeDefined();
      await until(() => fake.events().length >= 1, 5000);
      await new Promise((x) => setTimeout(x, 200));
      const events = fake.events().filter((e) => bodyOf(e).kind === 'camera.power.cycle.request');
      expect(events).toHaveLength(1);
      expect(bodyOf(events[0])).toMatchObject({ kind: 'camera.power.cycle.request', camera: 'cam1', requestId, askedAt: expect.any(Number) });
      expect(fake.verifyFromProxy(events[0].msg)).toBe(true);
      const v = strict('event');
      expect(v(events[0].msg), why(v)).toBe(true);
      expect(await power()).toMatchObject({ asked: { requestId }, result: null });

      // cams-admin runs the cycle on the operator: PoE off, then on again.
      sim.sim.engine.powerOff();
      expect(await done('camera.power.cycling', { camera: 'cam1', at: Date.now() })).toMatchObject({ status: 'ok' });
      expect((await request(p.base).get('/control/status').set(admin())).body.camera.reboot).toMatchObject({ kind: 'powercycle', phase: 'power-cycling' });
      const reboot = await request(p.base).post('/control/actions/camera-reboot').set(admin());
      expect(reboot.status).toBe(429);
      expect((await post(p.base)).status).toBe(429);
      void sim.sim.engine.powerOn(300);
      expect(await done('camera.power.cycled', { camera: 'cam1', ok: true, message: 'PoE on again after 5 s' })).toMatchObject({ status: 'ok' });
      expect(await done('camera.power.cycle.result', { camera: 'cam1', requestId, ok: true })).toMatchObject({ status: 'ok' });
      expect(await power()).toMatchObject({ asked: null, result: { requestId, ok: true } });
      await until(async () => (await request(p.base).get('/control/status').set(admin())).body.camera.reboot?.phase === 'back', 20_000);
      const recs = p.proxy.audit.list({ actions: ['camera-powercycle'] }).records.reverse();
      expect(recs.map((x) => (x.cam_proxy as { phase: string }).phase)).toEqual(['asked', 'requested', 'cycled', 'result', 'back']);
      expect(recs[0]).toMatchObject({ user: { name: 'admin' }, cam_proxy: { requestId, requestedBy: 'token', via: 'cams-admin' } });
      expect(p.proxy.audit.list({ actions: ['control-action'] }).records).toHaveLength(0);
      expect(sw.calls.length).toBe(calls);
    } finally {
      await p.proxy.stop();
      await fake.close();
    }
  }, 60_000);

  it('a proxy stop during the off time turns the PoE on again before the process ends', async () => {
    const { p, ctl } = await operated();
    const before = sw.opcodes.length;
    // A cycle in its off time (switch.cycle from cams-admin runs the same switch code).
    const pending = ctl.cycle(8, () => undefined, { verifyHost: null }).then(() => 'done', () => 'closed');
    await until(() => sw.poec[0] === 0, 5000);
    const t0 = Date.now();
    await p.proxy.stop({ reason: 'test' });
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(sw.poec[0]).toBe(1);
    expect(sw.opcodes.slice(before)).toEqual([0x2, 0x202]);
    expect(sw.activeSession()).toBe(false);
    await pending;
  }, 20000);

  it('the old camera switch actions camera-poe-on and poe-switch-read are gone (404); nothing reaches the switch', async () => {
    const p = await startProxy(sim);
    try {
      const calls = sw.calls.length;
      expect((await request(p.base).post('/control/actions/camera-poe-on').set(admin())).status).toBe(404);
      expect((await request(p.base).post('/control/actions/poe-switch-read').set(admin())).status).toBe(404);
      expect(sw.calls.length).toBe(calls);
    } finally {
      await p.proxy.stop();
    }
  });

  it('a proxy stop that cannot turn the PoE on again says so loudly: an audit failure record', async () => {
    const { p, ctl } = await operated();
    try {
      void ctl.cycle(8, () => undefined, { verifyHost: null }).catch(() => {});
      await until(() => sw.poec[0] === 0, 5000);
      sw.failSet = 1000;
      const t0 = Date.now();
      await p.proxy.stop({ reason: 'test' });
      expect(Date.now() - t0).toBeLessThan(12000);
      const recs = p.proxy.audit.list({ actions: ['camera-powercycle'] }).records;
      const left = recs.find((x) => /left OFF/.test(String(x.message)));
      expect(left).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { phase: 'stop', poeLeftOff: true, sessionMaybeOpen: false, switch: { id: SW, host: sw.host }, portsLeftOff: [8] } });
    } finally {
      sw.failSet = 0;
      sw.poec[0] = 1;
      await sim.sim.engine.powerOn(300).catch(() => {});
    }
  }, 30000);

  it('a proxy stop while the switch stops answering: bounded, and the audit says PoE may be off and the switch session may be open', async () => {
    const { p, ctl } = await operated();
    try {
      void ctl.cycle(8, () => undefined, { verifyHost: null }).catch(() => {});
      await until(() => sw.poec[0] === 0, 5000);
      sw.hang = true;
      const t0 = Date.now();
      await p.proxy.stop({ reason: 'test' });
      expect(Date.now() - t0).toBeLessThan(10000);
      const rec = p.proxy.audit.list({ actions: ['camera-powercycle'] }).records.find((x) => (x.cam_proxy as { phase?: string } | undefined)?.phase === 'stop');
      expect(rec).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { poeLeftOff: true, sessionMaybeOpen: true } });
      expect(rec?.message).toMatch(/web session on PoE switch sw_test .* may still be open/);
    } finally {
      sw.hang = false;
      sw.expireSession();
      sw.poec[0] = 1;
      await sim.sim.engine.powerOn(300).catch(() => {});
    }
  }, 30000);
});
