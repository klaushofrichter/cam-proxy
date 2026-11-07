import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { PoeSwitchError } from '../src/camera/poe-switch';
import { SwitchRegistry } from '../src/camera/switch/registry';
import { switchPasswordStore } from '../src/config/switch-passwords';
import { startPoeSwitchMock, type PoeSwitchMock } from './helpers/poe-switch-mock';
import { startProxy, auth, ADMIN_TOKEN, until } from './helpers/proxy';
import { auditText, audits } from './helpers/onboarding';
import { startSim } from './helpers/sim';

const PASSWORD = 'mock-switch-pw-4711';
const mocks: PoeSwitchMock[] = [];
afterEach(async () => {
  for (const m of mocks.splice(0)) await m.close();
});
const mock = async () => {
  const m = await startPoeSwitchMock({ password: PASSWORD, powered: { 0: 6.8, 5: 4.5 } });
  mocks.push(m);
  return m;
};
const refOf = (m: PoeSwitchMock, id = 'sw_a') => ({ id, model: 'sscpoe-web' as const, host: m.host, ports: 8, offSeconds: 10 });
const tmp = () => mkdtempSync(join(tmpdir(), 'swreg-'));
const reg = (dataDir: string, legacy: { host?: string; password?: string } = {}) =>
  new SwitchRegistry({ dataDir, legacy: () => ({ model: legacy.host ? 'sscpoe-web' : 'none', host: legacy.host, ports: 8, offSeconds: 10 }), legacyPassword: () => legacy.password, sleep: async () => undefined, timeoutMs: 1000 });

describe('SwitchRegistry', () => {
  it('persists refs (no secrets) and restores them in a new instance', async () => {
    const d = tmp();
    const m = await mock();
    const a = reg(d);
    a.get(refOf(m));
    switchPasswordStore(d).set('sw_a', PASSWORD, m.host);
    expect(a.known()).toEqual([refOf(m)]);
    const text = readFileSync(join(d, 'switches.json'), 'utf8');
    expect(text).not.toContain(PASSWORD);
    await a.stop();
    const b = reg(d);
    expect(b.known()).toEqual([refOf(m)]);
    expect(b.passwordSet('sw_a')).toBe(true);
    await b.stop();
  });

  it('get with a changed ref updates the same controller and the file', async () => {
    const d = tmp();
    const m = await mock();
    const a = reg(d);
    const c1 = a.get(refOf(m));
    const c2 = a.get({ ...refOf(m), offSeconds: 20 });
    expect(c2).toBe(c1);
    expect(a.known()[0].offSeconds).toBe(20);
    expect(reg(d).known()[0].offSeconds).toBe(20);
    await a.stop();
  });

  it('a corrupt switches.json starts empty', () => {
    const d = tmp();
    writeFileSync(join(d, 'switches.json'), '{oops');
    expect(reg(d).known()).toEqual([]);
  });

  it('forget removes the ref and the password', async () => {
    const d = tmp();
    const m = await mock();
    const a = reg(d);
    a.get(refOf(m));
    switchPasswordStore(d).set('sw_a', PASSWORD, m.host);
    expect(a.forget('sw_a')).toBe(true);
    expect(a.forget('sw_a')).toBe(false);
    expect(a.known()).toEqual([]);
    expect(switchPasswordStore(d).get('sw_a')).toBeUndefined();
    expect(reg(d).known()).toEqual([]);
    await a.stop();
  });

  it('works the switch with the stored password; without one: password_unset', async () => {
    const d = tmp();
    const m = await mock();
    const a = reg(d);
    const c = a.get(refOf(m));
    await expect(c.read(3)).rejects.toMatchObject({ code: 'password_unset' });
    await expect(c.read(3)).rejects.toBeInstanceOf(PoeSwitchError);
    switchPasswordStore(d).set('sw_a', PASSWORD, m.host);
    await expect(c.read(3, { fresh: true })).resolves.toMatchObject({ port: 3 });
    await a.stop();
  });

  it('legacy fallback (the env password) only when the hosts match and no password is stored', async () => {
    const d = tmp();
    const m = await mock();
    const other = await mock();
    const a = reg(d, { host: m.host, password: PASSWORD });
    const same = a.get(refOf(m, 'sw_same'));
    const diff = a.get(refOf(other, 'sw_diff'));
    expect(a.passwordSet('sw_same')).toBe(true);
    expect(a.passwordSet('sw_diff')).toBe(false);
    await expect(same.read(3)).resolves.toMatchObject({ port: 3 });
    await expect(diff.read(3)).rejects.toMatchObject({ code: 'password_unset' });
    // A stored password wins over the env one.
    switchPasswordStore(d).set('sw_same', 'wrong-pw', m.host);
    await expect(same.read(3, { fresh: true })).rejects.toMatchObject({ code: 'switch_auth' });
    await a.stop();
  });

  it('a stored password is bound to the address it was set for: another host answers password_unset and never gets it', async () => {
    const d = tmp();
    const m = await mock();
    const other = await mock();
    const a = reg(d);
    const c = a.get(refOf(m));
    switchPasswordStore(d).set('sw_a', PASSWORD, m.host.toUpperCase());
    expect(switchPasswordStore(d).get('sw_a')).toEqual({ password: PASSWORD, host: m.host.toLowerCase() });
    await expect(c.read(3, { fresh: true })).resolves.toMatchObject({ port: 3 });
    // cams-admin names another address for the same id: the password is not sent there.
    expect(a.get(refOf(other))).toBe(c);
    expect(a.passwordSet('sw_a')).toBe(false);
    const err = await c.read(3, { fresh: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PoeSwitchError);
    expect(err).toMatchObject({ code: 'password_unset', message: `the switch password was set for another address: set it again for ${other.host}` });
    expect(other.calls).toEqual([]);
    // Set again for the new address: used there.
    switchPasswordStore(d).set('sw_a', PASSWORD, other.host);
    await expect(c.read(3, { fresh: true })).resolves.toMatchObject({ port: 3 });
    expect(other.calls.map((x) => x.cmd)).toContain(123);
    await a.stop();
  });

  it('a password stored without an address (before binding) is bound to the switch host on first load', async () => {
    const d = tmp();
    const m = await mock();
    const other = await mock();
    reg(d).get(refOf(m));
    mkdirSync(join(d, 'admin'), { recursive: true });
    writeFileSync(join(d, 'admin', 'switch-passwords.json'), JSON.stringify({ v: 1, switches: { sw_a: { password: PASSWORD } } }), { mode: 0o600 });
    const a = reg(d);
    expect(a.passwordSet('sw_a')).toBe(true);
    expect(switchPasswordStore(d).get('sw_a')).toEqual({ password: PASSWORD, host: m.host.toLowerCase() });
    a.get(refOf(other));
    await expect(a.get(refOf(other)).read(3)).rejects.toMatchObject({ code: 'password_unset' });
    expect(other.calls).toEqual([]);
    await a.stop();
  });

  it('the legacy env fallback keeps its host rule when the stored password is for another address', async () => {
    const d = tmp();
    const m = await mock();
    const a = reg(d, { host: m.host, password: PASSWORD });
    a.get(refOf(m));
    switchPasswordStore(d).set('sw_a', 'old-pw', '192.0.2.99');
    expect(a.passwordSet('sw_a')).toBe(true);
    await expect(a.get(refOf(m)).read(3)).resolves.toMatchObject({ port: 3 });
    await a.stop();
  });

  it('after stop(), get() refuses: switch_error "the proxy is stopping", nothing is kept', async () => {
    const d = tmp();
    const m = await mock();
    const a = reg(d);
    const stopping = a.stop();
    expect(() => a.get(refOf(m))).toThrow(PoeSwitchError);
    expect(() => a.get(refOf(m))).toThrow('the proxy is stopping');
    await stopping;
    expect(a.known()).toEqual([]);
  });

  it('no legacy fallback when the host config says model none', async () => {
    const d = tmp();
    const m = await mock();
    const a = new SwitchRegistry({ dataDir: d, legacy: () => ({ model: 'none', host: m.host, ports: 8, offSeconds: 10 }), legacyPassword: () => PASSWORD });
    a.get(refOf(m));
    expect(a.passwordSet('sw_a')).toBe(false);
    await a.stop();
  });
});

// The mock's calls never show two logins (123) without a logout (126) between.
const oneSessionAtATime = (m: PoeSwitchMock) => {
  let open = 0;
  for (const c of m.calls) {
    if (c.cmd === 123) open++;
    if (c.cmd === 126) open--;
    expect(open).toBeLessThanOrEqual(1);
  }
  expect(m.calls.filter((c) => c.cmd === 123).length).toBeGreaterThanOrEqual(2);
};

describe('one session queue per switch host', () => {
  it('the legacy controller and a registry ref on its host never overlap', async () => {
    const d = tmp();
    const m = await mock();
    const a = reg(d, { host: m.host.toUpperCase(), password: PASSWORD });
    const c = a.get(refOf(m));
    const r = await Promise.all([a.legacy.read(3, { fresh: true }), c.read(4, { fresh: true })]);
    expect(r.map((x) => x.port)).toEqual([3, 4]);
    oneSessionAtATime(m);
    await a.stop();
  });

  it('two ids on one host never overlap', async () => {
    const d = tmp();
    const m = await mock();
    const a = reg(d);
    switchPasswordStore(d).set('sw_a', PASSWORD, m.host);
    switchPasswordStore(d).set('sw_b', PASSWORD, m.host);
    const r = await Promise.all([a.get(refOf(m, 'sw_a')).read(3, { fresh: true }), a.get(refOf(m, 'sw_b')).read(4, { fresh: true })]);
    expect(r.map((x) => x.port)).toEqual([3, 4]);
    oneSessionAtATime(m);
    await a.stop();
  });

  it('forget reports a stopped controller to onForgotten', async () => {
    const d = tmp();
    const m = await mock();
    const seen: unknown[] = [];
    const a = new SwitchRegistry({ dataDir: d, legacy: () => ({ model: 'none', ports: 8, offSeconds: 10 }), legacyPassword: () => undefined, onForgotten: (r) => seen.push(r) });
    a.get(refOf(m));
    a.forget('sw_a');
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([{ id: 'sw_a', ref: refOf(m), portsLeftOff: [], sessionMaybeOpen: false }]);
    await a.stop();
  });
});

describe('switch routes', () => {
  it('lists switches without passwords; sets a password (600 file, audited, never echoed); turns a port PoE on (audited)', async () => {
    const sim = await startSim();
    const m = await mock();
    const p = await startProxy(sim);
    try {
      p.proxy.switches.get(refOf(m));
      const list = async () => (await request(p.base).get('/control/switches').set(auth(ADMIN_TOKEN))).body;
      expect(await list()).toEqual({ switches: [{ ...refOf(m), passwordSet: false, busy: false, poeMaybeOff: [] }] });
      const put = await request(p.base).put('/control/switches/sw_a/password').set(auth(ADMIN_TOKEN)).send({ password: PASSWORD });
      expect(put.status).toBe(200);
      expect(JSON.stringify(put.body)).not.toContain(PASSWORD);
      expect(statSync(join(p.dir, 'data', 'admin', 'switch-passwords.json')).mode & 0o777).toBe(0o600);
      // Bound to the switch's current address.
      expect(switchPasswordStore(join(p.dir, 'data')).get('sw_a')).toEqual({ password: PASSWORD, host: m.host.toLowerCase() });
      const after = await request(p.base).get('/control/switches').set(auth(ADMIN_TOKEN));
      expect(after.body.switches[0].passwordSet).toBe(true);
      expect(JSON.stringify(after.body)).not.toContain(PASSWORD);
      expect((await request(p.base).put('/control/switches/sw_a/password').set(auth(ADMIN_TOKEN)).send({ password: '' })).status).toBe(400);
      expect((await request(p.base).put('/control/switches/nope/password').set(auth(ADMIN_TOKEN)).send({ password: 'x' })).status).toBe(404);

      m.poec[3] = 0; // port 5 (GPS208: index 8 - port) has PoE off
      const on = await request(p.base).post('/control/switches/sw_a/ports/5/poe-on').set(auth(ADMIN_TOKEN));
      expect(on.status).toBe(200);
      expect(m.poec[3]).toBe(1);
      expect(on.body).toMatchObject({ port: 5, poe: true, wasOn: false });
      expect((await request(p.base).post('/control/switches/sw_a/ports/9/poe-on').set(auth(ADMIN_TOKEN))).status).toBe(400);
      expect((await request(p.base).post('/control/switches/nope/ports/1/poe-on').set(auth(ADMIN_TOKEN))).status).toBe(404);

      expect(audits(p.dir, 'switch-password')).toHaveLength(1);
      expect(audits(p.dir, 'switch-password')[0].event.category).toEqual(['configuration']);
      expect(audits(p.dir, 'switch-port-poe-on').map((r) => r.event.outcome)).toContain('success');
      const audit = auditText(p.dir);
      expect(audit).not.toContain(PASSWORD);
    } finally {
      await p.proxy.stop();
      await sim.close();
    }
  }, 30000);

  it('a proxy stop that cannot turn a registry switch\'s PoE on again: one record naming the switch, its ports left off and a readable message', async () => {
    const sim = await startSim();
    const m = await mock();
    const p = await startProxy(sim);
    try {
      p.proxy.switches.get({ ...refOf(m), offSeconds: 60 });
      switchPasswordStore(join(p.dir, 'data')).set('sw_a', PASSWORD, m.host);
      void p.proxy.switches.get({ ...refOf(m), offSeconds: 60 }).cycle(3, () => undefined, { verifyHost: null }).catch(() => {});
      await until(() => m.poec[5] === 0, 5000);
      m.failSet = 1000;
      await p.proxy.stop({ reason: 'test' });
      const recs = p.proxy.audit.list({ actions: ['camera-powercycle'] }).records.filter((x) => (x.cam_proxy as { phase?: string }).phase === 'stop');
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { phase: 'stop', poeLeftOff: true, sessionMaybeOpen: false, switch: { id: 'sw_a', host: m.host }, portsLeftOff: [3] } });
      expect((recs[0].cam_proxy as { switch: Record<string, unknown> }).switch.ports).toBeUndefined();
      expect(recs[0].message).toBe(`cam-proxy stopping: PoE may be left OFF on PoE switch sw_a (${m.host}) port 3; turn it on in the switch's web UI, or with "Turn PoE on" under Proxy settings once the proxy is back`);
    } finally {
      m.failSet = 0;
      await p.proxy.stop();
      await sim.close();
    }
  }, 30000);

  it('poe-on without a stored password: 409 password_unset', async () => {
    const sim = await startSim();
    const m = await mock();
    const p = await startProxy(sim);
    try {
      p.proxy.switches.get(refOf(m));
      const r = await request(p.base).post('/control/switches/sw_a/ports/5/poe-on').set(auth(ADMIN_TOKEN));
      expect([r.status, r.body.error]).toEqual([409, 'password_unset']);
    } finally {
      await p.proxy.stop();
      await sim.close();
    }
  }, 30000);
});

