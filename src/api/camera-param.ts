import type { NextFunction, Request, Response } from 'express';
import { can, type AccessInfo, type AccessNeed } from './auth';
import type { CameraRegistry } from '../cameras/registry';
import type { CameraWorker } from '../cameras/worker';

// How long a client waits before asking a restarting camera again.
export const RESTART_RETRY_S = 5;

// The worker of camera `id`, or undefined once it answered: unknown → 404
// not_found; without the rights `need` asks for → 403 admin_only (`null`: no
// rights check here); restarting → 503 camera_restarting with Retry-After
// (never a hang).
export function resolveCamera(cams: CameraRegistry, id: string, res: Response, need: AccessNeed | null): CameraWorker | undefined {
  const w = cams.get(id);
  if (!w) return void res.status(404).json({ error: 'not_found' });
  const a = res.locals.access as AccessInfo | undefined;
  if (need !== null && a && !can(a, need, w.id)) return void res.status(403).json({ error: 'admin_only' });
  if (w.phase() === 'restarting') {
    res.setHeader('Retry-After', String(RESTART_RETRY_S));
    return void res.status(503).json({ error: 'camera_restarting' });
  }
  return w;
}

// Resolves `:cam` to its worker for every route of a router (spec
// 2026-10-05-multi-camera-host-design §6.1), answering as resolveCamera does.
// Use: router.param('cam', cameraParam(cams)).
export function cameraParam(cams: CameraRegistry, need: AccessNeed = 'client') {
  return (_req: Request, res: Response, next: NextFunction, id: string): void => {
    const w = resolveCamera(cams, String(id), res, need);
    if (!w) return;
    res.locals.worker = w;
    next();
  };
}

export function workerOf(res: Response): CameraWorker {
  return res.locals.worker as CameraWorker;
}
