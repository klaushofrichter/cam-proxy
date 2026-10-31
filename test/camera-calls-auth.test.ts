import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { managedAdminToken } from './helpers/onboarding';
import { CLIENT_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// Who may make the camera calls cams makes (spec 2026-10-30-camera-onboarding-design
// §4.8, §10.1): reads with a client token, camera-changing calls with an
// admin-kind token (a managed admin token for exactly these), the audit token
// and no token nowhere. Writes are sent with invalid bodies: a token that may
// make them gets 400 from the route, never a camera change.
const AUDIT_TOKEN = 'audit-token-'.padEnd(40, 'z');
let s: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let managed: string;
beforeAll(async () => {
  s = await startSim();
  const dir = mkdtempSync(join(tmpdir(), 'calls-auth-'));
  managed = managedAdminToken(dir);
  p = await startProxy(s, { dir, env: { CAMPROXY_AUDIT_TOKEN: AUDIT_TOKEN }, settings: { stills: { enabled: false } } });
  await until(() => p.proxy.cameras.get('cam1')!.status.state().online, 10_000);
}, 30_000);
afterAll(async () => {
  await p?.proxy.stop();
  await s?.close();
});

const READS = ['/api/cameras/cam1/status', '/api/cameras/cam1/snapshot.jpg', '/api/cameras/cam1/settings', '/api/cameras/cam1/settings/image', '/api/cameras/cam1/settings/detection', '/api/cameras/cam1/light'];
const WRITES: [method: 'put' | 'post', path: string, body: object][] = [
  ['put', '/api/cameras/cam1/settings/image', { extra: 1 }],
  ['put', '/api/cameras/cam1/settings/detection', { extra: 1 }],
  ['put', '/api/cameras/cam1/light', { on: 'yes' }],
  ['post', '/api/cameras/cam1/reboot', {}],
];
type Who = 'client' | 'managed' | 'audit' | 'none';
const headers = (who: Who): Record<string, string> => (who === 'none' ? {} : auth(who === 'client' ? CLIENT_TOKEN : who === 'managed' ? managed : AUDIT_TOKEN));
const live = (who: Who) => new Promise<number | string>((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${p.port}/api/cameras/cam1/live`, { headers: headers(who) });
  ws.on('unexpected-response', (_q, r) => resolve(r.statusCode ?? 0));
  ws.on('message', (d) => resolve(String(d)));
  ws.on('error', () => undefined);
});

describe('the camera calls by token kind', () => {
  it.each(['client', 'managed'] as const)('reads answer a %s token', async (who) => {
    for (const path of READS) expect((await request(p.base).get(path).set(headers(who))).status, path).toBe(200);
    // The live socket opens (stills are off here: the stream is unavailable, told over the socket).
    expect(await live(who)).toBe(JSON.stringify({ type: 'error', value: 'stream_unavailable' }));
  });

  it('writes answer a client token 403 admin_only', async () => {
    for (const [m, path, body] of WRITES) {
      const r = await request(p.base)[m](path).set(headers('client')).send(body);
      expect([r.status, r.body.error], `${m} ${path}`).toEqual([403, 'admin_only']);
    }
  });

  it('writes reach their route with a managed admin token (400 for these bodies, never 403)', async () => {
    for (const [m, path, body] of WRITES) {
      const r = await request(p.base)[m](path).set(headers('managed')).send(body);
      expect([r.status, r.body.error], `${m} ${path}`).toEqual([400, 'invalid']);
    }
    // And the two /control routes camera-calls includes for a managed admin token.
    expect((await request(p.base).put('/control/cameras/cam1/password').set(headers('managed')).send({})).status).toBe(400);
    expect((await request(p.base).post('/control/cameras/cam1/actions/camera-trust-pin').set(headers('managed')).send({ fingerprint: 'x' })).status).not.toBe(403);
  });

  it.each(['audit', 'none'] as const)('every call answers the %s token 401', async (who) => {
    for (const path of READS) expect((await request(p.base).get(path).set(headers(who))).status, path).toBe(401);
    for (const [m, path, body] of WRITES) expect((await request(p.base)[m](path).set(headers(who)).send(body)).status, `${m} ${path}`).toBe(401);
    expect(await live(who)).toBe(401);
  });

  it('the camera list announces camera-calls', async () => {
    expect((await request(p.base).get('/api/cameras').set(auth())).body[0].features).toContain('camera-calls');
  });
});
