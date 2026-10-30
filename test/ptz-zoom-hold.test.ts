// A held zoom (cams repeats the call every 250 ms) against a camera that, like
// the E1 (measured 2026-10-30), refuses ZoomInc/ZoomDec with -13 while a zoom
// runs, in either direction. The real lease and Reolink commands, a fake
// camera and a fake clock.
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ptzApi } from '../src/api/ptz-api';
import { CameraRegistry } from '../src/cameras/registry';
import type { CameraWorker } from '../src/cameras/worker';
import type { Capabilities } from '../src/camera/capabilities';
import { CameraError } from '../src/camera/client';
import { ReolinkPtz } from '../src/camera/ptz';
import { MoveLease, MAX_LEASE_MS } from '../src/ptz/lease';

const E1: Capabilities = { schema: 1, ptz: { move: true, zoom: true, focus: true, speed: true, positions: { max: 20 } } };

interface Timer { at: number; fn: () => void; cancelled: boolean }

let now: number;
let timers: Timer[];
let ops: string[]; // PtzCtrl ops the camera accepted
let refused: string[];
let zooming: boolean;
let lease: MoveLease;
let app: express.Express;

const idle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
// Moves the fake clock on, firing the timers that fall due.
const advance = async (ms: number) => {
  const end = now + ms;
  for (;;) {
    const due = timers.filter((t) => !t.cancelled && t.at <= end).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    now = due.at;
    due.cancelled = true;
    due.fn();
    await idle();
  }
  now = end;
};

beforeEach(() => {
  now = 0;
  timers = [];
  ops = [];
  refused = [];
  zooming = false;
  const camera = new ReolinkPtz(async (cmd, param) => {
    const op = (param as { op: string }).op;
    expect(cmd).toBe('PtzCtrl');
    const zoom = op === 'ZoomInc' || op === 'ZoomDec';
    if (zoom && zooming) {
      refused.push(op);
      throw new CameraError('camera_error', 'set config failed', false, -13);
    }
    ops.push(op);
    // Measured: a move or focus is accepted mid-zoom; Stop ends the zoom. Not
    // measured whether a move ends a zoom; this camera assumes it does.
    zooming = zoom;
    return { rspCode: 200 };
  }, () => true);
  lease = new MoveLease({
    stop: () => camera.stop(),
    schedule: (ms, fn) => {
      const t: Timer = { at: now + ms, fn, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    },
  });
  const worker = {
    id: 'e1',
    phase: () => 'ready',
    capabilities: () => E1,
    status: { state: () => ({ online: true, since: 0 }) },
    ptz: { camera, lease },
  } as unknown as CameraWorker;
  const cams = new CameraRegistry(() => ['e1']);
  cams.add(worker);
  app = express();
  app.use(express.json());
  app.use('/api', ptzApi({ cameras: cams, audit: { write: () => null } }));
});

const base = '/api/cameras/e1/ptz';
const post = (what: string, direction: string, durationMs = 400) => request(app).post(`${base}/${what}`).send({ direction, durationMs });

describe('held zoom (camera refuses a zoom while zooming)', () => {
  it('a held zoom (calls 250 ms apart) sends one ZoomInc and one Stop at the end', async () => {
    for (let i = 0; i < 6; i++) {
      expect((await post('zoom', 'in')).status).toBe(204);
      await advance(250);
    }
    expect(ops).toEqual(['ZoomInc']);
    await advance(400);
    expect(ops).toEqual(['ZoomInc', 'Stop']);
    expect(refused).toEqual([]);
    expect(lease.active()).toBe(false);
  });

  it('the last call\'s durationMs sets when the Stop goes out (at most 2000 ms)', async () => {
    await post('zoom', 'in', 400);
    await advance(250);
    await post('zoom', 'in', 1000);
    await advance(999);
    expect(ops).toEqual(['ZoomInc']);
    await advance(1);
    expect(ops).toEqual(['ZoomInc', 'Stop']);
    await post('zoom', 'out', 400);
    await advance(250);
    await post('zoom', 'out', MAX_LEASE_MS);
    await advance(MAX_LEASE_MS - 1);
    expect(ops).toEqual(['ZoomInc', 'Stop', 'ZoomDec']);
    await advance(1);
    expect(ops).toEqual(['ZoomInc', 'Stop', 'ZoomDec', 'Stop']);
  });

  it('zoom in then out: ZoomInc, Stop, ZoomDec, Stop', async () => {
    expect((await post('zoom', 'in')).status).toBe(204);
    await advance(250);
    expect((await post('zoom', 'out')).status).toBe(204);
    await advance(250);
    expect((await post('zoom', 'out')).status).toBe(204);
    await advance(400);
    expect(ops).toEqual(['ZoomInc', 'Stop', 'ZoomDec', 'Stop']);
    expect(refused).toEqual([]);
  });

  it('a move after a zoom is sent, and repeated moves still are', async () => {
    await post('zoom', 'in');
    await advance(250);
    expect((await post('move', 'left')).status).toBe(204);
    await advance(250);
    expect((await post('move', 'left')).status).toBe(204);
    await advance(400);
    expect(ops).toEqual(['ZoomInc', 'Left', 'Left', 'Stop']);
  });

  it('focus is re-sent on every call, as before', async () => {
    await post('focus', 'far');
    await advance(250);
    await post('focus', 'far');
    await advance(400);
    expect(ops).toEqual(['FocusInc', 'FocusInc', 'Stop']);
  });

  it('a zoom after the lease ended starts a new zoom', async () => {
    await post('zoom', 'in');
    await advance(400);
    expect((await post('zoom', 'in')).status).toBe(204);
    await advance(400);
    expect(ops).toEqual(['ZoomInc', 'Stop', 'ZoomInc', 'Stop']);
  });

  it('stop during a held zoom sends Stop at once; the next zoom is sent again', async () => {
    await post('zoom', 'in');
    await advance(250);
    expect((await request(app).post(`${base}/stop`)).status).toBe(204);
    expect(ops).toEqual(['ZoomInc', 'Stop']);
    await post('zoom', 'in');
    await advance(400);
    expect(ops).toEqual(['ZoomInc', 'Stop', 'ZoomInc', 'Stop']);
  });
});
