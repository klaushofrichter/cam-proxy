import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { ARGS_VALIDATORS } from '../src/fleet/command-args';
import type { CommandBody } from '../src/fleet/command-check';
import type { Done } from '../src/fleet/commands';
import { ALLOW_ENTRIES, DEFAULT_ON, DISRUPTIVE_ENTRIES, ENTRY_TEXT, IMPLEMENTED, entryFor } from '../src/fleet/policy';
import { ASK_TIMEOUT_MS, CameraPowerStore, POWER_FILE, powerHandlers, powerView, requestPowerCycle } from '../src/fleet/power-commands';
import type { AdminEvent } from '../src/fleet/outbox';
import { CameraReboot, type RebootDeps } from '../src/camera/reboot';
import { poeHttpStatus } from '../src/camera/switch/errors';
import { strict, why } from './helpers/contract';
import { until } from './helpers/proxy';

// camera.power.set|cycling|cycled|cycle.result and the camera.power.cycle.request
// event (spec 2026-11-07-poe-switches-design, "Who does what", "Asking from a
// proxy"): cams-admin runs the cycle through the operating proxy; this proxy
// keeps the camera's reboot state, its cooldown and its watch.
const POWER = ['camera.power.set', 'camera.power.cycling', 'camera.power.cycled', 'camera.power.cycle.result'];
const CMD = `cmd_${'7'.repeat(20)}`;
const body = (command: string): CommandBody => ({ proxyId: `prx_${'1'.repeat(20)}`, connId: `con_${'2'.repeat(20)}`, cmdId: CMD, exp: 0, actor: 'admin@example.org', command, args: {} });

function setup(over: Partial<RebootDeps> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'power-cmd-'));
  const t = { now: 1_800_000_000_000 };
  const checks: Array<{ ok: boolean; serial?: string }> = [];
  const records: Record<string, any>[] = [];
  const audit = { write: (r: Record<string, any>) => void records.push(r) };
  const deps: RebootDeps = {
    send: vi.fn(async () => ({ rspCode: 200 })),
    forgetToken: vi.fn(),
    serial: () => 'S1',
    check: vi.fn(async () => checks.shift() ?? { ok: false }),
    audit: audit as any,
    pollMs: 5,
    now: () => t.now,
    ...over,
  };
  const reboot = new CameraReboot(deps);
  const store = new CameraPowerStore(dataDir, () => t.now);
  const h = powerHandlers({ store, cameraIds: () => ['cam1'], reboot: () => reboot, audit: audit as any });
  const run = async (command: string, args: object): Promise<Done> => (await h[command]({ v: 1, ...args }, body(command))) as Done;
  const ok = (command: string, d: Done) => {
    expect(d.status, JSON.stringify(d)).toBe('ok');
    const v = strict(`commands/${command}.result`);
    expect(v(d.result), why(v)).toBe(true);
  };
  return { dataDir, t, checks, records, deps, reboot, store, run, ok };
}

describe('policy and validators', () => {
  it('the four commands are default-on allow entries, implemented, not disruptive, each with a sentence', () => {
    for (const c of POWER) {
      expect(ALLOW_ENTRIES).toContain(c);
      expect(DEFAULT_ON).toContain(c);
      expect(IMPLEMENTED.has(c)).toBe(true);
      expect(DISRUPTIVE_ENTRIES.has(c)).toBe(false);
      expect(entryFor(c, {})).toBe(c);
      expect(ARGS_VALIDATORS[c]).toBeTypeOf('function');
      expect(ENTRY_TEXT[c]).toMatch(/^cams-admin /);
    }
  });

  it('validators accept the contract shapes and refuse the rest', () => {
    const ok = (c: string, a: object) => {
      expect(ARGS_VALIDATORS[c](a).ok).toBe(true);
      const v = strict(`commands/${c}.args`);
      expect(v(a), why(v)).toBe(true);
    };
    const bad = (c: string, a: object) => expect(ARGS_VALIDATORS[c](a).ok).toBe(false);
    ok('camera.power.set', { v: 1, camera: 'cam1', power: { kind: 'poe', switchName: 'Switch 2', port: 3, watts: 4.5, verifiedAt: 1, notSeen: false } });
    ok('camera.power.set', { v: 1, camera: 'cam1', power: { kind: 'unknown' } });
    bad('camera.power.set', { v: 1, camera: 'cam1', power: { kind: 'battery' } });
    bad('camera.power.set', { v: 1, camera: 'cam1', power: { kind: 'poe', port: 65 } });
    bad('camera.power.set', { v: 1, camera: 'cam1', power: { kind: 'poe', switchName: 'x'.repeat(65) } });
    bad('camera.power.set', { v: 1, camera: 'cam1', power: { kind: 'poe', password: 'x' } });
    bad('camera.power.set', { v: 1, camera: 'Cam_1', power: { kind: 'poe' } });
    expect(ARGS_VALIDATORS['camera.power.set']({ v: 2, camera: 'cam1', power: { kind: 'poe' } })).toMatchObject({ ok: false, code: 'unsupported_version' });
    ok('camera.power.cycling', { v: 1, camera: 'cam1', at: 5 });
    bad('camera.power.cycling', { v: 1, camera: 'cam1', at: -1 });
    bad('camera.power.cycling', { v: 1, camera: 'cam1', at: 1.5 });
    ok('camera.power.cycled', { v: 1, camera: 'cam1', ok: true, message: '' });
    bad('camera.power.cycled', { v: 1, camera: 'cam1', ok: true, message: 'x'.repeat(201) });
    bad('camera.power.cycled', { v: 1, camera: 'cam1', ok: 'yes', message: '' });
    ok('camera.power.cycle.result', { v: 1, camera: 'cam1', requestId: 'pc_1', ok: false, reason: 'not PoE powered' });
    ok('camera.power.cycle.result', { v: 1, camera: 'cam1', requestId: 'pc_1', ok: true });
    bad('camera.power.cycle.result', { v: 1, camera: 'cam1', requestId: '', ok: true });
    bad('camera.power.cycle.result', { v: 1, camera: 'cam1', requestId: 'x'.repeat(65), ok: true });
    bad('camera.power.cycle.result', { v: 1, camera: 'cam1', requestId: 'pc_1', ok: true, force: true });
  });

  it('a switch refusal that is not_verified is a 409 like busy, no power and no password', () => {
    for (const c of ['not_verified', 'switch_busy', 'no_power', 'password_unset'] as const) expect(poeHttpStatus(c)).toBe(409);
    for (const c of ['switch_auth', 'switch_unreachable', 'switch_error'] as const) expect(poeHttpStatus(c)).toBe(502);
  });
});

describe('camera.power.set', () => {
  it('stores the display record, in memory and in camera-power.json (read again by a new store)', async () => {
    const s = setup();
    const power = { kind: 'poe' as const, switchName: 'Switch 2', port: 3, watts: 4.5, verifiedAt: s.t.now - 7200_000 };
    s.ok('camera.power.set', await s.run('camera.power.set', { camera: 'cam1', power }));
    expect(s.store.view('cam1')).toMatchObject({ power, setAt: s.t.now, asked: null, result: null });
    expect(existsSync(join(s.dataDir, POWER_FILE))).toBe(true);
    expect(JSON.parse(readFileSync(join(s.dataDir, POWER_FILE), 'utf8'))).toMatchObject({ v: 1, cameras: { cam1: { power, setAt: s.t.now } } });
    expect(new CameraPowerStore(s.dataDir).view('cam1').power).toEqual(power);
    s.ok('camera.power.set', await s.run('camera.power.set', { camera: 'cam1', power: { kind: 'adapter' } }));
    expect(new CameraPowerStore(s.dataDir).view('cam1').power).toEqual({ kind: 'adapter' });
  });

  it('an unknown camera: failed unknown_camera, nothing stored', async () => {
    const s = setup();
    expect(await s.run('camera.power.set', { camera: 'cam9', power: { kind: 'poe' } })).toEqual({ status: 'failed', code: 'unknown_camera' });
    expect(s.store.view('cam9').power).toBeNull();
    expect(await s.run('camera.power.cycling', { camera: 'cam9', at: 1 })).toEqual({ status: 'failed', code: 'unknown_camera' });
  });
});

describe('camera.power.cycling and camera.power.cycled', () => {
  it('cycling then cycled ok drives the reboot state like a power-cycle: cooldown, token dropped, watch until the camera answers', async () => {
    const s = setup();
    const at = s.t.now - 1000;
    s.ok('camera.power.cycling', await s.run('camera.power.cycling', { camera: 'cam1', at }));
    expect(s.reboot.state()).toMatchObject({ kind: 'powercycle', phase: 'power-cycling', offAt: at, endedAt: null });
    expect(s.deps.forgetToken).toHaveBeenCalledTimes(1);
    // The cooldown is shared with the reboot.
    expect(await s.reboot.request({ requestedBy: 'token' })).toMatchObject({ status: 429 });
    expect(s.reboot.cooldown()).toMatchObject({ status: 429 });
    expect(s.records[0]).toMatchObject({ action: 'camera-powercycle', type: ['change'], outcome: 'success', user: 'cams-admin', details: { phase: 'requested', via: 'cams-admin', offAt: at, requestedBy: 'cams-admin' } });
    s.ok('camera.power.cycled', await s.run('camera.power.cycled', { camera: 'cam1', ok: true, message: 'PoE on again after 10 s' }));
    expect(s.reboot.state()).toMatchObject({ kind: 'powercycle', phase: 'rebooting' });
    expect(s.records[1]).toMatchObject({ action: 'camera-powercycle', outcome: 'success', details: { phase: 'cycled', via: 'cams-admin' } });
    expect(s.records[1].message).toContain('PoE on again after 10 s');
    s.checks.push({ ok: false }, { ok: true, serial: 'S2' });
    await until(() => s.reboot.state()?.phase === 'back', 2000);
    expect(s.reboot.state()!.downSec).toEqual(expect.any(Number));
    expect(s.records.at(-1)).toMatchObject({ action: 'camera-powercycle', type: ['end'], outcome: 'success', details: { phase: 'back' } });
    s.reboot.stop();
  });

  it('cycled ok:false ends it with the message', async () => {
    const s = setup();
    await s.run('camera.power.cycling', { camera: 'cam1', at: s.t.now });
    s.ok('camera.power.cycled', await s.run('camera.power.cycled', { camera: 'cam1', ok: false, message: 'PoE may still be OFF on Switch 2 port 3' }));
    expect(s.reboot.state()).toMatchObject({ kind: 'powercycle', phase: 'not-back', endedAt: s.t.now, message: 'PoE may still be OFF on Switch 2 port 3' });
    const last = s.records.at(-1)!;
    expect(last).toMatchObject({ action: 'camera-powercycle', type: ['end'], outcome: 'failure', details: { phase: 'failed', via: 'cams-admin' } });
    expect(last.message).toContain('PoE may still be OFF on Switch 2 port 3');
    // The watch ended with it: no "back" record later.
    s.checks.push({ ok: false }, { ok: true, serial: 'S2' });
    await new Promise((r) => setTimeout(r, 50));
    expect(s.reboot.state()!.phase).toBe('not-back');
  });

  it('cycling while a reboot is under way: ok, logged, the state switches to power-cycling with the new offAt; no second watch', async () => {
    const s = setup();
    expect((await s.reboot.request({ requestedBy: 'token' })).status).toBe(202);
    expect(s.reboot.state()).toMatchObject({ kind: 'reboot', phase: 'rebooting' });
    // The reboot's watch has seen the camera down.
    await until(() => (s.deps.check as ReturnType<typeof vi.fn>).mock.calls.length > 0, 1000);
    s.t.now += 30_000;
    s.ok('camera.power.cycling', await s.run('camera.power.cycling', { camera: 'cam1', at: s.t.now }));
    expect(s.reboot.state()).toMatchObject({ kind: 'powercycle', phase: 'power-cycling', offAt: s.t.now, endedAt: null });
    expect(s.records.at(-1)).toMatchObject({ action: 'camera-powercycle', details: { phase: 'requested', via: 'cams-admin', duringReboot: true } });
    // The same watch goes on: it saw the camera down, so an answer with the
    // same serial is "back" (a new watch would wait for a failed check first).
    s.checks.push({ ok: true, serial: 'S1' });
    await until(() => s.reboot.state()?.phase === 'back', 2000);
    expect(s.records.filter((r) => r.type?.[0] === 'end')).toHaveLength(1);
    s.reboot.stop();
  });

  it('an operator clock ahead of ours: offAt is never in the future', async () => {
    const s = setup();
    await s.run('camera.power.cycling', { camera: 'cam1', at: s.t.now + 60_000 });
    expect(s.reboot.state()!.offAt).toBe(s.t.now);
    s.reboot.stop();
  });
});

describe('camera.power.cycle.result and the request', () => {
  const connected = (events: AdminEvent[], on = true) => ({ emit: (e: AdminEvent) => void events.push(e), connected: () => on });

  it('the request: 202 {requestId}, exactly one camera.power.cycle.request event (strict), "asked" until the result', async () => {
    const s = setup();
    await s.run('camera.power.set', { camera: 'cam1', power: { kind: 'poe', switchName: 'Switch 2', port: 3 } });
    const events: AdminEvent[] = [];
    const a = requestPowerCycle({ ...connected(events), store: s.store, reboot: () => s.reboot, audit: { write: (r: any) => void s.records.push(r) } as any, now: () => s.t.now }, 'cam1', { user: 'admin', requestedBy: 'session', ip: '10.0.0.5' });
    expect(a).toEqual({ status: 202, requestId: expect.stringMatching(/^pc_[0-9A-HJKMNP-TV-Z]{26}$/) });
    const requestId = (a as { requestId: string }).requestId;
    expect(events).toEqual([{ kind: 'camera.power.cycle.request', camera: 'cam1', requestId }]);
    const v = strict('event');
    const env = { v: 1, type: 'event', id: '01K60000000000000000000017', seq: 1, ts: 1, sig: 'A'.repeat(86) + '==', body: { ...events[0], proxyId: `prx_${'1'.repeat(20)}`, connId: `con_${'2'.repeat(20)}` } };
    expect(v(env), why(v)).toBe(true);
    expect(s.store.view('cam1').asked).toEqual({ requestId, at: s.t.now });
    expect(s.records.at(-1)).toMatchObject({ action: 'camera-powercycle', outcome: 'success', user: 'admin', ip: '10.0.0.5', details: { phase: 'asked', requestId, requestedBy: 'session', via: 'cams-admin' } });
    // No cooldown and no state yet: cams-admin decides.
    expect(s.reboot.state()).toBeNull();

    s.t.now += 5000;
    s.ok('camera.power.cycle.result', await s.run('camera.power.cycle.result', { camera: 'cam1', requestId, ok: false, reason: 'not verified: the camera did not answer the ping burst' }));
    expect(s.store.view('cam1')).toMatchObject({ asked: null, result: { requestId, ok: false, reason: 'not verified: the camera did not answer the ping burst', at: s.t.now } });
    expect(s.records.at(-1)).toMatchObject({ action: 'camera-powercycle', outcome: 'failure', user: 'cams-admin', details: { phase: 'result', requestId, via: 'cams-admin' } });
  });

  it('a result for another request leaves the open one asked', async () => {
    const s = setup();
    s.store.set('cam1', { kind: 'poe' });
    s.store.ask('cam1', 'pc_A');
    await s.run('camera.power.cycle.result', { camera: 'cam1', requestId: 'pc_B', ok: true });
    expect(s.store.view('cam1')).toMatchObject({ asked: { requestId: 'pc_A' }, result: { requestId: 'pc_B', ok: true } });
  });

  it('409 power_cycle_needs_cams_admin: not connected, or no power record from cams-admin; 429 within the cooldown; nothing emitted', async () => {
    const s = setup();
    const events: AdminEvent[] = [];
    const deps = (on: boolean) => ({ ...connected(events, on), store: s.store, reboot: () => s.reboot, audit: { write: (r: any) => void s.records.push(r) } as any, now: () => s.t.now });
    const who = { user: 'admin', requestedBy: 'token' as const };
    expect(requestPowerCycle(deps(true), 'cam1', who)).toMatchObject({ status: 409, error: 'power_cycle_needs_cams_admin', detail: expect.stringContaining('cams-admin') });
    s.store.set('cam1', { kind: 'poe' });
    expect(requestPowerCycle(deps(false), 'cam1', who)).toMatchObject({ status: 409, error: 'power_cycle_needs_cams_admin' });
    expect(events).toEqual([]);
    expect(s.records).toEqual([]);
    await s.run('camera.power.cycling', { camera: 'cam1', at: s.t.now });
    expect(requestPowerCycle(deps(true), 'cam1', who)).toMatchObject({ status: 429, retryAfterS: 120 });
    expect(events).toEqual([]);
    s.reboot.stop();
  });

  it('a second request while one is open: 429 in_flight, no second event; after the answer or the 5 minutes it can ask again', async () => {
    const s = setup();
    s.store.set('cam1', { kind: 'poe' });
    const events: AdminEvent[] = [];
    const deps = { ...connected(events), store: s.store, reboot: () => s.reboot, audit: { write: (r: any) => void s.records.push(r) } as any, now: () => s.t.now };
    const who = { user: 'admin', requestedBy: 'token' as const };
    const a = requestPowerCycle(deps, 'cam1', who) as { requestId: string };
    s.t.now += 60_000;
    expect(requestPowerCycle(deps, 'cam1', who)).toEqual({ status: 429, error: 'in_flight', detail: 'a power-cycle of this camera was asked of cams-admin and is not answered yet', retryAfterS: 240 });
    expect(events).toHaveLength(1);
    expect(s.records).toHaveLength(1);
    await s.run('camera.power.cycle.result', { camera: 'cam1', requestId: a.requestId, ok: false, reason: 'not verified' });
    expect(requestPowerCycle(deps, 'cam1', who)).toMatchObject({ status: 202 });
    expect(events).toHaveLength(2);
    s.t.now += ASK_TIMEOUT_MS;
    expect(requestPowerCycle(deps, 'cam1', who)).toMatchObject({ status: 202 });
    expect(events).toHaveLength(3);
  });

  it('an unanswered request ends after 5 minutes: a failed result says so, a late answer still replaces it', async () => {
    const s = setup();
    s.store.set('cam1', { kind: 'poe' });
    const events: AdminEvent[] = [];
    const a = requestPowerCycle({ ...connected(events), store: s.store, reboot: () => s.reboot, audit: { write: () => undefined } as any, now: () => s.t.now }, 'cam1', { user: 'admin', requestedBy: 'token' });
    const requestId = (a as { requestId: string }).requestId;
    const asked = s.t.now;
    expect(ASK_TIMEOUT_MS).toBe(300_000);
    s.t.now += ASK_TIMEOUT_MS - 1;
    expect(s.store.view('cam1')).toMatchObject({ asked: { requestId }, result: null });
    s.t.now += 1;
    expect(s.store.view('cam1')).toMatchObject({ asked: null, result: { requestId, ok: false, reason: 'no answer from cams-admin within 5 minutes', at: asked + ASK_TIMEOUT_MS } });
    // The button can ask again.
    expect(powerView({ ...connected(events), store: s.store, configured: () => true }, 'cam1')).toMatchObject({ asked: null, canRequest: true });
    s.t.now += 60_000;
    await s.run('camera.power.cycle.result', { camera: 'cam1', requestId, ok: true });
    expect(s.store.view('cam1')).toMatchObject({ asked: null, result: { requestId, ok: true, at: s.t.now } });
    expect(s.store.view('cam1').result!.reason).toBeUndefined();
  });

  it('unenrolled or cams-admin switched off: the open request ends (no answer can come)', () => {
    const s = setup();
    s.store.set('cam1', { kind: 'poe' });
    s.store.ask('cam1', 'pc_A');
    const events: AdminEvent[] = [];
    expect(powerView({ ...connected(events, false), store: s.store, configured: () => true }, 'cam1').asked).toMatchObject({ requestId: 'pc_A' });
    expect(powerView({ ...connected(events, false), store: s.store, configured: () => false }, 'cam1')).toMatchObject({ asked: null, canRequest: false });
  });
});
