import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { clipById, listClips } from '../catalog/clips';
import type { Catalog } from '../catalog/db';
import type { Config } from '../config/defaults';
import { compositionWindow, composeMaxS, planComposition, planSeconds, type ClipSpan, type Window } from '../compose/plan';
import { SIZES, validTimeZone, type ComposeSize } from '../compose/ffmpeg';
import type { createComposer } from '../compose/jobs';
import type { AuditLog } from '../audit/audit-log';
import { DAY, dayStart } from '../time-units';
import { clientIp } from './auth';

const run = promisify(execFile);
export const COMPOSITIONS_PER_MINUTE = 10;
type Body = { clipId?: unknown; at?: unknown; span?: unknown; preS?: unknown; postS?: unknown; size?: unknown; badge?: unknown; timeZone?: unknown; dryRun?: unknown };
type Checked = { b: Body & { preS: number; postS: number }; clip?: ClipSpan; span?: { start: number; end: number }; maxS: number; w: Extract<Window, { ok: true }> };
type Outcome = 'started' | 'busy' | 'nothing_to_compose' | 'storage_paused' | 'no_font';
const bad = (res: Response, detail: string) => void res.status(400).json({ error: 'invalid', detail });
const toSpan = (c: { id: number; start_ts: number; end_ts: number | null; path: string }): ClipSpan => ({ id: c.id, start: c.start_ts, end: c.end_ts ?? c.start_ts, path: c.path });

// Composed clips (spec 2026-09-28): start, poll, fetch, cancel. The planner
// decides each second's source from the catalog and the stills store.
export function composeApi(d: {
  config: () => Config;
  catalog: Catalog;
  composer: ReturnType<typeof createComposer>;
  stillsIn: (from: number, to: number) => number[];
  paused: () => boolean;
  font: string | null;
  audit: AuditLog;
}): express.Router {
  const r = express.Router();
  const cam = () => d.config().camera.id;
  const known = (req: Request, res: Response) => (req.params.cam === cam() ? true : (res.status(404).json({ error: 'not_found' }), false));

  // The request, checked before anything is planned (spec 2026-10-04-still-
  // checks-design §13): one anchor, a clip (`clipId`, `span?`) or a second
  // (`at`); the window from compositionWindow; a 400 or 404 writes nothing.
  const validate = (req: Request, res: Response, next: NextFunction) => {
    if (!known(req, res)) return;
    const b = (req.body ?? {}) as Body;
    if (typeof b.preS !== 'number' || typeof b.postS !== 'number' || typeof b.badge !== 'boolean' || typeof b.size !== 'string' || !(b.size in SIZES)) {
      return bad(res, 'clipId or at, preS, postS (seconds), size (sd, 360p, 720p, 1080p) and badge (true/false) are required');
    }
    if ((b.clipId === undefined) === (b.at === undefined)) return bad(res, 'exactly one of clipId (a clip) or at (a second, unix ms)');
    if (b.dryRun !== undefined && typeof b.dryRun !== 'boolean') return bad(res, 'dryRun is true or false');
    // The viewer's zone for the cards' time (the pod runs in UTC).
    if (b.timeZone !== undefined && !(typeof b.timeZone === 'string' && validTimeZone(b.timeZone))) {
      return bad(res, 'timeZone must be an IANA zone such as America/Chicago');
    }
    const now = Date.now();
    let clip: ClipSpan | undefined;
    let span: { start: number; end: number } | undefined;
    if (b.at !== undefined) {
      // A second, checked like a still check's `at` (ruling 39).
      const at = b.at;
      if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return bad(res, 'at is a whole number (unix ms)');
      if (at % 1000 !== 0) return bad(res, 'at is a whole second');
      if (at > now) return bad(res, 'at is in the future');
      const days = Math.max(d.config().retention.stillsDays, d.config().retention.clipsDays);
      if (at < dayStart(now - days * DAY)) return bad(res, `at is older than the stills and clips kept (${days} days)`);
      if (b.span !== undefined) return bad(res, 'span goes with clipId, not with at');
      // Nothing to cut around a second (ruling 40).
      if (![b.preS, b.postS].every((v) => Number.isInteger(v) && v >= 0 && v <= 3600)) return bad(res, 'around a second, pre-roll and post-roll are whole seconds from 0 to 3600');
      span = { start: at, end: at + 1000 };
    } else {
      if (!Number.isSafeInteger(b.clipId)) return bad(res, 'clipId is a whole number');
      // The recording the viewer chose (cams: the SD-card file), when it isn't
      // the clip itself: the rolls apply to it (cams's dialog, 2026-10-04).
      const chosen = b.span === undefined ? undefined : spanOf(b.span);
      if (chosen === null) return bad(res, 'span is {start, end} in unix ms, start before end, at most a day apart');
      const row = clipById(d.catalog, b.clipId as number);
      if (!row || row.cam !== cam() || row.end_ts === null) return void res.status(404).json({ error: 'not_found' });
      clip = toSpan(row);
      // The span is the recording this clip is a copy of: it must overlap the
      // clip by at least 1 s (the same 1 s as "at least 1 s must remain"), so
      // a clip id can't be used to compose another time of day.
      if (chosen && Math.min(chosen.end, clip.end) - Math.max(chosen.start, clip.start) < 1000) return bad(res, 'span must overlap the clip by at least 1 s');
      span = chosen;
    }
    const maxS = composeMaxS(b.size);
    const w = compositionWindow(span ?? clip!, b.preS, b.postS, maxS);
    if (!w.ok) return bad(res, w.error);
    // The seconds after now have no still yet (ruling 41).
    if (b.at !== undefined && w.end > now) return bad(res, `the window ends in the future (${Math.ceil((w.end - now) / 1000)} s from now)`);
    res.locals.compose = { b: b as Checked['b'], clip, span, maxS, w } satisfies Checked;
    next();
  };
  // Real requests past the input check, per client (ruling 45); dry runs
  // only count in the general limiter.
  const limiter = rateLimit({
    windowMs: 60_000, limit: COMPOSITIONS_PER_MINUTE, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited' },
    skip: (_req, res) => (res.locals.compose as Checked | undefined)?.b.dryRun === true,
  });

  r.post('/cameras/:cam/compositions', validate, limiter, (req, res) => {
    const { b, clip, span, maxS, w } = res.locals.compose as Checked;
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
    const clips = listClips(d.catalog, cam(), w.start, w.end).map(toSpan);
    const plan = planComposition({ ...(clip ? { clip } : {}), ...(span ? { span } : {}), preS: b.preS, postS: b.postS, maxS, clips, stillAt });
    if (!plan.ok) return bad(res, plan.error);
    const seconds = planSeconds(plan);
    const access = res.locals.access as { access?: string; viaCookie?: boolean } | undefined;
    const audit = (outcome: Outcome, jobId: string | null = null) => {
      if (b.dryRun) return;
      const anchor = b.at !== undefined ? { anchor: 'at', at: b.at } : { anchor: 'clip', clipId: b.clipId };
      const what = b.at !== undefined ? `around ${new Date(b.at as number).toISOString()}` : `of clip ${String(b.clipId)}`;
      d.audit.write({
        action: 'composition', category: ['host'], type: ['access'], outcome: outcome === 'started' ? 'success' : 'failure',
        user: access?.access === 'admin' ? 'admin' : 'client', ip: clientIp(req), userAgent: req.get('user-agent'),
        message: `Composition ${what} (${plan.durationS} s, ${b.size as string}): ${outcome === 'started' ? 'started' : `refused: ${outcome}`}`,
        ...(outcome !== 'started' ? { error: outcome } : {}),
        details: { ...anchor, from: plan.start, to: plan.end, durationS: plan.durationS, size: b.size, seconds, outcome, jobId, requestedBy: access?.viaCookie ? 'session' : 'token' },
      });
    };
    // Only cards: a video of "No recording" helps nobody (ruling 42).
    if (seconds.clip === 0 && seconds.still === 0) {
      audit('nothing_to_compose');
      return void res.status(409).json({ error: 'nothing_to_compose', detail: 'no clip or still covers any second of this window' });
    }
    if (b.dryRun) {
      const used = new Set(plan.segments.flatMap((x) => (x.kind === 'clip' ? [x.clipId] : [])));
      return void res.json({ start: plan.start, end: plan.end, durationS: plan.durationS, seconds, clips: clips.filter((c) => used.has(c.id)).map((c) => ({ start: c.start, end: c.end })) });
    }
    if (d.paused()) {
      audit('storage_paused');
      return void res.status(503).json({ error: 'storage_paused' });
    }
    if (!d.font && (b.badge || plan.segments.some((x) => x.kind === 'card'))) {
      audit('no_font');
      return void res.status(503).json({ error: 'no_font' });
    }
    const job = d.composer.start({ cam: cam(), plan, size: b.size as ComposeSize, badge: b.badge as boolean, ...(typeof b.timeZone === 'string' ? { timeZone: b.timeZone } : {}) });
    if (job === 'busy') {
      audit('busy');
      return void res.status(429).json({ error: 'busy' });
    }
    audit('started', job.id);
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
