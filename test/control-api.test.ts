import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
    expect(r.body.ftp).toEqual({ enabled: false, listening: false, port: 2121, tls: true, publicHost: null, passwordSet: false, lastUpload: null, lastClip: null, clips: 0, failures: 0, camera: null, stalled: null });
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
    expect(r.body['camera.host']).toEqual({ value: sim.camera.host, source: 'file', restart: true, pending: false, type: 'string' });
    expect(r.body['retention.stillsDays']).toEqual({ value: 7, source: 'default', restart: false, pending: false, type: 'integer' });
    // The type, so the Settings page can save a number for an optional setting with no value yet (#85).
    expect(r.body['camera.poeSwitch.port']).toEqual({ source: 'default', restart: false, pending: false, type: 'integer' });
    expect(r.body['stills.enabled']).toMatchObject({ type: 'boolean' });
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

// Klaus 2026-10-05: Reset says what it goes back to; one request resets all.
describe('control API: back to the defaults', () => {
  it('an override says what Reset goes back to: the file value, else the default', async () => {
    const r = await request(p.base).put('/control/config').set(admin()).send({ retention: { auditDays: 30 }, camera: { statusPollS: 8 } });
    try {
      expect(r.body['retention.auditDays']).toMatchObject({ value: 30, source: 'override', resetTo: { value: 90, source: 'default' } });
      expect(r.body['camera.statusPollS']).toMatchObject({ source: 'override', resetTo: { value: 5, source: 'file' } });
      expect(r.body['retention.stillsDays']).not.toHaveProperty('resetTo');
    } finally {
      for (const k of ['retention.auditDays', 'camera.statusPollS']) await request(p.base).delete(`/control/config/${k}`).set(admin());
    }
  });

  // Klaus 2026-10-05: no override that only repeats the default; Reset says
  // what an unset state means.
  it('PUT of a whole group stores only what differs, and Reset to none / not set says what that means', async () => {
    const r = await request(p.base).put('/control/config').set(admin()).send({ camera: { poeSwitch: { model: 'sscpoe-web', host: '192.0.2.98', port: 8, ports: 8, offSeconds: 10 } } });
    try {
      expect(r.status).toBe(200);
      expect(r.body['camera.poeSwitch.ports']).toMatchObject({ value: 8, source: 'default' });
      expect(r.body['camera.poeSwitch.offSeconds']).toMatchObject({ value: 10, source: 'default' });
      expect(r.body['camera.poeSwitch.model']).toMatchObject({ source: 'override', resetTo: { value: 'none', source: 'default', means: 'no PoE switch: power-cycle off' } });
      expect(r.body['camera.poeSwitch.host']).toMatchObject({ source: 'override', resetTo: { source: 'default', means: 'PoE switch control off: no switch address' } });
      expect(JSON.parse(readFileSync(join(p.dir, 'data', 'overrides.json'), 'utf8')).camera.poeSwitch).toEqual({ model: 'sscpoe-web', host: '192.0.2.98', port: 8 });
      // Saving the default over an override removes it.
      const back = await request(p.base).put('/control/config').set(admin()).send({ camera: { poeSwitch: { model: 'none' } } });
      expect(back.body['camera.poeSwitch.model']).toMatchObject({ value: 'none', source: 'default' });
    } finally {
      for (const k of ['model', 'host', 'port']) await request(p.base).delete(`/control/config/camera.poeSwitch.${k}`).set(admin());
    }
  });

  it('DELETE /control/config removes every override in one write and one config-change record', async () => {
    await request(p.base).put('/control/config').set(admin()).send({ retention: { auditDays: 30, eventsDays: 4 }, sse: { pingS: 11 } });
    const n = p.proxy.audit.list({ actions: ['config-change'], limit: 500 }).records.length;
    const r = await request(p.base).delete('/control/config').set(admin());
    expect(r.status).toBe(200);
    expect(Object.values(r.body as Record<string, { source: string }>).filter((s) => s.source === 'override')).toEqual([]);
    expect(r.body['retention.auditDays']).toMatchObject({ value: 90, source: 'default' });
    expect(r.body['sse.pingS']).toMatchObject({ value: 15, source: 'default' });
    expect(JSON.parse(readFileSync(join(p.dir, 'data', 'overrides.json'), 'utf8'))).toEqual({});
    const records = p.proxy.audit.list({ actions: ['config-change'], limit: 500 }).records;
    expect(records.length).toBe(n + 1);
    expect(records[0]).toMatchObject({ message: expect.stringMatching(/^Settings reset to defaults: /), cam_proxy: { reset: 'all' } });
    const keys = (records[0].cam_proxy as { changes: { key: string }[] }).changes.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['retention.auditDays', 'retention.eventsDays', 'sse.pingS'])); // and earlier tests' overrides
    // Nothing to reset: no record.
    expect((await request(p.base).delete('/control/config').set(admin())).status).toBe(200);
    expect(p.proxy.audit.list({ actions: ['config-change'], limit: 500 }).records.length).toBe(n + 1);
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

  // #78: usage() scans the data folders; one scrape measures once, not once per gauge.
  it('measures storage once per scrape', async () => {
    const spy = vi.spyOn(p.proxy.storage, 'usage');
    try {
      expect((await request(p.base).get('/metrics')).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('token in the URL', () => {
  it('is refused on the control and audit routes too, before the access check', async () => {
    for (const path of ['/control/status?token=x', '/control/audit?access_token=x', '/control/actions/restart?token=x']) {
      const r = await (path.includes('restart') ? request(p.base).post(path) : request(p.base).get(path)).set(auth(ADMIN_TOKEN));
      expect([r.status, r.body], path).toEqual([400, { error: 'token_in_url' }]);
    }
    expect((await request(p.base).get('/control/status?token=x')).status).toBe(400); // no credential at all
  });

  it('is refused on the session routes too (#78); the login link uses ?code=', async () => {
    for (const [method, path] of [['get', '/control/session?token=x'], ['get', '/control/login-link?code=c&token=x'], ['post', '/control/login?token=x'], ['post', '/control/logout?access_token=x']] as const) {
      const r = await request(p.base)[method](path).send({ token: ADMIN_TOKEN });
      expect([r.status, r.body], path).toEqual([400, { error: 'token_in_url' }]);
    }
    expect((await request(p.base).get('/control/session')).status).toBe(200);
  });
});
