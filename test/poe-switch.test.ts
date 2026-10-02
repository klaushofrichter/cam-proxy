// Issue #85: the PoE switch's local web protocol (STEAMEMO/SSCPOE GPS-208
// and kin), against the mock in test/helpers; the real switch is never used.
import { afterEach, describe, expect, it } from 'vitest';
import { PoeSwitch, PoeSwitchError, poeOpcode, portIndex, reverseOrder } from '../src/camera/poe-switch';
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
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PoeSwitchError);
    return (e as PoeSwitchError).code;
  }
  throw new Error('expected a PoeSwitchError');
};

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

  it('logs out when PoE off fails, and retries PoE on before giving up (poeOff: true)', async () => {
    const m = await mock();
    m.failSet = 1;
    expect(await codeOf(sw(m).s.cycle(() => {}))).toBe('switch_error');
    expect(m.calls.at(-1)?.cmd).toBe(126);
    expect(m.poec[0]).toBe(1);

    const m2 = await mock();
    let off = 0;
    const s = sw(m2).s;
    // PoE off works, then PoE on fails twice: the third try turns it on.
    const p = s.cycle(() => void (off++, (m2.failSet = 2)));
    const r = await p;
    expect(off).toBe(1);
    expect(r.watts).toBe(6.8);
    expect(m2.opcodes).toEqual([0x2, 0x202, 0x202, 0x202]);
    expect(m2.poec[0]).toBe(1);

    const m3 = await mock();
    const s3 = sw(m3).s;
    const e = await s3.cycle(() => void (m3.failSet = 10)).catch((x: unknown) => x as PoeSwitchError);
    expect(e).toMatchObject({ code: 'switch_error', poeOff: true });
    expect((e as Error).message).toMatch(/PoE may still be off on port 8/);
    expect(m3.calls.at(-1)?.cmd).toBe(126);
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
    await s.stop();
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
    expect(st).toEqual({ model: 'sscpoe-web', host: '192.0.2.7', port: 8, ports: 8, offSeconds: 10, passwordSet: true, configured: true, busy: false, last: null });
    expect(JSON.stringify(st)).not.toContain(PASSWORD);
  });
});
