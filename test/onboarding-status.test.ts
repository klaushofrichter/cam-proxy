import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CertState } from '../src/tls/camera-certs';
import { compactOf, onboardingStatus, REQUIRED, STEPS, type OnboardingInput } from '../src/onboarding/status';
import { servedCertificate } from '../src/tls/served';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// The onboarding status (spec 2026-10-30-camera-onboarding-design §4.5).
const FP = `SHA256:${'A'.repeat(64)}`;
const cert: CertState = { mode: 'pinned', servername: null, fingerprint: FP, notAfter: null, lastPush: null, problem: null };
// Berlin's rule as the camera reports it (GetTime → TimeInfo).
const BERLIN = { stdOffsetMinutes: 60, dstOffsetMinutes: 60, dstRule: { startMon: 3, startWeek: 5, startWeekday: 0, startHour: 2, startMin: 0, endMon: 10, endWeek: 5, endWeekday: 0, endHour: 3, endMin: 0 } };
const NOW = Date.UTC(2026, 9, 30, 12);
const input = (o: Partial<OnboardingInput> = {}): OnboardingInput => ({
  camera: 'cam1', now: NOW, protocol: 'https',
  state: { online: true, since: 1, checkedAt: NOW - 1000, clockOffsetMs: 300 },
  credentials: { source: 'store', authOk: true, checkedAt: NOW - 1000 },
  cert, served: FP, capabilities: { schema: 1, ptz: null },
  stills: { enabled: true, up: true },
  intake: { onvif: 'subscribed', since: 1, source: 'onvif', resubscribes: 0 },
  ftp: { enabled: true, view: { state: 'on', checkedAt: 1, enable: true, server: '192.0.2.1', port: 21, user: 'cam1', mismatch: [], error: null }, lastUpload: NOW - 60_000 },
  timeInfo: BERLIN, zone: 'Europe/Berlin',
  name: { name: 'Den', nameSource: 'camera' }, poePort: null, profile: [],
  ...o,
});

describe('the onboarding status', () => {
  it('lists the steps in order; the required ones', () => {
    expect(STEPS).toEqual(['reachable', 'login', 'trust', 'capabilities', 'stream', 'events', 'ftp', 'time', 'name', 'poe', 'profile']);
    expect(REQUIRED).toEqual(['reachable', 'login', 'trust', 'capabilities', 'stream', 'events']);
    expect(Object.keys(onboardingStatus(input()).steps)).toEqual([...STEPS]);
  });

  it('ready needs every required step; trust none is not ok and names the fix', () => {
    const s = onboardingStatus(input({ cert: { ...cert, mode: 'none' } }));
    expect([s.ready, s.steps.trust]).toEqual([false, { ok: false, detail: 'certificate not trusted: use "Trust this camera\'s certificate"', action: 'camera-trust-pin' }]);
    expect(compactOf(s)).toEqual({ ready: false, missing: ['trust'] });
    const ok = onboardingStatus(input());
    expect(ok.ready).toBe(true);
    expect(compactOf(ok)).toEqual({ ready: true, missing: [] });
    expect(ok.steps.poe).toEqual({ ok: true, detail: 'none' });
    expect(ok.trust).toEqual({ mode: 'pinned', fingerprint: FP, served: FP });
    expect(ok.time).toEqual({ clockOffsetMs: 300, zone: 'Europe/Berlin', cameraStdOffsetMinutes: 60, cameraDst: true });
    expect(ok.checkedAt).toBe(NOW);
  });

  it('a pinned camera serving another certificate is not trusted until pinned again', () => {
    const s = onboardingStatus(input({ served: `SHA256:${'B'.repeat(64)}` }));
    expect(s.steps.trust).toEqual({ ok: false, detail: 'serves another certificate: pin again', action: 'camera-trust-pin' });
  });

  it('FTP and stills off by choice are ok; an http camera is never ready', () => {
    const off = onboardingStatus(input({ ftp: { enabled: false, view: null, lastUpload: null }, stills: { enabled: false, up: false } }));
    expect([off.steps.ftp, off.steps.stream, off.ready]).toEqual([{ ok: true, detail: 'off' }, { ok: true, detail: 'off' }, true]);
    const http = onboardingStatus(input({ protocol: 'http', cert: null, served: null }));
    expect([http.ready, http.steps.trust.ok, http.steps.trust.detail]).toEqual([false, false, 'plain http: no certificate']);
    const elsewhere = onboardingStatus(input({ ftp: { enabled: true, view: { state: 'elsewhere', checkedAt: 1, enable: true, server: '192.0.2.99', port: 21, user: 'cam1', mismatch: ['server'], error: null }, lastUpload: null } }));
    expect(elsewhere.steps.ftp).toMatchObject({ ok: false, action: 'camera-ftp-setup' });
    expect(onboardingStatus(input({ ftp: { enabled: true, view: null, lastUpload: null } })).steps.ftp.ok).toBeNull();
  });

  it('time: zone unknown is null, another zone or 2 minutes off is false', () => {
    expect(onboardingStatus(input({ zone: null })).steps.time).toEqual({ ok: null, detail: 'zone unknown: set time.zone' });
    expect(onboardingStatus(input({ timeInfo: undefined })).steps.time.ok).toBeNull();
    expect(onboardingStatus(input({ zone: 'America/Chicago' })).steps.time).toMatchObject({ ok: false, action: 'camera-time-set' });
    expect(onboardingStatus(input({ state: { online: true, since: 1, clockOffsetMs: 120_000 } })).steps.time.ok).toBe(false);
    expect(onboardingStatus(input({ zone: 'Asia/Tokyo', timeInfo: { stdOffsetMinutes: 540, dstOffsetMinutes: 0 } })).steps.time.ok).toBe(true);
  });

  it('login, reachability, events and the profile', () => {
    const none = onboardingStatus(input({ credentials: { source: 'none', authOk: null, checkedAt: null } }));
    expect(none.steps.login).toMatchObject({ ok: false, action: 'password' });
    const refused = onboardingStatus(input({ state: { online: false, since: 1, error: 'camera_auth_failed', checkedAt: 1 }, credentials: { source: 'store', authOk: false, checkedAt: 1 } }));
    expect([refused.steps.reachable.ok, refused.steps.login.ok]).toEqual([true, false]);
    expect(onboardingStatus(input({ state: { online: false, since: 1, error: 'camera_offline', checkedAt: 1 } })).steps.reachable.ok).toBe(false);
    expect(onboardingStatus(input({ intake: { onvif: 'down', since: 1, source: 'poll', resubscribes: 0 } })).steps.events.ok).toBe(false);
    const over = onboardingStatus(input({ profile: ['profile_cameras_exceeded'] }));
    expect([over.steps.profile.ok, over.ready, compactOf(over).missing]).toEqual([false, true, ['profile']]);
    expect(onboardingStatus(input({ poePort: 8 })).steps.poe).toEqual({ ok: true, detail: 'port 8' });
    for (const s of Object.values(onboardingStatus(input({ name: { name: 'x'.repeat(300), nameSource: 'camera' } })).steps)) expect(s.detail.length).toBeLessThanOrEqual(200);
  });
});

describe('the onboarding routes', () => {
  let s: Awaited<ReturnType<typeof startSim>>;
  let p: Awaited<ReturnType<typeof startProxy>>;
  beforeAll(async () => {
    s = await startSim();
    p = await startProxy(s, { settings: { camera: { host: `127.0.0.1:${s.ports.https}`, protocol: 'https', user: 'proxy', onvifPort: s.ports.onvif, rtspPort: s.ports.rtsp || 554, baichuanPort: s.camera.baichuanPort, statusPollS: 5 } }, proxy: { hostZone: { intl: () => 'UTC' } } });
  }, 30_000);
  afterAll(async () => {
    await p?.proxy.stop();
    await s?.close();
  });
  const get = (path: string) => request(p.base).get(path).set(auth(ADMIN_TOKEN));

  it('GET /control/cameras/cam1/onboarding and /control/onboarding against an https sim with a pin', async () => {
    const before = (await get('/control/cameras/cam1/onboarding')).body;
    expect([before.camera, before.ready, before.steps.trust.action]).toEqual(['cam1', false, 'camera-trust-pin']);
    const fp = (await servedCertificate('127.0.0.1', s.ports.https))!.fingerprint;
    expect((await request(p.base).post('/control/cameras/cam1/actions/camera-trust-pin').set(auth(ADMIN_TOKEN)).send({ fingerprint: fp })).status).toBe(200);
    await until(async () => (await get('/control/cameras/cam1/onboarding')).body.ready === true, 30_000);
    const one = (await get('/control/cameras/cam1/onboarding')).body;
    expect(one.trust).toEqual({ mode: 'pinned', fingerprint: fp, served: fp });
    expect(one.steps.time.ok).toBeNull(); // no time.zone on a UTC host
    const all = (await get('/control/onboarding')).body;
    expect(all.cameras.map((c: { camera: string }) => c.camera)).toEqual(['cam1']);
    expect((await request(p.base).get('/control/onboarding').set(auth())).status).toBe(403);
    expect((await get('/control/cameras/nope/onboarding')).status).toBe(404);
  }, 45_000);
});
