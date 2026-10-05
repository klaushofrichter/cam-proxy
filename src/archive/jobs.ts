import { randomBytes } from 'crypto';
import { renameSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { crc32 } from 'zlib';
import type { ArchiveRow } from '../catalog/archive';
import { logger } from '../log';
import { itemJson, metadataJson, type ArchiveItem } from './json';
import { chooseThumbnail, type Taken, type ThumbDeps } from './metadata';
import { ArchiveJobError, copyWithCrc, type JobErrorCode, type Obtain } from './sources';
import type { ArchiveStore } from './store';

// Archive jobs (spec 2026-10-05-archive-design §2.2, ruling 2): obtain the
// file (a fetch for an SD recording), copy it with its CRC into a staged
// folder, then the thumbnail, the metadata snapshot, the row and the
// folder's rename. A job runs to its end without polling; DELETE cancels.
// At most MAX_JOBS in flight; a finished job is kept KEEP_MS.

export const MAX_JOBS = 4;
const KEEP_MS = 15 * 60_000;
export const SPARE_BYTES = 2 ** 20; // the thumbnail and the metadata (ruling 5)

type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
type Phase = 'fetching' | 'copying' | 'finishing' | null;
export interface JobView {
  id: string;
  cam: string;
  state: JobState;
  phase: Phase;
  progress: number;
  bytes: number;
  size: number;
  archiveId?: number;
  item?: ArchiveItem;
  error?: JobErrorCode;
  detail?: string;
}

// What the API resolved from a request: everything but the file.
export interface ArchiveRequest {
  cam: string;
  source: Record<string, unknown>; // the item's `source`
  kind: 'composition' | 'clip' | 'recording';
  window: { from: number; to: number };
  quality: string;
  original: boolean;
  size: number; // the file's size, known up front
  durationS: number; // the window's length: used when ffprobe can't tell
  obtain: Obtain;
  name?: string; // else the default name
  labels: string[];
  retentionDays: number | null;
  thumbnailAt?: number;
  createdBy: 'client' | 'admin';
}

export interface JobDeps {
  store: ArchiveStore;
  now?: () => number;
  // Throws ArchiveJobError('insufficient_space', …, {needed, free, minFreeBytes, inFlight}) when
  // it won't fit beside what the other jobs in flight still write (`jobId`: this job, not counted).
  checkSpace: (bytes: number, jobId: string) => void;
  snapshot: (window: { from: number; to: number }) => Taken;
  thumbDeps: (clipPath: string) => ThumbDeps;
  duration: (clipPath: string) => Promise<number | null>;
  defaultName: (from: number) => string;
  onDone: (row: ArchiveRow, req: ArchiveRequest, job: JobView) => void;
  onFailed: (req: ArchiveRequest, job: JobView) => void;
}

// The HTTP status a create answers with the job's view (docs/archive.md
// §2): 201 done, 202 still running, else its error's status.
const FAILED_STATUS: Record<JobErrorCode, number> = { insufficient_space: 507, camera_offline: 503, unknown_recording: 404, source_gone: 404, fetch_failed: 502, store_failed: 500, cancelled: 409 };
export function createStatus(v: JobView): number {
  if (v.state === 'done') return 201;
  if (v.state === 'queued' || v.state === 'running') return 202;
  return FAILED_STATUS[v.error ?? 'store_failed'] ?? 500;
}

interface Job { view: JobView; req: ArchiveRequest; ctl: AbortController; endedAt?: number; done: Promise<void> }

const round1 = (n: number) => Math.round(n * 10) / 10;

export class ArchiveJobs {
  private readonly jobs = new Map<string, Job>();
  private stopped = false;
  constructor(private readonly d: JobDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private inFlight(): number {
    return [...this.jobs.values()].filter((j) => j.view.state === 'queued' || j.view.state === 'running').length;
  }

  private view(j: Job): JobView {
    return { ...j.view };
  }

  start(req: ArchiveRequest): JobView | 'busy' {
    if (this.stopped || this.inFlight() >= MAX_JOBS) return 'busy';
    const id = randomBytes(16).toString('base64url');
    const view: JobView = { id, cam: req.cam, state: 'running', phase: req.kind === 'recording' ? 'fetching' : 'copying', progress: 0, bytes: 0, size: req.size };
    const j: Job = { view, req, ctl: new AbortController(), done: Promise.resolve() };
    this.jobs.set(id, j);
    j.done = this.run(j);
    return this.view(j);
  }

  // What the jobs in flight (but `except`) still have to write: their size
  // and the spare, less what they wrote (review of #159: four jobs that each
  // fit alone must not together pass storage.minFreeBytes).
  pendingBytes(except?: string): number {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.view.id === except || (j.view.state !== 'queued' && j.view.state !== 'running')) continue;
      n += Math.max(0, j.view.size + SPARE_BYTES - j.view.bytes);
    }
    return n;
  }

  get(id: string): JobView | undefined {
    const j = this.jobs.get(id);
    return j && this.view(j);
  }

  // The view once the job ended, or after `ms`, whichever is first.
  async wait(id: string, ms: number): Promise<JobView | undefined> {
    const j = this.jobs.get(id);
    if (!j) return undefined;
    let t: NodeJS.Timeout | undefined;
    await Promise.race([j.done, new Promise<void>((r) => (t = setTimeout(r, ms)))]);
    clearTimeout(t);
    return this.view(j);
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j) return false;
    if (j.view.state === 'running' || j.view.state === 'queued') j.ctl.abort();
    else this.jobs.delete(id);
    return true;
  }

  // Finished jobs go after KEEP_MS.
  sweep(): void {
    const t = this.now();
    for (const [id, j] of this.jobs) if (j.endedAt !== undefined && t - j.endedAt > KEEP_MS) this.jobs.delete(id);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const j of this.jobs.values()) j.ctl.abort();
    await Promise.all([...this.jobs.values()].map((j) => j.done));
  }

  private async run(j: Job): Promise<void> {
    const { req, view, ctl } = j;
    const signal = ctl.signal;
    let staged: string | null = null;
    const check = () => {
      if (signal.aborted) throw new ArchiveJobError('cancelled', 'cancelled');
    };
    try {
      await Promise.resolve(); // start() answers first
      check();
      this.d.checkSpace(req.size, view.id);
      staged = this.d.store.stage();
      const clip = join(staged, 'clip.mp4');
      const got = await req.obtain({ dir: staged, signal, progress: (b) => this.progress(view, b, req.kind === 'recording' ? 0.9 : 0.95) });
      let file: { bytes: number; crc32: number };
      try {
        check();
        if (got.crc32 !== undefined && got.path.startsWith(staged)) {
          // The fetch streamed into the job's own file: no second copy.
          renameSync(got.path, clip);
          file = { bytes: statSync(clip).size, crc32: got.crc32 };
        } else {
          view.phase = 'copying';
          view.bytes = 0;
          this.d.checkSpace(req.size, view.id); // again: the fetch may have taken minutes
          file = await copyWithCrc(got.path, clip, signal, (b) => this.progress(view, b, 0.95));
        }
      } finally {
        got.release();
      }
      check();
      view.phase = 'finishing';
      const duration = await this.d.duration(clip).catch(() => null);
      const taken = this.d.snapshot(req.window);
      const thumb = await chooseThumbnail(this.d.thumbDeps(clip), taken, req.thumbnailAt);
      let thumbFile: { bytes: number; crc32: number } | null = null;
      if (thumb.jpeg) {
        writeFileSync(join(staged, 'thumb.jpg'), thumb.jpeg);
        thumbFile = { bytes: thumb.jpeg.length, crc32: crc32(thumb.jpeg) };
      }
      check();
      const row = this.d.store.commit(staged, {
        cam: req.cam,
        name: req.name ?? this.d.defaultName(req.window.from),
        labels: req.labels,
        retention_days: req.retentionDays,
        created_at: this.now(),
        recorded_from: req.window.from,
        recorded_to: req.window.to,
        quality: req.quality,
        original: req.original ? 1 : 0,
        duration_s: round1(duration ?? req.durationS),
        bytes: file.bytes,
        files: JSON.stringify({ clip: file, thumb: thumbFile }),
        source: JSON.stringify(req.source),
        thumb_from: thumb.from,
        thumb_at: thumb.at,
        created_by: req.createdBy,
        metadata: JSON.stringify(taken.snapshot),
      }, (r) => JSON.stringify(metadataJson(r), null, 2));
      staged = null;
      Object.assign(view, { state: 'done', phase: null, progress: 1, bytes: file.bytes, archiveId: row.id, item: itemJson(row) });
      j.endedAt = this.now();
      this.safe(() => this.d.onDone(row, req, this.view(j)));
    } catch (err) {
      if (staged) this.d.store.discard(staged);
      const e = err instanceof ArchiveJobError ? err : storeFailed(err);
      Object.assign(view, { state: e.code === 'cancelled' ? 'cancelled' : 'failed', phase: null, error: e.code, detail: e.message });
      j.endedAt = this.now();
      this.safe(() => this.d.onFailed(req, this.view(j)));
    }
  }

  private progress(view: JobView, bytes: number, share: number): void {
    view.bytes = bytes;
    view.progress = view.size > 0 ? Math.min(share, (bytes / view.size) * share) : 0;
  }

  private safe(f: () => void): void {
    try {
      f();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'archive_job_report_failed');
    }
  }
}

function storeFailed(err: unknown): ArchiveJobError {
  if ((err as NodeJS.ErrnoException).code === 'ENOSPC') return new ArchiveJobError('insufficient_space', 'the disk is full');
  logger.warn({ err: (err as Error).message }, 'archive_job_failed');
  return new ArchiveJobError('store_failed', 'the clip could not be stored');
}
