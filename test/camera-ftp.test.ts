import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { startSim } from './helpers/sim';
import { startProxy, auth, until, freePort, ADMIN_TOKEN } from './helpers/proxy';
import { listClips } from '../src/catalog/clips';
import { ftpObject } from '../src/clips/camera-ftp';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let ftpPort = 0;
const admin = () => auth(ADMIN_TOKEN);

beforeAll(async () => {
  sim = await startSim();
  ftpPort = await freePort();
  const passive = await freePort();
  p = await startProxy(sim, {
    settings: { ftp: { enabled: true, port: ftpPort, passive: `${passive}-${passive + 9}`, publicHost: '127.0.0.1', tls: true, stream: 'sub' } },
    env: { CAMPROXY_FTP_PASSWORD: 'ftp-secret-'.padEnd(24, 'z') },
  });
  // Recordings end one second after the event (the camera's post-record time).
  sim.sim.engine.settings.running.Rec.postRec = '1 Seconds';
}, 30_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

const action = (name: string) => request(p.base).post(`/control/actions/${name}`).set(admin());

describe('camera FTP setup', () => {
  it('writes the whole Ftp object pointing at the proxy, and reads it back', async () => {
    const r = await action('camera-ftp-setup');
    expect(r.status).toBe(200);
    const ftp = sim.sim.engine.settings.running.Ftp;
    expect(ftp).toMatchObject({ enable: 1, server: '127.0.0.1', port: ftpPort, userName: 'camera', onlyFtps: 1, streamType: 1, autoDir: 1 });
    expect(ftp.password).toBe('ftp-secret-'.padEnd(24, 'z'));
    expect(ftp.schedule.table.MD).toBe('1'.repeat(168));
    expect(ftp.schedule.table.AI_PEOPLE).toBe('1'.repeat(168));
    expect(ftp.schedule.table.TIMING).toBe('0'.repeat(168)); // untouched
    // The answer never carries the password.
    expect(JSON.stringify(r.body)).not.toContain('ftp-secret');
    expect(r.body.ftp).toMatchObject({ enable: 1, server: '127.0.0.1', port: ftpPort });
  });

  it('tests the camera’s FTP connection: 0 while the proxy listens', async () => {
    const r = await action('camera-ftp-test');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, rspCode: 0 });
  });

  it('indexes the clip the camera uploads after an event', async () => {
    const t0 = Date.now();
    sim.sim.engine.events.trigger('motion', 1);
    await until(() => listClips(p.proxy.catalog, 'cam1', t0 - 60_000, Date.now() + 60_000).length > 0, 30_000);
    const [clip] = listClips(p.proxy.catalog, 'cam1', t0 - 60_000, Date.now() + 60_000);
    expect(Math.abs(clip.start_ts - t0)).toBeLessThan(5000);
    expect(clip.stream).toBe('sub');
    expect(clip.end_ts! - clip.start_ts).toBeGreaterThan(0);
    await until(() => !!listClips(p.proxy.catalog, 'cam1', t0 - 60_000, Date.now() + 60_000)[0].snapshot, 10_000);
    const st = (await request(p.base).get('/control/status').set(admin())).body.ftp;
    expect(st).toMatchObject({ enabled: true, listening: true, port: ftpPort, tls: true, clips: 1, failures: 0 });
    expect(st.lastUpload).toBeGreaterThanOrEqual(t0);
    expect(st.lastClip).toBeGreaterThanOrEqual(t0);
    // Storage knows about the clip before its next count.
    expect(p.proxy.storage.usage().clips.bytes).toBeGreaterThan(0);
  }, 40_000);

  it('turns the camera’s FTP off with the rest kept; no more uploads', async () => {
    const r = await action('camera-ftp-off');
    expect(r.status).toBe(200);
    expect(sim.sim.engine.settings.running.Ftp).toMatchObject({ enable: 0, server: '127.0.0.1', port: ftpPort });
    const before = listClips(p.proxy.catalog, 'cam1', 0, Date.now() + 60_000).length;
    sim.sim.engine.events.trigger('motion', 1);
    await new Promise((r) => setTimeout(r, 4000));
    expect(listClips(p.proxy.catalog, 'cam1', 0, Date.now() + 60_000)).toHaveLength(before);
  }, 20_000);

  it('reports the camera’s failure code when the proxy doesn’t listen', async () => {
    await action('camera-ftp-setup');
    await p.proxy.clips!.server.stop();
    const r = await action('camera-ftp-test');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: false, rspCode: -454 });
    await action('camera-ftp-off');
  });
});

// Issue #5: the rule "never server: ''" lives next to the object it protects.
describe('ftpObject', () => {
  it('refuses an empty server', () => {
    expect(() => ftpObject({}, { server: '', port: 2121, user: 'camera', password: 'x'.repeat(24), tls: true, stream: 'main' })).toThrow(/server/);
    expect(ftpObject({}, { server: '10.0.0.2', port: 2121, user: 'camera', password: 'x'.repeat(24), tls: true, stream: 'main' }).server).toBe('10.0.0.2');
  });
});
