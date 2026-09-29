import express, { type Request, type Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { clipById, listClips } from '../catalog/clips';
import type { Catalog } from '../catalog/db';
import type { Config } from '../config/defaults';
import { planComposition } from '../compose/plan';
import { SIZES, type ComposeSize } from '../compose/ffmpeg';
import type { createComposer } from '../compose/jobs';

const run = promisify(execFile);

// Composed clips (spec 2026-09-28): start, poll, fetch, cancel. The planner
// decides each second's source from the catalog and the stills store.
export function composeApi(d: {
  config: () => Config;
  catalog: Catalog;
  composer: ReturnType<typeof createComposer>;
  stillsIn: (from: number, to: number) => number[];
  paused: () => boolean;
  font: string | null;
}): express.Router {
  const r = express.Router();
  const cam = () => d.config().camera.id;
  const known = (req: Request, res: Response) => (req.params.cam === cam() ? true : (res.status(404).json({ error: 'not_found' }), false));

  r.post('/cameras/:cam/compositions', (req, res) => {
    if (!known(req, res)) return;
    const b = (req.body ?? {}) as { clipId?: unknown; preS?: unknown; postS?: unknown; size?: unknown; badge?: unknown };
    if (!Number.isSafeInteger(b.clipId) || typeof b.preS !== 'number' || typeof b.postS !== 'number' || typeof b.badge !== 'boolean' || typeof b.size !== 'string' || !(b.size in SIZES)) {
      return void res.status(400).json({ error: 'invalid', detail: 'clipId, preS, postS (seconds), size (sd, 360p, 720p, 1080p) and badge (true/false) are required' });
    }
    const row = clipById(d.catalog, b.clipId as number);
    if (!row || row.cam !== cam() || row.end_ts === null) return void res.status(404).json({ error: 'not_found' });
    if (d.paused()) return void res.status(503).json({ error: 'storage_paused' });
    const span = (c: { id: number; start_ts: number; end_ts: number | null; path: string }) => ({ id: c.id, start: c.start_ts, end: c.end_ts ?? c.start_ts, path: c.path });
    const from = row.start_ts - 600_000, to = row.end_ts + 60_000;
    const stills = new Set(d.stillsIn(from, to));
    const plan = planComposition({
      clip: span(row), preS: b.preS, postS: b.postS,
      clips: listClips(d.catalog, cam(), from, to).map(span),
      hasStill: (t) => stills.has(Math.floor(t / 1000) * 1000),
    });
    if (!plan.ok) return void res.status(400).json({ error: 'invalid', detail: plan.error });
    if (!d.font && (b.badge || plan.segments.some((s) => s.kind === 'card'))) return void res.status(503).json({ error: 'no_font' });
    const job = d.composer.start({ cam: cam(), plan, size: b.size as ComposeSize, badge: b.badge });
    if (job === 'busy') return void res.status(429).json({ error: 'busy' });
    res.status(201).json(job);
  });

  r.get('/cameras/:cam/compositions/:file', (req, res) => {
    if (!known(req, res)) return;
    const m = /^([A-Za-z0-9_-]{22})(\.mp4)?$/.exec(String(req.params.file));
    if (!m) return void res.status(404).json({ error: 'not_found' });
    const job = d.composer.get(cam(), m[1]);
    if (!job) return void res.status(404).json({ error: 'not_found' });
    if (!m[2]) return void res.json(job);
    const file = d.composer.file(cam(), m[1]);
    if (!file) return void res.status(409).json({ error: 'not_ready' });
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(file, { headers: { 'Content-Type': 'video/mp4' }, acceptRanges: true });
  });

  r.delete('/cameras/:cam/compositions/:id', (req, res) => {
    if (!known(req, res)) return;
    if (!d.composer.cancel(cam(), String(req.params.id))) return void res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });
  return r;
}

// Whether a clip file has an audio track (the camera may send none).
export async function hasAudio(path: string): Promise<boolean> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
