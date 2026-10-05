import { spawn } from 'child_process';
import { trackChild } from '../children';
import { randomBytes } from 'crypto';
import { setPriority } from 'os';
import { linkSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { within } from '../async';
import { logger } from '../log';
import { cardImageArgs, groupRuns, joinArgs, joinList, parseProgress, PIECE_MAX_BYTES, pieceArgs, runFrames, type ComposeSize } from './ffmpeg';
import type { Plan, Segment } from './plan';

// Composition jobs (spec 2026-09-28): one encoding at a time, up to 3
// waiting. A job nobody polls for 30 s (a closed tab) stops; a result lives
// 15 minutes. Each job has its own folder under `dir`.

type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
interface JobView { id: string; state: JobState; progress: number; durationS: number; error?: string }
// `asked`: the request as the client made it (the anchor and rolls), kept for
// the Archive's record of a composition (spec 2026-10-05-archive-design §2.1).
export interface ComposeRequest { cam: string; plan: Extract<Plan, { ok: true }>; size: ComposeSize; badge: boolean; timeZone?: string; asked?: Record<string, unknown> }
export interface Runner {
  (job: { dir: string; out: string; req: ComposeRequest; onProgress: (p: number) => void; signal: AbortSignal }): Promise<void>;
}

const MAX_BYTES = 200 * 1024 * 1024; // the spec's disk budget per job

// A failure with a reason people may read. Anything else (ffmpeg's own text
// can name server paths) is logged and reported as "the encoder failed".
export class ComposeError extends Error {}

interface Job extends JobView { cam: string; req: ComposeRequest; dir: string; out: string; seen: number; startedAt?: number; doneAt?: number; ctl: AbortController }

export function createComposer(o: { dir: string; runner: Runner; now?: () => number; doneTtlMs?: number; idleMs?: number; maxQueued?: number; maxRunMs?: number }) {
  const now = o.now ?? Date.now;
  const doneTtl = o.doneTtlMs ?? 15 * 60_000;
  const idle = o.idleMs ?? 30_000;
  const maxQueued = o.maxQueued ?? 3;
  // An open modal keeps polling: a hung encode would hold the encoder for ever.
  // 10 minutes: the longest results (300 s at SD, 120 s at 1080p) take about
  // 3 minutes on a Pi 4 (estimated, plan.ts), so this leaves a margin.
  const maxRun = o.maxRunMs ?? 10 * 60_000;
  mkdirSync(o.dir, { recursive: true });
  for (const f of readdirSync(o.dir)) rmSync(join(o.dir, f), { recursive: true, force: true });
  const jobs = new Map<string, Job>();
  let running: Job | undefined;
  let runningDone: Promise<unknown> | undefined; // stop() waits for it
  let stopped = false;

  const view = (j: Job): JobView => ({ id: j.id, state: j.state, progress: j.progress, durationS: j.durationS, ...(j.error ? { error: j.error } : {}) });
  // A running job's folder goes when its encoder has ended (ffmpeg takes up
  // to 2 s after the abort and still writes there).
  const drop = (j: Job) => {
    jobs.delete(j.id);
    if (j !== running) rmSync(j.dir, { recursive: true, force: true });
  };
  const next = () => {
    if (running || stopped) return;
    const j = [...jobs.values()].find((x) => x.state === 'queued');
    if (!j) return;
    running = j;
    j.state = 'running';
    j.startedAt = now();
    runningDone = o.runner({ dir: j.dir, out: j.out, req: j.req, signal: j.ctl.signal, onProgress: (p) => { if (j.state === 'running') j.progress = Math.max(j.progress, Math.min(1, p)); } })
      .then(() => {
        if (j.state !== 'running') return;
        j.state = 'done';
        j.progress = 1;
        j.doneAt = now();
      })
      .catch((err: Error) => {
        if (j.state !== 'running') return;
        j.state = 'failed';
        if (!(err instanceof ComposeError)) logger.warn({ err: err.message }, 'composition_failed');
        j.error = err instanceof ComposeError ? err.message : 'the encoder failed';
        j.doneAt = now();
      })
      .finally(() => {
        running = undefined;
        if (!jobs.has(j.id)) rmSync(j.dir, { recursive: true, force: true });
        next();
      });
  };

  return {
    start(req: ComposeRequest): JobView | 'busy' {
      if ([...jobs.values()].filter((j) => j.state === 'queued').length >= maxQueued) return 'busy';
      const id = randomBytes(16).toString('base64url');
      const dir = join(o.dir, id);
      mkdirSync(dir);
      const j: Job = { id, cam: req.cam, req, dir, out: join(dir, 'out.mp4'), state: 'queued', progress: 0, durationS: req.plan.durationS, seen: now(), ctl: new AbortController() };
      jobs.set(id, j);
      next();
      return view(j);
    },
    get(cam: string, id: string): JobView | undefined {
      const j = jobs.get(id);
      if (!j || j.cam !== cam) return undefined;
      j.seen = now();
      if (j.state === 'done') j.doneAt = j.seen; // a result being looked at stays
      return view(j);
    },
    file(cam: string, id: string): string | undefined {
      const j = jobs.get(id);
      return j && j.cam === cam && j.state === 'done' ? j.out : undefined;
    },
    // A job's request (any state), or undefined. Looking counts as a poll.
    request(cam: string, id: string): ComposeRequest | undefined {
      const j = jobs.get(id);
      if (!j || j.cam !== cam) return undefined;
      j.seen = now();
      if (j.state === 'done') j.doneAt = j.seen;
      return j.req;
    },
    cancel(cam: string, id: string): boolean {
      const j = jobs.get(id);
      if (!j || j.cam !== cam) return false;
      j.state = 'cancelled';
      j.ctl.abort();
      drop(j);
      return true;
    },
    sweep(): void {
      const t = now();
      for (const j of [...jobs.values()]) {
        if (j.state === 'running' && j.startedAt !== undefined && t - j.startedAt > maxRun) {
          j.state = 'failed';
          j.error = `took longer than ${Math.round(maxRun / 60_000)} minutes`;
          j.doneAt = t;
          j.ctl.abort();
          continue;
        }
        const live = j.state === 'queued' || j.state === 'running';
        if ((live && t - j.seen > idle) || (!live && j.doneAt !== undefined && t - j.doneAt > doneTtl)) {
          j.state = 'cancelled';
          j.ctl.abort();
          drop(j);
        }
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      for (const j of [...jobs.values()]) j.ctl.abort();
      // Let a running ffmpeg end (it's killed within 2 s) before its folder goes.
      if (runningDone) await within(runningDone.catch(() => {}), 3000);
      for (const j of [...jobs.values()]) drop(j);
    },
  };
}

// ffmpeg's niceness (review of #140): a 300 s composition encodes for
// minutes on a Pi 4, and must not starve the stills grabber, the stream or
// the API. os.setPriority works on Linux and macOS without a `nice` binary.
export const FFMPEG_NICE = 10;
export function lowerPriority(pid: number | undefined, set: (pid: number, prio: number) => void = setPriority): boolean {
  if (pid === undefined) return false;
  try {
    set(pid, FFMPEG_NICE);
    return true;
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'composition_nice_failed');
    return false;
  }
}

// One ffmpeg process at FFMPEG_NICE: SIGTERM on cancel, SIGKILL 2 s later if
// it lingers.
export function runFfmpeg(args: string[], signal: AbortSignal, onStdout: (text: string) => void, lower: (pid: number | undefined) => boolean = lowerPriority): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new ComposeError('cancelled'));
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    trackChild(p);
    lower(p.pid);
    let err = '';
    p.stdout.on('data', (b: Buffer) => onStdout(b.toString()));
    p.stderr.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-2000); });
    const kill = () => {
      p.kill('SIGTERM');
      setTimeout(() => p.kill('SIGKILL'), 2000).unref();
    };
    signal.addEventListener('abort', kill, { once: true });
    p.on('error', reject);
    p.on('close', (code) => {
      signal.removeEventListener('abort', kill);
      if (signal.aborted) reject(new ComposeError('cancelled'));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').pop() ?? ''}`));
    });
  });
}

// The real runner (final review C1): stills written once and hard-linked
// into numbered runs, then one small encode per piece, one after another,
// then a join without encoding again. Checks for a cancel between steps.
export function ffmpegRunner(o: { font: string; clock: (ts: number, timeZone?: string) => string; readStill: (cam: string, ts: number) => Promise<Buffer | undefined>; hasAudio: (path: string) => Promise<boolean>; paused?: () => boolean; stillsIntervalS?: (cam: string) => number; pieceMaxBytes?: number }): Runner {
  const pieceMax = o.pieceMaxBytes ?? PIECE_MAX_BYTES;
  return async ({ dir, out, req, onProgress, signal }) => {
    const check = () => {
      if (signal.aborted) throw new ComposeError('cancelled');
    };
    // Storage paused since the job was queued: no writing.
    if (o.paused?.()) throw new ComposeError('storage is paused');
    const segments: (Segment & { audio?: boolean })[] = [];
    for (const s of req.plan.segments) {
      check();
      if (s.kind === 'still') {
        const jpeg = await o.readStill(req.cam, s.ts);
        if (jpeg) {
          writeFileSync(join(dir, `still-${s.ts}.jpg`), jpeg);
          segments.push(s);
        } else {
          segments.push({ kind: 'card', ts: s.ts }); // gone since planning
        }
      } else if (s.kind === 'clip') {
        segments.push({ ...s, audio: await o.hasAudio(s.path) });
      } else {
        segments.push(s);
      }
    }
    const card = join(dir, 'card.jpg');
    if (segments.some((s) => s.kind === 'card')) await runFfmpeg(cardImageArgs(req.size, card), signal, () => {});
    let k = 0;
    for (const g of groupRuns(segments)) {
      if (g.kind !== 'run') continue;
      for (const f of runFrames(g.seconds, k)) linkSync(f.kind === 'still' ? join(dir, `still-${f.ts}.jpg`) : card, join(dir, f.file));
      k++;
    }
    const pieces = pieceArgs({ segments, runFile: (n) => join(dir, `run-${n}-%04d.jpg`), pieceFile: (n) => join(dir, `piece-${n}.mp4`), size: req.size, badge: req.badge, font: o.font, clock: (ts) => o.clock(ts, req.timeZone), stillsIntervalS: o.stillsIntervalS?.(req.cam) ?? 1, maxBytes: pieceMax });
    const total = pieces.reduce((a, p) => a + p.durationS, 0);
    let done = 0;
    for (const p of pieces) {
      check();
      await runFfmpeg(p.args, signal, (text) => {
        const v = parseProgress(text, p.durationS);
        if (v !== null) onProgress(Math.min(0.99, (done + v * p.durationS) / total));
      });
      // -fs stopped writing at the cap: the piece is cut short.
      if (statSync(p.out).size >= pieceMax) throw new ComposeError(`a part of the clip reached the size limit (${Math.round(pieceMax / 1e6)} MB)`);
      done += p.durationS;
    }
    check();
    const list = join(dir, 'pieces.txt');
    writeFileSync(list, joinList(pieces.map((p) => p.out)));
    await runFfmpeg(joinArgs(list, out), signal, () => {});
    // The spec's per-job disk budget (a 300 s SD result is about 40 MB, a
    // 120 s 1080p one about 50 MB).
    if (statSync(out).size > MAX_BYTES) throw new ComposeError('the result is larger than 200 MB');
    onProgress(1);
  };
}
