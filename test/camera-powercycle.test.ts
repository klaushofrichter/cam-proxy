// Issue #85: power-cycle the camera through its PoE switch,
// POST /control/actions/camera-powercycle. The switch is the mock in
// test/helpers; the real switch is never contacted.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLog } from '../src/audit/audit-log';
import { CameraReboot, type RebootDeps } from '../src/camera/reboot';
import { PoeSwitchError, type CycleResult } from '../src/camera/poe-switch';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, CLIENT_TOKEN, startProxy, until } from './helpers/proxy';
import { startPoeSwitchMock, type PoeSwitchMock } from './helpers/poe-switch-mock';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const who = { requestedBy: 'token' as const, ip: '10.0.0.5', userAgent: 'test' };
const INFO = { switch: { model: 'sscpoe-web', host: '192.0.2.7', port: 8 }, offSeconds: 10 };

function make(over: Partial<RebootDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'powercycle-audit-'));
  dirs.push(dir);
  const audit = new AuditLog({ dir, version: 'dev', camera: () => 'cam1' });
  const checks: Array<{ ok: boolean; serial?: string }> = [];
  const deps: RebootDeps = {
    send: vi.fn(async () => ({ rspCode: 200 })),
    forgetToken: vi.fn(),
    serial: () => 'S1',
    check: vi.fn(async () => checks.shift() ?? { ok: false }),
    audit,
    pollMs: 5,
    ...over,
  };
  const r = new CameraReboot(deps);
  const records = (action = 'camera-powercycle') => audit.list({ actions: [action], limit: 100 }).records.reverse();
  return { r, deps, audit, checks, records };
}
// A switch run: PoE off (onOff), then back on.
const run = (watts = 6.8, hold?: Promise<void>) => async (onOff: (at: number) => void): Promise<CycleResult> => {
  const offAt = Date.now();
  onOff(offAt);
  await hold;
  return { offAt, onAt: Date.now(), watts };
};

describe('CameraReboot.powerCycle', () => {
  it('answers 202 {offAt, onAt, watts}: "power-cycling" while PoE is off, then "rebooting"; forgets the token; records the request', async () => {
    const { r, deps, records } = make();
    let release!: () => void;
    const hold = new Promise<void>((x) => (release = x));
    const p = r.powerCycle(who, INFO, run(6.8, hold));
    await until(() => r.state()?.phase === 'power-cycling', 1000);
    expect(r.state()).toMatchObject({ kind: 'powercycle', phase: 'power-cycling', offAt: expect.any(Number) });
    expect(deps.forgetToken).toHaveBeenCalledTimes(1);
    release();
    const a = await p;
    r.stop();
    expect(a).toEqual({ status: 202, offAt: expect.any(Number), onAt: expect.any(Number), watts: 6.8 });
    expect(r.state()).toMatchObject({ kind: 'powercycle', phase: 'rebooting' });
    expect(deps.send).not.toHaveBeenCalled();
    expect(records()[0]).toMatchObject({
      event: { category: ['host'], type: ['change'], action: 'camera-powercycle', outcome: 'success' },
      user: { name: 'admin' }, source: { ip: '10.0.0.5' },
      cam_proxy: { switch: { model: 'sscpoe-web', host: '192.0.2.7', port: 8 }, watts: 6.8, offSeconds: 10, requestedBy: 'token', phase: 'requested' },
    });
  });

  it('records the camera back with the seconds since the cut', async () => {
    const { r, checks, records } = make();
    checks.push({ ok: false }, { ok: true, serial: 'S2' });
    await r.powerCycle(who, INFO, run());
    await until(() => r.state()?.phase === 'back', 2000);
    expect(records()[1]).toMatchObject({ event: { action: 'camera-powercycle', type: ['end'], outcome: 'success' }, user: { name: 'system' }, cam_proxy: { phase: 'back', downSec: expect.any(Number) } });
    r.stop();
  });

  it('records a failure when the camera is not back in time', async () => {
    const { r, records } = make({ timeoutMs: 50 });
    await r.powerCycle(who, INFO, run());
    await until(() => r.state()?.phase === 'not-back', 2000);
    expect(records()[1]).toMatchObject({ event: { action: 'camera-powercycle', outcome: 'failure' }, cam_proxy: { phase: 'not-back' } });
    r.stop();
  });

  it('shares the 120 s cooldown with the camera reboot, both ways', async () => {
    const t = { now: 1_000_000 };
    const a = make({ now: () => t.now, check: async () => ({ ok: true, serial: 'S1' }) });
    expect((await a.r.request(who)).status).toBe(202);
    t.now += 60_000;
    expect(await a.r.powerCycle(who, INFO, run())).toEqual({ status: 429, retryAfterS: 60, inFlight: false });
    a.r.stop();
    const b = make({ now: () => t.now, check: async () => ({ ok: true, serial: 'S1' }) });
    expect((await b.r.powerCycle(who, INFO, run())).status).toBe(202);
    t.now += 119_000;
    expect(await b.r.request(who)).toEqual({ status: 429, retryAfterS: 1, inFlight: false });
    expect(b.deps.send).not.toHaveBeenCalled();
    b.r.stop();
  });

  it('refuses a reboot or a second power-cycle while one is in flight (429, inFlight)', async () => {
    const { r, deps } = make();
    let release!: () => void;
    const hold = new Promise<void>((x) => (release = x));
    const p = r.powerCycle(who, INFO, run(6.8, hold));
    expect(await r.request(who)).toMatchObject({ status: 429, inFlight: true });
    expect(await r.powerCycle(who, INFO, run())).toMatchObject({ status: 429, inFlight: true });
    expect(deps.send).not.toHaveBeenCalled();
    release();
    await p;
    r.stop();
  });

  it('a refusal before PoE went off (busy, no power, wrong password): 409 or 502, a failure record, no cooldown, no state', async () => {
    const { r, deps, records } = make();
    for (const [code, status] of [['switch_busy', 409], ['no_power', 409], ['switch_auth', 502], ['switch_unreachable', 502]] as const) {
      const a = await r.powerCycle(who, INFO, async () => { throw new PoeSwitchError(code, `mock ${code}`); });
      expect(a).toEqual({ status, error: code, detail: `mock ${code}` });
    }
    expect(r.state()).toBeNull();
    expect(deps.forgetToken).not.toHaveBeenCalled();
    const recs = records();
    expect(recs).toHaveLength(4);
    expect(recs[0]).toMatchObject({ event: { outcome: 'failure', type: ['change'] }, error: { message: 'switch_busy' }, cam_proxy: { switch: INFO.switch, phase: 'requested', poeOff: false } });
    // No cooldown: a power-cycle goes through now.
    expect((await r.powerCycle(who, INFO, run())).status).toBe(202);
    r.stop();
  });

  it('PoE may still be off (the switch did not turn it on): 502 with poeOff, turnedOn false; audited with the truth; cooldown and watch run', async () => {
    const { r, records } = make();
    const a = await r.powerCycle(who, INFO, async (onOff) => {
      onOff(Date.now());
      throw new PoeSwitchError('switch_error', 'PoE may still be OFF on port 8', true, false);
    });
    expect(a).toEqual({ status: 502, error: 'switch_error', detail: 'PoE may still be OFF on port 8', poeOff: true, turnedOn: false });
    expect(r.state()).toMatchObject({ kind: 'powercycle', phase: 'rebooting' });
    expect(records()[0]).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { poeOff: true, turnedOn: false } });
    // The cut's time (#106): the stills inventory counts the outage from it, not from this record.
    expect(records()[0].cam_proxy!.offAt).toBe(r.state()!.offAt);
    expect(records()[0].message).toMatch(/PoE may have been cut; turned back on: no/);
    expect((await r.request(who)).status).toBe(429);
    r.stop();
  });

  it('the off answer was lost (onOff never ran): poeOff from the error decides, not a refusal', async () => {
    const { r, deps, records } = make();
    const a = await r.powerCycle(who, INFO, async () => {
      throw new PoeSwitchError('switch_error', 'PoE may have been cut on port 8; it is on again (no answer)', true, true);
    });
    expect(a).toMatchObject({ status: 502, error: 'switch_error', poeOff: true, turnedOn: true });
    expect(deps.forgetToken).toHaveBeenCalledTimes(1);
    expect(r.state()).toMatchObject({ kind: 'powercycle', phase: 'rebooting', offAt: expect.any(Number) });
    const rec = records()[0];
    expect(rec).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'switch_error' }, cam_proxy: { poeOff: true, turnedOn: true } });
    expect(rec.message).toMatch(/PoE may have been cut; turned back on: yes/);
    expect(rec.message).not.toMatch(/refused/);
    // The cooldown runs: a retry is 429, not a no_power refusal.
    expect((await r.powerCycle(who, INFO, run())).status).toBe(429);
    r.stop();
  });
});

// Every file under a folder, as text.
function allText(dir: string): string {
  return readdirSync(dir).map((f) => {
    const full = join(dir, f);
    return statSync(full).isDirectory() ? allText(full) : readFileSync(full).toString('latin1');
  }).join('\n');
}

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
  const configure = (base: string, over: object = {}) => request(base).put('/control/config').set(admin()).send({ camera: { poeSwitch: { model: 'sscpoe-web', host: sw.host, port: 8, offSeconds: 5, ...over } } });
  const post = (base: string) => request(base).post('/control/actions/camera-powercycle').set(admin());

  it('409 not_configured: model none, or no password; nothing reaches the switch', async () => {
    const p = await startProxy(sim, { env: { CAMPROXY_POE_SWITCH_PASSWORD: PASSWORD } });
    const q = await startProxy(sim);
    try {
      const calls = sw.calls.length;
      const r = await post(p.base);
      expect([r.status, r.body]).toEqual([409, { error: 'not_configured', detail: 'camera.poeSwitch.model is none' }]);
      expect((await request(p.base).get('/control/status').set(admin())).body.camera.poeSwitch).toMatchObject({ model: 'none', configured: false, passwordSet: true });
      await configure(q.base);
      const r2 = await post(q.base);
      expect([r2.status, r2.body]).toEqual([409, { error: 'not_configured', detail: 'CAMPROXY_POE_SWITCH_PASSWORD is not set' }]);
      expect(sw.calls.length).toBe(calls);
      // Not a reboot: no camera-powercycle record, no control-action record.
      expect(p.proxy.audit.list({ actions: ['camera-powercycle', 'control-action'] }).records).toHaveLength(0);
    } finally {
      await p.proxy.stop();
      await q.proxy.stop();
    }
  });

  it('refuses the client and the audit token (403), and a session without the CSRF header', async () => {
    const p = await startProxy(sim, { env: { CAMPROXY_POE_SWITCH_PASSWORD: PASSWORD, CAMPROXY_AUDIT_TOKEN: AUDIT_TOKEN } });
    try {
      await configure(p.base);
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

  it('switch busy (409 switch_busy), no power (409 no_power), wrong password (502 switch_auth); logged out every time', async () => {
    const p = await startProxy(sim, { env: { CAMPROXY_POE_SWITCH_PASSWORD: PASSWORD } });
    const wrong = await startProxy(sim, { env: { CAMPROXY_POE_SWITCH_PASSWORD: 'wrong-switch-pw-4242' } });
    try {
      await configure(p.base);
      sw.browserLogin();
      const busy = await post(p.base);
      sw.browserLogout();
      expect(busy.status).toBe(409);
      expect(busy.body).toMatchObject({ error: 'switch_busy', detail: expect.stringContaining("logged in to the switch's web UI") });
      await configure(p.base, { port: 3 });
      const none = await post(p.base);
      expect([none.status, none.body.error]).toEqual([409, 'no_power']);
      expect(sw.activeSession()).toBe(false);
      await configure(wrong.base);
      const bad = await post(wrong.base);
      expect([bad.status, bad.body.error]).toEqual([502, 'switch_auth']);
      expect(bad.text).not.toContain('wrong-switch-pw-4242');
      expect(sw.opcodes).toEqual([]);
      expect(sw.activeSession()).toBe(false);
      expect(p.proxy.audit.list({ actions: ['camera-powercycle'] }).records.map((x) => x.event.outcome)).toEqual(['failure', 'failure']);
      // No cooldown after a refusal: the real cycle runs in the next test.
    } finally {
      await p.proxy.stop();
      await wrong.proxy.stop();
    }
  });

  it('power-cycles: 202 once PoE is back, the camera is "power-cycling", then back; the cooldown is shared; audited; the password is nowhere', async () => {
    const p = await startProxy(sim, { env: { CAMPROXY_POE_SWITCH_PASSWORD: PASSWORD }, settings: { server: { logLevel: 'info' } } });
    try {
      await configure(p.base);
      await until(() => p.proxy.intake.state().onvif === 'subscribed' && p.proxy.status.state().online);
      const reset = vi.spyOn(p.proxy.recordings, 'reset');
      // The switch, read when asked (never polled).
      const read = await request(p.base).post('/control/actions/poe-switch-read').set(admin());
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ port: 8, index: 0, poe: true, watts: 6.8, sn: 'GPS208MOCK0001' });
      const t0 = Date.now();
      const pending = post(p.base).then((r) => r);
      await until(async () => (await request(p.base).get('/control/status').set(admin())).body.camera.reboot?.phase === 'power-cycling', 3000);
      // A reboot while the power-cycle is in flight: 429, not "rebooted less than 2 minutes ago".
      const during = await request(p.base).post('/control/actions/camera-reboot').set(admin());
      expect(during.status).toBe(429);
      expect(during.body.detail).toMatch(/in progress/);
      expect(during.body.detail).not.toMatch(/less than 2 minutes ago/);
      // The PoE-off went out: the recordings side was reset (its session would be dead).
      expect(reset).toHaveBeenCalled();
      const r = await pending;
      expect(r.status).toBe(202);
      expect(r.body).toEqual({ offAt: expect.any(Number), onAt: expect.any(Number), watts: 6.8 });
      expect(r.body.onAt - r.body.offAt).toBeGreaterThanOrEqual(5000);
      expect(sw.opcodes).toEqual([0x2, 0x202]);
      expect(sw.activeSession()).toBe(false);
      // Shared cooldown: the camera reboot is refused now, and says why.
      const reboot = await request(p.base).post('/control/actions/camera-reboot').set(admin());
      expect(reboot.status).toBe(429);
      expect(reboot.body.detail).toMatch(/rebooted or power-cycled less than 2 minutes ago/);
      expect((await post(p.base)).status).toBe(429);
      await until(() => p.proxy.audit.list({ actions: ['camera-powercycle'] }).records.length === 2, 20000);
      const [back, req] = p.proxy.audit.list({ actions: ['camera-powercycle'] }).records;
      expect(req).toMatchObject({ event: { category: ['host'], type: ['change'], outcome: 'success' }, user: { name: 'admin' }, cam_proxy: { switch: { model: 'sscpoe-web', host: sw.host, port: 8 }, watts: 6.8, offSeconds: 5, requestedBy: 'token' } });
      expect(back).toMatchObject({ event: { outcome: 'success', type: ['end'] }, cam_proxy: { phase: 'back', downSec: expect.any(Number) } });
      const st = (await request(p.base).get('/control/status').set(admin())).body;
      expect(st.camera.reboot).toMatchObject({ kind: 'powercycle', phase: 'back' });
      expect(st.camera.poeSwitch).toMatchObject({ model: 'sscpoe-web', host: sw.host, port: 8, configured: true, passwordSet: true, last: { watts: 6.8 } });
      // The proxy logged in to the camera again, and ONVIF subscribed again.
      await until(() => p.proxy.intake.state().onvif === 'subscribed' && p.proxy.intake.state().since > t0, 15000);
      expect(p.proxy.audit.list({ actions: ['control-action'] }).records.map((x) => x.cam_proxy?.action)).toEqual(['poe-switch-read']);

      const answers = await Promise.all(['/control/log?limit=500', '/control/config', '/control/status', '/control/stats', '/control/audit?limit=500', '/metrics'].map((u) => request(p.base).get(u).set(admin())));
      for (const a of answers) {
        expect(a.status).toBe(200);
        expect(a.text).not.toContain(PASSWORD);
      }
      expect(answers[0].text).toContain('poe_switch_port_off');
      expect(allText(p.dir)).not.toContain(PASSWORD);
    } finally {
      await p.proxy.stop();
    }
  }, 40000);

  it('a proxy stop during the off time turns the PoE on again before the process ends', async () => {
    const p = await startProxy(sim, { env: { CAMPROXY_POE_SWITCH_PASSWORD: PASSWORD } });
    await configure(p.base, { offSeconds: 60 });
    const before = sw.opcodes.length;
    const pending = post(p.base).then((r) => r.status, () => 'closed');
    await until(() => sw.poec[0] === 0, 5000);
    const t0 = Date.now();
    await p.proxy.stop({ reason: 'test' });
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(sw.poec[0]).toBe(1);
    expect(sw.opcodes.slice(before)).toEqual([0x2, 0x202]);
    expect(sw.activeSession()).toBe(false);
    await pending;
  }, 20000);

  it('the off answer is lost on the switch: 502 poeOff, turnedOn; PoE is on again; audited as a failure; the cooldown runs', async () => {
    const p = await startProxy(sim, { env: { CAMPROXY_POE_SWITCH_PASSWORD: PASSWORD } });
    try {
      await configure(p.base);
      await until(() => p.proxy.status.state().online);
      const before = sw.opcodes.length;
      sw.offFault = 'drop';
      const r = await post(p.base);
      expect(r.status).toBe(502);
      expect(r.body).toMatchObject({ error: 'switch_error', poeOff: true, turnedOn: true });
      expect(sw.opcodes.slice(before)).toEqual([0x2, 0x202]);
      expect(sw.poec[0]).toBe(1);
      const st = (await request(p.base).get('/control/status').set(admin())).body;
      expect(st.camera.poeSwitch.poeMaybeOff).toBe(false);
      expect(st.camera.reboot).toMatchObject({ kind: 'powercycle' });
      expect(p.proxy.audit.list({ actions: ['camera-powercycle'] }).records[0]).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { poeOff: true, turnedOn: true } });
      expect((await post(p.base)).status).toBe(429);
    } finally {
      await p.proxy.stop();
    }
  }, 30000);

  it('POST camera-poe-on: admin only; turns the port on when it is off (no power check), audited as camera-poe-on', async () => {
    const p = await startProxy(sim, { env: { CAMPROXY_POE_SWITCH_PASSWORD: PASSWORD, CAMPROXY_AUDIT_TOKEN: AUDIT_TOKEN } });
    const on = (t = ADMIN_TOKEN) => request(p.base).post('/control/actions/camera-poe-on').set(auth(t));
    try {
      expect((await on()).body).toEqual({ error: 'not_configured', detail: 'camera.poeSwitch.model is none' });
      await configure(p.base);
      expect((await on(CLIENT_TOKEN)).status).toBe(403);
      expect((await on(AUDIT_TOKEN)).status).toBe(403);
      const before = sw.opcodes.length;
      sw.poec[0] = 0; // off, as after a failed power-cycle (cam-sim keeps running: only the switch state matters here)
      const r = await on();
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ port: 8, index: 0, wasOn: false, poe: true });
      expect(sw.opcodes.slice(before)).toEqual([0x202]);
      expect((await on()).body).toMatchObject({ wasOn: true, poe: true });
      expect(sw.opcodes.slice(before)).toEqual([0x202]);
      sw.browserLogin();
      const busy = await on();
      sw.browserLogout();
      expect([busy.status, busy.body.error]).toEqual([409, 'switch_busy']);
      const recs = p.proxy.audit.list({ actions: ['camera-poe-on'] }).records.reverse();
      expect(recs.map((x) => x.event.outcome)).toEqual(['success', 'success', 'failure']);
      expect(recs[0]).toMatchObject({ event: { category: ['host'], type: ['change'] }, user: { name: 'admin' }, cam_proxy: { switch: { model: 'sscpoe-web', host: sw.host, port: 8 }, wasOn: false, requestedBy: 'token' } });
      expect(recs[1].cam_proxy).toMatchObject({ wasOn: true });
      expect(p.proxy.audit.list({ actions: ['control-action'] }).records).toHaveLength(0);
      expect(JSON.stringify(recs)).not.toContain(PASSWORD);
    } finally {
      sw.browserLogout();
      await p.proxy.stop();
    }
  });

  it('a proxy stop that cannot turn the PoE on again says so loudly: an audit failure record', async () => {
    const p = await startProxy(sim, { env: { CAMPROXY_POE_SWITCH_PASSWORD: PASSWORD } });
    try {
      await configure(p.base, { offSeconds: 60 });
      void post(p.base).catch(() => {});
      await until(() => sw.poec[0] === 0, 5000);
      sw.failSet = 1000;
      const t0 = Date.now();
      await p.proxy.stop({ reason: 'test' });
      expect(Date.now() - t0).toBeLessThan(12000);
      const recs = p.proxy.audit.list({ actions: ['camera-powercycle'] }).records;
      const left = recs.find((x) => /left OFF/.test(String(x.message)));
      expect(left).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { phase: 'stop', poeLeftOff: true, sessionMaybeOpen: false } });
    } finally {
      sw.failSet = 0;
      sw.poec[0] = 1;
      await sim.sim.engine.powerOn(300).catch(() => {});
    }
  }, 30000);

  it('a proxy stop while the switch stops answering: bounded, and the audit says PoE may be off and the switch session may be open', async () => {
    const p = await startProxy(sim, { env: { CAMPROXY_POE_SWITCH_PASSWORD: PASSWORD } });
    try {
      await configure(p.base, { offSeconds: 60 });
      void post(p.base).catch(() => {});
      await until(() => sw.poec[0] === 0, 5000);
      sw.hang = true;
      const t0 = Date.now();
      await p.proxy.stop({ reason: 'test' });
      expect(Date.now() - t0).toBeLessThan(10000);
      const rec = p.proxy.audit.list({ actions: ['camera-powercycle'] }).records.find((x) => (x.cam_proxy as { phase?: string } | undefined)?.phase === 'stop');
      expect(rec).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { poeLeftOff: true, sessionMaybeOpen: true } });
      expect(rec?.message).toMatch(/web session on the switch may still be open/);
    } finally {
      sw.hang = false;
      sw.expireSession();
      sw.poec[0] = 1;
      await sim.sim.engine.powerOn(300).catch(() => {});
    }
  }, 30000);
});
