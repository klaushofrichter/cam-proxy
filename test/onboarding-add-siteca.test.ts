import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cameraPasswordsFile } from '../src/config/camera-passwords';
import { siteCa, type SiteCa } from '../src/tls/ca';
import { issueLeaf } from '../src/tls/leaf';
import { servedCertificate } from '../src/tls/served';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { audits } from './helpers/onboarding';
import { ADMIN_TOKEN, auth, until } from './helpers/proxy';

// Finding 21 (2026-11-08): on a proxy with a site CA, Add camera trusts a
// camera without a fingerprint when it serves a leaf of THIS proxy's site CA
// for <id>.<site>.internal, valid now: `trust: {siteCa: true}`, or `trust`
// left out. A fingerprint is honoured as before; a camera serving anything
// else (another CA, self-signed, another camera's name) is not trusted that way.
const stops: (() => Promise<unknown>)[] = [];
afterAll(async () => void (await Promise.all(stops.map((f) => f()))), 60_000);
const admin = () => auth(ADMIN_TOKEN);
const portsOf = (s: Sim) => ({ https: s.ports.https, rtsp: s.ports.rtsp, onvif: s.ports.onvif, baichuan: s.ports.baichuan });
const fingerprintOf = async (s: Sim) => (await servedCertificate('127.0.0.1', s.ports.https))!.fingerprint;
const TLS = { site: 't', cameraSubnet: '127.0.0.0/16', proxyAddresses: '127.0.0.1' };
const NO_FINGERPRINT = 'trust.fingerprint: required for an https camera (the certificate it serves, from camera-probe)';

let sims: Sim[];
let p: Awaited<ReturnType<typeof startMultiProxy>>;
let own: SiteCa; // the proxy's own site CA (its files in the test's data folder)
let other: SiteCa; // another proxy's
const add = (body: object) => request(p.base).post('/control/cameras').set(admin()).send(body);
const body = (id: string, s: Sim, trust?: object) => ({ id, host: `127.0.0.1:${s.ports.https}`, user: 'proxy', password: s.password, ...(trust ? { trust } : {}), ports: portsOf(s) });
const passwords = (): Record<string, unknown> => (existsSync(cameraPasswordsFile(join(p.dir, 'data'))) ? JSON.parse(readFileSync(cameraPasswordsFile(join(p.dir, 'data')), 'utf8')).cameras : {});
// The camera serves this certificate from now on (CertificateClear, then the import; the sim restarts its HTTPS each time).
async function serve(s: Sim, pem: string, key: string, fingerprint: string): Promise<void> {
  s.sim.engine.clearCertificate();
  await until(() => !s.sim.engine.certRestarting, 10_000);
  expect(s.sim.engine.importCertificate(pem, key)).toBeNull();
  await until(async () => !s.sim.engine.certRestarting && (await servedCertificate('127.0.0.1', s.ports.https))?.fingerprint === fingerprint, 10_000);
}
const ids = async () => ((await request(p.base).get('/control/cameras').set(admin())).body as { id: string }[]).map((b) => b.id);

beforeAll(async () => {
  sims = await startSims(4);
  p = await startMultiProxy([sims[0]], {
    dir: mkdtempSync(join(tmpdir(), 'onb-siteca-')),
    https: true,
    proxy: { tlsPush: { clearWaitMs: 50, verifyMs: 3000, pollMs: 100 } },
    settings: { tls: TLS },
  });
  stops.push(async () => (await p.proxy.stop(), await Promise.all(sims.map((s) => s.close()))));
  own = await siteCa(join(p.dir, 'data', 'tls'), { site: 't', cameraSubnet: TLS.cameraSubnet, proxyAddresses: ['127.0.0.1'] });
  other = await siteCa(mkdtempSync(join(tmpdir(), 'onb-siteca-other-')), { site: 't', cameraSubnet: TLS.cameraSubnet, proxyAddresses: ['127.0.0.1'] });
  await until(async () => (await request(p.base).get('/api/cameras/cam3').set(auth())).body.online === true, 20_000);
}, 90_000);

describe('Add camera with site-CA trust', () => {
  it('re-adding a camera after a remove: trust left out, it serves our leaf for its name → 201 site-ca, audited', async () => {
    const s = sims[1];
    // The first add: pinned to its factory certificate, then its site-CA leaf pushed.
    const first = await add(body('cam6', s, { fingerprint: await fingerprintOf(s) }));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.onboarding.trust.mode).toBe('site-ca');
    expect((await request(p.base).delete('/control/cameras/cam6').set(admin())).status).toBe(200);
    await until(async () => !(await ids()).includes('cam6'), 10_000);
    const served = await fingerprintOf(s); // still the leaf the first add pushed
    const before = audits(p.dir, 'camera-trust').length;
    const r = await add(body('cam6', s));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.onboarding.trust.mode).toBe('site-ca');
    expect(r.body.setup.certificate).toMatchObject({ action: 'camera-cert-push', ok: true });
    expect(p.proxy.certs!.state('cam6').mode).toBe('site-ca');
    const trust = audits(p.dir, 'camera-trust').slice(before);
    expect(trust[0].message).toBe("Camera trust cam6: none → site-ca, trust site-ca: served certificate issued by this proxy's site CA for cam6.t.internal");
    expect(trust[0].cam_proxy).toMatchObject({ op: 'site-ca', from: 'none', fingerprint: served, servername: 'cam6.t.internal' });
    expect(trust.some((t) => String(t.message).includes('pinned'))).toBe(false);
    const rec = audits(p.dir, 'camera-add').at(-1)!;
    expect(rec.event.outcome).toBe('success');
    expect(rec.message).toContain('trust site-ca (cam6.t.internal)');
    expect(rec.cam_proxy).toMatchObject({ pinned: null, siteCa: 'cam6.t.internal' });
    expect(JSON.stringify(audits(p.dir, 'camera-trust')) + JSON.stringify(rec)).not.toContain('PRIVATE KEY');
    await until(async () => (await request(p.base).get('/api/cameras/cam6').set(auth())).body.online === true, 20_000);
  }, 90_000);

  it("another camera's leaf of our CA (wrong name): left out → today's 400; siteCa: true → 409 site_ca_untrusted", async () => {
    const s = sims[2];
    const leaf = await issueLeaf(own, { cn: 'cam9.t.internal', dns: ['cam9.t.internal'], ips: ['127.0.0.1'] });
    await serve(s, leaf.certPem, leaf.keyPem, leaf.fingerprint);
    const omitted = await add(body('cam7', s));
    expect([omitted.status, omitted.body.error, omitted.body.detail]).toEqual([400, 'invalid', NO_FINGERPRINT]);
    const r = await add(body('cam7', s, { siteCa: true }));
    expect([r.status, r.body.error], JSON.stringify(r.body)).toEqual([409, 'site_ca_untrusted']);
    expect(r.body.detail).toContain('not issued for cam7.t.internal');
    expect(r.body.served).toBe(leaf.fingerprint);
    expect(await ids()).not.toContain('cam7');
    expect(passwords().cam7).toBeUndefined();
    const rec = audits(p.dir, 'camera-add').at(-1)!;
    expect([rec.event.outcome, rec.error?.message, rec.labels.camera]).toEqual(['failure', 'site_ca_untrusted', 'cam7']);
  }, 30_000);

  it('a fingerprint is honoured as before: a wrong one is 409 fingerprint_mismatch even when the leaf is ours; the right one pins', async () => {
    const s = sims[2]; // serves our CA's leaf for cam9.t.internal
    const wrong = await add(body('cam9', s, { fingerprint: `SHA256:${'A'.repeat(64)}` }));
    expect([wrong.status, wrong.body.error]).toEqual([409, 'fingerprint_mismatch']);
    expect(await ids()).not.toContain('cam9');
    const before = audits(p.dir, 'camera-trust').length;
    const r = await add(body('cam9', s, { fingerprint: await fingerprintOf(s) }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const trust = audits(p.dir, 'camera-trust').slice(before);
    expect(trust[0].message).toContain('→ pinned');
    expect(audits(p.dir, 'camera-add').at(-1)!.message).toContain('certificate pinned');
  }, 60_000);

  it('a self-signed or another CA\'s certificate: siteCa: true → 409; left out → 400 as before', async () => {
    const s = sims[3];
    const factory = await add(body('cam8', s, { siteCa: true }));
    expect([factory.status, factory.body.error]).toEqual([409, 'site_ca_untrusted']);
    expect(factory.body.detail).toContain("not issued by this proxy's site CA");
    expect([(await add(body('cam8', s))).status]).toEqual([400]);
    const leaf = await issueLeaf(other, { cn: 'cam8.t.internal', dns: ['cam8.t.internal'], ips: ['127.0.0.1'] });
    await serve(s, leaf.certPem, leaf.keyPem, leaf.fingerprint);
    const foreign = await add(body('cam8', s, { siteCa: true }));
    expect([foreign.status, foreign.body.error]).toEqual([409, 'site_ca_untrusted']);
    expect(foreign.body.detail).toContain("not issued by this proxy's site CA");
    const omitted = await add(body('cam8', s));
    expect([omitted.status, omitted.body.detail]).toEqual([400, NO_FINGERPRINT]);
    expect(await ids()).not.toContain('cam8');
    expect(passwords().cam8).toBeUndefined();
  }, 30_000);

  it('the trust shape: fingerprint or siteCa: true, not both; siteCa only over https', async () => {
    const s = sims[3];
    for (const t of [{ siteCa: true, fingerprint: `SHA256:${'A'.repeat(64)}` }, { siteCa: 'yes' }, { siteCa: false }]) {
      const r = await add(body('cam8', s, t));
      expect([r.status, r.body.error], JSON.stringify(t)).toEqual([400, 'invalid']);
    }
    const http = await add({ ...body('cam8', s, { siteCa: true }), protocol: 'http' });
    expect([http.status, http.body.error, http.body.detail]).toEqual([400, 'invalid', 'trust.siteCa: only for an https camera']);
  }, 30_000);
});

describe('Add camera with site-CA trust on a proxy without a site CA', () => {
  it('siteCa: true → 409 site_ca_untrusted (no site CA); left out → 400 as before, the camera not asked', async () => {
    const [s0, s] = await startSims(2);
    const q = await startMultiProxy([s0], { https: true });
    stops.push(async () => (await q.proxy.stop(), await s0.close(), await s.close()));
    const r = await request(q.base).post('/control/cameras').set(admin()).send(body('cam6', s, { siteCa: true }));
    expect([r.status, r.body.error], JSON.stringify(r.body)).toEqual([409, 'site_ca_untrusted']);
    expect(r.body.detail).toContain('this proxy has no site CA');
    const omitted = await request(q.base).post('/control/cameras').set(admin()).send(body('cam6', s));
    expect([omitted.status, omitted.body.error, omitted.body.detail]).toEqual([400, 'invalid', NO_FINGERPRINT]);
  }, 60_000);
});
