import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { existsSync, mkdtempSync } from 'fs';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import { ptzApi } from '../src/api/ptz-api';
import { CameraRegistry } from '../src/cameras/registry';
import type { CameraWorker } from '../src/cameras/worker';
import type { Capabilities } from '../src/camera/capabilities';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { StreamLog } from '../src/stream/log';
import { CameraPtz } from '../src/ptz/camera-ptz';
import { CLIENT_TOKEN, startProxy, until } from './helpers/proxy';
import { E1_MODEL, startSim } from './helpers/sim';

// scripts/ptz-real-check.sh is meant for the real E1 through a proxy, by hand.
// Here it runs against the real PTZ router and positions service over a
// camera of 64 preset slots in memory, and through a real proxy against
// cam-sim's E1 Outdoor Pro.
const SCRIPT = join(__dirname, '..', 'scripts', 'ptz-real-check.sh');
const E1: Capabilities = { schema: 1, ptz: { move: true, zoom: true, focus: true, speed: true, positions: { max: 20 } } };

let server: Server;
let base: string;
let catalog: Catalog;
let ops: string[];
let e1: CameraWorker;

function fakeWorker(id: string, caps: Capabilities): CameraWorker {
  const slots = Array.from({ length: 64 }, (_, n) => ({ channel: 0, id: n, enable: 0, name: `pos${n + 1}` }));
  const command = async (cmd: string, param?: object) => {
    const p = param as Record<string, unknown>;
    if (cmd === 'GetPtzPreset') return { PtzPreset: slots.map((s) => ({ ...s })) };
    if (cmd === 'SetPtzPreset') {
      const x = (p as { PtzPreset: { id: number; enable: number; name: string } }).PtzPreset;
      slots[x.id] = { channel: 0, id: x.id, enable: x.enable, name: x.name };
    }
    if (cmd === 'PtzCtrl') ops.push(String(p.op));
    return { rspCode: 200 };
  };
  const log = new StreamLog(catalog);
  const w = { id, phase: () => 'ready', capabilities: () => caps, status: { state: () => ({ online: true, since: 0 }) } } as unknown as CameraWorker & { ptz: CameraPtz };
  w.ptz = new CameraPtz({ cam: id, command, capabilities: () => caps, online: () => true, catalog, log });
  return w;
}

const run = (cam: string, env: Record<string, string | undefined>, shell = 'bash') =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(shell, [SCRIPT, cam], { env: { PATH: process.env.PATH, PTZ_CHECK_PAUSE_S: '0.05', PTZ_CHECK_SETTLE_S: '0.05', ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });

beforeAll(async () => {
  catalog = openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-ptzcheck-')), 'catalog.sqlite'));
  ops = [];
  const cams = new CameraRegistry(() => ['e1', 'fixed']);
  e1 = fakeWorker('e1', E1);
  cams.add(e1);
  cams.add(fakeWorker('fixed', { schema: 1, ptz: null }));
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => (req.get('authorization') === `Bearer ${CLIENT_TOKEN}` ? next() : void res.status(401).json({ error: 'unauthorized' })));
  app.use('/api', ptzApi({ cameras: cams, audit: { write: () => null } }));
  app.get('/api/cameras/:cam', (req, res) => {
    const w = cams.get(req.params.cam);
    if (!w) return void res.status(404).json({ error: 'not_found' });
    res.json({ id: w.id, online: true, capabilities: w.capabilities() });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  catalog.close();
});

const auth = { Authorization: `Bearer ${CLIENT_TOKEN}` };
const positions = async () => (await request(base).get('/api/cameras/e1/ptz/positions').set(auth)).body as { positions: { id: string; name: string; home: boolean; order: number }[] };

describe('scripts/ptz-real-check.sh', () => {
  it('is valid bash', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
  });

  it('without the settings: usage, exit 2', async () => {
    const r = await run('e1', {});
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/usage/i);
  });

  it('a camera without PTZ: exit 2, nothing sent', async () => {
    const r = await run('fixed', { CAMPROXY_URL: base, CAMPROXY_TOKEN: CLIENT_TOKEN });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/not a PTZ camera/);
    expect(r.out).not.toContain(CLIENT_TOKEN);
  });

  it('the camera id is URL-encoded', async () => {
    const r = await run('e1/../fixed', { CAMPROXY_URL: base, CAMPROXY_TOKEN: CLIENT_TOKEN });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/HTTP 404/);
  });

  it('a wrong token: fails without printing it', async () => {
    const r = await run('e1', { CAMPROXY_URL: base, CAMPROXY_TOKEN: 'w'.repeat(40) });
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain('w'.repeat(40));
  });

  it('runs every step, prints only ok lines, and leaves the positions as it found them', async () => {
    const seeded = await request(base).post('/api/cameras/e1/ptz/positions').set(auth).send({ name: 'Existing' });
    expect(seeded.status).toBe(201);
    const before = await positions();
    ops = [];
    const r = await run('e1', { CAMPROXY_URL: base, CAMPROXY_TOKEN: CLIENT_TOKEN });
    expect(r.out).not.toContain(CLIENT_TOKEN);
    const lines = r.out.trim().split('\n');
    expect(lines.filter((l) => !l.startsWith('ok ')), r.out).toEqual([]);
    expect(r.code, r.out).toBe(0);
    expect(lines.length).toBeGreaterThan(15);
    expect(await positions()).toEqual(before);
    for (const op of ['Left', 'Right', 'Up', 'Down', 'LeftUp', 'LeftDown', 'RightUp', 'RightDown', 'ZoomInc', 'ZoomDec', 'FocusInc', 'FocusDec', 'ToPos', 'Stop']) expect(ops, op).toContain(op);
  }, 60_000);

  it('a camera with no positions: the start position is Home and still goes last', async () => {
    const list = await positions();
    for (const p of list.positions.filter((x) => !x.home)) await request(base).delete(`/api/cameras/e1/ptz/positions/${p.id}`).set(auth);
    for (const p of (await positions()).positions) await request(base).delete(`/api/cameras/e1/ptz/positions/${p.id}`).set(auth);
    expect((await positions()).positions).toEqual([]);
    const r = await run('e1', { CAMPROXY_URL: base, CAMPROXY_TOKEN: CLIENT_TOKEN });
    expect(r.code, r.out).toBe(0);
    expect((await positions()).positions).toEqual([]);
  }, 60_000);

  // A MacBook's /bin/bash is 3.2 (empty arrays under set -u).
  it.skipIf(!existsSync('/bin/bash'))('runs under /bin/bash too', async () => {
    const before = await positions();
    const r = await run('e1', { CAMPROXY_URL: base, CAMPROXY_TOKEN: CLIENT_TOKEN }, '/bin/bash');
    expect(r.code, r.out).toBe(0);
    expect(await positions()).toEqual(before);
  }, 60_000);

  it('a failure part-way: the trap removes what the run created', async () => {
    const before = await positions();
    // Moves fail from now on: the run stops after saving its start position.
    const lease = (e1 as unknown as { ptz: CameraPtz }).ptz.lease;
    const move = lease.move.bind(lease);
    lease.move = async () => {
      throw new Error('refused');
    };
    try {
      const r = await run('e1', { CAMPROXY_URL: base, CAMPROXY_TOKEN: CLIENT_TOKEN });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/^FAIL /m);
      expect(await positions()).toEqual(before);
    } finally {
      lease.move = move;
    }
  }, 60_000);

});

describe('scripts/ptz-real-check.sh against cam-sim E1-Outdoor-Pro through a proxy', () => {
  let sim: Awaited<ReturnType<typeof startSim>>;
  let px: Awaited<ReturnType<typeof startProxy>>;
  beforeAll(async () => {
    sim = await startSim({ model: E1_MODEL });
    px = await startProxy(sim);
    await until(async () => (await request(px.base).get('/api/cameras/cam1').set(auth)).body.capabilities != null, 15_000);
  }, 60_000);
  afterAll(async () => {
    await px.proxy.stop();
    await sim.close();
  });

  it('exit 0, every line ok, no token, the positions and presets as before', async () => {
    const list = async () => (await request(px.base).get('/api/cameras/cam1/ptz/positions').set(auth)).body;
    const before = await list();
    const r = await run('cam1', { CAMPROXY_URL: px.base, CAMPROXY_TOKEN: CLIENT_TOKEN });
    expect(r.code, r.out).toBe(0);
    expect(r.out.trim().split('\n').filter((l) => !l.startsWith('ok '))).toEqual([]);
    expect(r.out).not.toContain(CLIENT_TOKEN);
    expect(await list()).toEqual(before);
    expect(sim.sim.engine.ptz!.view().presets).toEqual([]);
  }, 60_000);
});
