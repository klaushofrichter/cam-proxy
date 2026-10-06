import { createHash, randomBytes } from 'crypto';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MANAGED_ALLOWED } from '../src/api/auth';
import { writePrivateJson } from '../src/fleet/private-file';
import { ADMIN_TOKEN, auth, startProxy } from './helpers/proxy';
import { startSim } from './helpers/sim';

// A cams-admin-managed admin token (spec M2: sign-in links and camera rename)
// is no local admin: every mutating admin route answers 403 local_admin_only
// unless it is on the explicit list (narrowing, rename, sign-in links). New
// routes are local-only by default. Sessions from links it minted are the same.
const tok = () => randomBytes(32).toString('base64url');
const hashOf = (t: string) => `sha256:${createHash('sha256').update(t).digest('hex')}`;
const MANAGED_ADMIN = tok();

// Every mutating /control operation in openapi.yaml (which test/openapi.test.ts
// keeps equal to the registered routes), without the session routes (no admin access).
function mutating(): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  let path = '';
  for (const line of readFileSync(join(__dirname, '..', 'openapi.yaml'), 'utf8').split('\n')) {
    const p = /^  (\/\S*):\s*$/.exec(line);
    if (p) path = p[1];
    const m = /^    (put|post|delete|patch):\s*$/.exec(line);
    if (m && path.startsWith('/control/') && !['/control/login', '/control/logout', '/control/login-link'].includes(path)) out.push({ method: m[1].toUpperCase(), path });
  }
  return out;
}
const concrete = (p: string) => p.replace('{cam}', 'cam1').replace('{name}', 'archive-clear').replace('{id}', `tok_${'7'.repeat(20)}`).replace('{path}', 'sse.pingS');
const allowed = (method: string, path: string) => MANAGED_ALLOWED.some(([m, re]) => m === method && re.test(path));

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  sim = await startSim();
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-mroutes-'));
  writePrivateJson(join(dir, 'data', 'admin', 'tokens.json'), { v: 1, revision: 1, blocked: [], tokens: [{ id: `tok_${'1'.repeat(20)}`, kind: 'admin', hash: hashOf(MANAGED_ADMIN), label: 'cams', retireAt: null }] });
  p = await startProxy(sim, { dir });
});
afterAll(async () => {
  await p?.proxy.stop();
  await sim?.close();
});

const send = (method: string, path: string, h: Record<string, string>, body: object = {}) => {
  const r = request(p.base)[method.toLowerCase() as 'post'](path);
  for (const [k, v] of Object.entries(h)) r.set(k, v);
  return r.send(body);
};

describe('a managed admin token on the admin API', () => {
  it('the allow-list is short: sign-in links, camera rename, pause, narrowing the allow-list, block', () => {
    expect(MANAGED_ALLOWED.map(([m, re]) => `${m} ${re.source}`)).toHaveLength(6);
  });
  it('every other mutating admin route: 403 local_admin_only (the probes: archive-clear, camsAdmin.url, enroll, camera-address, secret-override, …)', async () => {
    const ops = mutating();
    expect(ops.length).toBeGreaterThanOrEqual(18);
    for (const { method, path } of ops) {
      const url = concrete(path);
      const r = await send(method, url, auth(MANAGED_ADMIN), path === '/control/config' ? { camsAdmin: { url: 'https://evil.example' } } : { count: 0 });
      if (allowed(method, url)) expect(r.body?.error, `${method} ${url}`).not.toBe('local_admin_only');
      else expect([r.status, r.body?.error], `${method} ${url}`).toEqual([403, 'local_admin_only']);
    }
    for (const a of ['archive-clear', 'camera-address', 'camera-trust-clear', 'tls-ca-rotate', 'camera-poe-on', 'restart-proxy']) {
      expect((await send('POST', `/control/actions/${a}`, auth(MANAGED_ADMIN), { count: 0 })).status, a).toBe(403);
    }
    expect(p.proxy.running.camsAdmin.url).toBeUndefined();
  });
  it('reads and the allowed routes work: GET status, sign-in link, rename reaches its own checks', async () => {
    expect((await request(p.base).get('/control/status').set(auth(MANAGED_ADMIN))).status).toBe(200);
    expect((await request(p.base).get('/control/config').set(auth(MANAGED_ADMIN))).status).toBe(200);
    expect((await send('POST', '/control/login-links', auth(MANAGED_ADMIN))).status).toBe(201);
    expect((await send('PUT', '/control/camera/name', auth(MANAGED_ADMIN), { name: '' })).status).toBe(400);
  });
  it('a session from a link the managed token minted is managed too; one from the local token is not', async () => {
    const session = async (t: string) => {
      const code = (await send('POST', '/control/login-links', auth(t))).body.code;
      return String((await request(p.base).get(`/control/login-link?code=${code}`)).headers['set-cookie']).split(';')[0];
    };
    const m = await session(MANAGED_ADMIN);
    const r = await send('PUT', '/control/config', { Cookie: m, 'x-camproxy-ui': '1' }, { sse: { pingS: 9 } });
    expect([r.status, r.body.error]).toEqual([403, 'local_admin_only']);
    expect((await send('POST', '/control/actions/archive-clear', { Cookie: m, 'x-camproxy-ui': '1' }, { count: 0 })).status).toBe(403);
    const l = await session(ADMIN_TOKEN);
    expect((await send('PUT', '/control/config', { Cookie: l, 'x-camproxy-ui': '1' }, { sse: { pingS: 9 } })).status).toBe(200);
  });
});
