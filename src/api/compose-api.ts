import express, { type Request, type Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { clipById, listClips } from '../catalog/clips';
import type { Catalog } from '../catalog/db';
import type { Config } from '../config/defaults';
import { compositionWindow, composeMaxS, planComposition } from '../compose/plan';
import { SIZES, validTimeZone, type ComposeSize } from '../compose/ffmpeg';
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
    const b = (req.body ?? {}) as { clipId?: unknown; span?: unknown; preS?: unknown; postS?: unknown; size?: unknown; badge?: unknown; timeZone?: unknown };
    if (!Number.isSafeInteger(b.clipId) || typeof b.preS !== 'number' || typeof b.postS !== 'number' || typeof b.badge !== 'boolean' || typeof b.size !== 'string' || !(b.size in SIZES)) {
      return void res.status(400).json({ error: 'invalid', detail: 'clipId, preS, postS (seconds), size (sd, 360p, 720p, 1080p) and badge (true/false) are required' });
    }
    // The recording the viewer chose (cams: the SD-card file), when it isn't
    // the clip itself: the rolls apply to it (cams's dialog, 2026-10-04).
    const span = b.span === undefined ? undefined : spanOf(b.span);
    if (span === null) return void res.status(400).json({ error: 'invalid', detail: 'span is {start, end} in unix ms, start before end, at most a day apart' });
    // The viewer's zone for the cards' time (the pod runs in UTC).
    if (b.timeZone !== undefined && !(typeof b.timeZone === 'string' && validTimeZone(b.timeZone))) {
      return void res.status(400).json({ error: 'invalid', detail: 'timeZone must be an IANA zone such as America/Chicago' });
    }
    const row = clipById(d.catalog, b.clipId as number);
    if (!row || row.cam !== cam() || row.end_ts === null) return void res.status(404).json({ error: 'not_found' });
    if (d.paused()) return void res.status(503).json({ error: 'storage_paused' });
    const toSpan = (c: { id: number; start_ts: number; end_ts: number | null; path: string }) => ({ id: c.id, start: c.start_ts, end: c.end_ts ?? c.start_ts, path: c.path });
    const clip = toSpan(row);
    const maxS = composeMaxS(b.size);
    // The window first: the clips and stills it needs are listed for it.
    const w = compositionWindow(span ?? clip, b.preS, b.postS, maxS);
    if (!w.ok) return void res.status(400).json({ error: 'invalid', detail: w.error });
    // The still that shows at second t: the latest one within the stills
    // interval (stills every 2 s hold for 2 s instead of flickering to cards).
    const holdMs = d.config().stills.intervalS * 1000;
    const stills = d.stillsIn(w.start - holdMs, w.end).sort((x, y) => x - y);
    const stillAt = (t: number): number | null => {
      let lo = 0;
      let hi = stills.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (stills[mid] <= t) lo = mid + 1;
        else hi = mid;
      }
      const s = stills[lo - 1];
      return s !== undefined && t - s < holdMs ? s : null;
    };
    const plan = planComposition({
      clip, ...(span ? { span } : {}), preS: b.preS, postS: b.postS, maxS,
      clips: listClips(d.catalog, cam(), w.start, w.end).map(toSpan),
      stillAt,
    });
    if (!plan.ok) return void res.status(400).json({ error: 'invalid', detail: plan.error });
    if (!d.font && (b.badge || plan.segments.some((s) => s.kind === 'card'))) return void res.status(503).json({ error: 'no_font' });
    const job = d.composer.start({ cam: cam(), plan, size: b.size as ComposeSize, badge: b.badge, ...(typeof b.timeZone === 'string' ? { timeZone: b.timeZone } : {}) });
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

// {start, end} in unix ms, start before end, at most a day apart; null if not.
function spanOf(v: unknown): { start: number; end: number } | null {
  const o = (v ?? {}) as { start?: unknown; end?: unknown };
  if (typeof v !== 'object' || !Number.isSafeInteger(o.start) || !Number.isSafeInteger(o.end)) return null;
  const start = o.start as number, end = o.end as number;
  return end > start && end - start <= 86_400_000 ? { start, end } : null;
}

// Whether a clip file has an audio track (the camera may send none).
export async function hasAudio(path: string): Promise<boolean> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path], { timeout: 10_000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
