import https from 'https';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { servedFingerprint } from '../src/tls/push';
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

  it("a camera that serves a certificate not from the CA is refused, until its leaf is pushed again", async () => {
    const w = p.proxy.cameras.get('cam3')!;
    const leaf = p.proxy.certs!.leaf('cam3')!.fingerprint;
    sims[0].sim.engine.clearCertificate(); // a reset camera: its factory certificate again
    await until(async () => ![null, leaf].includes(await servedFingerprint('127.0.0.1', sims[0].ports.https)), 10_000);
    https.globalAgent.destroy(); // a real camera's web server restart drops kept-alive connections; cam-sim's doesn't
    // The client trusts the site CA only: nothing is sent to a camera with another certificate.
    await expect(w.client.command('GetDevInfo')).rejects.toThrow(/TLS certificate check failed/);
    await p.proxy.certs!.tick(); // served ≠ leaf: pushed again at once (Ruling P5-5)
    await until(() => w.client.command('GetDevInfo').then(() => true, () => false), 30_000);
    expect(p.proxy.certs!.state('cam3')).toMatchObject({ mode: 'site-ca', lastPush: { outcome: 'pushed' } });
  }, 90_000);

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
});
