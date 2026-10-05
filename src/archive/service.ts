import type { AuditLog } from '../audit/audit-log';
import type { TimeInfo } from '../camera/time';
import { allArchive, archiveById, archiveLabelCounts, archiveTotals, countExpiringBy, expiredArchive, updateArchive, type ArchiveRow } from '../catalog/archive';
import type { Catalog } from '../catalog/db';
import type { Config } from '../config/defaults';
import { logger } from '../log';
import type { StreamLog } from '../stream/log';
import { readFile } from 'fs/promises';
import { resolve, sep } from 'path';
import { ArchiveCleanup, type CleanupResult } from './cleanup';
import { ArchiveJobs, round1, SPARE_BYTES, type ArchiveRequest, type JobView } from './jobs';
import { itemJson, metadataJson } from './json';
import { firstFrame, probeDuration } from './media';
import { takeSnapshot, type ThumbDeps } from './metadata';
import { defaultName, PREDEFINED_LABELS } from './rules';
import { ArchiveJobError } from './sources';
import { ArchiveStore } from './store';

// The Archive (spec 2026-10-05-archive-design): the store, the jobs, the
// daily cleanup, and every change's audit record and stream message. The
// API resolves requests; this holds the rules that don't depend on HTTP.

// Who made a change, for its audit record (ruling 8).
export interface Who { user: 'client' | 'admin' | 'system'; ip?: string; userAgent?: string; requestedBy?: 'token' | 'session'; onBehalfOf?: string }
export type Action = 'add' | 'update' | 'delete' | 'clear' | 'expire';

export interface ArchiveStatus {
  enabled: boolean;
  count: number;
  bytes: number;
  forever: number;
  oldestCreatedAt: number | null;
  newestCreatedAt: number | null;
  disk: { free: number; size: number };
  percentOfDisk: number;
  warnPercent: number;
  warning: boolean;
  minFreeBytes: number;
  nextCleanupAt: number;
  expiringAtNextCleanup: number;
  lastCleanup: { at: number; removed: number; bytes: number } | null;
  labels: { label: string; count: number }[];
}

export interface ArchiveDeps {
  dataDir: string;
  catalog: Catalog;
  log: StreamLog;
  audit: AuditLog;
  config: () => Config;
  disk: () => { free: number; size: number };
  timeInfo: () => TimeInfo | undefined;
  cameraName: () => string;
  cameraModel: () => string | null;
  version: string;
  stillsIn: (from: number, to: number) => number[];
  readStill: (ts: number) => Promise<Buffer | undefined>;
  now?: () => number;
  // tests: no ffmpeg/ffprobe
  media?: { duration: (path: string) => Promise<number | null>; frame: (path: string) => Promise<Buffer | undefined> };
}

const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;

export class Archive {
  readonly store: ArchiveStore;
  readonly jobs: ArchiveJobs;
  readonly cleanup: ArchiveCleanup;
  private sweeper: NodeJS.Timeout | undefined;

  constructor(private readonly d: ArchiveDeps) {
    this.store = new ArchiveStore({ dataDir: d.dataDir, catalog: d.catalog });
    const media = d.media ?? { duration: probeDuration, frame: firstFrame };
    this.jobs = new ArchiveJobs({
      store: this.store,
      now: d.now,
      checkSpace: (bytes, jobId) => this.checkSpace(bytes, jobId),
      snapshot: (w) => takeSnapshot({ catalog: d.catalog, cam: d.config().camera.id, cameraName: d.cameraName(), model: d.cameraModel(), version: d.version, maxOpenMs: d.config().events.maxOpenMin * 60_000, now: this.now() }, w.from, w.to),
      thumbDeps: (clip) => this.thumbDeps(clip, media.frame),
      duration: media.duration,
      defaultName: (from) => defaultName(from, d.cameraName(), d.timeInfo()),
      onDone: (row, req, job) => this.added(row, req, job),
      onFailed: (req, job) => this.failed(req, job),
    });
    this.cleanup = new ArchiveCleanup({ run: (now) => this.expire(now), timeInfo: d.timeInfo, now: d.now });
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  // The start-up sweep, the cleanup timer, the finished jobs' sweep.
  start(): void {
    try {
      this.store.sweep();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'archive_sweep_failed');
    }
    this.cleanup.start();
    this.sweeper = setInterval(() => this.jobs.sweep(), 60_000);
    this.sweeper.unref();
  }

  async stop(): Promise<void> {
    this.cleanup.stop();
    clearInterval(this.sweeper);
    await this.jobs.stop();
  }

  // Ruling 5: free − (bytes + spare) − what the other jobs in flight still
  // write must stay at or above storage.minFreeBytes. `jobId`: the asking
  // job, not counted against itself.
  checkSpace(bytes: number, jobId?: string): void {
    const free = this.d.disk().free;
    const minFreeBytes = this.d.config().storage.minFreeBytes;
    const needed = bytes + SPARE_BYTES;
    const inFlight = this.jobs.pendingBytes(jobId);
    if (free - needed - inFlight < minFreeBytes) {
      throw new ArchiveJobError('insufficient_space', `the clip needs ${mb(needed)}, ${mb(free)} are free, ${mb(inFlight)} are being archived and ${mb(minFreeBytes)} must stay free`, { needed, free, minFreeBytes, inFlight });
    }
  }

  private thumbDeps(clip: string, frame: (path: string) => Promise<Buffer | undefined>): ThumbDeps {
    const dataDir = resolve(this.d.dataDir);
    // Only image copies the analytics wrote (analytics/, still-checks/).
    const allowed = [resolve(dataDir, 'analytics'), resolve(dataDir, 'still-checks')];
    const intervalMs = this.d.config().stills.intervalS * 1000;
    return {
      stillNear: async (ts) => {
        for (const t of this.d.stillsIn(ts, ts + Math.max(3000, 2 * intervalMs)).sort((a, b) => a - b)) {
          const jpeg = await this.d.readStill(t);
          if (jpeg) return { ts: t, jpeg };
        }
        return undefined;
      },
      readImage: async (path) => {
        const p = resolve(path);
        if (!allowed.some((dir) => p.startsWith(dir + sep))) return undefined;
        return readFile(p).catch(() => undefined);
      },
      frame: () => frame(clip),
    };
  }

  // Notes every change: one stream message (ruling 19).
  notify(action: Action, ids: number[], items?: ArchiveRow[]): void {
    if (!ids.length) return;
    try {
      this.d.log.append(this.d.config().camera.id, 'archive', { action, ids, ...(items ? { items: items.map(itemJson) } : {}) });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'archive_notify_failed');
    }
  }

  private record(action: string, type: string, who: Who, outcome: 'success' | 'failure', message: string, details: Record<string, unknown>, error?: string): void {
    this.d.audit.write({
      action, category: ['file'], type: [type], outcome, user: who.user, ip: who.ip, userAgent: who.userAgent, message,
      ...(error ? { error } : {}),
      details: { ...details, ...(who.requestedBy ? { requestedBy: who.requestedBy } : {}), ...(who.onBehalfOf ? { onBehalfOf: who.onBehalfOf } : {}) },
    });
  }

  // --- creating -------------------------------------------------------
  private readonly whoOf = new Map<string, Who>();

  // A job, or 'busy'. The space check comes first (507 before any copy).
  create(req: ArchiveRequest, who: Who): JobView | 'busy' {
    const job = this.jobs.start(req);
    if (job !== 'busy') this.whoOf.set(job.id, who);
    return job;
  }

  // A refusal before any job (the space check): audited like a failed job.
  refused(req: ArchiveRequest, who: Who, err: ArchiveJobError): void {
    this.record('archive-add', 'creation', who, 'failure', `Archive: ${this.what(req)} not added: ${err.code}`, { cam: req.cam, source: req.source, bytes: req.size, ...err.extra, jobId: null }, err.code);
  }

  private what(req: ArchiveRequest): string {
    const s = req.source;
    return s.type === 'composition' ? `composition ${String(s.jobId)}` : s.type === 'clip' ? `clip ${String(s.clipId)}` : `recording ${String(s.recording)}`;
  }

  private added(row: ArchiveRow, req: ArchiveRequest, job: JobView): void {
    const who = this.whoOf.get(job.id) ?? { user: req.createdBy };
    this.whoOf.delete(job.id);
    this.record('archive-add', 'creation', who, 'success', `Archive: added "${row.name}" (${row.id}, ${mb(row.bytes)}, from ${this.what(req)})`, {
      id: row.id, cam: row.cam, name: row.name, source: req.source, bytes: row.bytes, labels: req.labels, retentionDays: req.retentionDays, durationS: row.duration_s, quality: row.quality, jobId: job.id,
    });
    this.notify('add', [row.id], [row]);
  }

  private failed(req: ArchiveRequest, job: JobView): void {
    const who = this.whoOf.get(job.id) ?? { user: req.createdBy };
    this.whoOf.delete(job.id);
    this.record('archive-add', 'creation', who, 'failure', `Archive: ${this.what(req)} not added: ${job.error}`, { cam: req.cam, source: req.source, bytes: req.size, jobId: job.id }, job.error);
  }

  // --- changing -------------------------------------------------------
  // The row after the change, or undefined (no such id). Unchanged fields
  // write nothing.
  update(id: number, patch: { name?: string; labels?: string[]; retentionDays?: number | null }, who: Who): ArchiveRow | undefined {
    const before = archiveById(this.d.catalog, id);
    if (!before) return undefined;
    const changes: { field: string; from: unknown; to: unknown }[] = [];
    const oldLabels = JSON.parse(before.labels) as string[];
    if (patch.name !== undefined && patch.name !== before.name) changes.push({ field: 'name', from: before.name, to: patch.name });
    if (patch.labels !== undefined && JSON.stringify(patch.labels) !== JSON.stringify(oldLabels)) changes.push({ field: 'labels', from: oldLabels, to: patch.labels });
    if (patch.retentionDays !== undefined && patch.retentionDays !== before.retention_days) changes.push({ field: 'retentionDays', from: before.retention_days, to: patch.retentionDays });
    if (!changes.length) return before;
    const row = updateArchive(this.d.catalog, id, { name: patch.name, labels: patch.labels, retention_days: patch.retentionDays });
    if (!row) return undefined;
    try {
      this.store.writeMeta(row, JSON.stringify(metadataJson(row), null, 2));
    } catch (err) {
      logger.warn({ err: (err as Error).message, id }, 'archive_meta_write_failed');
    }
    this.record('archive-update', 'change', who, 'success', `Archive: "${row.name}" (${id}) changed: ${changes.map((c) => c.field).join(', ')}`, { id, cam: row.cam, name: row.name, changes });
    this.notify('update', [id], [row]);
    return row;
  }

  // One record per clip, one stream message for all.
  delete(ids: number[], who: Who): { deleted: number[]; notFound: number[] } {
    const deleted: number[] = [];
    const notFound: number[] = [];
    for (const id of ids) {
      const row = this.store.remove(id);
      if (!row) {
        notFound.push(id);
        continue;
      }
      deleted.push(id);
      this.record('archive-delete', 'deletion', who, 'success', `Archive: deleted "${row.name}" (${id}, ${mb(row.bytes)})`, { id, cam: row.cam, name: row.name, bytes: row.bytes, createdAt: row.created_at });
    }
    this.notify('delete', deleted);
    return { deleted, notFound };
  }

  // Everything, when `count` is the number of clips now (ruling 14).
  clear(count: number, who: Who): { cleared: number; bytes: number } | { mismatch: number } {
    const rows = allArchive(this.d.catalog);
    if (count !== rows.length) return { mismatch: rows.length };
    let bytes = 0;
    for (const r of rows) {
      if (this.store.remove(r.id)) bytes += r.bytes;
    }
    const ids = rows.map((r) => r.id);
    this.record('archive-clear', 'deletion', who, 'success', `Archive cleared: ${rows.length} clip${rows.length === 1 ? '' : 's'}, ${mb(bytes)}`, { count: rows.length, bytes, ids });
    this.notify('clear', ids);
    return { cleared: rows.length, bytes };
  }

  // The daily cleanup's work: clips past their retention, one record each.
  expire(now: number): CleanupResult {
    const rows = expiredArchive(this.d.catalog, now);
    let bytes = 0;
    const ids: number[] = [];
    for (const r of rows) {
      if (!this.store.remove(r.id)) continue;
      bytes += r.bytes;
      ids.push(r.id);
      this.record('archive-expire', 'deletion', { user: 'system' }, 'success', `Archive: "${r.name}" (${r.id}) expired after ${r.retention_days} days`, {
        id: r.id, cam: r.cam, name: r.name, retentionDays: r.retention_days, createdAt: r.created_at, expiresAt: r.expires_at, bytes: r.bytes,
      });
    }
    this.notify('expire', ids);
    return { removed: ids.length, bytes };
  }

  // --- reading --------------------------------------------------------
  // The totals and their share of the disk (the status and the health item).
  private usage() {
    const t = archiveTotals(this.d.catalog);
    const disk = this.d.disk();
    const warnPercent = this.d.config().archive.warnPercent;
    const percent = disk.size > 0 ? (t.bytes / disk.size) * 100 : 0;
    return { t, disk, warnPercent, percentOfDisk: round1(percent), warning: percent > warnPercent };
  }

  status(): ArchiveStatus {
    const { t, disk, warnPercent, percentOfDisk, warning } = this.usage();
    const cfg = this.d.config();
    const next = this.cleanup.nextRunAt();
    const counts = archiveLabelCounts(this.d.catalog);
    const lower = new Map([...counts].map(([k, n]) => [k.toLowerCase(), n]));
    const predefinedKeys = new Set(PREDEFINED_LABELS.map((l) => l.toLowerCase()));
    const predefined = PREDEFINED_LABELS.map((l) => ({ label: l, count: lower.get(l.toLowerCase()) ?? 0 }));
    const custom = [...counts].filter(([k]) => !predefinedKeys.has(k.toLowerCase())).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    return {
      enabled: cfg.archive.enabled,
      count: t.count,
      bytes: t.bytes,
      forever: t.forever,
      oldestCreatedAt: t.oldest,
      newestCreatedAt: t.newest,
      disk: { free: disk.free, size: disk.size },
      percentOfDisk,
      warnPercent,
      warning,
      minFreeBytes: cfg.storage.minFreeBytes,
      nextCleanupAt: next,
      expiringAtNextCleanup: countExpiringBy(this.d.catalog, next),
      lastCleanup: this.cleanup.lastRun(),
      labels: [...predefined, ...custom],
    };
  }

  // The health item's input; null while the Archive is off.
  health(): { count: number; bytes: number; percentOfDisk: number; warning: boolean } | null {
    if (!this.d.config().archive.enabled) return null;
    const u = this.usage(); // not status(): no label counts or cleanup look-ahead for the health poll
    return { count: u.t.count, bytes: u.t.bytes, percentOfDisk: u.percentOfDisk, warning: u.warning };
  }
}
