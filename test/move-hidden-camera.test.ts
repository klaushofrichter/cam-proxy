// A camera with `moved` set is hidden like a removed one (camera-move plan
// Task 3, P2): worker stopped, not listed, FTP user refused; its config and
// content stay. Clearing `moved` starts it again, live.
import { Client } from 'basic-ftp';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, planRemoveAll } from '../src/config/load';
import { MoveJournal } from '../src/moves/journal';
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

  it('"Reset to defaults" keeps moved: the camera stays hidden (final review 1)', async () => {
    const r = await request(p.base).delete('/control/config').set(admin());
    expect(r.status).toBe(200);
    expect(p.proxy.running.cameras.cam4.moved).toBe(MOVE);
    expect(JSON.parse(readFileSync(join(p.dir, 'data', 'overrides.json'), 'utf8')).cameras.cam4.moved).toBe(MOVE);
    expect(p.proxy.cameras.get('cam4')).toBeUndefined();
  });

  it("clearing moved is refused while the move's journal record exists (final review 1)", async () => {
    const journal = new MoveJournal(join(p.dir, 'data', 'admin', 'moves'));
    journal.save({ v: 1, id: MOVE, role: 'source', camera: 'cam4', phase: 'released', plan: null, peer: { proxyId: 'px_t', name: 'T' }, chunks: {}, bytesDone: 0, startedAt: Date.now() });
    try {
      const r = await request(p.base).delete('/control/config/cameras.cam4.moved').set(admin());
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: 'move_open' });
      expect(r.body.detail).toMatch(/cams-admin/);
      expect(p.proxy.running.cameras.cam4.moved).toBe(MOVE);
    } finally {
      journal.remove(MOVE);
    }
  });

  it('clearing moved starts it again', async () => {
    const r = await request(p.base).delete('/control/config/cameras.cam4.moved').set(admin());
    expect(r.status).toBe(200);
    await until(() => !!p.proxy.cameras.get('cam4'), 10_000);
    await until(() => p.proxy.cameras.get('cam4')!.status.state().online === true, 20_000);
    expect(await listed()).toEqual(['cam3', 'cam4']);
    await ftpLogin('cam4');
  }, 40_000);
});

describe('moved and profile.cameras (moves.maxCameras) are local settings', () => {
  it('are refused from cams-admin (not_remote_settable) and by a managed ui.config session', () => {
    expect(classify('cameras.cam3.moved', ['cam3'])).toBe('denied');
    expect(classify('profile.cameras', ['cam3'])).toBe('denied');
    expect(DENIED).toContain('cameras.*.moved');
    expect(DENIED).toContain('moves');
    expect(isLocalSetting('cameras.cam3.moved')).toBe(true);
    expect(isLocalSetting('moves.maxCameras')).toBe(true);
  });

  it('profile.cameras is unset by default (moves.maxCameras reads as it); a camera node takes moved', () => {
    const env = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'x' };
    const load = (extra: object) => {
      const dir = mkdtempSync(join(tmpdir(), 'camproxy-moved-'));
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ cameras: [{ id: 'cam3', host: '192.0.2.3', moved: MOVE }], ...extra }));
      return loadConfig(env, { cwd: dir }).config;
    };
    expect(load({}).profile.cameras).toBeUndefined();
    expect(load({ moves: { maxCameras: 2 } }).profile.cameras).toBe(2);
    expect(load({}).cameras.cam3.moved).toBe(MOVE);
  });

  it('planRemoveAll keeps cameras.*.moved of a config.json camera (final review 1)', () => {
    const env = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'x' };
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-moved-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ cameras: [{ id: 'cam3', host: '192.0.2.3' }, { id: 'cam4', host: '192.0.2.4' }] }));
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'overrides.json'), JSON.stringify({ sse: { pingS: 20 }, cameras: { cam3: { moved: MOVE, statusPollS: 60 } } }));
    const plan = planRemoveAll(loadConfig(env, { cwd: dir }));
    expect(plan.overrides).toEqual({ cameras: { cam3: { moved: MOVE } } });
    expect(plan.next.config.cameras.cam3.moved).toBe(MOVE);
    expect(activeCameraIds(plan.next.config)).toEqual(['cam4']);
  });
});
