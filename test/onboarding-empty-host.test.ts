import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { cameraIds } from '../src/config/cameras';
import { readEnvValue } from '../src/config/env-file';
import { loadConfig } from '../src/config/load';
import { createProxy, type Proxy } from '../src/proxy';
import { servedCertificate } from '../src/tls/served';
import { audits } from './helpers/onboarding';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, freePort, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// Removing the legacy one-camera proxy's camera turns it into an empty
// several-camera host (decommission spec C1, C2; account-move findings 2, 3, 12a).
type Sim = Awaited<ReturnType<typeof startSim>>;
const stops: (() => Promise<unknown>)[] = [];
afterAll(async () => void (await Promise.all(stops.map((f) => f()))), 60_000);
const admin = () => auth(ADMIN_TOKEN);
const MOVE = `mv_${'2'.repeat(20)}`;
const FTP_PW = 'ftp-secret-'.padEnd(24, 'z');

// A config.json shaped like the Pi's: a legacy `camera` (with the retired
// poeSwitch), the legacy ftp.user; .env with CAMERA_HOST, PI_ADDRESS and the
// legacy CAMPROXY_CAMERA_PASSWORD (env_file: also in the process environment).
async function piFiles(sim: Sim, o: { moved?: boolean; configDir?: string; passwordInFile?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'onb-empty-'));
  mkdirSync(join(dir, 'data'));
  const cfgDir = o.configDir ? join(dir, o.configDir) : dir;
  mkdirSync(cfgDir, { recursive: true });
  const cfgPath = join(cfgDir, 'config.json');
  const cfg = {
    camera: { id: 'e1', name: 'PTZ Camera', protocol: 'http', user: 'proxy', onvifPort: sim.ports.onvif, rtspPort: sim.ports.rtsp || 554, baichuanPort: sim.camera.baichuanPort, statusPollS: 5, poeSwitch: { model: 'sscpoe-web', host: '192.0.2.217', port: 8, ports: 8, offSeconds: 10 } },
    server: { logLevel: 'silent', dataDir: join(dir, 'data') },
    stills: { enabled: false },
    go2rtc: { binary: 'go2rtc', rtspPort: await freePort(), apiPort: await freePort() },
    ftp: { enabled: true, user: 'camera', port: await freePort(), publicHost: '127.0.0.1' },
    events: { onvif: { subscribeMin: 1, pullTimeoutS: 1 }, poll: { enabled: true, intervalS: 1, afterOnvifDownS: 1 } },
  };
  writeFileSync(cfgPath, JSON.stringify(cfg));
  if (o.moved) writeFileSync(join(dir, 'data', 'overrides.json'), JSON.stringify({ camera: { statusPollS: 6 }, cameras: { e1: { moved: MOVE } } }));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, `CAMERA_HOST=${sim.camera.host}\nPI_ADDRESS=127.0.0.1\n${o.passwordInFile === false ? '' : `CAMPROXY_CAMERA_PASSWORD=${sim.password}\n`}`, { mode: 0o600 });
  // The process environment as compose's env_file made it at the container's creation.
  const env = { CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: sim.password, CAMPROXY_FTP_PASSWORD: FTP_PW, CAMERA_HOST: sim.camera.host, PI_ADDRESS: '127.0.0.1', CAMPROXY_ENV_FILE: envPath, CAMPROXY_CONFIG: cfgPath };
  return { dir, cfgPath, cfg, envPath, env };
}

async function start(env: Record<string, string>, dir: string) {
  const proxy: Proxy = createProxy(loadConfig(env, { cwd: dir }));
  stops.push(() => proxy.stop());
  const base = `http://127.0.0.1:${(await proxy.start({ port: 0, host: '127.0.0.1' })).port}`;
  return { proxy, base };
}

describe('removing the legacy camera: an empty host', () => {
  it('a live legacy camera: config.json → cameras: [] (backup), CAMERA_HOST and the legacy password line gone, honest leftovers; restarts empty; add takes any id with ftp', async () => {
    const sim = await startSim();
    stops.push(() => sim.close());
    const f = await piFiles(sim);
    const original = readFileSync(f.cfgPath, 'utf8');
    const { proxy, base } = await start(f.env, f.dir);
    await until(async () => (await request(base).get('/api/cameras/e1').set(auth())).body.online === true, 20_000);
    const r = await request(base).delete('/control/cameras/e1').set(admin());
    expect(r.status).toBe(200);
    expect(r.body.removed).toEqual(expect.arrayContaining([expect.stringMatching(/^config\.json camera \(now cameras: \[\]; backup config\.json\.bak-\d{8}-\d{6}\)$/), 'CAMERA_HOST', 'env CAMPROXY_CAMERA_PASSWORD line']));
    // The process environment still has both until the container is recreated: said so (finding 2).
    expect(r.body.leftovers).toEqual(['env CAMPROXY_CAMERA_PASSWORD', 'env CAMERA_HOST']);
    const cfg = JSON.parse(readFileSync(f.cfgPath, 'utf8'));
    expect(cfg.camera).toBeUndefined();
    expect(cfg.cameras).toEqual([]);
    expect(cfg.ftp).toEqual({ enabled: true, port: f.cfg.ftp.port, publicHost: '127.0.0.1' });
    expect(cfg.server).toEqual(f.cfg.server);
    const backups = readdirSync(f.dir).filter((n) => n.startsWith('config.json.bak-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(f.dir, backups[0]), 'utf8')).toBe(original);
    const envText = readFileSync(f.envPath, 'utf8');
    expect([readEnvValue(envText, 'CAMERA_HOST'), readEnvValue(envText, 'CAMPROXY_CAMERA_PASSWORD'), readEnvValue(envText, 'PI_ADDRESS')]).toEqual([undefined, undefined, '127.0.0.1']);
    expect(cameraIds(proxy.loaded.config)).toEqual([]);
    expect(proxy.loaded.legacyCamera).toBe(false);
    await until(async () => (await request(base).get('/api/cameras/e1').set(auth())).status === 404, 10_000);
    expect(audits(f.dir, 'camera-remove').at(-1)!.cam_proxy.leftovers).toEqual(r.body.leftovers);
    expect((await request(base).get('/control/status').set(admin())).body.removeLeftovers).toEqual([{ camera: 'e1', at: expect.any(Number), items: ['env CAMPROXY_CAMERA_PASSWORD', 'env CAMERA_HOST'] }]);
    // Gone: a second remove finds nothing.
    expect((await request(base).delete('/control/cameras/e1').set(admin())).status).toBe(404);
    await proxy.stop();

    // A restart with the old process environment (no recreation): starts empty, no crash loop.
    const again = await start(f.env, f.dir);
    expect(cameraIds(again.proxy.loaded.config)).toEqual([]);
    expect((await request(again.base).get('/control/status').set(admin())).body.removeLeftovers[0].items).toEqual(['env CAMPROXY_CAMERA_PASSWORD', 'env CAMERA_HOST']);
    await again.proxy.stop();

    // Recreated (env_file without the lines): nothing left; Add camera takes any id, ftp honoured.
    const { CAMPROXY_CAMERA_PASSWORD: _p, CAMERA_HOST: _h, ...recreated } = f.env;
    const q = await start(recreated, f.dir);
    expect((await request(q.base).get('/control/status').set(admin())).body.removeLeftovers).toEqual([]);
    const fingerprint = (await servedCertificate('127.0.0.1', sim.ports.https))!.fingerprint;
    const add = await request(q.base).post('/control/cameras').set(admin()).send({ id: 'e1lan', host: `127.0.0.1:${sim.ports.https}`, user: 'proxy', password: sim.password, trust: { fingerprint }, ports: { rtsp: sim.ports.rtsp, onvif: sim.ports.onvif, baichuan: sim.ports.baichuan }, ftp: true });
    expect([add.status, add.body.onboarding?.camera]).toEqual([201, 'e1lan']);
    expect(q.proxy.loaded.config.cameras.e1lan.ftp?.enabled).toBe(true);
    await until(async () => (await request(q.base).get('/api/cameras/e1lan').set(auth())).body.online === true, 20_000);
    expect(readEnvValue(readFileSync(f.envPath, 'utf8'), 'CAMERA_HOST')).toBeUndefined();
  }, 120_000);

  it("the Pi's ghost: a moved-away legacy camera (move over) with legacy overrides migrates to an empty host; nothing left once the container is recreated", async () => {
    const sim = await startSim();
    stops.push(() => sim.close());
    const f = await piFiles(sim, { moved: true });
    const { proxy, base } = await start(f.env, f.dir);
    expect(cameraIds(proxy.loaded.config)).toEqual(['e1']);
    const r = await request(base).delete('/control/cameras/e1').set(admin());
    expect(r.status).toBe(200);
    expect(r.body.removed).toEqual(expect.arrayContaining(['moved marker', 'CAMERA_HOST', 'env CAMPROXY_CAMERA_PASSWORD line']));
    expect(r.body.leftovers).toEqual(['env CAMPROXY_CAMERA_PASSWORD', 'env CAMERA_HOST']);
    const overrides = JSON.parse(readFileSync(join(f.dir, 'data', 'overrides.json'), 'utf8'));
    expect(overrides.cameras).toBeUndefined();
    expect(overrides.camera).toBeUndefined();
    await proxy.stop();
    // Recreated: loads as an empty host with no leftovers.
    const { CAMPROXY_CAMERA_PASSWORD: _p, CAMERA_HOST: _h, ...recreated } = f.env;
    const l = loadConfig(recreated, { cwd: f.dir });
    expect([cameraIds(l.config), l.legacyCamera]).toEqual([[], false]);
    const q = await start(recreated, f.dir);
    expect((await request(q.base).get('/control/status').set(admin())).body.removeLeftovers).toEqual([]);
  }, 60_000);

  it('a moved legacy camera whose move is still open here: 409 move_open, nothing changed', async () => {
    const sim = await startSim();
    stops.push(() => sim.close());
    const f = await piFiles(sim, { moved: true });
    const before = readFileSync(f.cfgPath, 'utf8');
    const loaded = loadConfig(f.env, { cwd: f.dir });
    const proxy = createProxy(loaded);
    stops.push(() => proxy.stop());
    const base = `http://127.0.0.1:${(await proxy.start({ port: 0, host: '127.0.0.1' })).port}`;
    // The move journal says the move is open.
    (proxy as unknown as { onboarding: { d: { moveOpen: (id: string) => boolean } } }).onboarding.d.moveOpen = (id) => id === MOVE;
    const r = await request(base).delete('/control/cameras/e1').set(admin());
    expect([r.status, r.body.error]).toEqual([409, 'move_open']);
    expect(readFileSync(f.cfgPath, 'utf8')).toBe(before);
  }, 30_000);

  it("config.json can't be written: the camera stays (idle), named as a leftover with the reason", async () => {
    const sim = await startSim();
    stops.push(() => sim.close());
    const f = await piFiles(sim, { configDir: 'ro' });
    const { base, proxy } = await start(f.env, f.dir);
    chmodSync(join(f.dir, 'ro'), 0o555);
    try {
      const r = await request(base).delete('/control/cameras/e1').set(admin());
      expect(r.status).toBe(200);
      expect(r.body.removed).toContain('CAMERA_HOST');
      expect(r.body.removed).not.toContain('env CAMPROXY_CAMERA_PASSWORD line');
      expect(r.body.leftovers).toEqual([expect.stringMatching(/^config\.json camera \(config\.json: could not be written \(E[A-Z]+\)\)$/)]);
      expect(proxy.loaded.legacyCamera).toBe(true);
      expect(readEnvValue(readFileSync(f.envPath, 'utf8'), 'CAMPROXY_CAMERA_PASSWORD')).toBe(sim.password);
      expect((await request(base).get('/control/status').set(admin())).body.removeLeftovers[0].items).toEqual(['config.json camera']);
    } finally {
      chmodSync(join(f.dir, 'ro'), 0o755);
    }
    expect(existsSync(join(f.dir, 'ro', 'config.json'))).toBe(true);
  }, 60_000);
});
