import { describe, expect, it } from 'vitest';
import { PoeSwitch } from '../src/camera/poe-switch';
import { fakeSwitch } from './helpers/fake-switch';

const host = { id: 'sw_test', model: 'sscpoe-web' as const, host: 'fake', ports: 8, offSeconds: 5 };

describe('one PoE controller per host (spec 2026-10-05-multi-camera-host-design §8.4)', () => {
  it('queue: the second waits; beyond the bound switch_busy', async () => {
    const sw = fakeSwitch();
    let releaseOff!: () => void;
    // The off time of the first cycle holds the switch until released.
    const p = new PoeSwitch({ ref: () => host, password: () => 'pw', driver: () => sw.driver, sleep: (ms) => (ms >= 5000 ? new Promise<void>((r) => (releaseOff = r)) : Promise.resolve()), queueWaitMs: () => 200 });
    const first = p.cycle(3, () => undefined, { verifyHost: null });
    await new Promise((r) => setTimeout(r, 20));
    const second = p.read(4, { fresh: true });
    const late = new Promise((r) => setTimeout(r, 300)).then(() => p.read(5, { fresh: true }));
    await expect(second).rejects.toMatchObject({ code: 'switch_busy' }); // waited 200 ms: over the bound
    releaseOff();
    await first;
    expect((await late).port).toBe(5);
    expect(sw.sessions()).toBe(0);
  });

  it('a waiting request runs after the first, in order', async () => {
    const sw = fakeSwitch();
    const p = new PoeSwitch({ ref: () => host, password: () => 'pw', driver: () => sw.driver, sleep: async () => undefined });
    const [a, b] = await Promise.all([p.cycle(3, () => undefined, { verifyHost: null }), p.read(4, { fresh: true })]);
    expect(a.watts).toBeGreaterThan(0);
    expect(b.port).toBe(4);
    expect(sw.log.indexOf('poe 2 on')).toBeLessThan(sw.log.lastIndexOf('login'));
  });

  it('one read serves every port for 10 s (Ruling P2-7)', async () => {
    let t = 0;
    const sw = fakeSwitch();
    const p = new PoeSwitch({ ref: () => host, password: () => 'pw', driver: () => sw.driver, now: () => t, sleep: async () => undefined });
    await p.read(3);
    await p.read(4);
    expect(sw.log.filter((l) => l === 'login')).toHaveLength(1);
    t += 10_001;
    await p.read(4);
    expect(sw.log.filter((l) => l === 'login')).toHaveLength(2);
  });

  it('per-port state', async () => {
    const sw = fakeSwitch();
    const p = new PoeSwitch({ ref: () => host, password: () => 'pw', driver: () => sw.driver, sleep: async () => undefined });
    sw.poe[5] = false;
    await p.read(6, { fresh: true });
    expect(p.portsMaybeOff()).toEqual([6]);
    expect((await p.poeOn(6)).wasOn).toBe(false);
    expect(p.portsMaybeOff()).toEqual([]);
    expect(p.notConfigured(null)).toBe('no switch port');
  });

  it('stop: every port left dark is named', async () => {
    const sw = fakeSwitch();
    const p = new PoeSwitch({ ref: () => host, password: () => 'pw', driver: () => sw.driver, sleep: async () => undefined });
    sw.poe[2] = false;
    sw.poe[4] = false;
    await p.read(3, { fresh: true });
    await p.read(5, { fresh: true });
    expect(await p.stop()).toEqual({ portsLeftOff: [3, 5], sessionMaybeOpen: false });
  });

  it('stop waits for the session that runs, also when a later request gave up waiting', async () => {
    const sw = fakeSwitch();
    let releaseOff!: () => void;
    const p = new PoeSwitch({ ref: () => host, password: () => 'pw', driver: () => sw.driver, sleep: (ms) => (ms >= 5000 ? new Promise<void>((r) => (releaseOff = r)) : Promise.resolve()), queueWaitMs: () => 50, stopWaitMs: 2000 });
    const first = p.cycle(3, () => undefined, { verifyHost: null });
    await new Promise((r) => setTimeout(r, 20));
    await expect(p.read(4, { fresh: true })).rejects.toMatchObject({ code: 'switch_busy' });
    void releaseOff;
    // stop() ends the off time at once and waits until the port is on and the session closed.
    expect(await p.stop()).toEqual({ portsLeftOff: [], sessionMaybeOpen: false });
    expect([sw.log.at(-1), sw.sessions()]).toEqual(['logout', 0]);
    expect((await first).watts).toBeGreaterThan(0);
    expect(sw.poe[2]).toBe(true);
  });

  // #364 (Task 3): two controllers of one switch share its lane. Stopping one
  // waits for its own sessions only, not for the other's long cycle: its queued
  // request ends at once, and no session or dark port is reported for it.
  it("stop of one controller on a shared lane: its queued request ends at once; the other's long session is not its own", async () => {
    const sw = fakeSwitch();
    const lane = { tail: Promise.resolve() as Promise<unknown> };
    let releaseOff!: () => void;
    const b = new PoeSwitch({ ref: () => host, password: () => 'pw', driver: () => sw.driver, lane: () => lane, sleep: (ms) => (ms >= 5000 ? new Promise<void>((r) => (releaseOff = r)) : Promise.resolve()) });
    const a = new PoeSwitch({ ref: () => host, password: () => 'pw', driver: () => sw.driver, lane: () => lane, sleep: async () => undefined, stopWaitMs: 300 });
    const long = b.cycle(3, () => undefined, { verifyHost: null });
    await new Promise((r) => setTimeout(r, 20));
    const queued = a.read(4, { fresh: true });
    const t0 = Date.now();
    expect(await a.stop()).toEqual({ portsLeftOff: [], sessionMaybeOpen: false });
    expect(Date.now() - t0).toBeLessThan(250);
    await expect(queued).rejects.toMatchObject({ code: 'switch_error' });
    // The other controller's cycle carries on and ends normally.
    releaseOff();
    expect((await long).watts).toBeGreaterThan(0);
    expect(sw.sessions()).toBe(0);
  });
});
