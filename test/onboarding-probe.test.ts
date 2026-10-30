import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NEVER_REMOTE_ACTIONS } from '../src/fleet/policy';
import { probeInput } from '../src/onboarding/probe';
import { otherCertificate } from './helpers/certs';
import { auditText, audits, logText, managedAdminToken } from './helpers/onboarding';
import { ADMIN_TOKEN, auth, startProxy } from './helpers/proxy';
import { startSim } from './helpers/sim';

// POST /control/actions/camera-probe (spec 2026-10-30-camera-onboarding-design §4.2).
type Sim = Awaited<ReturnType<typeof startSim>>;
const sims: Sim[] = [];
const sim = async (o: Parameters<typeof startSim>[0] = {}) => {
  const s = await startSim(o);
  sims.push(s);
  return s;
};
const proxies: Awaited<ReturnType<typeof startProxy>>[] = [];
const proxy = async (o: Parameters<typeof startProxy>[1] = {}) => {
  const p = await startProxy(await sim(), o);
  proxies.push(p);
  return p;
};
afterAll(async () => {
  await Promise.all(proxies.map((p) => p.proxy.stop()));
  await Promise.all(sims.map((s) => s.close()));
}, 60_000);
const portsOf = (s: Sim) => ({ http: s.ports.http, https: s.ports.https, rtsp: s.ports.rtsp, onvif: s.ports.onvif, baichuan: s.ports.baichuan });

describe('the probe input', () => {
  it('defaults https, admin and the Reolink ports; a :port in host is the protocol port', () => {
    expect(probeInput({ host: '192.0.2.10' })).toEqual({ host: '192.0.2.10', protocol: 'https', user: 'admin', ports: { http: 80, https: 443, rtsp: 554, onvif: 8000, baichuan: 9000 } });
    expect(probeInput({ host: '192.0.2.10:8443', protocol: 'http', ports: { rtsp: 1554 } })).toMatchObject({ protocol: 'http', ports: { http: 8443, https: 443, rtsp: 1554 } });
    expect(probeInput({ host: '192.0.2.10:8443' })).toMatchObject({ host: '192.0.2.10', ports: { https: 8443 } });
    for (const bad of [{}, { host: 'a b' }, { host: '192.0.2.10', protocol: 'ftp' }, { host: '192.0.2.10', ports: { http: 0 } }, { host: '192.0.2.10', fingerprint: 'SHA256:xyz' }, { host: '192.0.2.10', password: '' }, { host: '192.0.2.10', user: '' }]) expect(typeof probeInput(bad as Record<string, unknown>), JSON.stringify(bad)).toBe('string');
  });
});

describe('probing a camera', () => {
  let p: Awaited<ReturnType<typeof startProxy>>;
  beforeAll(async () => void (p = await proxy()), 30_000);
  const post = (body: object, t = ADMIN_TOKEN) => request(p.base).post('/control/actions/camera-probe').set(auth(t)).send(body);

  it.each(['RLC-1224A', 'CX820', 'E1-Outdoor-Pro'] as const)('%s over https: certificate first, then model and capabilities with the confirmed fingerprint', async (model) => {
    const s = await sim({ model });
    const ports = portsOf(s);
    const a = await post({ host: `127.0.0.1:${s.ports.https}`, ports });
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ host: '127.0.0.1', login: 'not_tried', device: null, capabilities: null, ports: { https: true, onvif: true, baichuan: true }, certificate: { subject: expect.stringContaining('CERTIFICATE'), selfSigned: true } });
    expect(a.body.certificate.fingerprint).toMatch(/^SHA256:[0-9A-F]{64}$/);
    const b = await post({ host: `127.0.0.1:${s.ports.https}`, ports, user: 'proxy', password: s.password, fingerprint: a.body.certificate.fingerprint });
    expect([b.status, b.body.login]).toEqual([200, 'ok']);
    expect(b.body.device.model).toBeTruthy();
    expect(b.body.capabilities.ptz === null).toBe(model !== 'E1-Outdoor-Pro');
    expect(s.sim.engine.counters.setCalls).toEqual([]); // read-only
    expect(s.sim.engine.sessions.online()).toHaveLength(0); // logged out
  }, 30_000);
});

describe('probe refusals and audit', () => {
  let p: Awaited<ReturnType<typeof startProxy>>;
  let managed: string;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onb-probe-'));
    managed = managedAdminToken(dir);
    p = await proxy({ dir });
  }, 30_000);
  const post = (body: object, t = ADMIN_TOKEN) => request(p.base).post('/control/actions/camera-probe').set(auth(t)).send(body);

  it('a password over https without a fingerprint is 400; with another fingerprint 409 and no login', async () => {
    const s = await sim();
    const host = `127.0.0.1:${s.ports.https}`;
    const no = await post({ host, ports: portsOf(s), user: 'proxy', password: s.password });
    expect([no.status, no.body.error, no.body.detail]).toEqual([400, 'invalid', 'fingerprint: required with a password over https']);
    const before = s.sim.engine.counters.loginAttempts;
    const other = await otherCertificate();
    const r = await post({ host, ports: portsOf(s), user: 'proxy', password: s.password, fingerprint: other.fingerprint });
    expect([r.status, r.body.error]).toEqual([409, 'fingerprint_mismatch']);
    expect(r.body.served).toMatch(/^SHA256:/);
    expect(s.sim.engine.counters.loginAttempts).toBe(before);
  }, 30_000);

  it('over http a password logs in; a wrong one is refused', async () => {
    const s = await sim();
    const ok = await post({ host: s.camera.host, protocol: 'http', ports: portsOf(s), user: 'proxy', password: s.password });
    expect([ok.status, ok.body.login, ok.body.certificate]).toEqual([200, 'ok', null]);
    expect((await post({ host: s.camera.host, protocol: 'http', ports: portsOf(s), user: 'proxy', password: 'wrong-pw' })).body.login).toBe('refused');
  }, 30_000);

  it('managed admin rights are refused (local only); it is never remote', async () => {
    const r = await post({ host: '192.0.2.10' }, managed);
    expect([r.status, r.body.error]).toEqual([403, 'local_admin_only']);
    expect(NEVER_REMOTE_ACTIONS).toContain('camera-probe');
  });

  it('audits host, outcome and model, never the password', async () => {
    const SENTINEL = 'S3ntinel-Probe!';
    const s = await sim();
    s.sim.engine.sessions.modifyUser('proxy', { password: SENTINEL });
    const r = await post({ host: s.camera.host, protocol: 'http', ports: portsOf(s), user: 'proxy', password: SENTINEL });
    expect(r.body.login).toBe('ok');
    const rec = audits(p.dir, 'camera-probe').at(-1)!;
    expect([rec.event.outcome, rec.cam_proxy.host, rec.cam_proxy.login, rec.cam_proxy.model, rec.cam_proxy.requestedBy]).toEqual(['success', '127.0.0.1', 'ok', r.body.device.model, 'token']);
    expect(audits(p.dir, 'control-action').filter((x) => x.cam_proxy?.action === 'camera-probe')).toHaveLength(0);
    expect(auditText(p.dir) + logText() + JSON.stringify(r.body)).not.toContain(SENTINEL);
  }, 30_000);
});

describe('numeric host spellings (security review 1)', () => {
  it('only a dotted quad in decimal, or a name with a letter', () => {
    for (const h of ['3232235781', '0xc0a80105', '192.168.001.005', '192.168.261', '192.168.1.5.', '0x7f.1', '017.0.0.1']) expect(typeof probeInput({ host: h }), h).toBe('string');
    for (const h of ['192.0.2.5', '192.0.2.5:8443', 'cam.example', 'cam-1.local', '0xcam.example']) expect(typeof probeInput({ host: h }), h).toBe('object');
  });
  it('spellings of one address share the 5 attempts (keyed by the resolved address)', async () => {
    const q = await proxy();
    const s = await sim();
    const post = (host: string) => request(q.base).post('/control/actions/camera-probe').set(auth(ADMIN_TOKEN)).send({ host, protocol: 'http', ports: portsOf(s), user: 'proxy', password: 'wrong-pw' });
    for (let i = 0; i < 5; i++) expect((await post(`localhost:${s.ports.http}`)).body.login).toBe('refused');
    expect((await post(`127.0.0.1:${s.ports.http}`)).status).toBe(429);
  }, 30_000);
  it('an http answer says plaintext; https says nothing', async () => {
    const q = await proxy();
    const s = await sim();
    const http = await request(q.base).post('/control/actions/camera-probe').set(auth(ADMIN_TOKEN)).send({ host: s.camera.host, protocol: 'http', ports: portsOf(s) });
    expect(http.body.plaintext).toBe(true);
    const https = await request(q.base).post('/control/actions/camera-probe').set(auth(ADMIN_TOKEN)).send({ host: `127.0.0.1:${s.ports.https}`, ports: portsOf(s) });
    expect(https.body.plaintext).toBeUndefined();
  }, 30_000);
});
