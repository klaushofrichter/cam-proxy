import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { startSim } from './helpers/sim';
import { startProxy, auth, until, freePort, ADMIN_TOKEN } from './helpers/proxy';
import { insertEvent } from '../src/catalog/events';

// Issue #93: /control/status, the audit log and /metrics tell when the
// camera's FTP upload is off, points elsewhere, or clips stop arriving.
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let ftpPort = 0;
const admin = () => auth(ADMIN_TOKEN);
const PASSWORD = 'ftp-secret-'.padEnd(24, 'q');

beforeAll(async () => {
  sim = await startSim();
  ftpPort = await freePort();
  const passive = await freePort();
  p = await startProxy(sim, {
    settings: { ftp: { enabled: true, port: ftpPort, passive: `${passive}-${passive + 9}`, publicHost: '127.0.0.1', tls: true, stream: 'sub' } },
    env: { CAMPROXY_FTP_PASSWORD: PASSWORD },
    proxy: { cameraFtpCheckMs: 200 },
  });
}, 30_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

type Ftp = { camera: { state: string; enable: boolean | null; server: string | null; mismatch: string[]; checkedAt: number | null } | null; stalled: { stalled: boolean; hours: number; lastClip: number | null; events: number } | null };
const ftpStatus = async (): Promise<Ftp> => {
  const r = await request(p.base).get('/control/status').set(admin());
  expect(JSON.stringify(r.body)).not.toContain('ftp-secret');
  return r.body.ftp as Ftp;
};
const metric = async (name: string) => {
  const text = (await request(p.base).get('/metrics')).text;
  return new RegExp(`^${name}\\{cam="cam1"\\} (\\S+)$`, 'm').exec(text)?.[1];
};
const cameraChecks = async () => {
  const r = await request(p.base).get('/control/audit?action=camera-check&after=&limit=100').set(admin());
  return r.text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { message: string; event: { outcome: string }; cam_proxy: { from: { state: string }; to: { state: string } } });
};
const action = (name: string) => request(p.base).post(`/control/actions/${name}`).set(admin());

describe('the camera FTP check (#93)', () => {
  // Review of #94: a fresh camera (cam2's sim starts so) is no alarm.
  it('the sim starts with FTP never set up: not_set_up, metric 0, no record, no stall despite events', async () => {
    insertEvent(p.proxy.catalog, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: Date.now() - 2 * 3600_000, raw: null });
    await until(async () => (await ftpStatus()).camera?.state === 'not_set_up', 10_000);
    expect((await ftpStatus()).camera).toMatchObject({ state: 'not_set_up', enable: false });
    expect((await ftpStatus()).stalled).toMatchObject({ stalled: false });
    expect(await metric('camproxy_camera_ftp_enabled')).toBe('0');
    expect(await metric('camproxy_clips_stalled')).toBe('0');
    expect(await cameraChecks()).toHaveLength(0);
  });

  it('"Point the camera\'s FTP here" turns it on at once: state on, metric 1, still no record (on is the baseline)', async () => {
    expect((await action('camera-ftp-setup')).status).toBe(200);
    expect((await ftpStatus()).camera).toMatchObject({ state: 'on', enable: true, server: '127.0.0.1', mismatch: [] });
    expect(await metric('camproxy_camera_ftp_enabled')).toBe('1');
    expect(await cameraChecks()).toHaveLength(0);
  });

  it('only another server: server_differs; another server and port: elsewhere', async () => {
    const ftp = sim.sim.engine.settings.running.Ftp;
    sim.sim.engine.settings.running.Ftp = { ...ftp, server: '192.0.2.7' };
    await until(async () => (await ftpStatus()).camera?.state === 'server_differs', 10_000);
    expect((await ftpStatus()).camera).toMatchObject({ server: '192.0.2.7', mismatch: ['server'] });
    sim.sim.engine.settings.running.Ftp = { ...ftp, server: '192.0.2.7', port: 21 };
    await until(async () => (await ftpStatus()).camera?.state === 'elsewhere', 10_000);
    expect((await ftpStatus()).camera).toMatchObject({ state: 'elsewhere', mismatch: ['server', 'port'] });
    expect(await metric('camproxy_camera_ftp_enabled')).toBe('1'); // on, just elsewhere
    expect((await cameraChecks()).at(-1)).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { to: { state: 'elsewhere' } } });
    expect((await cameraChecks()).at(-1)?.message).toContain('192.0.2.7');
    await action('camera-ftp-setup');
    expect((await ftpStatus()).camera?.state).toBe('on');
  });

  it('off on the camera with its server kept (as on 2026-10-01): off, red, a failure record', async () => {
    const ftp = sim.sim.engine.settings.running.Ftp;
    sim.sim.engine.settings.running.Ftp = { ...ftp, enable: 0 };
    await until(async () => (await ftpStatus()).camera?.state === 'off', 10_000);
    expect(await metric('camproxy_camera_ftp_enabled')).toBe('0');
    expect((await cameraChecks()).at(-1)).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { from: { state: 'on' }, to: { state: 'off' } } });
    await action('camera-ftp-setup');
    expect((await cameraChecks()).at(-1)).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { from: { state: 'off' }, to: { state: 'on' } } });
  });
});

describe('clips stalled (#93)', () => {
  it('recording events and no clip for ftp.stalledHours: stalled; a shorter window without events: not', async () => {
    // The person event of the first test, now that FTP is set up.
    expect((await ftpStatus()).stalled).toMatchObject({ stalled: true, hours: 6, lastClip: null, events: 1 });
    expect(await metric('camproxy_clips_stalled')).toBe('1');
    expect(await metric('camproxy_clips_last_received_timestamp_seconds')).toBe('0');
    expect((await request(p.base).put('/control/config').set(admin()).send({ ftp: { stalledHours: 1 } })).status).toBe(200);
    expect((await ftpStatus()).stalled).toMatchObject({ stalled: false, hours: 1, events: 0 });
    expect(await metric('camproxy_clips_stalled')).toBe('0');
  });

  it('ftp.stalledHours is 1 to 72', async () => {
    for (const bad of [0, 73, 2.5]) {
      const r = await request(p.base).put('/control/config').set(admin()).send({ ftp: { stalledHours: bad } });
      expect(r.status).toBe(400);
      expect(r.body.detail).toMatch(/ftp\.stalledHours/);
    }
    expect((await request(p.base).put('/control/config').set(admin()).send({ ftp: { stalledHours: 72 } })).status).toBe(200);
    const cfg = (await request(p.base).get('/control/config').set(admin())).body;
    expect(cfg['ftp.stalledHours']).toMatchObject({ value: 72, restart: false });
  });
});
