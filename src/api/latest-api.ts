import express, { type Request, type Response } from 'express';
import type { CameraRegistry } from '../cameras/registry';
import type { CameraWorker } from '../cameras/worker';
import { cameraParam, workerOf } from './camera-param';

export const latestUrls = (cam: string) => ({ url: `/api/cameras/${encodeURIComponent(cam)}/stills/latest.jpg`, tileUrl: `/api/cameras/${encodeURIComponent(cam)}/previews/latest.jpg` });

// The newest still and tile of each camera, from memory (spec
// 2026-10-05-multi-camera-host-design §6.4): no disk read, no decode. A
// client polling every few seconds gets 304 while nothing moved; while the
// stream is down: 404 no_still with the last ts (never a 304 for an image
// that is no longer current).
export function latestApi(d: { cameras: CameraRegistry }): express.Router {
  const r = express.Router();
  r.param('cam', cameraParam(d.cameras));
  const up = (w: CameraWorker) => w.stills?.grabber.up() ?? false;
  const send = (kind: 'still' | 'tile') => (req: Request, res: Response) => {
    const w = workerOf(res);
    const f = w.latestFrame();
    if (!f || !up(w)) return void res.status(404).json({ error: 'no_still', ts: f?.ts ?? null });
    const etag = `"${w.id}-${f.ts}"`;
    res.set({ ETag: etag, 'Cache-Control': 'no-cache', 'X-Still-Ts': String(f.ts) });
    if (req.get('if-none-match') === etag) return void res.status(304).end();
    res.type('image/jpeg').send(kind === 'still' ? f.still : f.tile);
  };
  r.get('/cameras/:cam/stills/latest.jpg', send('still'));
  r.get('/cameras/:cam/previews/latest.jpg', send('tile'));
  r.get('/stills/latest', (_req, res) => void res.json(d.cameras.list().map((w) => ({ cam: w.id, ts: w.latestFrame()?.ts ?? null, ...latestUrls(w.id), up: up(w) }))));
  return r;
}
