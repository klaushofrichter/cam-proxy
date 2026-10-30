import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { cameraPasswordsFile } from '../src/config/camera-passwords';
import { startMultiProxy } from './helpers/multi';
import { auditText, logText } from './helpers/onboarding';
import { ADMIN_TOKEN, auth, freePort, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// Onboarding end to end (spec 2026-10-30-camera-onboarding-design §3, §4):
// probe → add (password + certificate) → time → FTP → ready → remove, on
// every cam-sim model, over the API only.
const stops: (() => Promise<unknown>)[] = [];
afterAll(async () => void (await Promise.all(stops.map((f) => f()))), 60_000);
const ACTIONS = ['camera-probe', 'camera-add', 'camera-trust', 'camera-time', 'control-action', 'camera-remove'];

describe('onboarding end to end', () => {
  it.each(['RLC-1224A', 'CX820', 'E1-Outdoor-Pro'] as const)('%s: probe, add, time, FTP, ready, remove', async (model) => {
    const base = await startSim();
    const s = await startSim({ model });
    // The camera's password: never in an audit record or a log line (ONVIF and RTSP take the sim's own users, so the sim's password).
    const SENTINEL = s.password;
    const ftpPort = await freePort();
    const passive = await freePort();
    const p = await startMultiProxy([base], {
      settings: { time: { zone: 'Europe/Berlin' }, ftp: { enabled: true, port: ftpPort, passive: `${passive}-${passive + 29}`, publicHost: '127.0.0.1', stream: 'sub' } },
      env: { CAMPROXY_FTP_PASSWORD: 'ftp-secret-'.padEnd(24, 'z') },
    });
    stops.push(async () => (await p.proxy.stop(), await base.close(), await s.close()));
    const a = auth(ADMIN_TOKEN);
    const ports = { https: s.ports.https, rtsp: s.ports.rtsp, onvif: s.ports.onvif, baichuan: s.ports.baichuan };
    const host = `127.0.0.1:${s.ports.https}`;
    // 1. Probe: ports and the certificate, no password.
    const probe = await request(p.base).post('/control/actions/camera-probe').set(a).send({ host, ports });
    expect([probe.status, probe.body.login]).toEqual([200, 'not_tried']);
    const fingerprint = probe.body.certificate.fingerprint as string;
    // 2. Add with the password and that certificate.
    const add = await request(p.base).post('/control/cameras').set(a).send({ id: 'cam6', host, user: 'proxy', password: SENTINEL, trust: { fingerprint }, ports, ftp: true });
    expect(add.status).toBe(201);
    await until(async () => (await request(p.base).get('/api/cameras/cam6').set(auth())).body.online === true, 20_000);
    // 3. Time, 4. FTP.
    expect((await request(p.base).post('/control/cameras/cam6/actions/camera-time-set').set(a).send({})).body).toMatchObject({ outcome: 'set', zone: 'Europe/Berlin' });
    expect((await request(p.base).post('/control/cameras/cam6/actions/camera-ftp-setup').set(a).send({})).status).toBe(200);
    // 5. Ready, every step ok.
    const onboarding = async () => (await request(p.base).get('/control/cameras/cam6/onboarding').set(a)).body;
    await until(async () => { const o = await onboarding(); return o.ready && Object.values(o.steps).every((x) => (x as { ok: unknown }).ok === true); }, 30_000);
    const o = await onboarding();
    expect(o.steps.poe).toEqual({ ok: true, detail: 'none' });
    expect(o.trust).toEqual({ mode: 'pinned', fingerprint, served: fingerprint });
    // 6. Remove: nothing left.
    const rm = await request(p.base).delete('/control/cameras/cam6').set(a);
    expect([rm.status, rm.body.leftovers]).toEqual([200, []]);
    expect(rm.body.removed).toEqual(expect.arrayContaining(['camera FTP upload off', 'configuration', 'stored password', 'certificate pin']));
    expect(s.sim.engine.settings.running.Ftp.enable).toBe(0);
    expect(existsSync(cameraPasswordsFile(join(p.dir, 'data'))) ? JSON.parse(readFileSync(cameraPasswordsFile(join(p.dir, 'data')), 'utf8')).cameras.cam6 : undefined).toBeUndefined();
    expect(readdirSync(join(p.dir, 'data', 'tls', 'cameras')).filter((f) => f.startsWith('cam6'))).toEqual([]);
    // The audit trail, in order (the pin is recorded before the add: it is made before the camera starts).
    const recs = auditText(p.dir).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>).filter((r) => ACTIONS.includes(r.event.action));
    expect(recs.map((r) => r.event.action)).toEqual(['camera-probe', 'camera-trust', 'camera-add', 'camera-time', 'control-action', 'camera-trust', 'camera-remove']);
    expect(auditText(p.dir) + logText()).not.toContain(SENTINEL);
  }, 90_000);
});
