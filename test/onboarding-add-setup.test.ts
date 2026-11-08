import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { runSetupAction } from '../src/onboarding/setup';
import type { ActionDeps } from '../src/api/actions';
import { servedCertificate } from '../src/tls/served';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { audits } from './helpers/onboarding';
import { ADMIN_TOKEN, auth, freePort, until } from './helpers/proxy';

// Finding 15 (account-move test, 2026-11-08): Add camera with ftp: true on a
// several-camera proxy runs camera-ftp-setup's code, and with a site CA that
// covers the camera's TLS name camera-cert-push's; a failure of either is
// reported (answer and camera-add record) and never fails the add.
const stops: (() => Promise<unknown>)[] = [];
afterAll(async () => void (await Promise.all(stops.map((f) => f()))), 60_000);
const admin = () => auth(ADMIN_TOKEN);
const portsOf = (s: Sim) => ({ https: s.ports.https, rtsp: s.ports.rtsp, onvif: s.ports.onvif, baichuan: s.ports.baichuan });
const fingerprintOf = async (s: Sim) => (await servedCertificate('127.0.0.1', s.ports.https))!.fingerprint;
const FTP_PASSWORD = 'ftp-secret-'.padEnd(24, 'z');

describe('Add camera runs the FTP setup and the certificate push', () => {
  it('ftp: true with a site CA: the camera uploads here and serves a site-CA leaf', async () => {
    const sims = await startSims(2);
    const ftpPort = await freePort();
    const passive = await freePort();
    const p = await startMultiProxy([sims[0]], {
      dir: mkdtempSync(join(tmpdir(), 'onb-setup-')),
      https: true,
      proxy: { tlsPush: { clearWaitMs: 50, verifyMs: 3000, pollMs: 100 } },
      settings: { tls: { site: 't', cameraSubnet: '127.0.0.0/16', proxyAddresses: '127.0.0.1' }, ftp: { enabled: true, port: ftpPort, passive: `${passive}-${passive + 29}`, publicHost: '127.0.0.1', stream: 'sub' } },
      env: { CAMPROXY_FTP_PASSWORD: FTP_PASSWORD },
    });
    stops.push(async () => (await p.proxy.stop(), await Promise.all(sims.map((s) => s.close()))));
    await until(async () => (await request(p.base).get('/api/cameras/cam3').set(auth())).body.online === true, 20_000);
    const s = sims[1];
    const r = await request(p.base).post('/control/cameras').set(admin()).send({ id: 'cam6', host: `127.0.0.1:${s.ports.https}`, user: 'proxy', password: s.password, trust: { fingerprint: await fingerprintOf(s) }, ports: portsOf(s), ftp: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.setup.ftp).toMatchObject({ action: 'camera-ftp-setup', ok: true });
    expect(r.body.setup.certificate).toMatchObject({ action: 'camera-cert-push', ok: true });
    expect(s.sim.engine.settings.running.Ftp).toMatchObject({ enable: 1, server: '127.0.0.1', port: ftpPort });
    expect(p.proxy.certs!.state('cam6').mode).toBe('site-ca');
    expect(r.body.onboarding.steps.ftp.ok).not.toBe(false);
    expect(r.body.onboarding.trust.mode).toBe('site-ca');
    const rec = audits(p.dir, 'camera-add').at(-1)!;
    expect(rec.event.outcome).toBe('success');
    expect(rec.cam_proxy.setup).toMatchObject({ ftp: { ok: true }, certificate: { ok: true } });
    expect(JSON.stringify(r.body) + JSON.stringify(rec)).not.toContain(FTP_PASSWORD);
  }, 90_000);

  it('a failed FTP setup is reported, the camera is still added; no site CA: no push', async () => {
    const sims = await startSims(2);
    const ftpPort = await freePort();
    const passive = await freePort();
    // No ftp.publicHost: camera-ftp-setup answers not_configured.
    const p = await startMultiProxy([sims[0]], {
      https: true,
      settings: { ftp: { enabled: true, port: ftpPort, passive: `${passive}-${passive + 29}`, stream: 'sub' } },
      env: { CAMPROXY_FTP_PASSWORD: FTP_PASSWORD },
    });
    stops.push(async () => (await p.proxy.stop(), await Promise.all(sims.map((s) => s.close()))));
    const s = sims[1];
    const fingerprint = await fingerprintOf(s);
    const r = await request(p.base).post('/control/cameras').set(admin()).send({ id: 'cam6', host: `127.0.0.1:${s.ports.https}`, user: 'proxy', password: s.password, trust: { fingerprint }, ports: portsOf(s), ftp: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.setup.ftp).toEqual({ action: 'camera-ftp-setup', ok: false, detail: 'ftp.publicHost is not set' });
    expect(r.body.setup.certificate).toBeUndefined();
    expect(r.body.onboarding.steps.ftp).toEqual({ ok: false, detail: 'FTP setup failed: ftp.publicHost is not set', action: 'camera-ftp-setup' });
    expect(r.body.onboarding.trust).toMatchObject({ mode: 'pinned', fingerprint });
    expect(audits(p.dir, 'camera-cert-push')).toEqual([]);
    const rec = audits(p.dir, 'camera-add').at(-1)!;
    expect(rec.event.outcome).toBe('success');
    expect(rec.message).toContain('FTP setup failed');
    expect(rec.cam_proxy.setup).toEqual({ ftp: { action: 'camera-ftp-setup', ok: false, detail: 'ftp.publicHost is not set' } });
    expect((await request(p.base).get('/control/cameras').set(admin())).body.map((b: { id: string }) => b.id)).toContain('cam6');
  }, 60_000);
});

// The step runner over performAction: the actions' own code, a verdict from what the camera answered.
describe('runSetupAction', () => {
  const who = { user: 'admin', requestedBy: 'token' as const };
  const target = { server: '192.0.2.5', port: 2121, user: 'camera', password: 'pw', tls: true, stream: 'sub' as const };
  const deps = (o: { setup?: () => Promise<unknown>; push?: () => Promise<unknown> }) => ({
    cameraFtp: { target: () => target, setup: o.setup ?? (async () => ({})), test: async () => ({}), off: async () => ({}) },
    tls: { pushNow: o.push ?? (async () => ({ outcome: 'pushed', served: 'SHA256:A', leaf: { fingerprint: 'SHA256:A', notAfter: 1, names: [], ips: [], certPem: '', keyPem: '' }, tookMs: 1 })) },
  }) as unknown as ActionDeps;

  it('FTP: ok when the re-read matches, the mismatch otherwise, a camera error as its message', async () => {
    const good = { enable: 1, server: '192.0.2.5', port: 2121, onlyFtps: 1, streamType: 1, uploadOn: ['MD', 'AI_PEOPLE', 'AI_VEHICLE', 'AI_DOG_CAT'] };
    expect(await runSetupAction(deps({ setup: async () => good }), 'camera-ftp-setup', 'cam6', who)).toEqual({ action: 'camera-ftp-setup', ok: true, detail: 'uploads to 192.0.2.5:2121' });
    expect(await runSetupAction(deps({ setup: async () => ({ ...good, server: '192.0.2.9' }) }), 'camera-ftp-setup', 'cam6', who)).toEqual({ action: 'camera-ftp-setup', ok: false, detail: 'the camera read back other FTP settings: server' });
    expect(await runSetupAction(deps({ setup: async () => { throw new Error('camera_auth_failed'); } }), 'camera-ftp-setup', 'cam6', who)).toEqual({ action: 'camera-ftp-setup', ok: false, detail: 'camera_auth_failed' });
  });

  it('push: pushed or current is ok; refused or failed is reported with its detail', async () => {
    expect((await runSetupAction(deps({}), 'camera-cert-push', 'cam6', who)).ok).toBe(true);
    expect(await runSetupAction(deps({ push: async () => ({ outcome: 'refused', served: 'SHA256:B', tookMs: 1 }) }), 'camera-cert-push', 'cam6', who)).toEqual({ action: 'camera-cert-push', ok: false, detail: 'refused' });
    expect(await runSetupAction(deps({ push: async () => ({ outcome: 'failed', served: null, detail: 'an event is open', tookMs: 0 }) }), 'camera-cert-push', 'cam6', who)).toEqual({ action: 'camera-cert-push', ok: false, detail: 'failed: an event is open' });
    expect(await runSetupAction(deps({ push: async () => { throw new Error('boom'); } }), 'camera-cert-push', 'cam6', who)).toEqual({ action: 'camera-cert-push', ok: false, detail: 'boom' });
  });
});
