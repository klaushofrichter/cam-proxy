// Issue #85: the PoE switch's local web protocol (STEAMEMO/SSCPOE GPS-208
// and kin), against the mock in test/helpers; the real switch is never used.
import { afterEach, describe, expect, it } from 'vitest';
import { PoeSwitch, PoeSwitchError, Session, poeOpcode, portIndex, reverseOrder } from '../src/camera/poe-switch';
import { startPoeSwitchMock, type PoeSwitchMock } from './helpers/poe-switch-mock';

const PASSWORD = 'mock-switch-pw-4711';
const mocks: PoeSwitchMock[] = [];
afterEach(async () => {
  for (const m of mocks.splice(0)) await m.close();
});
async function mock(o: Partial<Parameters<typeof startPoeSwitchMock>[0]> = {}) {
  const m = await startPoeSwitchMock({ password: PASSWORD, ...o });
  mocks.push(m);
  return m;
}
const sw = (m: PoeSwitchMock, over: { password?: string; port?: number; ports?: number; offSeconds?: number } = {}) => {
  const slept: number[] = [];
  const s = new PoeSwitch({
    config: () => ({ model: 'sscpoe-web', host: m.host, port: over.port ?? 8, ports: over.ports ?? 8, offSeconds: over.offSeconds ?? 10 }),
    password: () => over.password ?? PASSWORD,
    sleep: async (ms) => void slept.push(ms),
    timeoutMs: 1000,
  });
  return { s, slept };
};
// A fake clock: sleep advances it at once (the retry window is about 60 s).
const clocked = (m: PoeSwitchMock, over: { offSeconds?: number; timeoutMs?: number; realOffSleep?: boolean } = {}) => {
  const clock = { t: 1_000_000 };
  const slept: number[] = [];
  const s = new PoeSwitch({
    config: () => ({ model: 'sscpoe-web', host: m.host, port: 8, ports: 8, offSeconds: over.offSeconds ?? 10 }),
    password: () => PASSWORD,
    now: () => clock.t,
    // realOffSleep: the off time waits for real (stop() cuts it short).
    sleep: async (ms) => {
      slept.push(ms);
      if (over.realOffSleep && ms === (over.offSeconds ?? 10) * 1000) return new Promise<void>(() => {});
      clock.t += ms;
    },
    timeoutMs: over.timeoutMs ?? 1000,
  });
  return { s, slept, clock };
};
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PoeSwitchError);
    return (e as PoeSwitchError).code;
  }
  throw new Error('expected a PoeSwitchError');
};

describe('session hygiene (#90)', () => {
  it('a lost logout is retried once on the same session', async () => {
    const m = await mock();
    const { s } = sw(m);
    m.dropLogout = 1;
    expect((await s.read()).watts).toBe(6.8);
    expect(m.calls.filter((c) => c.cmd === 126)).toHaveLength(2);
    expect(m.activeSession()).toBe(false);
    expect((await s.stop()).sessionMaybeOpen).toBe(false);
  });

  it('two lost logouts: the session may be open, and the next busy login says it may be the proxy\'s own', async () => {
    const m = await mock();
    const { s } = sw(m);
    m.dropLogout = 2;
    await s.read();
    expect(m.calls.filter((c) => c.cmd === 126)).toHaveLength(2);
    expect(m.activeSession()).toBe(true);
    const e = await s.read().catch((x: unknown) => x as PoeSwitchError);
    expect((e as PoeSwitchError).code).toBe('switch_busy');
    expect((e as PoeSwitchError).message).toMatch(/possibly the proxy's own session/);
    expect((e as PoeSwitchError).message).toMatch(/frees itself about 3 minutes after the last call/);
    expect((await s.stop()).sessionMaybeOpen).toBe(true);
  });

  it('a busy login with no lost logout keeps the plain message', async () => {
    const m = await mock();
    m.browserLogin();
    const { s } = sw(m);
    const e = await s.read().catch((x: unknown) => x as PoeSwitchError);
    expect((e as PoeSwitchError).message).not.toMatch(/proxy's own/);
  });

  it('a refused login does not replace the cookie of the session', async () => {
    const m = await mock({});
    m.failCookie = true;
    const s = new Session(m.host, () => 1000);
    await s.login(PASSWORD);
    expect(await codeOf(s.login('wrong-password'))).toBe('switch_auth');
    await s.detail();
    expect(m.calls.at(-1)).toMatchObject({ cmd: 101, session: true });
    await s.logout();
    expect(m.activeSession()).toBe(false);
  });
});

describe('port mapping and opcodes', () => {
  it("follows sscpoe's reverse_order: GPS2xx and kin count the ports backwards", () => {
    for (const sn of ['GPS208', 'GPS204V3', 'GS105', 'GPS1xx', 'GFS226V1', 'GPS424V3']) expect(reverseOrder(sn), sn).toBe(true);
    for (const sn of ['PS208G', 'PS308G', 'GPS316', '']) expect(reverseOrder(sn), sn).toBe(false);
  });

  it('maps the UI port to the internal index: GPS-208 port 8 is index 0, port 1 is index 7', () => {
    expect(portIndex(8, 8, 'GPS208')).toBe(0);
    expect(portIndex(1, 8, 'GPS208')).toBe(7);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((p) => portIndex(p, 8, 'GPS208'))).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    expect(portIndex(8, 8, 'PS208G')).toBe(7);
    expect(portIndex(1, 8, 'PS208G')).toBe(0);
    expect(portIndex(4, 4, 'GPS204')).toBe(0);
  });

  it('builds the set-PoE opcode on<<9 | index<<4 | 2 (port 8: off 0x2, on 0x202)', () => {
    expect(poeOpcode(0, false)).toBe(0x2);
    expect(poeOpcode(0, true)).toBe(0x202);
    expect(poeOpcode(7, false)).toBe(0x72);
    expect(poeOpcode(7, true)).toBe(0x272);
  });
});

describe('PoeSwitch against the mock', () => {
  it('reads the port: logs in, reads 101 and logs out', async () => {
    const m = await mock();
    const { s } = sw(m);
    const r = await s.read();
    expect(r).toMatchObject({ port: 8, index: 0, poe: true, watts: 6.8, link: true, sn: 'GPS208MOCK0001', firmware: 'mock-1.0' });
    expect(m.calls.map((c) => c.cmd)).toEqual([123, 101, 126]);
    expect(m.activeSession()).toBe(false);
    expect(s.status().last).toMatchObject({ watts: 6.8 });
  });

  it('power-cycles: off with 0x2, waits offSeconds, on with 0x202, logs out; answers offAt, onAt, watts', async () => {
    const changes: Array<[number, boolean]> = [];
    const m = await mock({ onPoe: (i, on) => changes.push([i, on]) });
    const { s, slept } = sw(m, { offSeconds: 7 });
    const offs: number[] = [];
    const r = await s.cycle((at) => offs.push(at));
    expect(m.opcodes).toEqual([0x2, 0x202]);
    expect(changes).toEqual([[0, false], [0, true]]);
    expect(slept).toContain(7000);
    expect(r).toMatchObject({ watts: 6.8, offAt: expect.any(Number), onAt: expect.any(Number) });
    expect(offs).toEqual([r.offAt]);
    expect(m.calls.map((c) => c.cmd)).toEqual([123, 101, 103, 103, 126]);
    expect(m.activeSession()).toBe(false);
  });

  it('refuses a port with PoE off or no power draw (no_power) and switches nothing', async () => {
    const m = await mock({ powered: { 0: 6.8 } });
    expect(await codeOf(sw(m, { port: 1 }).s.cycle(() => {}))).toBe('no_power');
    m.poec[0] = 0;
    expect(await codeOf(sw(m).s.cycle(() => {}))).toBe('no_power');
    expect(m.opcodes).toEqual([]);
    expect(m.calls.filter((c) => c.cmd === 126)).toHaveLength(2);
    expect(m.activeSession()).toBe(false);
  });

  it('a non-reversed switch: port 1 is index 0', async () => {
    const m = await mock({ sn: 'PS208G-0001', powered: { 0: 4.2 } });
    const r = await sw(m, { port: 1 }).s.cycle(() => {});
    expect(r.watts).toBe(4.2);
    expect(m.opcodes).toEqual([0x2, 0x202]);
  });

  it('switch busy: a browser is logged in, the login is dropped with no answer (switch_busy)', async () => {
    const m = await mock();
    m.browserLogin();
    const { s } = sw(m);
    const e = await s.cycle(() => {}).catch((x: unknown) => x as PoeSwitchError);
    expect(e).toBeInstanceOf(PoeSwitchError);
    expect((e as PoeSwitchError).code).toBe('switch_busy');
    expect((e as PoeSwitchError).message).toMatch(/logged in to the switch's web UI/);
    expect(await codeOf(s.read())).toBe('switch_busy');
    expect(m.opcodes).toEqual([]);
    m.browserLogout();
    expect((await s.read()).watts).toBe(6.8);
  });

  it('a wrong password: switch_auth, and the password is not in the error', async () => {
    const m = await mock();
    const wrong = 'wrong-switch-pw-0815';
    const e = await sw(m, { password: wrong }).s.cycle(() => {}).catch((x: unknown) => x as PoeSwitchError);
    expect((e as PoeSwitchError).code).toBe('switch_auth');
    expect(JSON.stringify(e) + String(e) + (e as Error).stack).not.toContain(wrong);
    expect(m.opcodes).toEqual([]);
    // Never logged in: nothing to log out of.
    expect(m.calls.map((c) => c.cmd)).toEqual([123]);
  });

  it('nothing listening: switch_unreachable', async () => {
    const m = await mock();
    const host = m.host;
    await m.close();
    mocks.splice(0);
    const s = new PoeSwitch({ config: () => ({ model: 'sscpoe-web', host, port: 8, ports: 8, offSeconds: 5 }), password: () => PASSWORD, sleep: async () => {}, timeoutMs: 500 });
    expect(await codeOf(s.read())).toBe('switch_unreachable');
  });

  it('the off answer lost (dropped, hung, or without config: ok): turns PoE on again and reports poeOff, turnedOn', async () => {
    for (const fault of ['drop', 'hang', 'noconfig'] as const) {
      const m = await mock();
      m.offFault = fault;
      const { s } = clocked(m, { timeoutMs: 300 });
      const offs: number[] = [];
      const e = await s.cycle((at) => offs.push(at)).catch((x: unknown) => x as PoeSwitchError);
      expect(e, fault).toBeInstanceOf(PoeSwitchError);
      expect(e, fault).toMatchObject({ code: 'switch_error', poeOff: true, turnedOn: true });
      expect((e as Error).message, fault).toMatch(/PoE may have been cut on port 8; it is on again/);
      expect(m.opcodes.at(-1), fault).toBe(0x202);
      expect(m.opcodes[0], fault).toBe(0x2);
      expect(m.poec[0], fault).toBe(1);
      expect(m.activeSession(), fault).toBe(false);
      expect(s.status().poeMaybeOff, fault).toBe(false);
    }
  });

  it('onOff throwing after the cut still turns PoE on again', async () => {
    const m = await mock();
    const { s } = clocked(m);
    const e = await s.cycle(() => { throw new Error('boom'); }).catch((x: unknown) => x as PoeSwitchError);
    expect(e).toMatchObject({ code: 'switch_error', poeOff: true, turnedOn: true });
    expect(m.opcodes).toEqual([0x2, 0x202]);
    expect(m.poec[0]).toBe(1);
  });

  it('an explicit refusal of the off, and the port still powered: refused, nothing cut, not poeOff', async () => {
    const m = await mock();
    m.failSet = 1; // answers config: fail, applies nothing
    const offs: number[] = [];
    const e = await clocked(m).s.cycle((at) => offs.push(at)).catch((x: unknown) => x as PoeSwitchError);
    expect(e).toMatchObject({ code: 'switch_error', poeOff: false });
    expect((e as Error).message).toMatch(/refused PoE off on port 8; the port still has power: nothing was cut/);
    expect(m.opcodes).toEqual([0x2]);
    expect(offs).toEqual([]);
    expect(m.calls.map((c) => c.cmd)).toEqual([123, 101, 103, 101, 126]);
  });

  it('an explicit refusal of the off, but the port is off after all: poeOff, and PoE on again', async () => {
    const m = await mock();
    m.offFault = 'noconfig'; // applies the off, answers config: fail
    const e = await clocked(m).s.cycle(() => {}).catch((x: unknown) => x as PoeSwitchError);
    expect(e).toMatchObject({ code: 'switch_error', poeOff: true, turnedOn: true });
    expect(m.opcodes).toEqual([0x2, 0x202]);
    expect(m.poec[0]).toBe(1);
  });

  it('a transient hang over the first retry (its PoE on and logout): the session is kept, PoE ends on, the session closed', async () => {
    const m = await mock();
    const { s } = clocked(m, { timeoutMs: 500 });
    const e = await s.cycle(() => m.hangFor(2500)).then(() => null, (x: unknown) => x as PoeSwitchError);
    // PoE came back on within the retries: a normal result.
    expect(e).toBeNull();
    expect(m.poec[0]).toBe(1);
    expect(m.activeSession()).toBe(false);
    expect(s.status().poeMaybeOff).toBe(false);
    // Never a request without our cookie while our session was open: none dropped as foreign.
    expect(m.calls.filter((c) => c.dropped && !c.session)).toEqual([]);
  });

  it('PoE on fails twice: retried on the same session, then on a new one, with backoff', async () => {
    const m = await mock();
    const { s, slept } = clocked(m);
    const r = await s.cycle(() => void (m.failSet = 2));
    expect(r.watts).toBe(6.8);
    expect(m.opcodes.filter((o) => o === 0x202).length).toBeGreaterThanOrEqual(3);
    expect(m.poec[0]).toBe(1);
    // Try 1 on the session; after a backoff, try 2 on the session, then on a new one.
    expect(slept.filter((x) => x !== 10000)).toEqual([1000]);
    expect(m.calls.filter((c) => c.cmd === 123)).toHaveLength(2);
  });

  it('the session is lost during the off time: logs in again and turns PoE on', async () => {
    const m = await mock();
    const { s } = clocked(m);
    const r = await s.cycle(() => m.expireSession());
    expect(r.watts).toBe(6.8);
    expect(m.poec[0]).toBe(1);
    // The PoE on with the expired session was answered as expired; then a new login.
    expect(m.calls.some((c) => c.cmd === 103 && c.expired)).toBe(true);
    expect(m.calls.filter((c) => c.cmd === 123)).toHaveLength(2);
    expect(m.calls.at(-1)?.cmd).toBe(126);
    expect(m.activeSession()).toBe(false);
  });

  it('PoE on keeps failing: retries for about 60 s with backoff, then reports PoE may still be off', async () => {
    const m = await mock();
    const { s, clock } = clocked(m);
    const t0 = clock.t;
    const e = await s.cycle(() => void (m.failSet = 1000)).catch((x: unknown) => x as PoeSwitchError);
    expect(e).toMatchObject({ code: 'switch_error', poeOff: true, turnedOn: false });
    expect((e as Error).message).toMatch(/PoE may still be OFF on port 8/);
    const onTries = m.opcodes.filter((o) => o === 0x202).length;
    expect(onTries).toBeGreaterThan(3);
    expect(onTries).toBeLessThan(40);
    const waited = clock.t - t0 - 10000; // minus the off time
    expect(waited).toBeGreaterThanOrEqual(55_000);
    expect(waited).toBeLessThanOrEqual(75_000);
    expect(s.status().poeMaybeOff).toBe(true);
    expect(m.calls.at(-1)?.cmd).toBe(126);
  });

  it('poeOn: turns the port on when it is off, without the power check; nothing to do when it is on', async () => {
    const m = await mock();
    const { s } = clocked(m);
    m.poec[0] = 0;
    expect(await s.poeOn()).toMatchObject({ port: 8, index: 0, wasOn: false, poe: true });
    expect(m.opcodes).toEqual([0x202]);
    expect(m.poec[0]).toBe(1);
    expect(await s.poeOn()).toMatchObject({ wasOn: true, poe: true });
    expect(m.opcodes).toEqual([0x202]);
    expect(m.activeSession()).toBe(false);
  });

  it('poeOn clears the "PoE may be off" state', async () => {
    const m = await mock();
    const { s } = clocked(m);
    await s.cycle(() => void (m.failSet = 1000)).catch(() => {});
    expect(s.status().poeMaybeOff).toBe(true);
    m.failSet = 0;
    expect(await s.poeOn()).toMatchObject({ wasOn: false, poe: true });
    expect(s.status().poeMaybeOff).toBe(false);
  });

  it('a login that times out is switch_busy (busy or unreachable); a refused connection stays unreachable', async () => {
    const m = await mock();
    m.hang = true;
    const s = new PoeSwitch({ config: () => ({ model: 'sscpoe-web', host: m.host, port: 8, ports: 8, offSeconds: 5 }), password: () => PASSWORD, timeoutMs: 300 });
    const e = await s.read().catch((x: unknown) => x as PoeSwitchError);
    expect(e).toMatchObject({ code: 'switch_busy' });
    expect((e as Error).message).toMatch(/busy or unreachable: is someone logged in to the switch's web UI\?/);
    expect(m.opcodes).toEqual([]);
  });

  it('a stop during the login or the 101 read never cuts the port', async () => {
    for (const cmd of [123, 101]) {
      const m = await mock();
      m.delay[cmd] = 200;
      const { s } = clocked(m);
      const cycling = s.cycle(() => {}).catch((x: unknown) => x as PoeSwitchError);
      await new Promise((r) => setTimeout(r, 50));
      await s.stop();
      expect(await cycling, String(cmd)).toMatchObject({ code: 'switch_error', poeOff: false });
      expect(m.opcodes, String(cmd)).toEqual([]);
      expect(m.poec[0]).toBe(1);
    }
  });

  it('stop() with a switch that stops answering: every call is bounded by the stop budget, the final logout is tried, and it says the session may be open', async () => {
    const m = await mock();
    const s = new PoeSwitch({
      config: () => ({ model: 'sscpoe-web', host: m.host, port: 8, ports: 8, offSeconds: 60 }),
      password: () => PASSWORD,
      sleep: (ms) => (ms >= 60000 ? new Promise<void>(() => {}) : new Promise<void>((r) => setTimeout(r, ms))),
      timeoutMs: 5000,
    });
    const cycling = s.cycle(() => void (m.hang = true)).catch((x: unknown) => x as PoeSwitchError);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    const r = await s.stop();
    const took = Date.now() - t0;
    expect(took).toBeLessThan(8000);
    expect(r).toEqual({ poeLeftOff: true, sessionMaybeOpen: true });
    // The stop waited for the whole session, including the final logout attempt.
    expect(m.calls.at(-1)?.cmd).toBe(126);
    expect(await cycling).toMatchObject({ poeOff: true, turnedOn: false });
    m.hang = false;
  }, 15000);

  it('stop() is bounded: a switch that won\'t turn PoE on is given a short try, then stop reports it left off', async () => {
    const m = await mock();
    const { s } = clocked(m, { offSeconds: 60, realOffSleep: true });
    const cycling = s.cycle(() => void (m.failSet = 1000)).catch((x: unknown) => x as PoeSwitchError);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    const r = await s.stop();
    expect(Date.now() - t0).toBeLessThan(9000);
    expect(r).toEqual({ poeLeftOff: true, sessionMaybeOpen: false });
    expect(await cycling).toMatchObject({ poeOff: true, turnedOn: false });
    expect(m.calls.at(-1)?.cmd).toBe(126);
  });

  it('one switch session at a time: a read during a cycle is refused (switch_busy) without touching the switch', async () => {
    const m = await mock();
    let release!: () => void;
    const s = new PoeSwitch({ config: () => ({ model: 'sscpoe-web', host: m.host, port: 8, ports: 8, offSeconds: 5 }), password: () => PASSWORD, sleep: () => new Promise<void>((r) => (release = r)), timeoutMs: 1000 });
    const cycling = s.cycle(() => {});
    await new Promise((r) => setTimeout(r, 100));
    const calls = m.calls.length;
    expect(await codeOf(s.read())).toBe('switch_busy');
    expect(m.calls.length).toBe(calls);
    release();
    await cycling;
  });

  it('a stop during the off time turns PoE on at once and logs out, then refuses new sessions', async () => {
    const m = await mock();
    const s = new PoeSwitch({ config: () => ({ model: 'sscpoe-web', host: m.host, port: 8, ports: 8, offSeconds: 60 }), password: () => PASSWORD, sleep: () => new Promise<void>(() => {}), timeoutMs: 1000 });
    let off = false;
    const cycling = s.cycle(() => void (off = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(off).toBe(true);
    expect(m.poec[0]).toBe(0);
    expect(await s.stop()).toEqual({ poeLeftOff: false, sessionMaybeOpen: false });
    expect(m.poec[0]).toBe(1);
    expect(m.opcodes).toEqual([0x2, 0x202]);
    expect(m.calls.at(-1)?.cmd).toBe(126);
    expect((await cycling).watts).toBe(6.8);
    expect(await codeOf(s.read())).toBe('switch_error');
    await s.stop(); // nothing in flight: at once
  });

  it('names what is missing when not configured', () => {
    const base = { model: 'sscpoe-web' as const, host: '192.0.2.7', port: 8, ports: 8, offSeconds: 10 };
    const nc = (c: object, pw: string | null = PASSWORD) => new PoeSwitch({ config: () => ({ ...base, ...c }), password: () => pw ?? undefined }).notConfigured();
    expect(nc({})).toBeNull();
    expect(nc({ model: 'none' })).toMatch(/camera.poeSwitch.model is none/);
    expect(nc({ host: undefined })).toMatch(/camera.poeSwitch.host/);
    expect(nc({ port: undefined })).toMatch(/camera.poeSwitch.port/);
    expect(nc({ port: 9 })).toMatch(/camera.poeSwitch.port is above camera.poeSwitch.ports/);
    expect(nc({}, null)).toMatch(/CAMPROXY_POE_SWITCH_PASSWORD is not set/);
    const st = new PoeSwitch({ config: () => base, password: () => PASSWORD }).status();
    expect(st).toEqual({ model: 'sscpoe-web', host: '192.0.2.7', port: 8, ports: 8, offSeconds: 10, passwordSet: true, configured: true, busy: false, poeMaybeOff: false, last: null });
    expect(JSON.stringify(st)).not.toContain(PASSWORD);
  });
});
