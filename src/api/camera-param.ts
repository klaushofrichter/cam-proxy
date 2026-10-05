import type { NextFunction, Request, Response } from 'express';
import { can, type AccessInfo, type AccessNeed } from './auth';
import type { CameraRegistry } from '../cameras/registry';
import type { CameraWorker } from '../cameras/worker';

// How long a client waits before asking a restarting camera again.
export const RESTART_RETRY_S = 5;

// Resolves `:cam` to its worker for every route of a router (spec
// 2026-10-05-multi-camera-host-design §6.1): unknown → 404 not_found;
// restarting → 503 camera_restarting with Retry-After (never a hang).
// Use: router.param('cam', cameraParam(cams)).
export function cameraParam(cams: CameraRegistry, need: AccessNeed = 'client') {
  return (_req: Request, res: Response, next: NextFunction, id: string): void => {
    const w = cams.get(String(id));
    if (!w) return void res.status(404).json({ error: 'not_found' });
    const a = res.locals.access as AccessInfo | undefined;
    if (a && !can(a, need, w.id)) return void res.status(403).json({ error: 'admin_only' });
    if (w.phase() === 'restarting') {
      res.setHeader('Retry-After', String(RESTART_RETRY_S));
      return void res.status(503).json({ error: 'camera_restarting' });
    }
    res.locals.worker = w;
    next();
  };
}

export function workerOf(res: Response): CameraWorker {
  return res.locals.worker as CameraWorker;
}
