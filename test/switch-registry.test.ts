import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { PoeSwitchError } from '../src/camera/poe-switch';
import { SwitchRegistry } from '../src/camera/switch/registry';
import { switchPasswordStore } from '../src/config/switch-passwords';
import { startPoeSwitchMock, type PoeSwitchMock } from './helpers/poe-switch-mock';
import { startProxy, auth, ADMIN_TOKEN } from './helpers/proxy';
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
    switchPasswordStore(d).set('sw_a', PASSWORD);
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
    switchPasswordStore(d).set('sw_a', PASSWORD);
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
    switchPasswordStore(d).set('sw_a', PASSWORD);
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
    switchPasswordStore(d).set('sw_same', 'wrong-pw');
    await expect(same.read(3, { fresh: true })).rejects.toMatchObject({ code: 'switch_auth' });
    await a.stop();
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
      expect(audits(p.dir, 'switch-port-poe-on').map((r) => r.event.outcome)).toContain('success');
      const audit = auditText(p.dir);
      expect(audit).not.toContain(PASSWORD);
    } finally {
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

