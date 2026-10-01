import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { startSim } from './helpers/sim';
import { startProxy, auth, CLIENT_TOKEN, ADMIN_TOKEN } from './helpers/proxy';
import { createLoginLinks } from '../src/api/login-links';
import { LOGIN_ATTEMPTS } from '../src/api/control-api';

// One-time sign-in links (Klaus, 2026-09-28): cams, holding the admin token,
// mints a code server to server; the browser redeems it for a UI session.
describe('createLoginLinks', () => {
  it('issues random single-use codes that expire', () => {
    vi.useFakeTimers();
    try {
      const links = createLoginLinks(60_000);
      const a = links.issue();
      const b = links.issue();
      expect(a.code).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(a.code).not.toBe(b.code);
      expect(links.consume(a.code)).toBe(true);
      expect(links.consume(a.code)).toBe(false); // once
      vi.advanceTimersByTime(60_001);
      expect(links.consume(b.code)).toBe(false); // expired
      expect(links.consume('nope')).toBe(false);
      expect(links.consume(undefined)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps at most 100 codes, dropping the oldest', () => {
    const links = createLoginLinks(60_000);
    const first = links.issue();
    for (let i = 0; i < 100; i++) links.issue();
    expect(links.consume(first.code)).toBe(false);
  });
});

describe('login links over HTTP', () => {
  let sim: Awaited<ReturnType<typeof startSim>>;
  let p: Awaited<ReturnType<typeof startProxy>>;
  beforeAll(async () => {
    sim = await startSim();
    p = await startProxy(sim);
  });
  afterAll(async () => {
    await p.proxy.stop();
    await sim.close();
  });

  it('only the admin token mints a link', async () => {
    expect((await request(p.base).post('/control/login-links')).status).toBe(401);
    expect((await request(p.base).post('/control/login-links').set(auth(CLIENT_TOKEN))).status).toBe(403);
    const r = await request(p.base).post('/control/login-links').set(auth(ADMIN_TOKEN));
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ code: expect.stringMatching(/^[A-Za-z0-9_-]{32,}$/), expiresInS: 60 });
  });

  it('redeems a code once for a UI session, then sends the browser to the UI', async () => {
    const { code } = (await request(p.base).post('/control/login-links').set(auth(ADMIN_TOKEN))).body;
    const r = await request(p.base).get(`/control/login-link?code=${code}`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/');
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toMatch(/^camproxy_session=v1\..*HttpOnly.*SameSite=Strict/);
    const session = cookie.split(';')[0];
    expect((await request(p.base).get('/control/session').set('Cookie', session)).body).toEqual({ loggedIn: true });
    const again = await request(p.base).get(`/control/login-link?code=${code}`);
    expect(again.status).toBe(302);
    expect(again.headers.location).toBe('/?link=expired');
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  it('has its own attempt limit, and a limited browser lands on the token login (review)', async () => {
    for (let i = 0; i < 25; i++) {
      const r = await request(p.base).get('/control/login-link?code=wrong');
      expect(r.status).toBe(302);
      expect(r.headers.location).toBe('/?link=expired');
    }
    // The token login's own attempts are untouched by those.
    expect((await request(p.base).post('/control/login').send({ token: 'x' })).status).toBe(401);
  });
});

// Issue #29: behind the cluster's ingress every client has the ingress's
// address, so rate limits count everyone together unless the proxy trusts
// X-Forwarded-For (server.trustProxy: the number of proxies in front).
describe('server.trustProxy', () => {
  let sim: Awaited<ReturnType<typeof startSim>>;
  beforeAll(async () => {
    sim = await startSim();
  });
  afterAll(async () => {
    await sim.close();
  });
  const attempts = async (settings: object) => {
    const p = await startProxy(sim, { settings });
    try {
      const codes: number[] = [];
      for (let i = 0; i <= LOGIN_ATTEMPTS; i++) codes.push((await request(p.base).post('/control/login').set('X-Forwarded-For', `10.0.0.${i + 1}`).send({ token: 'wrong' })).status);
      return codes;
    } finally {
      await p.proxy.stop();
    }
  };
  it('counts clients by X-Forwarded-For when trusted', async () => {
    expect((await attempts({ server: { logLevel: 'silent', trustProxy: 1 } })).includes(429)).toBe(false);
  });
  it('counts everyone together when not (the default)', async () => {
    expect((await attempts({})).at(-1)).toBe(429);
  });
});
