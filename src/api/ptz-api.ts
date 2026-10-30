// The PTZ API (spec 2026-10-30-ptz-capabilities-design §5): moves with a
// lease, zoom, focus and saved positions, in the proxy's own terms. Client or
// admin access (applied by the caller). Nothing here names a Reolink command,
// a preset or a slot; camera errors reach clients as their code only.
import express, { type Request, type Response } from 'express';
import type { AuditLog } from '../audit/audit-log';
import { withCamera } from '../audit/audit-log';
import type { PtzCapability } from '../camera/capabilities';
import { CameraError } from '../camera/client';
import { PTZ_DIRECTIONS, type FocusDirection, type PtzDirection, type ZoomDirection } from '../camera/ptz';
import type { CameraRegistry } from '../cameras/registry';
import type { CameraWorker } from '../cameras/worker';
import { errorMessage, logger } from '../log';
import { PtzError, type PtzPositionJson } from '../ptz/positions';
import { actorOf, clientIp, type AccessInfo } from './auth';
import { cameraParam, workerOf } from './camera-param';
import { bad } from './respond';

type Need = 'move' | 'zoom' | 'focus' | 'positions';
type Op = 'save' | 'resave' | 'rename' | 'home' | 'order' | 'delete';

const SPEED = { min: 1, max: 10, default: 5 };
const DURATION = { min: 100, max: 2000, default: 400 };

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

// A whole number in range, the default when absent; undefined (after a 400) when not.
function intIn(res: Response, v: unknown, name: string, r: { min: number; max: number; default: number }): number | undefined {
  if (v === undefined) return r.default;
  if (isInt(v, r.min, r.max)) return v;
  bad(res, `${name} must be a whole number from ${r.min} to ${r.max}`);
  return undefined;
}

export function ptzApi(d: { cameras: CameraRegistry; audit: Pick<AuditLog, 'write'> }): express.Router {
  const r = express.Router();
  r.param('cam', cameraParam(d.cameras));

  // The worker and its PTZ capability, or undefined once answered.
  const gate = (res: Response, need: Need): { w: CameraWorker; ptz: PtzCapability } | undefined => {
    const w = workerOf(res);
    const caps = w.capabilities();
    if (!caps) return void res.status(503).json({ error: 'camera_offline' });
    const ptz = caps.ptz;
    if (!ptz || (need === 'zoom' && !ptz.zoom) || (need === 'focus' && !ptz.focus) || (need === 'positions' && !ptz.positions)) return void res.status(404).json({ error: 'not_supported' });
    if (need !== 'positions' && !w.status.state().online) return void res.status(503).json({ error: 'camera_offline' });
    return { w, ptz };
  };

  // Refusals in our terms; a camera's own message never reaches the client.
  const fail = (res: Response, err: unknown): void => {
    if (err instanceof PtzError) {
      if (err.status === 400) return bad(res, err.message);
      return void res.status(err.status).json({ error: err.code });
    }
    if (err instanceof CameraError) return void res.status(err.code === 'camera_offline' ? 503 : 502).json({ error: err.code === 'camera_offline' ? 'camera_offline' : 'camera_error' });
    logger.error({ cameraId: workerOf(res).id, err: errorMessage(err) }, 'ptz_request_failed');
    res.status(500).json({ error: 'internal' });
  };
  const cameraFailed = (err: unknown) => err instanceof CameraError && err.code !== 'camera_offline';

  // --- moves (not audited) -------------------------------------------------
  r.post('/cameras/:cam/ptz/move', async (req: Request, res: Response) => {
    const g = gate(res, 'move');
    if (!g) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!(PTZ_DIRECTIONS as readonly unknown[]).includes(b.direction)) return bad(res, `direction must be one of ${PTZ_DIRECTIONS.join(', ')}`);
    const speed = intIn(res, b.speed, 'speed', SPEED);
    if (speed === undefined) return;
    const ms = intIn(res, b.durationMs, 'durationMs', DURATION);
    if (ms === undefined) return;
    const p = g.w.ptz;
    try {
      await p.lease.move(() => p.camera.move(b.direction as PtzDirection, speed), ms);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  const lensMove = (need: 'zoom' | 'focus', dirs: readonly string[], run: (w: CameraWorker, dir: string) => Promise<void>) => async (req: Request, res: Response) => {
    const g = gate(res, need);
    if (!g) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!dirs.includes(b.direction as string)) return bad(res, `direction must be one of ${dirs.join(', ')}`);
    const ms = intIn(res, b.durationMs, 'durationMs', DURATION);
    if (ms === undefined) return;
    try {
      await g.w.ptz.lease.move(() => run(g.w, b.direction as string), ms);
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  };
  r.post('/cameras/:cam/ptz/zoom', lensMove('zoom', ['in', 'out'], (w, dir) => w.ptz.camera.zoom(dir as ZoomDirection)));
  r.post('/cameras/:cam/ptz/focus', lensMove('focus', ['near', 'far'], (w, dir) => w.ptz.camera.focus(dir as FocusDirection)));

  r.post('/cameras/:cam/ptz/stop', async (_req: Request, res: Response) => {
    const g = gate(res, 'move');
    if (!g) return;
    try {
      await g.w.ptz.lease.stop();
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  // --- positions -------------------------------------------------------------
  const audit = (req: Request, res: Response, w: CameraWorker, op: Op, outcome: 'success' | 'failure', x: { id?: string; name?: string; from?: string; ids?: string[] }) => {
    const a = res.locals.access as AccessInfo | undefined;
    // A managed token is named by its label (as admin records do); otherwise admin or client.
    const user = a?.origin === 'managed' && a.tokenLabel ? actorOf(a) : a?.access === 'admin' ? 'admin' : 'client';
    const what = op === 'order' ? 'PTZ positions reordered'
      : op === 'rename' ? `PTZ position "${x.from ?? x.id}" renamed to "${x.name}"`
      : `PTZ position "${x.name ?? x.id}" ${{ save: 'saved', resave: 'saved again', home: 'made Home', delete: 'deleted' }[op]}`;
    withCamera(d.audit, w.id).write({
      action: 'ptz-position', category: ['configuration'], type: [op === 'save' ? 'creation' : op === 'delete' ? 'deletion' : 'change'], outcome,
      user, ip: clientIp(req), userAgent: req.get('user-agent'),
      message: outcome === 'success' ? what : `${what}: failed (camera_error)`,
      ...(outcome === 'failure' ? { error: 'camera_error' } : {}),
      details: { op, ...(x.id !== undefined ? { id: x.id } : {}), ...(x.name !== undefined ? { name: x.name } : {}), ...(x.from !== undefined ? { from: x.from } : {}), ...(x.ids ? { ids: x.ids } : {}), requestedBy: a?.viaCookie ? 'session' : 'token' },
    });
  };

  // Runs a position change: audited on success and on a camera failure (502) only.
  const change = async <T>(req: Request, res: Response, w: CameraWorker, op: Op, info: () => { id?: string; name?: string; from?: string; ids?: string[] }, run: () => Promise<T>, after: (t: T) => { id?: string; name?: string }): Promise<T | undefined> => {
    const before = info();
    try {
      const t = await run();
      audit(req, res, w, op, 'success', { ...before, ...after(t) });
      return t;
    } catch (err) {
      if (cameraFailed(err)) audit(req, res, w, op, 'failure', before);
      fail(res, err);
      return undefined;
    }
  };
  const named = (p: PtzPositionJson) => ({ id: p.id, name: p.name });

  r.get('/cameras/:cam/ptz/positions', async (_req: Request, res: Response) => {
    const g = gate(res, 'positions');
    if (!g) return;
    try {
      res.json(await g.w.ptz.positions.list());
    } catch (err) {
      fail(res, err);
    }
  });

  r.post('/cameras/:cam/ptz/positions', async (req: Request, res: Response) => {
    const g = gate(res, 'positions');
    if (!g) return;
    const name = (req.body as { name?: unknown } | undefined)?.name;
    const p = await change(req, res, g.w, 'save', () => ({ ...(typeof name === 'string' ? { name: name.trim() } : {}) }), () => g.w.ptz.positions.save(name), named);
    if (p) res.status(201).json(p);
  });

  // Before /positions/:id.
  r.put('/cameras/:cam/ptz/positions/order', async (req: Request, res: Response) => {
    const g = gate(res, 'positions');
    if (!g) return;
    const ids = (req.body as { ids?: unknown } | undefined)?.ids;
    const list = await change(req, res, g.w, 'order', () => ({ ...(Array.isArray(ids) ? { ids: ids.filter((x): x is string => typeof x === 'string') } : {}) }), () => g.w.ptz.positions.reorder(ids), () => ({}));
    if (list) res.json({ max: g.ptz.positions!.max, positions: list });
  });

  r.patch('/cameras/:cam/ptz/positions/:id', async (req: Request, res: Response) => {
    const g = gate(res, 'positions');
    if (!g) return;
    const id = String(req.params.id);
    const b = (req.body ?? {}) as { name?: unknown; home?: unknown };
    if (b.name === undefined && b.home === undefined) return bad(res, 'name or home is required');
    if (b.home !== undefined && b.home !== true) return bad(res, 'home is only ever set to true');
    const pos = g.w.ptz.positions;
    let out: PtzPositionJson | undefined;
    if (b.name !== undefined) {
      out = await change(req, res, g.w, 'rename', () => ({ id, from: pos.name(id) }), () => pos.rename(id, b.name), named);
      if (!out) return;
    }
    if (b.home === true) {
      out = await change(req, res, g.w, 'home', () => ({ id, name: pos.name(id) }), () => pos.makeHome(id), named);
      if (!out) return;
    }
    res.json(out);
  });

  r.post('/cameras/:cam/ptz/positions/:id/save', async (req: Request, res: Response) => {
    const g = gate(res, 'positions');
    if (!g) return;
    const id = String(req.params.id);
    const pos = g.w.ptz.positions;
    const p = await change(req, res, g.w, 'resave', () => ({ id, name: pos.name(id) }), () => pos.resave(id), named);
    if (p) res.json(p);
  });

  r.post('/cameras/:cam/ptz/positions/:id/go', async (req: Request, res: Response) => {
    const g = gate(res, 'positions');
    if (!g) return;
    try {
      await g.w.ptz.positions.goTo(String(req.params.id));
      res.status(204).end();
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete('/cameras/:cam/ptz/positions/:id', async (req: Request, res: Response) => {
    const g = gate(res, 'positions');
    if (!g) return;
    const id = String(req.params.id);
    const pos = g.w.ptz.positions;
    const done = await change(req, res, g.w, 'delete', () => ({ id, name: pos.name(id) }), async () => (await pos.remove(id), true), () => ({}));
    if (done) res.status(204).end();
  });

  return r;
}
