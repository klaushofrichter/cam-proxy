// Finding a camera's switch port by a ping burst (spec 2026-11-07-poe-switches
// "Finding a camera (locate)"), against the mock switch; ping is never spawned.
import { afterEach, describe, expect, it } from 'vitest';
import { PoeSwitch, PoeSwitchError } from '../src/camera/poe-switch';
import type { SwitchDetail } from '../src/camera/switch/driver';
import { pickPort, pingBurst, pingHost, type Runner } from '../src/camera/switch/locate';
import { startPoeSwitchMock, type PoeSwitchMock } from './helpers/poe-switch-mock';

const PASSWORD = 'mock-switch-pw-4711';
const mocks: PoeSwitchMock[] = [];
afterEach(async () => {
  for (const m of mocks.splice(0)) await m.close();
});

// A GPS-208's detail: 8 ports reversed (UI port p = index 8 - p) plus two
// uplink entries (index 9 = the uplink).
const reversed = (p: number) => 8 - p;
const detail = (tx: number[], o: { rx?: number[]; link?: (boolean | null)[]; watts?: number[] } = {}): SwitchDetail => ({
  poe: Array.from({ length: 10 }, (_, i) => i < 8),
  watts: o.watts ?? Array.from({ length: 10 }, (_, i) => (i < 8 ? 4.5 : 0)),
  link: o.link ?? Array.from({ length: 10 }, () => true),
  tx,
  rx: o.rx ?? Array.from({ length: 10 }, () => 1),
  sn: 'GPS208MOCK0001',
  firmware: 'mock-1.0',
});
const ones = () => Array.from({ length: 10 }, () => 1);
const withAt = (at: Record<number, number>) => ones().map((v, i) => at[i] ?? v);

describe('pickPort: the port whose tx rose clearly above every other port', () => {
  it('finds port 3 from a tx spike at its index', () => {
    expect(pickPort(8, detail(ones()), detail(withAt({ [reversed(3)]: 40 })), reversed)).toEqual({ found: true, port: 3, poe: true, watts: 4.5, link: true, ratio: 40 });
  });

  it('uses tx only: an rx spike (a camera stream) does not count', () => {
    const burst = detail(withAt({ [reversed(3)]: 40 }), { rx: withAt({ [reversed(2)]: 400 }) });
    expect(pickPort(8, detail(ones()), burst, reversed)).toMatchObject({ found: true, port: 3 });
  });

  it('two ports close together: ambiguous, not found', () => {
    expect(pickPort(8, detail(ones()), detail(withAt({ [reversed(3)]: 30, [reversed(6)]: 20 })), reversed)).toEqual({ found: false, reason: 'ambiguous', ratio: 1.5 });
  });

  it('a spike on the uplink only (index 9): no traffic on any port', () => {
    expect(pickPort(8, detail(ones()), detail(withAt({ 9: 40 })), reversed)).toEqual({ found: false, reason: 'no_traffic' });
  });

  it('a port with steady high tx is not picked: the burst must be 5× its own baseline', () => {
    const base = detail(withAt({ [reversed(3)]: 20 }));
    expect(pickPort(8, base, detail(withAt({ [reversed(3)]: 40 })), reversed)).toMatchObject({ found: false });
  });

  it('an unlinked port is ignored', () => {
    const link = Array.from({ length: 10 }, (_, i) => i !== reversed(5));
    // Port 5 has no link (a stale counter): port 3 wins alone.
    const burst = detail(withAt({ [reversed(3)]: 40, [reversed(5)]: 35 }), { link });
    expect(pickPort(8, detail(ones()), burst, reversed)).toMatchObject({ found: true, port: 3, ratio: 40 });
  });
});

describe('pingBurst', () => {
  const runner = (stdout: string, args: string[][] = []): Runner => (cmd, a) => {
    args.push([cmd, ...a]);
    return Promise.resolve({ code: 0, stdout });
  };

  it('spawns the measured BusyBox burst and reads the summary', async () => {
    const calls: string[][] = [];
    const r = await pingBurst('192.0.2.5', runner('--- 192.0.2.5 ping statistics ---\n500 packets transmitted, 497 packets received, 0% packet loss\n', calls)).done;
    expect(r).toEqual({ answered: true });
    expect(calls).toEqual([['ping', '-q', '-s', '1400', '-i', '0.01', '-w', '5', '192.0.2.5']]);
  });

  it('no reply, an unparsable output or a failed spawn: not answered', async () => {
    expect(await pingBurst('h', runner('500 packets transmitted, 0 packets received, 100% packet loss\n')).done).toEqual({ answered: false });
    expect(await pingBurst('h', runner('ping: bad address')).done).toEqual({ answered: false });
    expect(await pingBurst('h', () => Promise.reject(new Error('ENOENT'))).done).toEqual({ answered: false });
  });

  it('refuses a host that looks like an option', async () => {
    const calls: string[][] = [];
    expect(await pingBurst('-f', runner('1 packets transmitted, 1 packets received', calls)).done).toEqual({ answered: false });
    expect(calls).toEqual([]);
  });
});

describe('PoeSwitch.locate, survey and the verified cycle (on the mock)', () => {
  const ref = (m: PoeSwitchMock) => ({ id: 'sw_test', model: 'sscpoe-web' as const, host: m.host, ports: 8, offSeconds: 10 });
  // A burst that raises the mock's tx on the host's index (and only there)
  // from its start; it stays until the next burst.
  const burstOn = (m: PoeSwitchMock, at: Record<string, number>, answered = true) => (host: string) => {
    m.tx.fill(1);
    if (at[host] !== undefined) m.tx[at[host]] = 40;
    return { done: Promise.resolve({ answered }) };
  };
  async function setup(at: Record<string, number>, answered = true) {
    const m = await startPoeSwitchMock({ password: PASSWORD, powered: { 0: 6.8, 5: 4.5, 6: 3.2 } });
    mocks.push(m);
    const slept: number[] = [];
    const p = new PoeSwitch({ ref: () => ref(m), password: () => PASSWORD, sleep: async (ms) => void slept.push(ms), timeoutMs: 1000, pingBurst: burstOn(m, at, answered) });
    return { m, p, slept };
  }

  it('locate: index 5 rises → port 3, with its watts; one session, logged out', async () => {
    const { m, p, slept } = await setup({ cam3: 5 });
    expect(await p.locate('cam3')).toEqual({ found: true, port: 3, poe: true, watts: 4.5, link: true, ratio: 40, sn: 'GPS208MOCK0001' });
    expect(slept).toContain(700);
    expect(m.calls.map((c) => c.cmd)).toEqual([123, 101, 101, 126]);
    expect(m.activeSession()).toBe(false);
  });

  // Measured on the GPS-208 (2026-11-07): the rates refresh every ~2.5–3.5 s and
  // lag the traffic, so the burst can show only in a later read.
  it('locate: reads during the burst until a port shows; a late rise is still found', async () => {
    const m = await startPoeSwitchMock({ password: PASSWORD, powered: { 5: 4.5 } });
    mocks.push(m);
    let pauses = 0;
    const sleep = async () => {
      pauses += 1;
      if (pauses === 3) m.tx[5] = 40; // shows in the third read during the burst
    };
    const p = new PoeSwitch({ ref: () => ref(m), password: () => PASSWORD, sleep, timeoutMs: 1000, pingBurst: () => ((m.tx.fill(1)), { done: Promise.resolve({ answered: true }) }) });
    expect(await p.locate('cam3')).toMatchObject({ found: true, port: 3 });
    expect(m.calls.map((c) => c.cmd)).toEqual([123, 101, 101, 101, 101, 126]);
  });

  it('locate: a previous burst still showing on another port does not block the camera', async () => {
    const m = await startPoeSwitchMock({ password: PASSWORD, powered: { 5: 4.5, 7: 3.3 } });
    mocks.push(m);
    let pauses = 0;
    const sleep = async () => {
      pauses += 1;
      if (pauses === 1) m.tx[5] = 40; // the camera's port rises…
      if (pauses === 2) m.tx[7] = 1; // …while port 1 (index 7) falls back from the last burst
    };
    const p = new PoeSwitch({ ref: () => ref(m), password: () => PASSWORD, sleep, timeoutMs: 1000, pingBurst: () => ((m.tx.fill(1)), (m.tx[7] = 30), { done: Promise.resolve({ answered: true }) }) });
    expect(await p.locate('cam3')).toMatchObject({ found: true, port: 3 });
  });

  it('locate: nothing shows in any read → no_traffic after a bounded number of reads', async () => {
    const { m, p } = await setup({});
    expect(await p.locate('cam9')).toMatchObject({ found: false, reason: 'no_traffic' });
    const reads = m.calls.filter((c) => c.cmd === 101).length;
    expect(reads).toBeGreaterThan(2);
    expect(reads).toBeLessThanOrEqual(12);
    expect(m.activeSession()).toBe(false);
  });

  it('a camera host with :port: only the host part is pinged (locate, survey, verified cycle)', async () => {
    const { p } = await setup({ '192.0.2.10': 5 });
    const pinged: string[] = [];
    const inner = (p as unknown as { d: { pingBurst: (h: string) => { done: Promise<{ answered: boolean }> } } }).d;
    const burst = inner.pingBurst;
    inner.pingBurst = (h) => (pinged.push(h), burst(h));
    expect(await p.locate('192.0.2.10:443')).toMatchObject({ found: true, port: 3 });
    expect(await p.survey([{ camera: 'cam_3', host: 'cam3.lan:8443' }])).toMatchObject({ results: [{ camera: 'cam_3' }] });
    await expect(p.cycle(3, () => undefined, { verifyHost: '192.0.2.10:443' })).resolves.toMatchObject({ verified: true });
    expect(pinged).toEqual(['192.0.2.10', 'cam3.lan', '192.0.2.10']);
  });

  it('pingHost: the host part of host[:port], IPv6 brackets dropped', () => {
    expect(pingHost('192.0.2.10')).toBe('192.0.2.10');
    expect(pingHost('192.0.2.10:443')).toBe('192.0.2.10');
    expect(pingHost('cam.lan:80')).toBe('cam.lan');
    expect(pingHost('[fe80::1]:443')).toBe('fe80::1');
    expect(pingHost('[fe80::1]')).toBe('fe80::1');
    expect(pingHost('fe80::1')).toBe('fe80::1');
  });

  it('locate: a burst with no reply is not_reachable, and the session is logged out', async () => {
    const { m, p } = await setup({ cam3: 5 }, false);
    expect(await p.locate('cam3')).toEqual({ found: false, reason: 'not_reachable', sn: 'GPS208MOCK0001' });
    expect(m.calls.at(-1)?.cmd).toBe(126);
    expect(m.activeSession()).toBe(false);
  });

  it('survey: each camera in turn, each in its own session', async () => {
    const { m, p } = await setup({ cam3: 5, cam2: 6 });
    expect(await p.survey([{ camera: 'cam_3', host: 'cam3' }, { camera: 'cam_2', host: 'cam2' }, { camera: 'cam_x', host: 'nowhere' }])).toEqual({
      sn: 'GPS208MOCK0001',
      results: [
        { camera: 'cam_3', found: true, port: 3, poe: true, watts: 4.5, link: true, ratio: 40 },
        { camera: 'cam_2', found: true, port: 2, poe: true, watts: 3.2, link: true, ratio: 40 },
        { camera: 'cam_x', found: false, reason: 'no_traffic' },
      ],
    });
    expect(m.calls.filter((c) => c.cmd === 123)).toHaveLength(3);
    expect(m.calls.filter((c) => c.cmd === 126)).toHaveLength(3);
    expect(m.activeSession()).toBe(false);
  });

  // #364 m3: one camera's switch failure is that camera's result; the survey goes on.
  it('survey: a switch error on one camera is its result (switch_error, detail), the others still surveyed', async () => {
    const m = await startPoeSwitchMock({ password: PASSWORD, powered: { 0: 6.8, 5: 4.5, 6: 3.2 } });
    mocks.push(m);
    const burst = burstOn(m, { cam3: 5, cam2: 6 });
    const p = new PoeSwitch({ ref: () => ref(m), password: () => PASSWORD, sleep: async () => undefined, timeoutMs: 1000, pingBurst: (h) => {
      if (h === 'cam2') throw new PoeSwitchError('switch_busy', `the switch is busy ${'x'.repeat(300)}`);
      return burst(h);
    } });
    const r = await p.survey([{ camera: 'cam_3', host: 'cam3' }, { camera: 'cam_2', host: 'cam2' }, { camera: 'cam_x', host: 'nowhere' }]);
    expect(r.sn).toBe('GPS208MOCK0001');
    expect(r.results.map((x) => [x.camera, x.found, x.reason])).toEqual([['cam_3', true, undefined], ['cam_2', false, 'switch_error'], ['cam_x', false, 'no_traffic']]);
    const failed = r.results[1] as { detail?: string };
    expect(failed.detail).toMatch(/^switch_busy: the switch is busy x+/);
    expect([...failed.detail!].length).toBeLessThanOrEqual(200);
    expect(m.activeSession()).toBe(false);
  });

  it('survey: every camera failing, or a failure of the whole switch (no password, wrong password, forgotten), still fails it', async () => {
    const m = await startPoeSwitchMock({ password: PASSWORD, powered: { 5: 4.5 } });
    mocks.push(m);
    const all = new PoeSwitch({ ref: () => ref(m), password: () => PASSWORD, sleep: async () => undefined, timeoutMs: 1000, pingBurst: () => {
      throw new PoeSwitchError('switch_unreachable', 'no answer');
    } });
    await expect(all.survey([{ camera: 'cam_3', host: 'cam3' }, { camera: 'cam_2', host: 'cam2' }])).rejects.toMatchObject({ code: 'switch_unreachable' });
    for (const code of ['switch_auth', 'password_unset', 'switch_unknown'] as const) {
      let n = 0;
      const p = new PoeSwitch({ ref: () => ref(m), password: () => PASSWORD, sleep: async () => undefined, timeoutMs: 1000, pingBurst: burstOn(m, { cam3: 5 }) });
      const inner = (p as unknown as { d: { pingBurst: (h: string) => { done: Promise<{ answered: boolean }> } } }).d;
      const b = inner.pingBurst;
      inner.pingBurst = (h) => {
        n += 1;
        if (n === 2) throw new PoeSwitchError(code, 'whole switch');
        return b(h);
      };
      await expect(p.survey([{ camera: 'cam_3', host: 'cam3' }, { camera: 'cam_2', host: 'cam2' }, { camera: 'cam_x', host: 'nowhere' }])).rejects.toMatchObject({ code });
    }
  });

  it('survey: a read queued during it goes between cameras, before the last one', async () => {
    const m = await startPoeSwitchMock({ password: PASSWORD, powered: { 0: 6.8, 5: 4.5, 6: 3.2 } });
    mocks.push(m);
    const order: string[] = [];
    const burst = burstOn(m, { cam3: 5, cam2: 6 });
    const p = new PoeSwitch({ ref: () => ref(m), password: () => PASSWORD, sleep: async () => undefined, timeoutMs: 1000, pingBurst: (h) => (order.push(`burst ${h}`), burst(h)) });
    const survey = p.survey([{ camera: 'cam_3', host: 'cam3' }, { camera: 'cam_2', host: 'cam2' }, { camera: 'cam_x', host: 'nowhere' }]);
    const read = p.read(8, { fresh: true }).then((r) => (order.push('read'), r));
    expect((await read).watts).toBe(6.8);
    expect((await survey).results).toHaveLength(3);
    expect(order).toEqual(['burst cam3', 'read', 'burst cam2', 'burst nowhere']);
  });

  it('cycle with verifyHost: the camera is on another port → not_verified, PoE never switched', async () => {
    const { m, p } = await setup({ cam3: 5 });
    const err = await p.cycle(8, () => undefined, { verifyHost: 'cam3' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PoeSwitchError);
    expect((err as PoeSwitchError).code).toBe('not_verified');
    expect(m.opcodes).toEqual([]);
    expect(m.calls.some((c) => c.cmd === 103)).toBe(false);
    expect(m.activeSession()).toBe(false);
  });

  it('cycle with verifyHost: a camera that does not answer → not_verified', async () => {
    const { m, p } = await setup({ cam3: 5 }, false);
    await expect(p.cycle(3, () => undefined, { verifyHost: 'cam3' })).rejects.toMatchObject({ code: 'not_verified' });
    expect(m.opcodes).toEqual([]);
  });

  it('cycle with verifyHost: verified on its port → cycled in the same session', async () => {
    const { m, p } = await setup({ cam3: 5 });
    const r = await p.cycle(3, () => undefined, { verifyHost: 'cam3' });
    expect(r).toMatchObject({ verified: true, watts: 4.5 });
    expect(m.opcodes).toEqual([(0 << 9) | (5 << 4) | 2, (1 << 9) | (5 << 4) | 2]);
    expect(m.calls.filter((c) => c.cmd === 123)).toHaveLength(1);
  });

  it('cycle forced (verifyHost null): no burst, not verified', async () => {
    const { m, p } = await setup({});
    const r = await p.cycle(3, () => undefined, { verifyHost: null });
    expect(r).toMatchObject({ verified: false, watts: 4.5 });
    expect(m.calls.filter((c) => c.cmd === 101)).toHaveLength(1);
  });
});
