import { afterAll, describe, expect, it } from 'vitest';
import { PasswordAttempts } from '../src/onboarding/attempts';
import { checkLogin } from '../src/onboarding/login-check';
import { servedCertificate } from '../src/tls/served';
import { otherCertificate } from './helpers/certs';
import { freePort } from './helpers/proxy';
import { startSim } from './helpers/sim';

type Sim = Awaited<ReturnType<typeof startSim>>;
const sims: Sim[] = [];
const sim = async (o: Parameters<typeof startSim>[0] = {}) => {
  const s = await startSim(o);
  sims.push(s);
  return s;
};
afterAll(async () => void (await Promise.all(sims.map((s) => s.close()))));

describe('password attempts (spec 2026-10-30-camera-onboarding-design §4.1)', () => {
  it('allows 5 attempts per address per 10 minutes, then says when to retry', () => {
    let t = 0;
    const a = new PasswordAttempts(() => t);
    for (let i = 0; i < 5; i++) expect(a.take('192.0.2.10:443').ok).toBe(true);
    expect(a.take('192.0.2.10')).toEqual({ ok: false, retryAfterS: 600 });
    expect(a.take('192.0.2.11').ok).toBe(true);
    t = 600_001;
    expect(a.take('192.0.2.10').ok).toBe(true);
  });

  it('the key is the bare address, any case', () => {
    const a = new PasswordAttempts(() => 0);
    for (let i = 0; i < 5; i++) expect(a.take(i % 2 ? 'Cam.Example:80' : 'cam.example').ok).toBe(true);
    expect(a.take('CAM.EXAMPLE:443').ok).toBe(false);
  });
});

describe('the login check', () => {
  it.each(['RLC-1224A', 'CX820', 'E1-Outdoor-Pro'] as const)('%s: the right password is ok with model and ability, a wrong one refused; both log out', async (model) => {
    const s = await sim({ model });
    const ok = await checkLogin({ id: 'x', host: s.camera.host, protocol: 'http', user: 'proxy', password: s.password });
    expect(ok.outcome).toBe('ok');
    expect(ok.device?.model).toBeTruthy();
    expect(ok.ability).toBeTruthy();
    expect((await checkLogin({ id: 'x', host: s.camera.host, protocol: 'http', user: 'proxy', password: 'wrong' })).outcome).toBe('refused');
    expect(s.sim.engine.sessions.online()).toHaveLength(0);
  });

  it('over https it logs in only to the pinned certificate', async () => {
    const s = await sim();
    const served = (await servedCertificate('127.0.0.1', s.ports.https))!;
    const theirs = await otherCertificate();
    const host = `127.0.0.1:${s.ports.https}`;
    const ok = await checkLogin({ id: 'x', host, protocol: 'https', user: 'proxy', password: s.password, trust: { ca: served.pem, fingerprint: served.fingerprint } });
    expect(ok.outcome).toBe('ok');
    const before = s.sim.engine.counters.loginAttempts;
    const r = await checkLogin({ id: 'x', host, protocol: 'https', user: 'proxy', password: s.password, trust: { ca: theirs.pem, fingerprint: theirs.fingerprint } });
    expect(r.outcome).toBe('error');
    expect(s.sim.engine.counters.loginAttempts).toBe(before);
    expect(s.sim.engine.sessions.online()).toHaveLength(0);
  });

  it('a closed port is offline', async () => {
    expect((await checkLogin({ id: 'x', host: `127.0.0.1:${await freePort()}`, protocol: 'http', user: 'proxy', password: 'p' }, { timeoutMs: 2000 })).outcome).toBe('offline');
  });
});
