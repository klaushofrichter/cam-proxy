// A camera with `moved` set is hidden like a removed one (camera-move plan
// Task 3, P2): worker stopped, not listed, FTP user refused; its config and
// content stay. Clearing `moved` starts it again, live.
import { Client } from 'basic-ftp';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load';
import { activeCameraIds, cameraIds } from '../src/config/cameras';
import { classify, DENIED } from '../src/fleet/remote-settable';
import { isLocalSetting } from '../src/api/auth';
import { ADMIN_TOKEN, auth, freePort, until } from './helpers/proxy';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';

const MOVE = 'mv_0123456789ABCDEFGHJK';
const FTP_PW = 'ftp-secret-'.padEnd(24, 'z');
let sims: Sim[];
let p: Awaited<ReturnType<typeof startMultiProxy>>;
let ftpPort = 0;
const admin = () => auth(ADMIN_TOKEN);
const listed = async () => ((await request(p.base).get('/api/cameras').set(auth())).body as { id: string }[]).map((c) => c.id);

beforeAll(async () => {
  sims = await startSims(2);
  ftpPort = await freePort();
  const passive = await freePort();
  p = await startMultiProxy(sims, {
    settings: { ftp: { enabled: true, port: ftpPort, passive: `${passive}-${passive + 29}`, publicHost: '127.0.0.1', tls: true, stream: 'sub' } },
    env: { CAMPROXY_FTP_PASSWORD: FTP_PW },
  });
  await until(() => p.proxy.cameras.get('cam4')?.status.state().online === true, 20_000);
}, 60_000);
afterAll(async () => {
  await p.proxy.stop();
  await Promise.all(sims.map((s) => s.close()));
});

async function ftpLogin(user: string): Promise<void> {
  const c = new Client(5000);
  try {
    await c.access({ host: '127.0.0.1', port: ftpPort, user, password: FTP_PW, secure: true, secureOptions: { rejectUnauthorized: false } });
  } finally {
    c.close();
  }
}

describe('a moved camera is hidden', () => {
  it('setting moved stops the worker live and hides the camera from /api/cameras', async () => {
    expect(await listed()).toEqual(['cam3', 'cam4']);
    await ftpLogin('cam4');
    const r = await request(p.base).put('/control/config').set(admin()).send({ cameras: { cam4: { moved: MOVE } } });
    expect(r.status).toBe(200);
    await until(() => !p.proxy.cameras.get('cam4'), 10_000);
    expect(await listed()).toEqual(['cam3']);
    expect((await request(p.base).get('/api/cameras/cam4').set(auth())).status).toBe(404);
    // Its configuration stays (the config.json entry is hidden, not removed).
    expect(p.proxy.running.cameraOrder).toEqual(['cam3', 'cam4']);
    expect(p.proxy.running.cameras.cam4.moved).toBe(MOVE);
    expect(activeCameraIds(p.proxy.running)).toEqual(['cam3']);
    expect(cameraIds(p.proxy.running)).toEqual(['cam3', 'cam4']);
  }, 30_000);

  it("FTP login of a moved camera's user is refused", async () => {
    await expect(ftpLogin('cam4')).rejects.toThrow(/530/);
    await ftpLogin('cam3');
  });

  it('restartCameraSide does not start a moved camera', async () => {
    await p.proxy.restart();
    expect(p.proxy.cameras.get('cam4')).toBeUndefined();
    expect(p.proxy.cameras.ids()).toEqual(['cam3']);
    expect(await listed()).toEqual(['cam3']);
    await until(() => p.proxy.cameras.get('cam3')?.status.state().online === true, 20_000);
  }, 40_000);

  it('clearing moved starts it again', async () => {
    const r = await request(p.base).delete('/control/config/cameras.cam4.moved').set(admin());
    expect(r.status).toBe(200);
    await until(() => !!p.proxy.cameras.get('cam4'), 10_000);
    await until(() => p.proxy.cameras.get('cam4')!.status.state().online === true, 20_000);
    expect(await listed()).toEqual(['cam3', 'cam4']);
    await ftpLogin('cam4');
  }, 40_000);
});

describe('moved and moves.maxCameras are local settings', () => {
  it('are refused from cams-admin (not_remote_settable) and by a managed ui.config session', () => {
    expect(classify('cameras.cam3.moved', ['cam3'])).toBe('denied');
    expect(classify('moves.maxCameras', ['cam3'])).toBe('denied');
    expect(DENIED).toContain('cameras.*.moved');
    expect(DENIED).toContain('moves');
    expect(isLocalSetting('cameras.cam3.moved')).toBe(true);
    expect(isLocalSetting('moves.maxCameras')).toBe(true);
  });

  it('moves.maxCameras defaults to no limit; a camera node takes moved', () => {
    const env = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'x' };
    const load = (extra: object) => {
      const dir = mkdtempSync(join(tmpdir(), 'camproxy-moved-'));
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ cameras: [{ id: 'cam3', host: '192.0.2.3', moved: MOVE }], ...extra }));
      return loadConfig(env, { cwd: dir }).config;
    };
    expect(load({}).moves.maxCameras).toBeUndefined();
    expect(load({ moves: { maxCameras: 2 } }).moves.maxCameras).toBe(2);
    expect(load({}).cameras.cam3.moved).toBe(MOVE);
  });
});
