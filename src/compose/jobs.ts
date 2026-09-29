import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildComposeArgs, parseProgress, type ComposeSize } from './ffmpeg';
import type { Plan } from './plan';

// Composition jobs (spec 2026-09-28): one encoding at a time, up to 3
// waiting. A job nobody polls for 30 s (a closed tab) stops; a result lives
// 15 minutes. Each job has its own folder under `dir`.

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export interface JobView { id: string; state: JobState; progress: number; durationS: number; error?: string }
export interface ComposeRequest { cam: string; plan: Extract<Plan, { ok: true }>; size: ComposeSize; badge: boolean }
export interface Runner {
  (job: { dir: string; out: string; req: ComposeRequest; onProgress: (p: number) => void; signal: AbortSignal }): Promise<void>;
}

const MAX_BYTES = 200 * 1024 * 1024; // the spec's disk budget per job

interface Job extends JobView { cam: string; req: ComposeRequest; dir: string; out: string; seen: number; doneAt?: number; ctl: AbortController }

export function createComposer(o: { dir: string; runner: Runner; now?: () => number; doneTtlMs?: number; idleMs?: number; maxQueued?: number }) {
  const now = o.now ?? Date.now;
  const doneTtl = o.doneTtlMs ?? 15 * 60_000;
  const idle = o.idleMs ?? 30_000;
  const maxQueued = o.maxQueued ?? 3;
  mkdirSync(o.dir, { recursive: true });
  for (const f of readdirSync(o.dir)) rmSync(join(o.dir, f), { recursive: true, force: true });
  const jobs = new Map<string, Job>();
  let running: Job | undefined;
  let stopped = false;

  const view = (j: Job): JobView => ({ id: j.id, state: j.state, progress: j.progress, durationS: j.durationS, ...(j.error ? { error: j.error } : {}) });
  const drop = (j: Job) => {
    jobs.delete(j.id);
    rmSync(j.dir, { recursive: true, force: true });
  };
  const next = () => {
    if (running || stopped) return;
    const j = [...jobs.values()].find((x) => x.state === 'queued');
    if (!j) return;
    running = j;
    j.state = 'running';
    o.runner({ dir: j.dir, out: j.out, req: j.req, signal: j.ctl.signal, onProgress: (p) => { if (j.state === 'running') j.progress = Math.max(j.progress, Math.min(1, p)); } })
      .then(() => {
        if (j.state !== 'running') return;
        j.state = 'done';
        j.progress = 1;
        j.doneAt = now();
      })
      .catch((err: Error) => {
        if (j.state !== 'running') return;
        j.state = 'failed';
        j.error = err.message;
        j.doneAt = now();
      })
      .finally(() => {
        running = undefined;
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
      return view(j);
    },
    file(cam: string, id: string): string | undefined {
      const j = jobs.get(id);
      return j && j.cam === cam && j.state === 'done' ? j.out : undefined;
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
      for (const j of [...jobs.values()]) {
        j.ctl.abort();
        drop(j);
      }
    },
  };
}

// The real runner: stills written as JPEGs in the job folder, then one ffmpeg.
export function ffmpegRunner(o: { font: string; clock: (ts: number) => string; readStill: (ts: number) => Promise<Buffer | undefined>; hasAudio: (path: string) => Promise<boolean> }): Runner {
  return async ({ dir, out, req, onProgress, signal }) => {
    const segments = [];
    for (const s of req.plan.segments) {
      if (s.kind === 'still') {
        const jpeg = await o.readStill(s.ts);
        if (jpeg) {
          writeFileSync(join(dir, `${s.ts}.jpg`), jpeg);
          segments.push(s);
        } else {
          segments.push({ kind: 'card' as const, ts: s.ts }); // gone since planning
        }
      } else if (s.kind === 'clip') {
        segments.push({ ...s, audio: await o.hasAudio(s.path) });
      } else {
        segments.push(s);
      }
    }
    const args = buildComposeArgs({ segments, stillFile: (ts) => join(dir, `${ts}.jpg`), size: req.size, badge: req.badge, font: o.font, clock: o.clock, out });
    await new Promise<void>((resolve, reject) => {
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      p.stdout.on('data', (b: Buffer) => {
        const v = parseProgress(b.toString(), req.plan.durationS);
        if (v !== null) onProgress(v);
      });
      p.stderr.on('data', (b: Buffer) => { err = (err + b.toString()).slice(-2000); });
      const kill = () => {
        p.kill('SIGTERM');
        setTimeout(() => p.kill('SIGKILL'), 2000).unref();
      };
      signal.addEventListener('abort', kill, { once: true });
      p.on('error', reject);
      p.on('close', (code) => {
        signal.removeEventListener('abort', kill);
        if (signal.aborted) reject(new Error('cancelled'));
        else if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').pop() ?? ''}`));
      });
    });
    // The spec's per-job disk budget (a 60 s 1080p result is far below it).
    if (statSync(out).size > MAX_BYTES) throw new Error('the result is larger than 200 MB');
  };
}
