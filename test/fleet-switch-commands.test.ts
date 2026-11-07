import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { switchHandlers } from '../src/fleet/switch-commands';
import { ARGS_VALIDATORS } from '../src/fleet/command-args';
import type { CommandBody } from '../src/fleet/command-check';
import type { Done, Handler } from '../src/fleet/commands';
import { ALLOW_ENTRIES, DISRUPTIVE_ENTRIES, entryFor, IMPLEMENTED } from '../src/fleet/policy';
import { PoeSwitchError } from '../src/camera/poe-switch';
import { SwitchRegistry } from '../src/camera/switch/registry';
import { switchPasswordStore } from '../src/config/switch-passwords';
import { startPoeSwitchMock, type PoeSwitchMock } from './helpers/poe-switch-mock';
import { strict, why } from './helpers/contract';

// switch.read|locate|survey|cycle|poeOn|forget (spec 2026-11-07-poe-switches-design):
// against the mock switch (never a real one); results validated against the
// vendored result schemas.
const PASSWORD = 'mock-switch-pw-4711';
const SW = 'sw_abcdefghijABCDEFGHIJ';
const CAM = 'cam_0123456789ABCDEFGHJK';
const CAM2 = 'cam_0123456789ABCDEFGHJM';
const CMD = `cmd_${'5'.repeat(20)}`;
const body = (command: string): CommandBody => ({ proxyId: `prx_${'1'.repeat(20)}`, connId: `con_${'2'.repeat(20)}`, cmdId: CMD, exp: 0, actor: 'admin@example.org', command, args: {} });

const mocks: PoeSwitchMock[] = [];
afterEach(async () => {
  for (const m of mocks.splice(0)) await m.close();
});

async function setup(o: { password?: boolean; at?: Record<string, number>; answered?: boolean } = {}) {
  const m = await startPoeSwitchMock({ password: PASSWORD, powered: { 0: 6.8, 5: 4.5, 6: 3.2 } });
  mocks.push(m);
  const dataDir = mkdtempSync(join(tmpdir(), 'swcmd-'));
  if (o.password !== false) switchPasswordStore(dataDir).set(SW, PASSWORD);
  const at = o.at ?? {};
  const registry = new SwitchRegistry({
    dataDir, legacy: () => ({ model: 'none', ports: 8, offSeconds: 10 }), legacyPassword: () => undefined,
    sleep: async () => undefined, timeoutMs: 1000,
    pingBurst: (host: string) => {
      m.tx.fill(1);
      if (at[host] !== undefined) m.tx[at[host]] = 40;
      return { done: Promise.resolve({ answered: o.answered ?? true }) };
    },
  });
  const records: Record<string, any>[] = [];
  const h = switchHandlers({ registry, audit: { write: (r: any) => void records.push(r) } as any });
  const sw = { id: SW, model: 'sscpoe-web', host: m.host, ports: 8, offSeconds: 10 };
  const run = async (command: string, args: object): Promise<Done> => (await h[command]({ v: 1, ...args }, body(command))) as Done;
  const okResult = (command: string, d: Done) => {
    expect(d.status, JSON.stringify(d)).toBe('ok');
    const v = strict(`commands/${command}.result`);
    expect(v(d.result), why(v)).toBe(true);
  };
  return { m, registry, records, sw, run, okResult, h: h as Record<string, Handler>, dataDir };
}

describe('policy and validators', () => {
  it('the six commands are allow entries, implemented, and switch.cycle is disruptive', () => {
    for (const c of ['switch.read', 'switch.locate', 'switch.survey', 'switch.cycle', 'switch.poeOn', 'switch.forget']) {
      expect(ALLOW_ENTRIES).toContain(c);
      expect(IMPLEMENTED.has(c)).toBe(true);
      expect(entryFor(c, {})).toBe(c);
      expect(ARGS_VALIDATORS[c]).toBeTypeOf('function');
    }
    expect(DISRUPTIVE_ENTRIES.has('switch.cycle')).toBe(true);
    expect(DISRUPTIVE_ENTRIES.has('switch.read')).toBe(false);
  });

  it('validators accept the contract shapes and refuse a bad id or extra fields', () => {
    const sw = { id: SW, model: 'sscpoe-web', host: '192.0.2.217', ports: 8, offSeconds: 10 };
    expect(ARGS_VALIDATORS['switch.read']({ v: 1, switch: sw }).ok).toBe(true);
    expect(ARGS_VALIDATORS['switch.read']({ v: 1, switch: { ...sw, id: 'sw_x' } }).ok).toBe(false);
    expect(ARGS_VALIDATORS['switch.read']({ v: 1, switch: sw, extra: 1 }).ok).toBe(false);
    expect(ARGS_VALIDATORS['switch.read']({ v: 2, switch: sw })).toMatchObject({ ok: false, code: 'unsupported_version' });
    expect(ARGS_VALIDATORS['switch.cycle']({ v: 1, switch: sw, port: 8, host: null, force: true, camera: CAM }).ok).toBe(true);
    expect(ARGS_VALIDATORS['switch.cycle']({ v: 1, switch: sw, port: 9, host: null, force: true, camera: CAM }).ok).toBe(true);
    expect(ARGS_VALIDATORS['switch.cycle']({ v: 1, switch: sw, port: 0, host: null, force: true, camera: CAM }).ok).toBe(false);
    expect(ARGS_VALIDATORS['switch.cycle']({ v: 1, switch: sw, port: 8, host: null, force: 'yes', camera: CAM }).ok).toBe(false);
    expect(ARGS_VALIDATORS['switch.survey']({ v: 1, switch: sw, cameras: [] }).ok).toBe(false);
    expect(ARGS_VALIDATORS['switch.survey']({ v: 1, switch: sw, cameras: [{ camera: CAM, host: 'h' }] }).ok).toBe(true);
    expect(ARGS_VALIDATORS['switch.forget']({ v: 1, switchId: SW }).ok).toBe(true);
    expect(ARGS_VALIDATORS['switch.forget']({ v: 1, switchId: 'nope' }).ok).toBe(false);
  });
});

describe('switch commands on the mock switch', () => {
  it('switch.read: the ports, tx/rx included', async () => {
    const t = await setup();
    const d = await t.run('switch.read', { switch: t.sw });
    t.okResult('switch.read', d);
    const r = d.result as { sn: string; firmware: string; ports: { port: number; poe: boolean; watts: number; link: boolean | null }[] };
    expect(r.sn).toBe('GPS208MOCK0001');
    expect(r.ports).toHaveLength(8);
    expect(r.ports.find((p) => p.port === 3)).toMatchObject({ poe: true, watts: 4.5, link: true, tx: 1, rx: 1 });
    expect(t.m.activeSession()).toBe(false);
  });

  it('switch.locate: found, with sn', async () => {
    const t = await setup({ at: { cam3: 5 } });
    const d = await t.run('switch.locate', { switch: t.sw, host: 'cam3' });
    t.okResult('switch.locate', d);
    expect(d.result).toMatchObject({ found: true, port: 3, sn: 'GPS208MOCK0001' });
  });

  it('switch.locate: a camera that does not answer is an ok result, found false', async () => {
    const t = await setup({ answered: false });
    const d = await t.run('switch.locate', { switch: t.sw, host: 'cam3' });
    t.okResult('switch.locate', d);
    expect(d.result).toMatchObject({ found: false, reason: 'not_reachable' });
  });

  it('switch.survey: one result per camera', async () => {
    const t = await setup({ at: { cam3: 5, cam2: 6 } });
    const d = await t.run('switch.survey', { switch: t.sw, cameras: [{ camera: CAM, host: 'cam3' }, { camera: CAM2, host: 'cam2' }] });
    t.okResult('switch.survey', d);
    expect((d.result as any).results.map((x: any) => [x.camera, x.port])).toEqual([[CAM, 3], [CAM2, 2]]);
  });

  it('switch.cycle forced: ok, audited switch-port-cycled with forced true', async () => {
    const t = await setup();
    const d = await t.run('switch.cycle', { switch: t.sw, port: 3, host: null, force: true, camera: CAM });
    t.okResult('switch.cycle', d);
    expect(d.result).toMatchObject({ verified: false, watts: 4.5 });
    expect(t.records).toHaveLength(1);
    expect(t.records[0]).toMatchObject({ action: 'switch-port-cycled', outcome: 'success', camera: CAM, details: { forced: true, switch: { id: SW, port: 3 } } });
    expect(JSON.stringify(t.records)).not.toContain(PASSWORD);
  });

  it('switch.cycle verified: ok with verified true, forced false', async () => {
    const t = await setup({ at: { cam3: 5 } });
    const d = await t.run('switch.cycle', { switch: t.sw, port: 3, host: 'cam3', force: false, camera: CAM });
    t.okResult('switch.cycle', d);
    expect((d.result as any).verified).toBe(true);
    expect(t.records[0]).toMatchObject({ action: 'switch-port-cycled', outcome: 'success', camera: CAM, details: { forced: false } });
  });

  it('switch.cycle with a mismatched port: failed not_verified, nothing switched, audited as failure', async () => {
    const t = await setup({ at: { cam3: 5 } });
    const d = await t.run('switch.cycle', { switch: t.sw, port: 8, host: 'cam3', force: false, camera: CAM });
    expect(d).toMatchObject({ status: 'failed', code: 'not_verified' });
    expect(t.m.opcodes).toEqual([]);
    expect(t.records[0]).toMatchObject({ action: 'switch-port-cycled', outcome: 'failure', error: 'not_verified', camera: CAM });
  });

  it('switch.cycle on a port with no power: failed no_power', async () => {
    const t = await setup();
    const d = await t.run('switch.cycle', { switch: t.sw, port: 7, host: null, force: true, camera: CAM });
    expect(d).toMatchObject({ status: 'failed', code: 'no_power' });
  });

  it('switch.cycle when PoE could not be turned on again: failed poe_may_be_off', async () => {
    const t = await setup();
    const reg = t.registry.get(t.sw as any);
    reg.cycle = () => Promise.reject(new PoeSwitchError('switch_error', 'PoE may still be OFF on port 3', true, false));
    const d = await t.run('switch.cycle', { switch: t.sw, port: 3, host: null, force: true, camera: CAM });
    expect(d).toMatchObject({ status: 'failed', code: 'poe_may_be_off' });
  });

  it('switch.cycle: a busy switch answers switch_busy', async () => {
    const t = await setup();
    const reg = t.registry.get(t.sw as any);
    reg.cycle = () => Promise.reject(new PoeSwitchError('switch_busy', 'busy'));
    expect(await t.run('switch.cycle', { switch: t.sw, port: 3, host: null, force: true, camera: CAM })).toMatchObject({ status: 'failed', code: 'switch_busy' });
  });

  it('switch.poeOn: wasOn true when PoE is on', async () => {
    const t = await setup();
    const d = await t.run('switch.poeOn', { switch: t.sw, port: 3 });
    t.okResult('switch.poeOn', d);
    expect(d.result).toMatchObject({ port: 3, poe: true, wasOn: true });
  });

  it('switch.poeOn: turns a port on that was off', async () => {
    const t = await setup();
    t.m.poec[5] = 0;
    const d = await t.run('switch.poeOn', { switch: t.sw, port: 3 });
    t.okResult('switch.poeOn', d);
    expect(d.result).toMatchObject({ port: 3, poe: true, wasOn: false });
  });

  it('no password: every switch command fails password_unset, the mock is never called', async () => {
    const t = await setup({ password: false });
    for (const [c, a] of [['switch.read', {}], ['switch.locate', { host: 'cam3' }], ['switch.survey', { cameras: [{ camera: CAM, host: 'cam3' }] }], ['switch.cycle', { port: 3, host: null, force: true, camera: CAM }], ['switch.poeOn', { port: 3 }]] as const) {
      expect(await t.run(c, { switch: t.sw, ...a }), c).toMatchObject({ status: 'failed', code: 'password_unset' });
    }
    expect(t.m.calls).toEqual([]);
  });

  it('switch.forget: answers {forgot}, drops the password, writes no audit of its own', async () => {
    const t = await setup();
    await t.run('switch.read', { switch: t.sw });
    const d = await t.run('switch.forget', { switchId: SW });
    t.okResult('switch.forget', d);
    expect(d.result).toEqual({ forgot: true });
    expect(t.records).toEqual([]);
    expect(t.registry.known()).toEqual([]);
  });

  it('switch.forget of an unknown id: ok, forgot false', async () => {
    const t = await setup();
    const d = await t.run('switch.forget', { switchId: 'sw_zzzzzzzzzzzzzzzzzzzz' });
    t.okResult('switch.forget', d);
    expect(d.result).toEqual({ forgot: false });
  });

  it('after forget, read and cycle (descriptor in args) still need a password: password_unset', async () => {
    const t = await setup();
    await t.run('switch.read', { switch: t.sw });
    await t.run('switch.forget', { switchId: SW });
    t.m.calls.length = 0;
    expect(await t.run('switch.read', { switch: t.sw })).toMatchObject({ status: 'failed', code: 'password_unset' });
    expect(await t.run('switch.cycle', { switch: t.sw, port: 3, host: null, force: true, camera: CAM })).toMatchObject({ status: 'failed', code: 'password_unset' });
    expect(t.m.calls).toEqual([]);
    expect(t.m.opcodes).toEqual([]);
  });
});

describe('switch.cycle without a host and not forced', () => {
  it('is not_verified and switches nothing', async () => {
    const t = await setup();
    const d = await t.run('switch.cycle', { switch: t.sw, port: 3, host: null, force: false, camera: CAM });
    expect(d).toMatchObject({ status: 'failed', code: 'not_verified' });
    expect(t.m.calls).toEqual([]);
  });
});
