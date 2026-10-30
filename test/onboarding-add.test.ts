import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cameraPasswordsFile } from '../src/config/camera-passwords';
import { servedCertificate } from '../src/tls/served';
import { otherCertificate } from './helpers/certs';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { auditText, audits, logText, managedAdminToken } from './helpers/onboarding';
import { ADMIN_TOKEN, auth, until } from './helpers/proxy';

// POST /control/cameras on a several-camera proxy (spec 2026-10-30-camera-onboarding-design §4.3).
let sims: Sim[];
let p: Awaited<ReturnType<typeof startMultiProxy>>;
let managed: string;
beforeAll(async () => {
  sims = await startSims(4);
  const dir = mkdtempSync(join(tmpdir(), 'onb-add-'));
  managed = managedAdminToken(dir);
  p = await startMultiProxy([sims[0]], { dir });
  await until(async () => (await request(p.base).get('/api/cameras/cam3').set(auth())).body.online === true, 20_000);
}, 60_000);
afterAll(async () => {
  await p?.proxy.stop();
  await Promise.all((sims ?? []).map((s) => s.close()));
}, 30_000);
const admin = () => auth(ADMIN_TOKEN);
const add = (body: object, h: Record<string, string> = admin()) => request(p.base).post('/control/cameras').set(h).send(body);
const portsOf = (s: Sim) => ({ https: s.ports.https, rtsp: s.ports.rtsp, onvif: s.ports.onvif, baichuan: s.ports.baichuan });
const fingerprintOf = async (s: Sim) => (await servedCertificate('127.0.0.1', s.ports.https))!.fingerprint;
const stored = () => (existsSync(cameraPasswordsFile(join(p.dir, 'data'))) ? JSON.parse(readFileSync(cameraPasswordsFile(join(p.dir, 'data')), 'utf8')).cameras : {});
const ids = async () => (await request(p.base).get('/control/cameras').set(admin())).body.map((b: { id: string }) => b.id);

describe('adding a camera', () => {
  it('adds an https camera with password and pin in one call; it is ready', async () => {
    const s = sims[1];
    const fingerprint = await fingerprintOf(s);
    const r = await add({ id: 'cam6', host: `127.0.0.1:${s.ports.https}`, user: 'proxy', password: s.password, trust: { fingerprint }, ports: portsOf(s) });
    expect(r.status).toBe(201);
    expect(r.body.onboarding.camera).toBe('cam6');
    await until(async () => (await request(p.base).get('/control/cameras/cam6/onboarding').set(admin())).body.ready === true, 30_000);
    expect(JSON.parse(readFileSync(join(p.dir, 'data', 'overrides.json'), 'utf8')).cameras.cam6).toMatchObject({ host: `127.0.0.1:${s.ports.https}`, onvifPort: s.ports.onvif, rtspPort: s.ports.rtsp, baichuanPort: s.ports.baichuan });
    expect(p.proxy.running.cameras.cam6).toMatchObject({ protocol: 'https', user: 'proxy' }); // the defaults: not stored as overrides
    const view = (await request(p.base).get('/api/cameras/cam6').set(auth())).body;
    expect([view.credentials.source, view.tls.mode, view.tls.fingerprint]).toEqual(['store', 'pinned', fingerprint]);
    expect(stored().cam6.password).toBe(s.password);
    const rec = audits(p.dir, 'camera-add').at(-1)!;
    expect([rec.event.outcome, rec.labels.camera, rec.cam_proxy.host, rec.cam_proxy.pinned, rec.cam_proxy.model]).toEqual(['success', 'cam6', `127.0.0.1:${s.ports.https}`, fingerprint, expect.any(String)]);
    expect(audits(p.dir, 'config-change').at(-1)!.message).toContain('cameras.cam6.host');
    // The same id again: 409 camera_exists, before the camera is asked.
    const again = await add({ id: 'cam6', host: `127.0.0.1:${s.ports.https}`, user: 'proxy', password: s.password, trust: { fingerprint }, ports: portsOf(s) });
    expect([again.status, again.body.error]).toEqual([409, 'camera_exists']);
  }, 60_000);

  it('a refused password stores and adds nothing', async () => {
    const s = sims[2];
    const r = await add({ id: 'cam7', host: `127.0.0.1:${s.ports.https}`, user: 'proxy', password: 'wrong-pw', trust: { fingerprint: await fingerprintOf(s) }, ports: portsOf(s) });
    expect([r.status, r.body.error]).toEqual([422, 'camera_refused']);
    expect(stored().cam7).toBeUndefined();
    expect(await ids()).not.toContain('cam7');
    const other = await otherCertificate();
    const m = await add({ id: 'cam7', host: `127.0.0.1:${s.ports.https}`, user: 'proxy', password: s.password, trust: { fingerprint: other.fingerprint }, ports: portsOf(s) });
    expect([m.status, m.body.error]).toEqual([409, 'fingerprint_mismatch']);
    expect(stored().cam7).toBeUndefined();
  }, 30_000);

  it('the body is checked first: https needs the fingerprint, an id, a host', async () => {
    for (const b of [{ id: 'cam8', host: '192.0.2.10', password: 'x' }, { host: '192.0.2.10', password: 'x', trust: { fingerprint: `SHA256:${'A'.repeat(64)}` } }, { id: 'Cam8', host: '192.0.2.10', protocol: 'http', password: 'x' }, { id: 'cam8', host: 'a b', protocol: 'http', password: 'x' }, { id: 'cam8', host: '192.0.2.10', protocol: 'http' }]) {
      const r = await add(b);
      expect([r.status, r.body.error], JSON.stringify(b)).toEqual([400, 'invalid']);
    }
  });

  it('a managed admin token or sign-in is 403 local_admin_only', async () => {
    const s = sims[2];
    const body = { id: 'cam7', host: `127.0.0.1:${s.ports.https}`, user: 'proxy', password: s.password, trust: { fingerprint: await fingerprintOf(s) }, ports: portsOf(s) };
    const r = await add(body, auth(managed));
    expect([r.status, r.body.error]).toEqual([403, 'local_admin_only']);
    const code = (await request(p.base).post('/control/login-links').set(auth(managed)).expect(201)).body.code;
    const cookie = String((await request(p.base).get(`/control/login-link?code=${code}`).expect(302)).headers['set-cookie']).split(';')[0];
    const viaSession = await add(body, { Cookie: cookie, 'X-CamProxy-UI': '1' });
    expect([viaSession.status, viaSession.body.error]).toEqual([403, 'local_admin_only']);
    expect(await ids()).not.toContain('cam7');
  }, 30_000);

  it('the password appears in no answer, audit record or log line', async () => {
    const SENTINEL = 'S3ntinel-Add!';
    const s = sims[3];
    s.sim.engine.sessions.modifyUser('proxy', { password: SENTINEL });
    const fp = await fingerprintOf(s);
    const bad = await add({ id: 'cam9', host: `127.0.0.1:${s.ports.https}`, user: 'proxy', password: `${SENTINEL}-x`, trust: { fingerprint: fp }, ports: portsOf(s) });
    const ok = await add({ id: 'cam9', host: `127.0.0.1:${s.ports.https}`, user: 'proxy', password: SENTINEL, trust: { fingerprint: fp }, ports: portsOf(s) });
    expect([bad.status, ok.status]).toEqual([422, 201]);
    await until(async () => (await request(p.base).get('/api/cameras/cam9').set(auth())).body.online === true, 20_000);
    expect(auditText(p.dir) + logText() + JSON.stringify([bad.body, ok.body, (await request(p.base).get('/control/cameras').set(admin())).body, (await request(p.base).get('/control/config').set(admin())).body])).not.toContain(SENTINEL);
  }, 40_000);

  it('at the limit: 409, no password stored, cameras unchanged', async () => {
    const before = await ids();
    expect((await request(p.base).put('/control/profile').set(admin()).send({ cameras: before.length })).status).toBe(200);
    const s = sims[2];
    const r = await add({ id: 'cam7', host: `127.0.0.1:${s.ports.https}`, user: 'proxy', password: s.password, trust: { fingerprint: await fingerprintOf(s) }, ports: portsOf(s) });
    expect([r.status, r.body.error, r.body.detail]).toEqual([409, 'camera_limit', `profile.cameras is ${before.length}`]);
    expect(stored().cam7).toBeUndefined();
    expect(await ids()).toEqual(before);
  }, 30_000);

  it('a proxy already over its profile keeps running with its warning', async () => {
    const before = await ids();
    expect((await request(p.base).put('/control/profile').set(admin()).send({ cameras: 1 })).status).toBe(200);
    const prof = (await request(p.base).get('/control/profile').set(admin())).body;
    expect(prof.warnings).toContain('profile_cameras_exceeded');
    expect(await ids()).toEqual(before);
    for (const id of before) expect((await request(p.base).get(`/api/cameras/${id}`).set(auth())).body.online, id).toBe(true);
    const s = sims[2];
    expect((await add({ id: 'cam7', host: `127.0.0.1:${s.ports.https}`, user: 'proxy', password: s.password, trust: { fingerprint: await fingerprintOf(s) }, ports: portsOf(s) })).body.error).toBe('camera_limit');
    expect((await request(p.base).get('/control/cameras/cam3/onboarding').set(admin())).body.steps.profile.ok).toBe(false);
  }, 30_000);
});
