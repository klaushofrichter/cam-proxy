import { spawn } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readEnvValue } from '../src/config/env-file';
import { loadConfig } from '../src/config/load';
import { createProxy } from '../src/proxy';
import { servedCertificate } from '../src/tls/served';
import { startMultiProxy } from './helpers/multi';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, freePort, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// scripts/onboard-camera.sh and offboard-camera.sh (spec
// 2026-10-30-camera-onboarding-design §7) against a cam-proxy over cam-sims,
// and a stand-in for cams-admin's diag, adopt and delete routes.
const ONBOARD = join(__dirname, '..', 'scripts', 'onboard-camera.sh');
const OFFBOARD = join(__dirname, '..', 'scripts', 'offboard-camera.sh');
const stops: (() => Promise<unknown>)[] = [];
afterAll(async () => void (await Promise.all(stops.map((f) => f()))), 60_000);

const dir = mkdtempSync(join(tmpdir(), 'onboard-scripts-'));
const tokenFile = (name: string, value: string) => {
  const f = join(dir, name);
  writeFileSync(f, `${value}\n`, { mode: 0o600 });
  return f;
};
const ADMIN_FILE = tokenFile('admin', ADMIN_TOKEN);
const DIAG = 'diag-token-'.padEnd(40, 'd');
const OPS = 'ops-token-'.padEnd(40, 'o');
const PRX = 'prx_ABCDEFGHIJKLMNOPQRST';

function run(script: string, args: string[], env: Record<string, string>, stdin = ''): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn('bash', [script, ...args], { env: { PATH: process.env.PATH!, ...env } });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code: code ?? -1, out }));
    c.stdin.end(stdin);
  });
}

// cams-admin, as far as the scripts use it.
function fakeCamsAdmin() {
  const st = { reported: [] as string[], cameras: [] as { id: string; accountId: string; camsId: string; proxyId: string; proxyCameraId: string }[], adopts: 0, deletes: 0 };
  const app = express();
  app.use(express.json());
  const tok = (t: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => (req.get('authorization') === `Bearer ${t}` ? next() : void res.status(403).json({ error: 'scope' }));
  app.get('/api/v1/diag/cameras', tok(DIAG), (_req, res) => void res.json({ items: st.cameras }));
  app.get('/api/v1/diag/proxies/:p/unregistered', tok(DIAG), (req, res) =>
    void res.json({ proxyId: req.params.p, accountId: 'acc_1', reported: true, items: st.reported.filter((r) => !st.cameras.some((c) => c.proxyCameraId === r)).map((ref) => ({ ref, proposedCamsId: ref })) }));
  app.post('/api/v1/accounts/:a/proxies/:p/adopt', tok(OPS), (req, res) => {
    st.adopts++;
    const ref = req.body.proxyCameraId;
    if (!st.reported.includes(ref)) return void res.status(400).json({ error: 'not_reported' });
    const c = { id: `cam_${st.adopts}`, accountId: String(req.params.a), camsId: String(req.body.camsId ?? ref), proxyId: String(req.params.p), proxyCameraId: String(ref) };
    st.cameras.push(c);
    res.status(201).json(c);
  });
  app.get('/api/v1/diag/cameras/:cid/onboarding', tok(DIAG), (req, res) => {
    const c = st.cameras.find((x) => x.camsId === req.params.cid && x.accountId === req.query.accountId);
    res.status(c ? 200 : 404).json(c ? { ready: true, missing: [] } : { error: 'not_found' });
  });
  app.delete('/api/v1/accounts/:a/cameras/:c', tok(OPS), (req, res) => {
    st.deletes++;
    st.cameras = st.cameras.filter((x) => x.id !== req.params.c);
    res.status(204).end();
  });
  return { app, st };
}

describe('onboard-camera.sh and offboard-camera.sh on a several-camera proxy', () => {
  let base: string;
  let host: string;
  let ports: string[];
  let fingerprint: string;
  let password: string;
  const env = () => ({ CAMPROXY_URL: base, CAMPROXY_ADMIN_TOKEN_FILE: ADMIN_FILE });
  const onboarding = async (id: string) => request(base).get(`/control/cameras/${id}/onboarding`).set(auth(ADMIN_TOKEN));

  beforeAll(async () => {
    const first = await startSim();
    const s = await startSim({ model: 'E1-Outdoor-Pro' });
    password = s.password;
    const p = await startMultiProxy([first], { settings: { time: { zone: 'Europe/Berlin' } } });
    stops.push(async () => (await p.proxy.stop(), await first.close(), await s.close()));
    base = p.base;
    host = `127.0.0.1:${s.ports.https}`;
    ports = ['--port-https', String(s.ports.https), '--port-rtsp', String(s.ports.rtsp), '--port-onvif', String(s.ports.onvif), '--port-baichuan', String(s.ports.baichuan)];
    const probe = await request(base).post('/control/actions/camera-probe').set(auth(ADMIN_TOKEN)).send({ host, ports: { https: s.ports.https } });
    fingerprint = probe.body.certificate.fingerprint;
  }, 60_000);

  it('without --fingerprint and no terminal: names the served one and adds nothing', async () => {
    const r = await run(ONBOARD, ['--host', host, '--id', 'cam6', '--user', 'proxy', ...ports], env(), `${password}\n`);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAIL certificate: give --fingerprint ${fingerprint}`);
    expect((await onboarding('cam6')).status).toBe(404);
  }, 60_000);

  it('another fingerprint than the served one: FAIL, nothing added', async () => {
    const other = `SHA256:${'0'.repeat(64)}`;
    const r = await run(ONBOARD, ['--host', host, '--id', 'cam6', '--user', 'proxy', '--fingerprint', other, ...ports], env(), `${password}\n`);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAIL certificate: the camera serves ${fingerprint}, not the given ${other}`);
    expect((await onboarding('cam6')).status).toBe(404);
  }, 60_000);

  it('a wrong password: the add is refused, nothing added, the password never printed', async () => {
    const r = await run(ONBOARD, ['--host', host, '--id', 'cam6', '--user', 'proxy', '--fingerprint', fingerprint, ...ports], env(), 'not-the-password-123\n');
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL add cam6 (HTTP 422 camera_refused)');
    expect(r.out).not.toContain('not-the-password-123');
    expect((await onboarding('cam6')).status).toBe(404);
  }, 60_000);

  it('onboards in the proxy and cams-admin (adopted by the ops token), then offboards from both', async () => {
    const ca = fakeCamsAdmin();
    const srv: Server = ca.app.listen(0, '127.0.0.1');
    stops.push(() => new Promise((r) => srv.close(r)));
    await new Promise((r) => srv.once('listening', r));
    const caEnv = { CAMS_ADMIN_URL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, CAMS_ADMIN_DIAG_TOKEN_FILE: tokenFile('diag', DIAG), CAMS_ADMIN_OPS_TOKEN_FILE: tokenFile('ops', OPS) };
    ca.st.reported.push('cam6'); // the proxy's heartbeat, as far as the stand-in knows
    const r = await run(ONBOARD, ['--host', host, '--id', 'cam6', '--name', 'Back yard', '--user', 'proxy', '--fingerprint', fingerprint, '--time', '--cams-admin-proxy', PRX, '--cams-id', 'backyard', '--wait', '60', ...ports], { ...env(), ...caEnv }, `${password}\n`);
    expect(r.out.split('\n').filter((l) => l.startsWith('ok ') || l.startsWith('FAIL'))).toEqual([
      expect.stringMatching(/^ok probe 127\.0\.0\.1:\d+: ports .*https/),
      'ok certificate confirmed',
      'ok add cam6',
      'ok time: set Europe/Berlin',
      'ok cam6 ready on the proxy',
      'ok cams-admin: adopted as backyard',
      'ok cams-admin: registered as backyard',
      'ok cams-admin: backyard ready',
    ]);
    expect(r.code).toBe(0);
    for (const secret of [password, ADMIN_TOKEN, DIAG, OPS]) expect(r.out).not.toContain(secret);
    const o = (await onboarding('cam6')).body;
    expect([o.ready, o.trust.mode, o.trust.fingerprint]).toEqual([true, 'pinned', fingerprint]);
    expect(ca.st.adopts).toBe(1);

    // Offboard: without --yes and no terminal it stops at once.
    expect((await run(OFFBOARD, ['--id', 'cam6'], env())).code).toBe(2);
    const off = await run(OFFBOARD, ['--id', 'cam6', '--yes', '--cams-admin-proxy', PRX], { ...env(), ...caEnv });
    expect(off.out.split('\n').filter((l) => l.startsWith('ok ') || l.startsWith('FAIL'))).toEqual([
      'ok cams-admin: backyard removed from its account',
      expect.stringMatching(/^ok proxy: removed .*configuration.*stored password.*certificate pin/),
      'ok proxy: cam6 gone',
    ]);
    expect(off.code).toBe(0);
    expect(ca.st.cameras).toEqual([]);
    expect((await onboarding('cam6')).status).toBe(404);
    for (const secret of [ADMIN_TOKEN, DIAG, OPS]) expect(off.out).not.toContain(secret);
  }, 120_000);

  it('without an ops token and no auto-adopt: FAIL after --wait, saying why', async () => {
    const ca = fakeCamsAdmin();
    const srv: Server = ca.app.listen(0, '127.0.0.1');
    stops.push(() => new Promise((r) => srv.close(r)));
    await new Promise((r) => srv.once('listening', r));
    ca.st.reported.push('cam7');
    // --wait bounds the proxy's ready step too: 5 s was too short for it under load (the
    // run then failed "cam7 not ready on the proxy", not at the cams-admin step this checks).
    const r = await run(ONBOARD, ['--host', host, '--id', 'cam7', '--user', 'proxy', '--fingerprint', fingerprint, '--cams-admin-proxy', PRX, '--wait', '20', ...ports],
      { ...env(), CAMS_ADMIN_URL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, CAMS_ADMIN_DIAG_TOKEN_FILE: tokenFile('diag2', DIAG) }, `${password}\n`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL cams-admin: cam7 not registered after 20s (no CAMS_ADMIN_OPS_TOKEN_FILE to adopt it');
    expect((await run(OFFBOARD, ['--id', 'cam7', '--yes'], env())).code).toBe(0);
  }, 120_000);
});

describe('the Pi: offboard its one camera, onboard it again', () => {
  it('offboard turns it into an empty host (CAMERA_HOST removed); onboard adds the camera by id; the camera back online', async () => {
    const sim = await startSim();
    stops.push(() => sim.close());
    const d = mkdtempSync(join(tmpdir(), 'onboard-pi-'));
    mkdirSync(join(d, 'data'));
    writeFileSync(join(d, 'config.json'), JSON.stringify({ camera: { id: 'cam1', protocol: 'http', user: 'proxy', onvifPort: sim.ports.onvif, rtspPort: sim.ports.rtsp || 554, baichuanPort: sim.camera.baichuanPort, statusPollS: 5 }, server: { logLevel: 'silent' }, stills: { enabled: false }, go2rtc: { binary: 'go2rtc', rtspPort: await freePort(), apiPort: await freePort() } }));
    const envPath = join(d, '.env');
    writeFileSync(envPath, `CAMERA_HOST=${sim.camera.host}\nPI_ADDRESS=127.0.0.1\n`, { mode: 0o600 });
    const proxy = createProxy(loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: sim.password, CAMPROXY_ENV_FILE: envPath }, { cwd: d }));
    stops.push(() => proxy.stop());
    const base = `http://127.0.0.1:${(await proxy.start({ port: 0, host: '127.0.0.1' })).port}`;
    await until(async () => (await request(base).get('/api/cameras/cam1').set(auth())).body.online === true, 20_000);
    const env = { CAMPROXY_URL: base, CAMPROXY_ADMIN_TOKEN_FILE: ADMIN_FILE };

    const off = await run(OFFBOARD, ['--id', 'cam1', '--yes'], env);
    // The legacy password stays in the process environment (as compose's env_file sets it): named, not hidden.
    expect(off.out).toContain('FAIL proxy: left over (remove by hand): env CAMPROXY_CAMERA_PASSWORD');
    expect(off.code).toBe(1);
    expect(readEnvValue(readFileSync(envPath, 'utf8'), 'CAMERA_HOST')).toBeUndefined();
    expect(JSON.parse(readFileSync(join(d, 'config.json'), 'utf8')).cameras).toEqual([]);
    expect((await request(base).get('/api/cameras/cam1').set(auth())).status).toBe(404);

    // Back in over https, its certificate pinned (http never counts as trusted).
    const host = `127.0.0.1:${sim.ports.https}`;
    const fingerprint = (await servedCertificate('127.0.0.1', sim.ports.https))!.fingerprint;
    const on = await run(ONBOARD, ['--host', host, '--id', 'cam1', '--user', 'proxy', '--fingerprint', fingerprint, '--port-https', String(sim.ports.https), '--port-onvif', String(sim.ports.onvif), '--port-rtsp', String(sim.ports.rtsp), '--port-baichuan', String(sim.ports.baichuan), '--wait', '60'], env, `${sim.password}\n`);
    expect(on.out).toContain('ok cam1 ready on the proxy');
    expect(on.code).toBe(0);
    // An empty host keeps the address in overrides.json, not CAMERA_HOST.
    expect(readEnvValue(readFileSync(envPath, 'utf8'), 'CAMERA_HOST')).toBeUndefined();
    expect(proxy.loaded.config.cameras.cam1.host).toBe(host);
    expect((await request(base).get('/api/cameras/cam1').set(auth())).body.online).toBe(true);
    expect(on.out).not.toContain(sim.password);
  }, 120_000);
});

// scripts/readdress-camera.sh: a configured camera's new address (PUT /control/cameras/<id>/host).
const READDRESS = join(__dirname, '..', 'scripts', 'readdress-camera.sh');

describe('readdress-camera.sh', () => {
  it('says where it runs, and needs --id with --host or --find', async () => {
    const help = await run(READDRESS, ['--help'], {});
    expect(help.code).toBe(2);
    expect(help.out).toContain('run on your workstation, not on the proxy host');
    expect((await run(READDRESS, ['--id', 'cam1'], { CAMPROXY_URL: 'http://127.0.0.1:1', CAMPROXY_ADMIN_TOKEN_FILE: ADMIN_FILE })).code).toBe(2);
    expect((await run(READDRESS, ['--host', '192.0.2.10'], { CAMPROXY_URL: 'http://127.0.0.1:1', CAMPROXY_ADMIN_TOKEN_FILE: ADMIN_FILE })).code).toBe(2);
  });

  it('moves the Pi camera to its new address; the same again is unchanged; another model fails', async () => {
    const [s0, s1, e1] = await Promise.all([startSim(), startSim(), startSim({ model: 'E1-Outdoor-Pro' })]);
    stops.push(() => Promise.all([s0.close(), s1.close(), e1.close()]));
    const d = mkdtempSync(join(tmpdir(), 'readdress-pi-'));
    mkdirSync(join(d, 'data'));
    writeFileSync(join(d, 'config.json'), JSON.stringify({ camera: { id: 'cam1', protocol: 'http', user: 'proxy', onvifPort: s0.ports.onvif, rtspPort: s0.ports.rtsp || 554, baichuanPort: s0.camera.baichuanPort, statusPollS: 5 }, server: { logLevel: 'silent' }, stills: { enabled: false }, go2rtc: { binary: 'go2rtc', rtspPort: await freePort(), apiPort: await freePort() } }));
    const envPath = join(d, '.env');
    writeFileSync(envPath, `CAMERA_HOST=${s0.camera.host}\n`, { mode: 0o600 });
    const proxy = createProxy(loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: s0.password, CAMPROXY_ENV_FILE: envPath }, { cwd: d }));
    stops.push(() => proxy.stop());
    const base = `http://127.0.0.1:${(await proxy.start({ port: 0, host: '127.0.0.1' })).port}`;
    await until(async () => (await request(base).get('/api/cameras/cam1').set(auth())).body.online === true, 20_000);
    const env = { CAMPROXY_URL: base, CAMPROXY_ADMIN_TOKEN_FILE: ADMIN_FILE };

    const bad = await run(READDRESS, ['--id', 'cam1', '--host', e1.camera.host], env);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('FAIL readdress cam1 (HTTP 409 different_camera:');
    expect(readEnvValue(readFileSync(envPath, 'utf8'), 'CAMERA_HOST')).toBe(s0.camera.host);

    const r = await run(READDRESS, ['--id', 'cam1', '--host', s1.camera.host, '--wait', '30'], env);
    expect(r.out.split('\n').filter((l) => l.startsWith('ok ') || l.startsWith('FAIL'))).toEqual([
      `ok cam1: ${s0.camera.host} -> ${s1.camera.host} (env; same model RLC-1224A; http: the login crossed the network unencrypted)`,
      'ok cam1 online',
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('-- cams-admin: not updated (CAMS_ADMIN_URL not set)');
    expect(readEnvValue(readFileSync(envPath, 'utf8'), 'CAMERA_HOST')).toBe(s1.camera.host);
    const again = await run(READDRESS, ['--id', 'cam1', '--host', s1.camera.host], env);
    expect(again.out).toContain(`ok cam1: already at ${s1.camera.host}`);
    expect(again.code).toBe(0);
    for (const out of [bad.out, r.out, again.out]) for (const secret of [ADMIN_TOKEN, s0.password]) expect(out).not.toContain(secret);
  }, 120_000);

  it('updates the host in cams-admin too; from-proxy stays; a cams-admin refusal is a FAIL, the proxy keeps the address', async () => {
    const [s0, s1, s2] = await Promise.all([startSim(), startSim(), startSim()]);
    stops.push(() => Promise.all([s0.close(), s1.close(), s2.close()]));
    const d = mkdtempSync(join(tmpdir(), 'readdress-ca-'));
    mkdirSync(join(d, 'data'));
    writeFileSync(join(d, 'config.json'), JSON.stringify({ camera: { id: 'cam1', protocol: 'http', user: 'proxy', onvifPort: s0.ports.onvif, rtspPort: s0.ports.rtsp || 554, baichuanPort: s0.camera.baichuanPort, statusPollS: 5 }, server: { logLevel: 'silent' }, stills: { enabled: false }, go2rtc: { binary: 'go2rtc', rtspPort: await freePort(), apiPort: await freePort() } }));
    const envPath = join(d, '.env');
    writeFileSync(envPath, `CAMERA_HOST=${s0.camera.host}\n`, { mode: 0o600 });
    const proxy = createProxy(loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: s0.password, CAMPROXY_ENV_FILE: envPath }, { cwd: d }));
    stops.push(() => proxy.stop());
    const base = `http://127.0.0.1:${(await proxy.start({ port: 0, host: '127.0.0.1' })).port}`;
    // cams-admin's diag camera list and the camera PATCH (scope registry; version = rowVersion), as far as the script uses them.
    const cam = { id: 'cam_1', accountId: 'acc_1', camsId: 'den', proxyId: PRX, proxyCameraId: 'cam1', host: s0.camera.host, rowVersion: 3 };
    const patches: object[] = [];
    let refuse = false;
    const app = express();
    app.use(express.json());
    app.get('/api/v1/diag/cameras', (req, res) => void (req.get('authorization') === `Bearer ${DIAG}` ? res.json({ items: [{ ...cam, proxyCameraId: 'other' }, cam] }) : res.status(401).json({ error: 'unauthorized' })));
    app.patch('/api/v1/accounts/:a/cameras/:c', (req, res) => {
      if (req.get('authorization') !== `Bearer ${OPS}`) return void res.status(403).json({ error: 'scope' });
      patches.push({ path: req.path, body: req.body });
      if (refuse || req.body.version !== cam.rowVersion) return void res.status(409).json({ error: 'version_conflict' });
      Object.assign(cam, { host: req.body.host, rowVersion: cam.rowVersion + 1 });
      res.json(cam);
    });
    const srv: Server = app.listen(0, '127.0.0.1');
    stops.push(() => new Promise((r) => srv.close(r)));
    await new Promise((r) => srv.once('listening', r));
    const env = { CAMPROXY_URL: base, CAMPROXY_ADMIN_TOKEN_FILE: ADMIN_FILE, CAMS_ADMIN_URL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, CAMS_ADMIN_DIAG_TOKEN_FILE: tokenFile('diag3', DIAG), CAMS_ADMIN_OPS_TOKEN_FILE: tokenFile('ops3', OPS) };
    const lines = (out: string) => out.split('\n').filter((l) => l.startsWith('ok ') || l.startsWith('FAIL'));
    await until(async () => (await request(base).get('/api/cameras/cam1').set(auth())).body.online === true, 20_000);

    // Without --cams-admin-proxy: a usage error, nothing changed.
    expect((await run(READDRESS, ['--id', 'cam1', '--host', s1.camera.host], env)).code).toBe(2);
    const r = await run(READDRESS, ['--id', 'cam1', '--host', s1.camera.host, '--cams-admin-proxy', PRX, '--wait', '30'], env);
    expect(lines(r.out)).toEqual([expect.stringMatching(/^ok cam1: .* -> /), `ok cams-admin: den host ${s0.camera.host} -> ${s1.camera.host}`, 'ok cam1 online']);
    expect(r.code).toBe(0);
    expect(patches).toEqual([{ path: '/api/v1/accounts/acc_1/cameras/cam_1', body: { host: s1.camera.host, version: 3 } }]);

    // cams-admin refuses: FAIL, exit 1, the proxy has the new address anyway; a rerun (unchanged on the proxy) fixes cams-admin.
    refuse = true;
    const bad = await run(READDRESS, ['--id', 'cam1', '--host', s2.camera.host, '--cams-admin-proxy', PRX, '--wait', '30'], env);
    expect(lines(bad.out)).toEqual([expect.stringMatching(/^ok cam1: .* -> /), `FAIL cams-admin: update den (HTTP 409 version_conflict); the proxy keeps ${s2.camera.host}`, 'ok cam1 online']);
    expect(bad.code).toBe(1);
    expect(readEnvValue(readFileSync(envPath, 'utf8'), 'CAMERA_HOST')).toBe(s2.camera.host);
    refuse = false;
    const retry = await run(READDRESS, ['--id', 'cam1', '--host', s2.camera.host, '--cams-admin-proxy', PRX], env);
    expect(lines(retry.out)).toEqual([`ok cam1: already at ${s2.camera.host}`, `ok cams-admin: den host ${s1.camera.host} -> ${s2.camera.host}`]);
    expect(retry.code).toBe(0);

    // from-proxy: the viewers reach the camera through the proxy; nothing to patch.
    cam.host = 'from-proxy';
    const n = patches.length;
    const fp = await run(READDRESS, ['--id', 'cam1', '--host', s2.camera.host, '--cams-admin-proxy', PRX], env);
    expect(fp.out).toContain('ok cams-admin: den reaches the camera through the proxy (host from-proxy), nothing to change');
    expect(patches).toHaveLength(n);
    for (const out of [r.out, bad.out, retry.out, fp.out]) for (const secret of [ADMIN_TOKEN, DIAG, OPS, s0.password]) expect(out).not.toContain(secret);
  }, 120_000);

  it('--find lists what answers and suggests the one camera of the same model not configured here', async () => {
    let devices: object[] = [];
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => (req.get('authorization') === `Bearer ${ADMIN_TOKEN}` ? next() : void res.status(401).json({ error: 'unauthorized' })));
    app.post('/control/actions/find-camera', (_req, res) => void res.json({ devices, tookMs: 3000 }));
    app.get('/control/cameras/cam1/status', (_req, res) => void res.json({ id: 'cam1', camera: { online: false, model: 'RLC-1224A' } }));
    const srv: Server = app.listen(0, '127.0.0.1');
    stops.push(() => new Promise((r) => srv.close(r)));
    await new Promise((r) => srv.once('listening', r));
    const env = { CAMPROXY_URL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, CAMPROXY_ADMIN_TOKEN_FILE: ADMIN_FILE };
    const dev = (useAddress: string, model: string, current = false) => ({ useAddress, address: useAddress, model, name: model, current });

    devices = [dev('192.0.2.20', 'RLC-1224A', true), dev('192.0.2.21', 'RLC-1224A'), dev('192.0.2.22', 'E1 Outdoor Pro')];
    const one = await run(READDRESS, ['--id', 'cam1', '--find'], env);
    expect(one.code).toBe(0);
    expect(one.out).toContain('192.0.2.22 E1 Outdoor Pro');
    expect(one.out).toContain('ok find-camera: 3 found');
    expect(one.out).toContain('ok suggestion: --id cam1 --host 192.0.2.21 (the one RLC-1224A not configured here)');

    devices = [dev('192.0.2.21', 'RLC-1224A'), dev('192.0.2.23', 'RLC-1224A')];
    const two = await run(READDRESS, ['--id', 'cam1', '--find'], env);
    expect(two.code).toBe(0);
    expect(two.out).toContain('no suggestion: 2 cameras of model RLC-1224A not configured here');
    expect(two.out).not.toContain('ok suggestion');
    expect(one.out + two.out).not.toContain(ADMIN_TOKEN);
  }, 60_000);
});
