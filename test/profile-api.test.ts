// GET/PUT /control/profile (cams-admin spec 2026-10-25-proxy-profile-design
// §0): the local admin reads and sets the proxy profile; a set is audited as
// config-change. A cams-admin-managed admin token is refused
// (test/auth-managed-routes.test.ts covers every mutating route).
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, auth, startProxy } from './helpers/proxy';
import { startSim } from './helpers/sim';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
const admin = () => auth(ADMIN_TOKEN);
beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
});
afterAll(async () => {
  await p?.proxy.stop();
  await sim?.close();
});
const overrides = () => JSON.parse(readFileSync(join(p.dir, 'data', 'overrides.json'), 'utf8'));

describe('GET /control/profile', () => {
  it('the defaults until set: the cameras held, no name or storage, FTP off', async () => {
    const r = await request(p.base).get('/control/profile').set(admin());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ set: false, name: null, cameras: 1, storageGB: null, held: 1, ftp: { enabled: false, passive: null }, warnings: [], firewall: { tool: 'ufw', lines: [] } });
    expect(r.body.hardware.cpuCores).toBeGreaterThanOrEqual(1);
    expect(r.body.storage.budgetBytes).toBeGreaterThan(0);
    expect(r.body.perCameraBytes).toBe(r.body.storage.budgetBytes);
  });
  it('needs the admin token', async () => {
    expect((await request(p.base).get('/control/profile')).status).toBe(401);
    expect((await request(p.base).get('/control/profile').set(auth())).status).toBe(403);
    expect((await request(p.base).put('/control/profile').set(auth()).send({ cameras: 2 })).status).toBe(403);
  });
});

describe('PUT /control/profile', () => {
  it('sets the given fields, writes overrides.json and records a config-change', async () => {
    const n = p.proxy.audit.list({ actions: ['config-change'], limit: 500 }).records.length;
    const r = await request(p.base).put('/control/profile').set(admin()).send({ cameras: 3, name: 'Test box (4 cores)', storageGB: 50 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ set: true, name: 'Test box (4 cores)', cameras: 3, storageGB: 50, held: 1 });
    expect(r.body.perCameraBytes).toBe(Math.floor(r.body.storage.budgetBytes / 3));
    expect(overrides().profile).toEqual({ cameras: 3, name: 'Test box (4 cores)', storageGB: 50 });
    const recs = p.proxy.audit.list({ actions: ['config-change'], limit: 500 }).records;
    expect(recs.length).toBe(n + 1);
    const changes = (recs[0].cam_proxy as { changes: { key: string }[] }).changes.map((c) => c.key).sort();
    expect(changes).toEqual(['profile.cameras', 'profile.name', 'profile.storageGB']);
    expect((await request(p.base).get('/control/profile').set(admin())).body.set).toBe(true);
  });
  it('null clears a field; absent ones stay', async () => {
    const r = await request(p.base).put('/control/profile').set(admin()).send({ name: null, firewall: 'nft' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: null, cameras: 3, storageGB: 50, firewall: { tool: 'nft' } });
    expect(overrides().profile).toEqual({ cameras: 3, storageGB: 50, firewall: 'nft' });
  });
  it('refuses what does not load, unknown fields, and a profile without cameras; nothing written', async () => {
    const before = JSON.stringify(overrides());
    const bad = async (body: unknown, detail: string) => {
      const r = await request(p.base).put('/control/profile').set(admin()).send(body as object);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body).toEqual({ error: 'invalid', detail });
    };
    await bad({ cameras: 0 }, 'profile.cameras: must be from 1 to 64');
    await bad({ name: 'x'.repeat(61) }, 'profile.name: has the wrong format');
    await bad({ cores: 4 }, 'cores: not a profile field (name, cameras, storageGB, firewall)');
    await bad([], 'the profile must be an object');
    await bad({ cameras: null }, 'cameras: required (the profile is set with its camera count)');
    expect(JSON.stringify(overrides())).toBe(before);
  });
  it('storageGB replaces a storage.maxBytes override (one change, one record); the profile view names what it ignores', async () => {
    expect((await request(p.base).put('/control/profile').set(admin()).send({ storageGB: null })).status).toBe(200);
    expect((await request(p.base).put('/control/config').set(admin()).send({ storage: { maxBytes: 10 ** 10 } })).status).toBe(200);
    const n = p.proxy.audit.list({ actions: ['config-change'], limit: 500 }).records.length;
    const r = await request(p.base).put('/control/profile').set(admin()).send({ storageGB: 50 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ storageGB: 50, ignored: {} });
    expect(overrides().storage?.maxBytes).toBeUndefined();
    const recs = p.proxy.audit.list({ actions: ['config-change'], limit: 500 }).records;
    expect(recs.length).toBe(n + 1);
    expect((recs[0].cam_proxy as { changes: { key: string }[] }).changes.map((c) => c.key).sort()).toEqual(['profile.storageGB', 'storage.maxBytes', 'storage.maxPercent']);
    // The Settings view says what is ignored (here: nothing).
    const v = (await request(p.base).get('/control/config').set(admin())).body as Record<string, { ignored?: string }>;
    expect(v['storage.maxBytes'].ignored).toBeUndefined();
  });
});

// een, the mini PC and the Pi as they are: storage.maxBytes in config.json, the profile set here.
describe('PUT /control/profile over a storage.maxBytes from config.json', () => {
  let q: Awaited<ReturnType<typeof startProxy>>;
  beforeAll(async () => {
    q = await startProxy(sim, { settings: { storage: { maxBytes: 5 * 10 ** 9 } } });
  });
  afterAll(async () => {
    await q?.proxy.stop();
  });
  it('storageGB becomes the budget; config.json storage.maxBytes is ignored, and both views say so', async () => {
    const r = await request(q.base).put('/control/profile').set(admin()).send({ cameras: 1, storageGB: 7 });
    expect(r.status).toBe(200);
    expect(r.body.storageGB).toBe(7);
    expect(r.body.ignored).toEqual({ 'storage.maxBytes': 'ignored: profile.storageGB (overrides.json) is the storage budget' });
    expect(q.proxy.storage.budget()).toBe(Math.min(7e9, Math.floor((r.body.storage.diskBytes * 85) / 100)));
    const v = (await request(q.base).get('/control/config').set(admin())).body as Record<string, { ignored?: string; source: string }>;
    expect(v['storage.maxBytes']).toMatchObject({ source: 'file', ignored: 'ignored: profile.storageGB (overrides.json) is the storage budget' });
  });
});
