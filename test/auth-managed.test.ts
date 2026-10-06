import { createHash, randomBytes } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writePrivateJson } from '../src/fleet/private-file';
import { createLoginLinks } from '../src/api/login-links';
import { createSessionSigner } from '../src/api/session';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, CLIENT_TOKEN, startProxy } from './helpers/proxy';

// Managed tokens beside CAMPROXY_TOKENS (migration P2, M §10.2), and the
// local-only widening rule (Ruling R2-3).
const tok = () => randomBytes(32).toString('base64url');
const hashOf = (t: string) => `sha256:${createHash('sha256').update(t).digest('hex')}`;
const id = (n: number) => `tok_${String(n).padStart(20, '0')}`;
const MANAGED_CLIENT = tok();
const MANAGED_ADMIN = tok();
const RETIRED = tok();

describe('sessions and login links carry their origin', () => {
  it('a session says whether it came from local or managed admin rights', () => {
    const s = createSessionSigner();
    expect(s.verify(s.issue('local'))).toEqual({ origin: 'local' });
    expect(s.verify(s.issue('managed', id(2)))).toEqual({ origin: 'managed', tokenId: id(2) });
    const v = s.issue('managed', id(2));
    // Changing the origin or the token id breaks the signature.
    expect(s.verify(v.replace(`.m~${id(2)}.`, '.l.'))).toBeNull();
    expect(s.verify(v.replace(id(2), id(3)))).toBeNull();
    expect(s.verify(undefined)).toBeNull();
  });
  it('a login link answers the origin it was minted with', () => {
    const l = createLoginLinks();
    const a = l.issue('local');
    const b = l.issue('managed', id(2));
    expect(l.consume(b.code)).toEqual({ origin: 'managed', tokenId: id(2) });
    expect(l.consume(a.code)).toEqual({ origin: 'local' });
    expect(l.consume(a.code)).toBeNull();
  });
});

describe('managed tokens over HTTP', () => {
  let sim: Awaited<ReturnType<typeof startSim>>;
  let p: Awaited<ReturnType<typeof startProxy>>;
  beforeAll(async () => {
    sim = await startSim();
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-managed-'));
    writePrivateJson(join(dir, 'data', 'admin', 'tokens.json'), {
      v: 1, revision: 1, blocked: [],
      tokens: [
        { id: id(1), kind: 'client', hash: hashOf(MANAGED_CLIENT), label: 'cams client', retireAt: null },
        { id: id(2), kind: 'admin', hash: hashOf(MANAGED_ADMIN), label: 'cams cluster', retireAt: null },
        { id: id(3), kind: 'client', hash: hashOf(RETIRED), label: 'old', retireAt: 1 },
      ],
    });
    p = await startProxy(sim, { dir });
  });
  afterAll(async () => {
    await p.proxy.stop();
    await sim.close();
  });

  it('access order: local admin, managed admin, local client, managed client', async () => {
    expect((await request(p.base).get('/api/cameras').set(auth(MANAGED_CLIENT))).status).toBe(200);
    expect((await request(p.base).get('/control/status').set(auth(MANAGED_CLIENT))).status).toBe(403);
    expect((await request(p.base).get('/control/status').set(auth(MANAGED_ADMIN))).status).toBe(200);
    expect((await request(p.base).get('/api/cameras').set(auth(CLIENT_TOKEN))).status).toBe(200); // CAMPROXY_TOKENS unchanged
    expect((await request(p.base).get('/control/status').set(auth(ADMIN_TOKEN))).status).toBe(200);
  });
  it('a retired managed token is refused like an unknown one (401)', async () => {
    const r = await request(p.base).get('/api/cameras').set(auth(RETIRED));
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'unauthorized' });
  });
  it('a managed admin token can narrow but not widen (R2-3)', async () => {
    await request(p.base).put('/control/admin/commands').set(auth(ADMIN_TOKEN)).send({ allow: ['tokens.apply'] }).expect(200);
    await request(p.base).put('/control/admin/commands').set(auth(MANAGED_ADMIN)).send({ allow: ['tokens.apply', 'tokens.apply.admin'] }).expect(403, { error: 'local_admin_only', message: 'adding an allowed command needs the local admin token' });
    await request(p.base).post('/control/admin/commands/pause').set(auth(MANAGED_ADMIN)).send({ reason: 'test' }).expect(200);
    await request(p.base).post('/control/admin/commands/resume').set(auth(MANAGED_ADMIN)).expect(403);
    await request(p.base).post('/control/admin/commands/resume').set(auth(ADMIN_TOKEN)).expect(200);
  });
  it('a UI session from a login link minted with a managed admin token is managed too', async () => {
    const link = (await request(p.base).post('/control/login-links').set(auth(MANAGED_ADMIN)).expect(201)).body.code;
    const res = await request(p.base).get(`/control/login-link?code=${link}`).expect(302);
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    await request(p.base).put('/control/admin/commands').set('Cookie', cookie).set('x-camproxy-ui', '1').send({ allow: ['tokens.apply', 'config.get'] }).expect(403);
    const local = (await request(p.base).post('/control/login-links').set(auth(ADMIN_TOKEN)).expect(201)).body.code;
    const res2 = await request(p.base).get(`/control/login-link?code=${local}`).expect(302);
    await request(p.base).put('/control/admin/commands').set('Cookie', String(res2.headers['set-cookie']).split(';')[0]).set('x-camproxy-ui', '1').send({ allow: ['tokens.apply', 'config.get'] }).expect(200);
  });
  it('a login link minted with a managed admin token gives a managed session', async () => {
    const code = (await request(p.base).post('/control/login-links').set(auth(MANAGED_ADMIN)).expect(201)).body.code;
    const res = await request(p.base).get(`/control/login-link?code=${code}`).expect(302);
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    expect(cookie).toMatch(/^camproxy_session=v2\.\d+\.m~tok_\w{20}\./);
    const local = (await request(p.base).post('/control/login-links').set(auth(ADMIN_TOKEN)).expect(201)).body.code;
    const res2 = await request(p.base).get(`/control/login-link?code=${local}`).expect(302);
    expect(String(res2.headers['set-cookie'])).toMatch(/^camproxy_session=v2\.\d+\.l\./);
  });
  it('audit names the managed token by label, never the hash', async () => {
    await request(p.base).post('/control/login-links').set(auth(MANAGED_ADMIN)).expect(201);
    const text = (await request(p.base).get('/control/audit?action=login-link-issued').set(auth(ADMIN_TOKEN)).expect(200)).text;
    const recs = text.trim().split('\n').map((l) => JSON.parse(l));
    expect(JSON.stringify(recs)).toContain('token:cams cluster');
    expect(text).not.toContain(hashOf(MANAGED_ADMIN).slice(7, 23));
    expect(text).not.toContain(MANAGED_ADMIN);
  });
  it('blocking the managed admin token ends its sessions and its unredeemed links at once (the last test: it blocks the token)', async () => {
    const mint = async () => (await request(p.base).post('/control/login-links').set(auth(MANAGED_ADMIN)).expect(201)).body.code as string;
    const code = await mint();
    const cookie = String((await request(p.base).get(`/control/login-link?code=${code}`).expect(302)).headers['set-cookie']).split(';')[0];
    expect((await request(p.base).get('/control/status').set('Cookie', cookie)).status).toBe(200);
    const pending = await mint();
    await request(p.base).post(`/control/admin/tokens/${id(2)}/block`).set(auth(ADMIN_TOKEN)).expect(200);
    expect((await request(p.base).get('/control/status').set('Cookie', cookie)).status).toBe(401);
    const r = await request(p.base).get(`/control/login-link?code=${pending}`).expect(302);
    expect(r.headers.location).toBe('/?link=expired');
    expect(r.headers['set-cookie']).toBeUndefined();
  });
});
