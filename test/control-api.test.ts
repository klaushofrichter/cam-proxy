import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { startSim } from './helpers/sim';
import { startProxy, auth, until, CLIENT_TOKEN, ADMIN_TOKEN } from './helpers/proxy';
import { insertEvent } from '../src/catalog/events';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
const admin = () => auth(ADMIN_TOKEN);
beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
  await until(() => p.proxy.intake.state().onvif === 'subscribed');
});
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

async function login(): Promise<string> {
  const r = await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
  expect(r.status).toBe(204);
  const cookie = String(r.headers['set-cookie']);
  expect(cookie).toMatch(/^camproxy_session=v1\./);
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Strict/);
  return cookie.split(';')[0];
}

describe('control API: auth', () => {
  it('needs the admin token; a client token is refused as admin_only', async () => {
    expect((await request(p.base).get('/control/status')).status).toBe(401);
    const client = await request(p.base).get('/control/status').set(auth());
    expect(client.status).toBe(403);
    expect(client.body).toEqual({ error: 'admin_only' });
    expect((await request(p.base).get('/control/status').set(admin())).status).toBe(200);
  });

  it('lets the admin token and an admin session read the client API', async () => {
    expect((await request(p.base).get('/api/cameras').set(admin())).status).toBe(200);
    const cookie = await login();
    expect((await request(p.base).get('/api/cameras').set('Cookie', cookie)).status).toBe(200);
  });

  it('signs in with the admin token only, and signs out', async () => {
    expect((await request(p.base).post('/control/login').send({ token: CLIENT_TOKEN })).status).toBe(401);
    const cookie = await login();
    expect((await request(p.base).get('/control/session').set('Cookie', cookie)).body).toEqual({ loggedIn: true });
    const out = await request(p.base).post('/control/logout').set('Cookie', cookie).set('X-CamProxy-UI', '1');
    expect(out.status).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await request(p.base).get('/control/status').set('Cookie', 'camproxy_session=v1.9999999999999.00')).status).toBe(401);
  });

  it('needs X-CamProxy-UI for writes with the session cookie', async () => {
    const cookie = await login();
    const no = await request(p.base).put('/control/config').set('Cookie', cookie).send({ sse: { pingS: 14 } });
    expect(no.status).toBe(403);
    expect(no.body).toEqual({ error: 'csrf' });
    expect((await request(p.base).put('/control/config').set('Cookie', cookie).set('X-CamProxy-UI', '1').send({ sse: { pingS: 14 } })).status).toBe(200);
  });
});

describe('control API: status, stats, config', () => {
  it('reports the camera, the intake, SSE and retention', async () => {
    const r = await request(p.base).get('/control/status').set(admin());
    expect(r.body.camera).toMatchObject({ online: expect.any(Boolean) });
    expect(r.body.intake).toMatchObject({ onvif: 'subscribed', source: 'onvif' });
    expect(r.body.sse).toEqual({ clients: 0 });
    expect(r.body.retention).toHaveProperty('lastRun');
    expect(r.body.version).toBeTruthy();
    // The camera's own web page: https://<host without port>/ unless set.
    expect(r.body.camera.webUiUrl).toBe('https://127.0.0.1/');
    expect(r.body.ftp).toEqual({ enabled: false, listening: false, port: 2121, tls: true, publicHost: null, passwordSet: false, lastUpload: null, lastClip: null, clips: 0, failures: 0 });
  });

  it('reports disk, events, the stream log and the storage budget', async () => {
    insertEvent(p.proxy.catalog, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: Date.now(), raw: null });
    const r = await request(p.base).get('/control/stats').set(admin());
    expect(r.body.disk.catalog.bytes).toBeGreaterThan(0);
    expect(r.body.disk.size).toBeGreaterThan(r.body.disk.free);
    expect(r.body.events.stored.person).toBeGreaterThanOrEqual(1);
    expect(r.body.stream.rows).toBeGreaterThanOrEqual(0);
    expect(r.body.storage.budget).toBe(Math.floor((r.body.disk.size * 85) / 100));
  });

  it('shows every setting with its value, source and restart flag, and never a secret', async () => {
    const r = await request(p.base).get('/control/config').set(admin());
    expect(r.body['camera.host']).toEqual({ value: sim.camera.host, source: 'file', restart: true, pending: false });
    expect(r.body['retention.stillsDays']).toEqual({ value: 7, source: 'default', restart: false, pending: false });
    const text = JSON.stringify(r.body);
    for (const s of [CLIENT_TOKEN, ADMIN_TOKEN, sim.password]) expect(text).not.toContain(s);
  });

  it('applies a live setting at once, and marks a restart setting as pending', async () => {
    const live = await request(p.base).put('/control/config').set(admin()).send({ sse: { maxClients: 7 } });
    expect(live.body['sse.maxClients']).toMatchObject({ value: 7, source: 'override', pending: false });
    const r = await request(p.base).put('/control/config').set(admin()).send({ camera: { statusPollS: 6 } });
    expect(r.body['camera.statusPollS']).toMatchObject({ value: 5, source: 'override', restart: true, pending: true, next: 6 });
  });

  it('refuses a bad setting with its name, and writes nothing', async () => {
    const before = readFileSync(join(p.dir, 'data', 'overrides.json'), 'utf8');
    const r = await request(p.base).put('/control/config').set(admin()).send({ sse: { pingS: 0 } });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'invalid', detail: expect.stringMatching(/^sse\.pingS: /) });
    expect(readFileSync(join(p.dir, 'data', 'overrides.json'), 'utf8')).toBe(before);
  });

  it('removes an override, back to the file or default value', async () => {
    await request(p.base).put('/control/config').set(admin()).send({ retention: { eventsDays: 3 } });
    const r = await request(p.base).delete('/control/config/retention.eventsDays').set(admin());
    expect(r.body['retention.eventsDays']).toMatchObject({ value: 30, source: 'default' });
    expect((await request(p.base).delete('/control/config/nope.x').set(admin())).status).toBe(400);
  });
});

describe('control API: actions and log', () => {
  it('re-subscribes ONVIF on request', async () => {
    const before = p.proxy.intake.state().resubscribes;
    expect((await request(p.base).post('/control/actions/onvif-resubscribe').set(admin())).status).toBe(202);
    await until(() => p.proxy.intake.state().resubscribes > before && p.proxy.intake.state().onvif === 'subscribed');
  });

  it('tests the camera now', async () => {
    const r = await request(p.base).post('/control/actions/camera-test').set(admin());
    expect(r.status, JSON.stringify({ body: r.body, headers: r.headers })).toBe(200);
    expect(r.body).toMatchObject({ online: true, model: 'RLC-1224A' });
  });

  it('runs retention, or previews it with dryRun', async () => {
    insertEvent(p.proxy.catalog, { cam: 'cam1', source: 'onvif', kind: 'pet', start_ts: 1000, raw: null });
    const dry = await request(p.base).post('/control/actions/retention-run').set(admin()).send({ dryRun: true });
    expect(dry.body).toMatchObject({ dryRun: true, deleted: { events: 1 } });
    const real = await request(p.base).post('/control/actions/retention-run').set(admin()).send({});
    expect(real.body).toMatchObject({ dryRun: false, deleted: { events: 1 } });
    const again = await request(p.base).post('/control/actions/retention-run').set(admin()).send({});
    expect(again.body.deleted.events).toBe(0);
  });

  it('restart applies the pending settings', async () => {
    await request(p.base).put('/control/config').set(admin()).send({ camera: { statusPollS: 8 } });
    expect((await request(p.base).post('/control/actions/restart').set(admin())).status).toBe(202);
    await until(async () => (await request(p.base).get('/control/config').set(admin())).body['camera.statusPollS'].value === 8);
    await until(() => p.proxy.intake.state().onvif === 'subscribed');
  });

  // Review: settings read once at process start stay pending after the
  // in-process restart, so the UI keeps saying a new process is needed.
  it('keeps process-start settings pending after the in-process restart', async () => {
    await request(p.base).put('/control/config').set(admin()).send({ server: { trustProxy: 2 } });
    expect((await request(p.base).post('/control/actions/restart').set(admin())).status).toBe(202);
    await until(() => p.proxy.intake.state().onvif === 'subscribed');
    await p.proxy.restart();
    const r = await request(p.base).get('/control/config').set(admin());
    expect(r.body['server.trustProxy']).toMatchObject({ pending: true, next: 2 });
    await request(p.base).delete('/control/config/server.trustProxy').set(admin());
  });

  it('answers 404 for an unknown action', async () => {
    expect((await request(p.base).post('/control/actions/nope').set(admin())).status).toBe(404);
  });

  it('keeps recent log lines, with no token or password in them', async () => {
    await request(p.base).get('/api/cameras').set(auth('wrong-'.padEnd(40, 'z')));
    const r = await request(p.base).get('/control/log?limit=100').set(admin());
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBeGreaterThan(0);
    const text = JSON.stringify(r.body);
    for (const s of [CLIENT_TOKEN, ADMIN_TOKEN, sim.password]) expect(text).not.toContain(s);
  });
});

describe('metrics', () => {
  it('serves Prometheus text without auth, with the phase 1 series and no event content', async () => {
    const r = await request(p.base).get('/metrics');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/plain/);
    for (const name of ['camproxy_disk_bytes{kind="catalog"}', 'camproxy_disk_free_bytes', 'camproxy_disk_size_bytes', 'camproxy_events_stored', 'camproxy_onvif_subscribed', 'camproxy_onvif_resubscribes_total', 'camproxy_camera_up', 'camproxy_sse_clients', 'camproxy_stream_log_rows', 'camproxy_retention_deleted_total', 'camproxy_build_info']) {
      expect(r.text).toContain(name);
    }
    expect(r.text).not.toContain(CLIENT_TOKEN);
  });
});
