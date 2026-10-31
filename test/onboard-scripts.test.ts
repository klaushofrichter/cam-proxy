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
    const r = await run(ONBOARD, ['--host', host, '--id', 'cam7', '--user', 'proxy', '--fingerprint', fingerprint, '--cams-admin-proxy', PRX, '--wait', '5', ...ports],
      { ...env(), CAMS_ADMIN_URL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, CAMS_ADMIN_DIAG_TOKEN_FILE: tokenFile('diag2', DIAG) }, `${password}\n`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('FAIL cams-admin: cam7 not registered after 5s (no CAMS_ADMIN_OPS_TOKEN_FILE to adopt it');
    expect((await run(OFFBOARD, ['--id', 'cam7', '--yes'], env())).code).toBe(0);
  }, 120_000);
});

describe('the Pi: offboard its one camera, onboard it again', () => {
  it('CAMERA_HOST removed and written again; the camera back online', async () => {
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
    expect(off.out).toContain('ok proxy: cam1 idle, without an address');
    expect(off.code).toBe(0);
    expect(readEnvValue(readFileSync(envPath, 'utf8'), 'CAMERA_HOST')).toBeUndefined();

    // Back in over https, its certificate pinned (http never counts as trusted).
    const host = `127.0.0.1:${sim.ports.https}`;
    const fingerprint = (await servedCertificate('127.0.0.1', sim.ports.https))!.fingerprint;
    const on = await run(ONBOARD, ['--host', host, '--id', 'cam1', '--user', 'proxy', '--fingerprint', fingerprint, '--port-https', String(sim.ports.https), '--port-onvif', String(sim.ports.onvif), '--port-rtsp', String(sim.ports.rtsp), '--port-baichuan', String(sim.ports.baichuan), '--wait', '60'], env, `${sim.password}\n`);
    expect(on.out).toContain('ok cam1 ready on the proxy');
    expect(on.code).toBe(0);
    expect(readEnvValue(readFileSync(envPath, 'utf8'), 'CAMERA_HOST')).toBe(host);
    expect((await request(base).get('/api/cameras/cam1').set(auth())).body.online).toBe(true);
    expect(on.out).not.toContain(sim.password);
  }, 120_000);
});
