import https from 'https';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { servedFingerprint } from '../src/tls/served';
import { ADMIN_TOKEN, auth, freePort, until } from './helpers/proxy';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';

let sims: Sim[];
let p: Awaited<ReturnType<typeof startMultiProxy>>;
let tlsPort = 0;
beforeAll(async () => {
  sims = await startSims(2, { ignoreImport: [1] });
  tlsPort = await freePort();
  p = await startMultiProxy(sims, { https: true, proxy: { tlsPush: { clearWaitMs: 50, verifyMs: 3000, pollMs: 100 } }, settings: { tls: { site: 't', cameraSubnet: '127.0.0.0/16', proxyAddresses: '127.0.0.1' }, server: { logLevel: 'silent', tls: { port: tlsPort } } } });
  await until(() => p.proxy.cameras.list().every((w) => w.status.state().online), 30_000);
  await p.proxy.certs!.tick();
}, 180_000);
afterAll(async () => {
  await p.proxy.stop();
  await Promise.all(sims.map((s) => s.close()));
});

describe('the site CA end to end (spec §15)', () => {
  it('cam3 serves its leaf; the proxy verifies it against the CA and still reaches it', async () => {
    const cams = (await request(p.base).get('/api/cameras').set(auth())).body;
    const c3 = cams.find((c: { id: string }) => c.id === 'cam3');
    expect(c3.tls).toMatchObject({ mode: 'site-ca', servername: 'cam3.t.internal', lastPush: { outcome: 'pushed' } });
    expect(await servedFingerprint('127.0.0.1', sims[0].ports.https)).toBe(c3.tls.fingerprint);
    await until(() => p.proxy.cameras.get('cam3')!.status.state().online, 30_000); // after the client switched to the CA
  }, 60_000);

  it('cam4 refused the import: pinned with its factory fingerprint (the fallback)', async () => {
    const c4 = (await request(p.base).get('/api/cameras').set(auth())).body.find((c: { id: string }) => c.id === 'cam4');
    expect(c4.tls).toMatchObject({ mode: 'pinned', fingerprint: await servedFingerprint('127.0.0.1', sims[1].ports.https), lastPush: { outcome: 'refused' } });
    const h = (await request(p.base).get('/api/local/health')).body;
    expect(h.items.find((i: { id: string }) => i.id === 'certificates')).toMatchObject({ problem: true, text: 'cam4: push refused (pinned)' });
  });

  it("the proxy's HTTPS verifies against /tls/ca.pem by proxy.t.internal", async () => {
    const ca = (await request(p.base).get('/tls/ca.pem')).text;
    const status = await new Promise<number>((resolve, reject) => https.get({ host: '127.0.0.1', port: tlsPort, path: '/api/cameras', servername: 'proxy.t.internal', ca, headers: auth() }, (r) => (r.resume(), resolve(r.statusCode ?? 0))).on('error', reject));
    expect(status).toBe(200);
  });

  it('Push now: the action on the camera route', async () => {
    const r = await request(p.base).post('/control/cameras/cam3/actions/camera-cert-push').set(auth(ADMIN_TOKEN));
    expect([r.status, r.body.outcome]).toEqual([200, 'current']);
  });

  it('a camera that served our leaf and now serves another certificate: refused, never pushed to automatically; Push now (admin) pushes (security review #178)', async () => {
    const w = p.proxy.cameras.get('cam3')!;
    const leaf = p.proxy.certs!.leaf('cam3')!.fingerprint;
    const imports = () => sims[0].sim.engine.counters.setCalls.length; // a baseline that changes with any write
    sims[0].sim.engine.clearCertificate(); // a reset camera, or an impostor: another certificate
    await until(async () => ![null, leaf].includes(await servedFingerprint('127.0.0.1', sims[0].ports.https)), 10_000);
    https.globalAgent.destroy(); // a real camera's web server restart drops kept-alive connections; cam-sim's doesn't
    // The client trusts the site CA only: nothing is sent to a camera with another certificate.
    await expect(w.client.command('GetDevInfo')).rejects.toThrow(/TLS certificate check failed/);
    const before = imports();
    await p.proxy.certs!.tick();
    expect(sims[0].sim.engine.certs.state.enable).toBe(0); // nothing imported
    expect(imports()).toBe(before);
    expect(p.proxy.certs!.state('cam3')).toMatchObject({ mode: 'site-ca', problem: expect.stringMatching(/^cam3 serves an unexpected certificate \(SHA256:[0-9A-F]{64}\): check the camera, then Push now$/) });
    await expect(w.client.command('GetDevInfo')).rejects.toThrow(/TLS certificate check failed/); // still no fallback
    const h = (await request(p.base).get('/api/local/health')).body;
    expect(h.items.find((i: { id: string }) => i.id === 'certificates')).toMatchObject({ problem: true, text: expect.stringMatching(/^cam3 serves an unexpected certificate/) });
    const r = await request(p.base).post('/control/cameras/cam3/actions/camera-cert-push').set(auth(ADMIN_TOKEN));
    expect([r.status, r.body.outcome]).toEqual([200, 'pushed']);
    await until(() => w.client.command('GetDevInfo').then(() => true, () => false), 30_000);
    expect(p.proxy.certs!.state('cam3')).toMatchObject({ mode: 'site-ca', lastPush: { outcome: 'pushed' }, problem: null });
  }, 90_000);

  it('cam4 (pinned): the proxy itself pins the certificate it reports; another one is refused', async () => {
    const w = p.proxy.cameras.get('cam4')!;
    expect(w.client.trusted()).toBe(true);
    expect(p.proxy.certs!.pin('cam4')!.fingerprint).toBe(p.proxy.certs!.state('cam4').fingerprint);
    await w.client.command('GetDevInfo'); // the pinned factory certificate
  });

  it('a restart: the known trust is in place before the first login (no unverified window)', async () => {
    const dir = p.dir;
    await p.proxy.stop();
    const q = await startMultiProxy(sims, { dir, https: true, proxy: { tlsPush: { clearWaitMs: 50, verifyMs: 3000, pollMs: 100 } }, settings: { tls: { site: 't', cameraSubnet: '127.0.0.0/16', proxyAddresses: '127.0.0.1' }, server: { logLevel: 'silent', tls: { port: tlsPort } } } });
    p = q; // afterAll stops this one
    expect(q.proxy.certs!.state('cam3').mode).toBe('site-ca');
    expect(q.proxy.cameras.get('cam3')!.client.trusted()).toBe(true);
    expect(q.proxy.cameras.get('cam4')!.client.trusted()).toBe(true);
  }, 60_000);

  it('the keys never leave the proxy: not in /api/cameras, /control/tls, the audit log or the health summary', async () => {
    const answers = [
      (await request(p.base).get('/api/cameras').set(auth())).text,
      (await request(p.base).get('/control/tls').set(auth(ADMIN_TOKEN))).text,
      (await request(p.base).get('/control/audit?action=camera-cert-push').set(auth(ADMIN_TOKEN))).text,
      (await request(p.base).get('/api/local/health')).text,
    ];
    for (const a of answers) expect(a).not.toMatch(/PRIVATE KEY|BEGIN RSA/);
    expect(answers[2]).toContain('Camera certificate pushed (cam3');
  });

  const restartWith = async (settings: object) => {
    const dir = p.dir;
    await p.proxy.stop();
    p = await startMultiProxy(sims, { dir, https: true, proxy: { tlsPush: { clearWaitMs: 50, verifyMs: 3000, pollMs: 100 } }, settings: { server: { logLevel: 'silent' }, ...settings } });
    return p;
  };
  const certItem = async () => (await request(p.base).get('/api/local/health')).body.items.find((i: { id: string }) => i.id === 'certificates');

  it('the CA cannot be loaded (ca.key missing): the cameras keep their trust (never unverified); health says so (security re-review)', async () => {
    const dir = p.dir;
    const { renameSync } = await import('fs');
    const { join } = await import('path');
    await p.proxy.stop();
    renameSync(join(dir, 'data', 'tls', 'ca.key'), join(dir, 'data', 'tls', 'ca.key.away'));
    try {
      p = await startMultiProxy(sims, { dir, https: true, settings: { tls: { site: 't', cameraSubnet: '127.0.0.0/16', proxyAddresses: '127.0.0.1' }, server: { logLevel: 'silent' } } });
      const w = p.proxy.cameras.get('cam3')!;
      expect(w.client.trusted()).toBe(true);
      expect(p.proxy.cameras.get('cam4')!.client.trusted()).toBe(true);
      await p.proxy.certs!.tick();
      expect(w.client.trusted()).toBe(true);
      await w.client.command('GetDevInfo'); // verified against ca.pem
      expect(await certItem()).toMatchObject({ problem: true, text: expect.stringMatching(/^ca\.key is missing/) });
    } finally {
      await p.proxy.stop();
      renameSync(join(dir, 'data', 'tls', 'ca.key.away'), join(dir, 'data', 'tls', 'ca.key'));
      p = await startMultiProxy(sims, { dir, https: true, settings: { tls: { site: 't', cameraSubnet: '127.0.0.0/16', proxyAddresses: '127.0.0.1' }, server: { logLevel: 'silent' } } });
    }
  }, 90_000);

  it('tls.site removed later: the cameras keep their trust, health says so; camera-trust-clear (admin) drops it, audited', async () => {
    await restartWith({});
    const w = p.proxy.cameras.get('cam3')!;
    expect(w.client.trusted()).toBe(true);
    expect(p.proxy.certs).toBeDefined();
    expect(await certItem()).toMatchObject({ problem: true, text: 'tls.site is not set: the cameras keep their site-CA trust (camera-trust-clear drops it)' });
    expect((await request(p.base).post('/control/cameras/cam3/actions/camera-trust-clear').set(auth(ADMIN_TOKEN)).send({})).status).toBe(400);
    const r = await request(p.base).post('/control/cameras/cam3/actions/camera-trust-clear').set(auth(ADMIN_TOKEN)).send({ confirm: 'clear' });
    expect([r.status, r.body.mode]).toEqual([200, 'none']);
    expect(w.client.trusted()).toBe(false);
    const audit = (await request(p.base).get('/control/audit?action=camera-trust').set(auth(ADMIN_TOKEN))).text;
    expect(audit).toContain('Camera trust cleared (cam3): site-ca → none');
    expect((await request(p.base).post('/control/actions/tls-ca-drop-previous').set(auth(ADMIN_TOKEN)).send({})).status).toBe(400);
    expect((await request(p.base).post('/control/actions/tls-ca-drop-previous').set(auth(ADMIN_TOKEN)).send({ confirm: 'drop' })).status).toBe(409);
    // The trust actions share a rate limit (6 a minute per client).
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await request(p.base).post('/control/actions/tls-ca-drop-previous').set(auth(ADMIN_TOKEN)).send({ confirm: 'drop' })).status);
    expect(codes).toContain(429);
  }, 90_000);
});
