import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { cameraPasswordStore } from '../src/config/camera-passwords';
import { loadConfig } from '../src/config/load';
import { credentialsOf, passwordSource } from '../src/onboarding/credentials';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

const T = 'a'.repeat(40);
const A = 'b'.repeat(40);

// A Loaded through loadConfig on a temp dir: cameras `ids`, the store written with cameraPasswordStore.
function loadedWith(o: { env?: Record<string, string>; stored?: Record<string, string>; ids?: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), 'onb-cred-'));
  const cams = (o.ids ?? ['cam1']).map((id, i) => ({ id, host: `192.0.2.${10 + i}`, protocol: 'http', user: 'admin' }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ cameras: cams, server: { logLevel: 'silent', dataDir: join(dir, 'data') } }));
  const store = cameraPasswordStore(join(dir, 'data'));
  for (const [id, pw] of Object.entries(o.stored ?? {})) store.set(id, pw);
  return loadConfig({ CAMPROXY_TOKENS: T, CAMPROXY_ADMIN_TOKEN: A, ...o.env }, { cwd: dir });
}

describe('where a camera password comes from (spec 2026-10-30-camera-onboarding-design §4.1)', () => {
  it('the own variable wins, then the store, then the shared default', () => {
    expect(passwordSource(loadedWith({ env: { CAMPROXY_CAMERA_PASSWORD_CAM_2: 'x' }, ids: ['cam-2'] }), 'cam-2')).toEqual({ source: 'env', envName: 'CAMPROXY_CAMERA_PASSWORD_CAM_2', ownEnv: true });
    expect(passwordSource(loadedWith({ stored: { cam1: 'y' }, env: { CAMPROXY_CAMERA_PASSWORD: 'z' } }), 'cam1')).toEqual({ source: 'store', ownEnv: false });
    expect(passwordSource(loadedWith({ env: { CAMPROXY_CAMERA_PASSWORD: 'z' } }), 'cam1')).toEqual({ source: 'env', envName: 'CAMPROXY_CAMERA_PASSWORD', ownEnv: false });
  });

  it('an own _FILE variable is the own variable', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'onb-cred-f-')), 'pw');
    writeFileSync(f, 'from-file\n');
    expect(passwordSource(loadedWith({ env: { CAMPROXY_CAMERA_PASSWORD_CAM1_FILE: f } }), 'cam1')).toEqual({ source: 'env', envName: 'CAMPROXY_CAMERA_PASSWORD_CAM1_FILE', ownEnv: true });
  });

  it('none when nothing gives one (a camera not configured here)', () => {
    expect(passwordSource(loadedWith({ env: { CAMPROXY_CAMERA_PASSWORD_CAM1: 'x' } }), 'cam9')).toEqual({ source: 'none', ownEnv: false });
  });

  it('authOk: online true, a rejected login false, anything else unknown', () => {
    const s = { source: 'store', ownEnv: false } as const;
    expect(credentialsOf(s, { online: true, since: 1, checkedAt: 5 })).toEqual({ source: 'store', authOk: true, checkedAt: 5 });
    expect(credentialsOf(s, { online: false, since: 1, error: 'camera_auth_failed', checkedAt: 6 }).authOk).toBe(false);
    expect(credentialsOf(s, { online: false, since: 1, error: 'camera_offline' })).toEqual({ source: 'store', authOk: null, checkedAt: null });
  });
});

describe('credentials in the camera views', () => {
  let cleanup = async () => {};
  afterAll(() => cleanup());

  it('GET /control/cameras and GET /api/cameras/:cam carry credentials, never a password', async () => {
    const sim = await startSim();
    const p = await startProxy(sim);
    cleanup = async () => (await p.proxy.stop(), await sim.close());
    await until(async () => (await request(p.base).get('/api/cameras/cam1').set(auth())).body.online === true, 20_000);
    const blocks = (await request(p.base).get('/control/cameras').set(auth(ADMIN_TOKEN))).body;
    expect(blocks[0].credentials).toMatchObject({ source: 'env', envName: 'CAMPROXY_CAMERA_PASSWORD', authOk: true });
    expect(typeof blocks[0].credentials.checkedAt).toBe('number');
    const one = (await request(p.base).get('/control/cameras/cam1/status').set(auth(ADMIN_TOKEN))).body;
    expect(one.credentials).toMatchObject({ source: 'env', authOk: true });
    const client = (await request(p.base).get('/api/cameras/cam1').set(auth())).body;
    expect(client.credentials).toMatchObject({ source: 'env', envName: 'CAMPROXY_CAMERA_PASSWORD', authOk: true });
    const list = (await request(p.base).get('/api/cameras').set(auth())).body;
    expect(list[0].credentials.source).toBe('env');
    expect(JSON.stringify([blocks, one, client, list])).not.toContain(sim.password);
  }, 40_000);
});
