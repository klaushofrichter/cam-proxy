import { createHash, randomBytes } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readEnvLayer } from '../src/config/env';
import { ALLOW_ENTRIES, CommandPolicy, ENTRY_TEXT, IMPLEMENTED, UI_ENTRIES, uiUnlocked } from '../src/fleet/policy';
import { writePrivateJson } from '../src/fleet/private-file';
import { UI_CONFIG_LOCAL } from '../src/api/auth';
import { narrowRules } from '../src/fleet/remote-settable';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// Issue #227 (Klaus, 2026-10-21): an admin UI session from a cams-admin
// sign-in link (managed-admin) may change settings or restart only when the
// proxy's own allow-list unlocks it (ui.config, ui.restart), off by default.
// Only the local admin widens that list; refusals stay auth-refused.
const tok = () => randomBytes(32).toString('base64url');
const hashOf = (t: string) => `sha256:${createHash('sha256').update(t).digest('hex')}`;
const MANAGED_ADMIN = tok();
const TOKEN_ID = `tok_${'2'.repeat(20)}`;

describe('the ui.* allow entries', () => {
  const quiet = { info() {}, warn() {}, debug() {} };
  const make = (env: NodeJS.ProcessEnv = {}) => new CommandPolicy({ base: () => ({ allow: [], paused: false }), file: join(mkdtempSync(join(tmpdir(), 'uipolicy-')), 'admin', 'policy.json'), env: () => readEnvLayer(env), log: quiet });
  it('are allow entries with a sentence, but no command: cams-admin never runs or sees them', () => {
    expect([...UI_ENTRIES]).toEqual(['ui.config', 'ui.restart']);
    for (const e of UI_ENTRIES) {
      expect(ALLOW_ENTRIES).toContain(e);
      expect(IMPLEMENTED.has(e), e).toBe(false);
      expect(ENTRY_TEXT[e], e).toMatch(/cams-admin sign-in/);
    }
    expect(ENTRY_TEXT['ui.restart']).toMatch(/^DISRUPTIVE/);
  });
  it('off by default; the local admin allows them; managed rights only take them away', () => {
    const p = make();
    expect(uiUnlocked(p.effective())).toEqual([]);
    expect(() => p.setAllow(['ui.config'], 'managed')).toThrow(/local admin token/);
    p.setAllow(['ui.config', 'ui.restart', 'tokens.apply'], 'local');
    expect(uiUnlocked(p.effective())).toEqual(['ui.config', 'ui.restart']);
    p.setAllow(['ui.restart'], 'managed');
    expect(uiUnlocked(p.effective())).toEqual(['ui.restart']);
  });
  it('a pause or the environment switch (CAMPROXY_ADMIN_COMMANDS) locks them again', () => {
    const p = make();
    p.setAllow(['ui.config'], 'local');
    p.pause('incident', 'managed');
    expect(uiUnlocked(p.effective())).toEqual([]);
    const off = make({ CAMPROXY_ADMIN_COMMANDS: 'off' });
    off.setAllow(['ui.config'], 'local');
    expect(uiUnlocked(off.effective())).toEqual([]);
  });
});

describe('a managed-admin UI session and the ui.* entries', () => {
  let sim: Awaited<ReturnType<typeof startSim>>;
  let p: Awaited<ReturnType<typeof startProxy>>;
  const exit = vi.fn();
  beforeAll(async () => {
    sim = await startSim();
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-uiunlock-'));
    writePrivateJson(join(dir, 'data', 'admin', 'tokens.json'), { v: 1, revision: 1, blocked: [], tokens: [{ id: TOKEN_ID, kind: 'admin', hash: hashOf(MANAGED_ADMIN), label: 'cams cluster', retireAt: null }] });
    p = await startProxy(sim, { dir, proxy: { exit } });
  });
  afterAll(async () => {
    await p?.proxy.stop();
    await sim?.close();
  });

  const session = async (t: string) => {
    const code = (await request(p.base).post('/control/login-links').set(auth(t)).expect(201)).body.code;
    return String((await request(p.base).get(`/control/login-link?code=${code}`).expect(302)).headers['set-cookie']).split(';')[0];
  };
  const ui = (cookie: string) => ({ Cookie: cookie, 'x-camproxy-ui': '1' });
  const allow = (list: string[], h: Record<string, string> = auth(ADMIN_TOKEN)) => request(p.base).put('/control/admin/commands').set(h).send({ allow: list });
  const refusals = (path: string) => p.proxy.audit.list({ actions: ['auth-refused'] }).records.filter((r) => String(r.message).includes(path));

  it('GET /control/session tells the page its rights: everything for the local admin, nothing extra for a cams-admin sign-in', async () => {
    const local = await session(ADMIN_TOKEN);
    expect((await request(p.base).get('/control/session').set('Cookie', local)).body).toEqual({ loggedIn: true, origin: 'local', rights: { localAdmin: true, config: true, restart: true } });
    const m = await session(MANAGED_ADMIN);
    expect((await request(p.base).get('/control/session').set('Cookie', m)).body).toEqual({ loggedIn: true, origin: 'managed', rights: { localAdmin: false, config: false, restart: false } });
    expect((await request(p.base).get('/control/session')).body).toEqual({ loggedIn: false });
  });

  it('GET /control/session names the move right only with the move.send entry', async () => {
    const m = await session(MANAGED_ADMIN);
    expect((await allow(['move.send'])).status).toBe(200);
    expect((await request(p.base).get('/control/session').set('Cookie', m)).body.rights.move).toBe(true);
    expect((await allow([])).status).toBe(200);
    expect((await request(p.base).get('/control/session').set('Cookie', m)).body.rights.move).toBeUndefined();
  });

  it('off by default: settings and restarts answer 403 local_admin_only, recorded as auth-refused', async () => {
    const m = await session(MANAGED_ADMIN);
    for (const [method, path, body] of [['put', '/control/config', { sse: { pingS: 9 } }], ['delete', '/control/config/sse.pingS', {}], ['delete', '/control/config', {}], ['post', '/control/actions/restart-proxy', {}], ['post', '/control/actions/restart', {}], ['post', '/control/cameras/cam1/actions/restart', {}]] as const) {
      const r = await request(p.base)[method](path).set(ui(m)).send(body);
      expect([r.status, r.body.error], `${method} ${path}`).toEqual([403, 'local_admin_only']);
    }
    // The refusal names who: the managed token's label, never a token.
    expect(refusals('PUT /control/config')[0]).toMatchObject({ user: { name: 'token:cams cluster' }, cam_proxy: { auth: { reason: 'local-admin-only', tokenKind: 'session' } } });
    expect(exit).not.toHaveBeenCalled();
  });

  it('cams-admin cannot grant itself an entry: neither its token nor its sign-in widens the list', async () => {
    const m = await session(MANAGED_ADMIN);
    expect((await allow(['ui.config'], auth(MANAGED_ADMIN))).body.error).toBe('local_admin_only');
    expect((await allow(['ui.config', 'ui.restart'], ui(m))).body.error).toBe('local_admin_only');
    expect((await request(p.base).get('/control/admin/commands').set(auth(ADMIN_TOKEN))).body.allow).toEqual([]);
  });

  it('ui.config unlocks the Settings writes for a cams-admin sign-in; the audit names who and why', async () => {
    await allow(['ui.config']).expect(200);
    const m = await session(MANAGED_ADMIN);
    expect((await request(p.base).get('/control/session').set('Cookie', m)).body.rights).toEqual({ localAdmin: false, config: true, restart: false, localSettings: [...UI_CONFIG_LOCAL], narrowSettings: narrowRules() });
    const r = await request(p.base).put('/control/config').set(ui(m)).send({ sse: { pingS: 11 } });
    expect(r.status).toBe(200);
    expect(p.proxy.audit.list({ actions: ['config-change'] }).records[0]).toMatchObject({ user: { name: 'token:cams cluster' }, cam_proxy: { allowedBy: 'ui.config' } });
    expect((await request(p.base).delete('/control/config/sse.pingS').set(ui(m))).status).toBe(200);
    // Still local only: the restarts, and every other local-admin write.
    expect((await request(p.base).post('/control/actions/restart-proxy').set(ui(m))).status).toBe(403);
    expect((await request(p.base).post('/control/actions/archive-clear').set(ui(m)).send({ count: 0 })).status).toBe(403);
    expect((await request(p.base).put('/control/secrets/google-vision-key').set(ui(m)).send({ key: 'x' })).status).toBe(403);
    // A managed admin token (no UI session) is not unlocked: ui.* is for the sign-in.
    expect((await request(p.base).put('/control/config').set(auth(MANAGED_ADMIN)).send({ sse: { pingS: 12 } })).body.error).toBe('local_admin_only');
  });

  it('ui.config never sets addresses, ports, files, trust, users or the cams-admin connection', async () => {
    const m = await session(MANAGED_ADMIN);
    const local: object[] = [
      { camsAdmin: { url: 'https://evil.example' } }, { camsAdmin: { enabled: false } }, { 'camsAdmin.enabled': false }, { camsAdmin: {} },
      { go2rtc: { binary: '/bin/sh' } }, { tls: { site: 'x' } }, { composition: { font: '/etc/passwd' } }, { ftp: { certFile: '/tmp/c.pem' } }, { server: { trustProxy: 1 } },
      // An address would send the camera's or the switch's password elsewhere; a new camera has one.
      { cameras: { cam1: { host: '203.0.113.9' } } }, { camera: { host: '203.0.113.9' } }, { ftp: { user: 'x' } }, { poeSwitch: { host: '203.0.113.9' } }, { camera: { poeSwitch: { host: '203.0.113.9' } } },
      { cameras: { cam6: { host: '203.0.113.9', protocol: 'http', user: 'proxy' } } }, { cameras: { cam6: {} } },
      { sse: { pingS: 13 }, camsAdmin: { enabled: false } },
    ];
    for (const body of local) {
      const r = await request(p.base).put('/control/config').set(ui(m)).send(body);
      expect([r.status, r.body.error], JSON.stringify(body)).toEqual([403, 'local_admin_only']);
    }
    expect(p.proxy.running.camsAdmin.url).toBeUndefined();
    expect(p.proxy.cameras.ids()).toEqual(['cam1']);
    // A camera's own non-address settings are fine.
    expect((await request(p.base).put('/control/config').set(ui(m)).send({ cameras: { cam1: { statusPollS: 6 } } })).status).toBe(200);
    expect(refusals('PUT /control/config')[0]).toMatchObject({ cam_proxy: { auth: { reason: 'local-admin-only' } } });
    // The local admin still can.
    expect((await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ go2rtc: { rtspPort: p.proxy.running.go2rtc.rtspPort } })).status).toBe(200);
  });

  it('ui.config resets never reach those settings either: a single reset, a whole camera, Reset to defaults', async () => {
    const m = await session(MANAGED_ADMIN);
    // The local admin's own overrides on protected settings, and a camera it added.
    await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ ntp: { server: 'ntp.example' }, cameras: { cam6: { host: '127.0.0.1:1', protocol: 'http', user: 'proxy6' } } }).expect(200);
    for (const path of ['camsAdmin.url', 'cameras.cam1.host', 'cameras.cam1.user', 'ftp.publicHost', 'poeSwitch.host', 'tls.site', 'server.trustProxy', 'ntp.server', 'camsAdmin%2Eurl', 'cameras.cam6', 'cameras', '%E0%A4%A']) {
      const r = await request(p.base).delete(`/control/config/${path}`).set(ui(m));
      expect([r.status, r.body.error], path).toEqual([403, 'local_admin_only']);
    }
    // A protected setting refused under ui.config: its own reason, and who.
    expect(refusals('DELETE /control/config/camsAdmin.url')[0]).toMatchObject({ user: { name: 'token:cams cluster' }, cam_proxy: { auth: { reason: 'local-setting', tokenKind: 'session' } } });
    // Reset to defaults keeps the protected overrides (and the added camera); the rest goes.
    await request(p.base).put('/control/config').set(ui(m)).send({ sse: { pingS: 13 } }).expect(200);
    const view = (await request(p.base).delete('/control/config').set(ui(m)).expect(200)).body;
    expect(view['ntp.server']).toMatchObject({ value: 'ntp.example', source: 'override' });
    expect(view['sse.pingS'].source).not.toBe('override');
    expect(p.proxy.cameras.ids()).toContain('cam6');
    // The local admin's Reset to defaults still takes everything (cameras added here stay).
    await request(p.base).delete('/control/config/cameras.cam6').set(auth(ADMIN_TOKEN)).expect(200);
    expect((await request(p.base).delete('/control/config').set(auth(ADMIN_TOKEN)).expect(200)).body['ntp.server'].source).not.toBe('override');
  });

  it('a pause locks ui.config again at once', async () => {
    const m = await session(MANAGED_ADMIN);
    await request(p.base).post('/control/admin/commands/pause').set(auth(ADMIN_TOKEN)).send({}).expect(200);
    expect((await request(p.base).put('/control/config').set(ui(m)).send({ sse: { pingS: 14 } })).status).toBe(403);
    expect((await request(p.base).get('/control/session').set('Cookie', m)).body.rights.config).toBe(false);
    await request(p.base).post('/control/admin/commands/resume').set(auth(ADMIN_TOKEN)).expect(200);
  });

  it('ui.restart unlocks the camera-side restart and the proxy restart; the record says the cams-admin sign-in did it (last: it stops the proxy)', async () => {
    await allow(['ui.restart']).expect(200);
    const m = await session(MANAGED_ADMIN);
    expect((await request(p.base).put('/control/config').set(ui(m)).send({ sse: { pingS: 15 } })).status).toBe(403);
    // A pause locks ui.restart too.
    await request(p.base).post('/control/admin/commands/pause').set(auth(ADMIN_TOKEN)).send({}).expect(200);
    expect((await request(p.base).post('/control/actions/restart').set(ui(m))).status).toBe(403);
    expect((await request(p.base).get('/control/session').set('Cookie', m)).body.rights.restart).toBe(false);
    await request(p.base).post('/control/admin/commands/resume').set(auth(ADMIN_TOKEN)).expect(200);
    expect((await request(p.base).post('/control/actions/restart').set(ui(m))).status).toBe(202);
    expect((await request(p.base).post('/control/actions/restart-proxy').set(ui(m))).status).toBe(202);
    expect(p.proxy.audit.list({ actions: ['proxy-restart'] }).records[0]).toMatchObject({ user: { name: 'token:cams cluster' }, cam_proxy: { requestedBy: 'session', allowedBy: 'ui.restart' } });
    await until(() => exit.mock.calls.length > 0);
  });
});

describe('CAMPROXY_ADMIN_COMMANDS=off over HTTP', () => {
  it('locks ui.config although the local admin allowed it', async () => {
    const sim = await startSim();
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-uioff-'));
    writePrivateJson(join(dir, 'data', 'admin', 'tokens.json'), { v: 1, revision: 1, blocked: [], tokens: [{ id: TOKEN_ID, kind: 'admin', hash: hashOf(MANAGED_ADMIN), label: 'cams cluster', retireAt: null }] });
    const p = await startProxy(sim, { dir, env: { CAMPROXY_ADMIN_COMMANDS: 'off' } });
    try {
      await request(p.base).put('/control/admin/commands').set(auth(ADMIN_TOKEN)).send({ allow: ['ui.config'] }).expect(200);
      const code = (await request(p.base).post('/control/login-links').set(auth(MANAGED_ADMIN)).expect(201)).body.code;
      const m = String((await request(p.base).get(`/control/login-link?code=${code}`).expect(302)).headers['set-cookie']).split(';')[0];
      expect((await request(p.base).get('/control/session').set('Cookie', m)).body.rights.config).toBe(false);
      const r = await request(p.base).put('/control/config').set({ Cookie: m, 'x-camproxy-ui': '1' }).send({ sse: { pingS: 9 } });
      expect([r.status, r.body.error]).toEqual([403, 'local_admin_only']);
    } finally {
      await p.proxy.stop();
      await sim.close();
    }
  });
});

// Klaus (2026-10-21, #227 follow-up): ui.config gets narrower. Storage
// limits, Google Vision on/off and every change against NARROW's direction
// (shorter retention, lower size caps, higher spending caps) stay the local
// admin's, for a set, a single reset and Reset to defaults alike.
describe('ui.config: storage, Google Vision and the direction rules', () => {
  let sim: Awaited<ReturnType<typeof startSim>>;
  let p: Awaited<ReturnType<typeof startProxy>>;
  beforeAll(async () => {
    sim = await startSim();
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-uinarrow-'));
    writePrivateJson(join(dir, 'data', 'admin', 'tokens.json'), { v: 1, revision: 1, blocked: [], tokens: [{ id: TOKEN_ID, kind: 'admin', hash: hashOf(MANAGED_ADMIN), label: 'cams cluster', retireAt: null }] });
    // ftp.maxGB from config.json: a reset of its override goes back to 10 GB, not to no cap.
    p = await startProxy(sim, { dir, settings: { ftp: { maxGB: 10 } } });
    await request(p.base).put('/control/admin/commands').set(auth(ADMIN_TOKEN)).send({ allow: ['ui.config'] }).expect(200);
  });
  afterAll(async () => {
    await p?.proxy.stop();
    await sim?.close();
  });
  const session = async () => {
    const code = (await request(p.base).post('/control/login-links').set(auth(MANAGED_ADMIN)).expect(201)).body.code;
    return String((await request(p.base).get(`/control/login-link?code=${code}`).expect(302)).headers['set-cookie']).split(';')[0];
  };
  const ui = (cookie: string) => ({ Cookie: cookie, 'x-camproxy-ui': '1' });
  const local = (body: object) => request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send(body).expect(200);
  const refusals = (path: string) => p.proxy.audit.list({ actions: ['auth-refused'] }).records.filter((r) => String(r.message).includes(path));

  it('the session names them: storage and Google Vision on/off as local settings, the direction rules as narrowSettings', async () => {
    const m = await session();
    const r = (await request(p.base).get('/control/session').set('Cookie', m)).body.rights;
    expect(r.localSettings).toEqual(expect.arrayContaining(['storage', 'cameras.*.storage', 'analytics.googleVision.enabled']));
    expect(r.narrowSettings).toMatchObject({
      'retention.clipsDays': { dir: 'more' }, 'retention.auditDays': { dir: 'more' },
      'stills.maxGB': { dir: 'more', unlimited: 'unset' },
      'analytics.googleVision.monthlyLimit': { dir: 'less' }, 'analytics.googleVision.dailyCap': { dir: 'less', unlimited: 0 },
    });
    expect(r.narrowSettings['retention.intervalMin']).toBeUndefined();
    // The local admin's session has none of it.
    expect((await request(p.base).get('/control/session').set('Cookie', m)).body.rights.localAdmin).toBe(false);
  });

  it('a PUT never touches storage limits or switches Google Vision, either way', async () => {
    const m = await session();
    for (const body of [{ storage: { maxPercent: 50 } }, { storage: { keepHours: { clips: 1 } } }, { 'storage.minFreeBytes': 1 }, { cameras: { cam1: { storage: { sharePercent: 10 } } } }, { camera: { storage: { sharePercent: 10 } } }, { analytics: { googleVision: { enabled: true } } }, { analytics: { googleVision: { enabled: false } } }]) {
      const r = await request(p.base).put('/control/config').set(ui(m)).send(body);
      expect([r.status, r.body.error], JSON.stringify(body)).toEqual([403, 'local_admin_only']);
    }
    expect(refusals('PUT /control/config')[0]).toMatchObject({ user: { name: 'token:cams cluster' }, cam_proxy: { auth: { reason: 'local-setting' } } });
    expect(p.proxy.running.storage.maxPercent).toBe(85);
    // Switches and thresholds stay open to it.
    expect((await request(p.base).put('/control/config').set(ui(m)).send({ health: { diskPercent: 80 }, analytics: { kinds: { pet: true } } })).status).toBe(200);
  });

  it('a PUT may keep data longer and spend less, never the other way', async () => {
    await local({ retention: { clipsDays: 30 }, analytics: { googleVision: { monthlyLimit: 100, dailyCap: 10 } }, stills: { maxGB: 20 } });
    const m = await session();
    for (const body of [{ retention: { clipsDays: 20 } }, { retention: { auditDays: 1 } }, { stills: { maxGB: 10 } }, { analytics: { googleVision: { monthlyLimit: 200 } } }, { analytics: { googleVision: { dailyCap: 0 } } }, { retention: { clipsDays: 40, eventsDays: 1 } }]) {
      const r = await request(p.base).put('/control/config').set(ui(m)).send(body);
      expect([r.status, r.body.error], JSON.stringify(body)).toEqual([403, 'local_admin_only']);
      expect(r.body.detail, JSON.stringify(body)).toMatch(/cams-admin sign-in/);
    }
    expect(p.proxy.running.retention.clipsDays).toBe(30);
    for (const body of [{ retention: { clipsDays: 40 } }, { stills: { maxGB: 30 } }, { analytics: { googleVision: { monthlyLimit: 50, dailyCap: 5 } } }]) {
      expect((await request(p.base).put('/control/config').set(ui(m)).send(body)).status, JSON.stringify(body)).toBe(200);
    }
    expect(p.proxy.running.retention.clipsDays).toBe(40);
    // An invalid value is still the route's 400, not a refusal.
    expect((await request(p.base).put('/control/config').set(ui(m)).send({ retention: { clipsDays: 'x' } })).status).toBe(400);
  });

  it('a single reset that would shorten retention, raise a cap or touch storage is refused; one the other way is fine', async () => {
    await local({ retention: { clipsDays: 60, eventsDays: 5 }, analytics: { googleVision: { monthlyLimit: 100 } }, storage: { keepHours: { clips: 48 } } });
    const m = await session();
    for (const path of ['retention.clipsDays', 'storage.keepHours.clips', 'analytics.googleVision.enabled']) {
      const r = await request(p.base).delete(`/control/config/${path}`).set(ui(m));
      expect([r.status, r.body.error], path).toEqual([403, 'local_admin_only']);
    }
    expect(refusals('DELETE /control/config/retention.clipsDays')[0]).toMatchObject({ user: { name: 'token:cams cluster' }, cam_proxy: { auth: { reason: 'local-setting' } } });
    expect(p.proxy.running.retention.clipsDays).toBe(60);
    // Back to 30 days of events (longer) and no Google Vision calls (less spending).
    expect((await request(p.base).delete('/control/config/retention.eventsDays').set(ui(m))).status).toBe(200);
    expect((await request(p.base).delete('/control/config/analytics.googleVision.monthlyLimit').set(ui(m))).status).toBe(200);
    expect(p.proxy.running.retention.eventsDays).toBe(30);
  });

  it('Reset to defaults keeps the overrides whose reset would shorten retention or raise spending, and storage', async () => {
    await local({ retention: { clipsDays: 60, eventsDays: 5 }, analytics: { googleVision: { monthlyLimit: 100, enabled: true } }, storage: { keepHours: { clips: 48 } }, sse: { pingS: 13 } });
    const m = await session();
    const view = (await request(p.base).delete('/control/config').set(ui(m)).expect(200)).body;
    expect(view['retention.clipsDays']).toMatchObject({ value: 60, source: 'override' });
    expect(view['storage.keepHours.clips']).toMatchObject({ value: 48, source: 'override' });
    expect(view['analytics.googleVision.enabled']).toMatchObject({ value: true, source: 'override' });
    for (const k of ['retention.eventsDays', 'analytics.googleVision.monthlyLimit', 'sse.pingS']) expect(view[k].source, k).not.toBe('override');
    // The local admin's reset still takes everything.
    const all = (await request(p.base).delete('/control/config').set(auth(ADMIN_TOKEN)).expect(200)).body;
    expect(all['retention.clipsDays'].source).not.toBe('override');
  });

  // An unset size cap is no cap (UNSET_IS_UNLIMITED), 0 for the daily cap
  // is none (ZERO_IS_UNLIMITED): as for cams-admin's config.set.
  it('an unset stills.maxGB is no cap: setting one is lowering it; resetting one is raising it', async () => {
    expect(p.proxy.running.stills.maxGB).toBeUndefined();
    const m = await session();
    const r = await request(p.base).put('/control/config').set(ui(m)).send({ stills: { maxGB: 10 } });
    expect([r.status, r.body.error]).toEqual([403, 'local_admin_only']);
    expect(r.body.detail).toMatch(/^stills\.maxGB: a cams-admin sign-in may only keep data longer$/);
    expect(refusals('PUT /control/config')[0]).toMatchObject({ cam_proxy: { auth: { reason: 'local-setting' } } });
    expect(p.proxy.running.stills.maxGB).toBeUndefined();
    await local({ stills: { maxGB: 20 } });
    expect((await request(p.base).delete('/control/config/stills.maxGB').set(ui(m))).status).toBe(200);
    expect(p.proxy.running.stills.maxGB).toBeUndefined();
  });

  it('dailyCap 0 is no cap: 0 to 5 lowers spending', async () => {
    expect(p.proxy.running.analytics.googleVision.dailyCap).toBe(0);
    const m = await session();
    expect((await request(p.base).put('/control/config').set(ui(m)).send({ analytics: { googleVision: { dailyCap: 5 } } })).status).toBe(200);
    expect(p.proxy.running.analytics.googleVision.dailyCap).toBe(5);
  });

  it('Reset to defaults keeps a size cap whose reset would lower it, and resets one whose reset means no cap', async () => {
    // ftp.maxGB 20 over config.json's 10: its reset lowers the cap. stills.maxGB 5: its reset is no cap.
    await local({ ftp: { maxGB: 20 }, stills: { maxGB: 5 } });
    const m = await session();
    const view = (await request(p.base).delete('/control/config').set(ui(m)).expect(200)).body;
    expect(view['ftp.maxGB']).toMatchObject({ value: 20, source: 'override' });
    expect(view['stills.maxGB'].source).not.toBe('override');
    expect(p.proxy.running.ftp.maxGB).toBe(20);
    await request(p.base).delete('/control/config').set(auth(ADMIN_TOKEN)).expect(200);
    expect(p.proxy.running.ftp.maxGB).toBe(10);
  });
});
