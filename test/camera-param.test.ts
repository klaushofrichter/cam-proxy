import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { can, type AccessInfo } from '../src/api/auth';
import { cameraParam, workerOf } from '../src/api/camera-param';
import { CameraRegistry } from '../src/cameras/registry';
import type { CameraWorker, WorkerPhase } from '../src/cameras/worker';

const worker = (id: string, phase: WorkerPhase) => ({ id, phase: () => phase }) as unknown as CameraWorker;

function app(phases: Record<string, WorkerPhase>) {
  const cams = new CameraRegistry(() => Object.keys(phases));
  for (const [id, p] of Object.entries(phases)) cams.add(worker(id, p));
  const a = express();
  const r = express.Router();
  r.param('cam', cameraParam(cams));
  r.get('/cameras/:cam/x', (_req, res) => void res.json({ id: workerOf(res).id }));
  a.use((_req, res, next) => ((res.locals.access = { access: 'client', viaCookie: false, tokenKind: 'client' }), next()));
  a.use(r);
  return a;
}

describe('cameraParam (spec §6.1, §3.3)', () => {
  it('puts the worker on res.locals', async () => {
    const r = await request(app({ cam3: 'ready', cam4: 'ready' })).get('/cameras/cam4/x');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: 'cam4' });
  });
  it('unknown camera: 404 not_found', async () => {
    const r = await request(app({ cam3: 'ready' })).get('/cameras/cam9/x');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'not_found' });
  });
  it('restarting camera answers 503 at once; the others answer normally', async () => {
    const a = app({ cam3: 'restarting', cam4: 'ready' });
    const t0 = Date.now();
    const r = await request(a).get('/cameras/cam3/x');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'camera_restarting' });
    expect(r.headers['retry-after']).toBe('5');
    expect((await request(a).get('/cameras/cam4/x')).status).toBe(200);
  });
  it('an idle camera (no address) is still served: its stored data stays readable', async () => {
    expect((await request(app({ cam3: 'idle' })).get('/cameras/cam3/x')).status).toBe(200);
  });
});

describe('can() (spec §6.6): what the token kind allows, for any camera', () => {
  const p = (access: AccessInfo['access'], tokenKind: AccessInfo['tokenKind'] = 'client'): AccessInfo => ({ access, viaCookie: tokenKind === 'session', tokenKind, origin: access ? 'local' : null });
  it.each([
    [p('admin', 'admin'), 'admin', true],
    [p('admin', 'session'), 'client', true],
    [p('client'), 'client', true],
    [p('client'), 'admin', false],
    [p('audit', 'audit'), 'audit-read', true],
    [p('audit', 'audit'), 'client', false],
    [p(null, 'none'), 'client', false],
  ] as const)('%j may %s: %s', (who, need, ok) => {
    expect(can(who, need)).toBe(ok);
    expect(can(who, need, 'cam3')).toBe(ok);
  });
});
