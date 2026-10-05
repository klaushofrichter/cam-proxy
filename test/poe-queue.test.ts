import { describe, expect, it } from 'vitest';
import { PoeSwitch } from '../src/camera/poe-switch';
import { fakeSwitch } from './helpers/fake-switch';

const host = { model: 'sscpoe-web' as const, host: 'fake', ports: 8, offSeconds: 5 };

describe('one PoE controller per host (spec 2026-10-05-multi-camera-host-design §8.4)', () => {
  it('queue: the second waits; beyond the bound switch_busy', async () => {
    const sw = fakeSwitch();
    let releaseOff!: () => void;
    // The off time of the first cycle holds the switch until released.
    const p = new PoeSwitch({ config: () => host, password: () => 'pw', driver: () => sw.driver, sleep: (ms) => (ms >= 5000 ? new Promise<void>((r) => (releaseOff = r)) : Promise.resolve()), queueWaitMs: () => 200 });
    const first = p.cycle(3, () => undefined);
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
    const p = new PoeSwitch({ config: () => host, password: () => 'pw', driver: () => sw.driver, sleep: async () => undefined });
    const [a, b] = await Promise.all([p.cycle(3, () => undefined), p.read(4, { fresh: true })]);
    expect(a.watts).toBeGreaterThan(0);
    expect(b.port).toBe(4);
    expect(sw.log.indexOf('poe 2 on')).toBeLessThan(sw.log.lastIndexOf('login'));
  });

  it('one read serves every port for 10 s (Ruling P2-7)', async () => {
    let t = 0;
    const sw = fakeSwitch();
    const p = new PoeSwitch({ config: () => host, password: () => 'pw', driver: () => sw.driver, now: () => t, sleep: async () => undefined });
    await p.read(3);
    await p.read(4);
    expect(sw.log.filter((l) => l === 'login')).toHaveLength(1);
    t += 10_001;
    await p.read(4);
    expect(sw.log.filter((l) => l === 'login')).toHaveLength(2);
  });

  it('per-port state; the port handle is a camera view', async () => {
    const sw = fakeSwitch();
    const p = new PoeSwitch({ config: () => host, password: () => 'pw', driver: () => sw.driver, sleep: async () => undefined });
    sw.poe[5] = false;
    await p.read(6, { fresh: true });
    expect(p.status(6).poeMaybeOff).toBe(true);
    expect(p.status(3).poeMaybeOff).toBe(false);
    const h = p.forPort(() => 6);
    expect((await h.poeOn()).wasOn).toBe(false);
    expect(p.status(6).poeMaybeOff).toBe(false);
    expect(p.forPort(() => undefined).notConfigured()).toBe("the camera's poeSwitch.port is not set");
    expect(p.forPort(() => undefined).status()).toMatchObject({ port: null, configured: false, poeMaybeOff: false });
  });

  it('stop: every port left dark is named', async () => {
    const sw = fakeSwitch();
    const p = new PoeSwitch({ config: () => host, password: () => 'pw', driver: () => sw.driver, sleep: async () => undefined });
    sw.poe[2] = false;
    sw.poe[4] = false;
    await p.read(3, { fresh: true });
    await p.read(5, { fresh: true });
    expect(await p.stop()).toEqual({ portsLeftOff: [3, 5], sessionMaybeOpen: false });
  });

  it('stop waits for the session that runs, also when a later request gave up waiting', async () => {
    const sw = fakeSwitch();
    let releaseOff!: () => void;
    const p = new PoeSwitch({ config: () => host, password: () => 'pw', driver: () => sw.driver, sleep: (ms) => (ms >= 5000 ? new Promise<void>((r) => (releaseOff = r)) : Promise.resolve()), queueWaitMs: () => 50, stopWaitMs: 2000 });
    const first = p.cycle(3, () => undefined);
    await new Promise((r) => setTimeout(r, 20));
    await expect(p.read(4, { fresh: true })).rejects.toMatchObject({ code: 'switch_busy' });
    void releaseOff;
    // stop() ends the off time at once and waits until the port is on and the session closed.
    expect(await p.stop()).toEqual({ portsLeftOff: [], sessionMaybeOpen: false });
    expect([sw.log.at(-1), sw.sessions()]).toEqual(['logout', 0]);
    expect((await first).watts).toBeGreaterThan(0);
    expect(sw.poe[2]).toBe(true);
  });
});
