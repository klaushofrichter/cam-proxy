import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { siteCa } from '../src/tls/ca';
import https from 'https';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, auth, freePort, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let tlsPort = 0;
beforeAll(async () => {
  sim = await startSim();
  tlsPort = await freePort();
  p = await startProxy(sim, { settings: { tls: { site: 'test', cameraSubnet: '127.0.0.0/16', proxyAddresses: '127.0.0.1' }, server: { logLevel: 'silent', tls: { port: tlsPort } } } });
}, 90_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('the proxy side of the site CA (spec §10.4)', () => {
  it('GET /tls/ca.pem: public, the CA; its fingerprint in /control/tls', async () => {
    const r = await request(p.base).get('/tls/ca.pem');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/x-pem-file/);
    expect(r.text).toContain('BEGIN CERTIFICATE');
    expect(r.text).not.toContain('PRIVATE');
    const t = (await request(p.base).get('/control/tls').set(auth(ADMIN_TOKEN))).body;
    expect(t).toMatchObject({ site: 'test', caFingerprint: expect.stringMatching(/^SHA256:[0-9A-F]{64}$/), proxy: { servername: 'proxy.test.internal' } });
  });

  it('HTTPS with the proxy leaf, verified against the CA by its .internal name', async () => {
    const ca = (await request(p.base).get('/tls/ca.pem')).text;
    const body = await new Promise<string>((resolve, reject) => {
      https.get({ host: '127.0.0.1', port: tlsPort, path: '/health', servername: 'proxy.test.internal', ca }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(b));
      }).on('error', reject);
    });
    expect(JSON.parse(body).ok).toBe(true);
  });

  it('nothing else under /tls/ is served, and the key is never in an answer', async () => {
    for (const path of ['/tls/ca.key', '/tls/', '/tls/cameras/cam1.key', '/tls/proxy.key']) {
      const r = await request(p.base).get(path);
      expect(r.status, path).toBe(404);
      expect(r.text, path).not.toContain('PRIVATE');
    }
    const t = await request(p.base).get('/control/tls').set(auth(ADMIN_TOKEN));
    expect(JSON.stringify(t.body)).not.toContain('PRIVATE');
    expect((await request(p.base).get('/control/tls')).status).toBe(401);
  });

  it('the key files: 600, in <dataDir>/tls', () => {
    for (const f of ['ca.key', 'proxy.key']) expect(statSync(join(p.dir, 'data', 'tls', f)).mode & 0o777, f).toBe(0o600);
  });

  it('Push now on an HTTP camera: says why nothing was pushed', async () => {
    const r = await request(p.base).post('/control/cameras/cam1/actions/camera-cert-push').set(auth(ADMIN_TOKEN));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ outcome: 'failed', detail: 'cam1 has no site-CA certificate (http)' });
  });

  it('tls-ca-rotate: only with confirm; a new CA, the old files kept', async () => {
    expect((await request(p.base).post('/control/actions/tls-ca-rotate').set(auth(ADMIN_TOKEN)).send({})).status).toBe(400);
    const before = (await request(p.base).get('/control/tls').set(auth(ADMIN_TOKEN))).body.caFingerprint;
    const r = await request(p.base).post('/control/actions/tls-ca-rotate').set(auth(ADMIN_TOKEN)).send({ confirm: 'rotate' });
    expect(r.status).toBe(200);
    expect(r.body.caFingerprint).toMatch(/^SHA256:[0-9A-F]{64}$/);
    expect(r.body.caFingerprint).not.toBe(before);
    expect(readdirSync(join(p.dir, 'data', 'tls')).filter((f) => f.startsWith('ca.key.old-'))).toHaveLength(1);
    const after = (await request(p.base).get('/control/tls').set(auth(ADMIN_TOKEN))).body;
    expect(after.caFingerprint).toBe(r.body.caFingerprint);
    // The HTTPS listener serves a leaf of the new CA.
    const ca = (await request(p.base).get('/tls/ca.pem')).text;
    const ok = await new Promise<number>((resolve, reject) => https.get({ host: '127.0.0.1', port: tlsPort, path: '/health', servername: 'proxy.test.internal', ca }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on('error', reject));
    expect(ok).toBe(200);
    const audit = (await request(p.base).get('/control/audit?action=config-change').set(auth(ADMIN_TOKEN))).text;
    expect(audit).not.toContain('PRIVATE');
    expect(audit).toContain(`Site CA rotated: ${before} → ${r.body.caFingerprint}`);
  }, 60_000);

  it('two rotations at once: one runs, the other is refused (409 busy)', async () => {
    const send = () => request(p.base).post('/control/actions/tls-ca-rotate').set(auth(ADMIN_TOKEN)).send({ confirm: 'rotate' });
    const rs = await Promise.all([send(), send()]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)!.body.error).toBe('busy');
    const t = (await request(p.base).get('/control/tls').set(auth(ADMIN_TOKEN))).body;
    expect(t.caFingerprint).toBe(rs.find((r) => r.status === 200)!.body.caFingerprint);
    expect(t.problems).toEqual([]);
  }, 60_000);

  it('a camera outside the CA: no leaf, and the health item names it (Ruling P5-3)', async () => {
    const s2 = await startSim();
    const q = await startProxy(s2, { settings: {
      camera: { host: `127.0.0.1:${s2.ports.https}`, protocol: 'https', user: 'proxy', onvifPort: s2.ports.onvif, rtspPort: s2.ports.rtsp || 554, baichuanPort: s2.camera.baichuanPort, statusPollS: 5 },
      tls: { site: 'test', cameraSubnet: '10.9.0.0/16', proxyAddresses: '127.0.0.2' },
    } });
    try {
      await q.proxy.certs!.tick();
      const h = (await request(q.base).get('/api/local/health')).body;
      expect(h.items.find((i: { id: string }) => i.id === 'certificates')).toMatchObject({ problem: true, text: 'cam1: 127.0.0.1 is outside the site CA: rotate the CA (tls-ca-rotate)' });
      expect(s2.sim.engine.certs.state.enable).toBe(0);
    } finally {
      await q.proxy.stop();
      await s2.close();
    }
  }, 60_000);

  it('a CA without its key (a restore without ca.key): no new CA, HTTP as before, the health item says so (Review Focus 3)', async () => {
    const s2 = await startSim();
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-nokey-'));
    const made = mkdtempSync(join(tmpdir(), 'camproxy-nokey-ca-'));
    const old = await siteCa(made, { site: 'test', cameraSubnet: '127.0.0.0/16', proxyAddresses: ['127.0.0.1'] });
    mkdirSync(join(dir, 'data', 'tls'), { recursive: true });
    writeFileSync(join(dir, 'data', 'tls', 'ca.pem'), old.certPem);
    const port2 = await freePort();
    const q = await startProxy(s2, { dir, settings: { tls: { site: 'test', cameraSubnet: '127.0.0.0/16', proxyAddresses: '127.0.0.1' }, server: { logLevel: 'silent', tls: { port: port2 } } } });
    try {
      expect(readFileSync(join(dir, 'data', 'tls', 'ca.pem'), 'utf8')).toBe(old.certPem);
      expect(existsSync(join(dir, 'data', 'tls', 'ca.key'))).toBe(false);
      expect((await request(q.base).get('/health')).status).toBe(200);
      const h = (await request(q.base).get('/api/local/health')).body;
      expect(h.items.find((i: { id: string }) => i.id === 'certificates')).toMatchObject({ problem: true, text: expect.stringMatching(/^ca\.key is missing/) });
      await expect(new Promise((resolve, reject) => https.get({ host: '127.0.0.1', port: port2, path: '/health', rejectUnauthorized: false }, resolve).on('error', reject))).rejects.toThrow(/ECONNREFUSED/);
    } finally {
      await q.proxy.stop();
      await s2.close();
    }
  }, 60_000);

  it('without tls.site: 404 no_site_ca', async () => {
    const s2 = await startSim();
    const q = await startProxy(s2);
    try {
      const r = await request(q.base).get('/tls/ca.pem');
      expect([r.status, r.body]).toEqual([404, { error: 'no_site_ca' }]);
      expect((await request(q.base).get('/control/tls').set(auth(ADMIN_TOKEN))).body).toEqual({ site: null, caFingerprint: null, caNotAfter: null, proxy: null, cameras: [], problems: [] });
      expect(existsSync(join(q.dir, 'data', 'tls'))).toBe(false);
    } finally {
      await q.proxy.stop();
      await s2.close();
    }
  });
});
