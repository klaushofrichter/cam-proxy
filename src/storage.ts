import { EventEmitter } from 'events';
import { existsSync, lstatSync, readdirSync, rmdirSync, statSync, statfsSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { Catalog } from './catalog/db';
import { deleteClip } from './catalog/clips';
import { analysisImages, pruneUsage } from './catalog/analyses';
import { deleteEventsBefore } from './catalog/events';
import type { AuditLog } from './audit/audit-log';
import type { Config } from './config/defaults';
import { logger } from './log';
import type { StreamLog } from './stream/log';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GROWTH_WINDOW = 3 * DAY;

export type FileKind = 'stills' | 'previews' | 'clips' | 'recordings';
type MinuteKind = Exclude<FileKind, 'recordings'>;
const MINUTE_KINDS: MinuteKind[] = ['stills', 'previews', 'clips'];
const KINDS: FileKind[] = [...MINUTE_KINDS, 'recordings'];
// After the recordings cache (always first, least recently used), what goes first when over budget.
const BUDGET_ORDER: MinuteKind[] = ['stills', 'clips', 'previews'];

export interface KindUsage { bytes: number; files: number; oldest: number | null; newest: number | null; growthPerDay: number }
export interface StorageRun { dryRun: boolean; at: number; deleted: Record<string, number>; freedBytes: number; reason: string[] }

// One stored minute of a kind: its files (a pack; a sprite and its sidecar).
interface Unit { ts: number; files: { path: string; bytes: number }[] }

const unitBytes = (u: Unit) => u.files.reduce((n, f) => n + f.bytes, 0);
const dayStart = (ts: number) => Math.floor(ts / DAY) * DAY;

// Keeps the data folder within its limits (spec §8a): age per kind, a size
// budget (oldest hour first: stills, clips, previews; never below keepHours),
// and a hard floor that pauses writing. Also deletes old event and stream
// log rows.
export class Storage extends EventEmitter {
  private readonly units: Record<FileKind, Unit[]> = { stills: [], previews: [], clips: [], recordings: [] }; // oldest first
  private readonly writes: { at: number; kind: FileKind; bytes: number }[] = [];
  private isPaused = false;
  private last: number | null = null;
  private readonly total: Record<string, number> = {};
  private timer: NodeJS.Timeout | undefined;
  private floorTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly d: {
      catalog: Catalog;
      log: StreamLog;
      audit?: AuditLog;
      config: () => Config;
      now?: () => number;
      statfs?: (dir: string) => { free: number; size: number };
      recordingsBusy?: (path: string) => boolean; // a recording being read: never deleted
    },
  ) {
    super();
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private disk(): { free: number; size: number } {
    const dir = this.d.config().server.dataDir;
    if (this.d.statfs) return this.d.statfs(dir);
    const s = statfsSync(existsSync(dir) ? dir : join(dir, '..'));
    return { free: s.bavail * s.bsize, size: s.blocks * s.bsize };
  }

  budget(): number {
    const s = this.d.config().storage;
    return s.maxBytes ?? Math.floor((this.disk().size * (s.maxPercent ?? 85)) / 100);
  }

  // Walks <dataDir>/<kind>/<cam>/YYYY/MM/DD once (start, and when asked).
  recount(): void {
    const root = this.d.config().server.dataDir;
    for (const kind of MINUTE_KINDS) {
      const byMinute = new Map<string, Unit>();
      const base = join(root, kind);
      if (!existsSync(base)) {
        this.units[kind] = [];
        continue;
      }
      for (const cam of readdirSync(base)) {
        for (const y of safeDir(join(base, cam))) {
          for (const m of safeDir(join(base, cam, y))) {
            for (const dd of safeDir(join(base, cam, y, m))) {
              const folder = join(base, cam, y, m, dd);
              for (const name of safeDir(folder)) {
                const hm = /^(\d{2})(\d{2})(?:-[^.]*)?\./.exec(name);
                if (!hm) continue;
                const ts = Date.UTC(Number(y), Number(m) - 1, Number(dd), Number(hm[1]), Number(hm[2]));
                if (Number.isNaN(ts)) continue;
                const key = `${cam}/${ts}`;
                const path = join(folder, name);
                let bytes = 0;
                try {
                  bytes = statSync(path).size;
                } catch {
                  continue;
                }
                const u = byMinute.get(key) ?? { ts, files: [] };
                u.files.push({ path, bytes });
                byMinute.set(key, u);
              }
            }
          }
        }
      }
      this.units[kind] = [...byMinute.values()].sort((a, b) => a.ts - b.ts);
    }
    this.recountRecordings();
  }

  // The recordings cache: one unit per regular file, its time the last use
  // (mtime). Paths are join(dir, id), the strings the cache pins by. Also run
  // by usage(): the cache evicts on its own (makeRoom), and it is one small folder.
  private recountRecordings(): void {
    const recs: Unit[] = [];
    const recDir = join(this.d.config().server.dataDir, 'recordings');
    for (const cam of safeDir(recDir)) {
      for (const name of safeDir(join(recDir, cam))) {
        if (name.endsWith('.part')) continue; // being written
        const path = join(recDir, cam, name);
        try {
          const s = lstatSync(path);
          if (s.isFile()) recs.push({ ts: s.mtimeMs, files: [{ path, bytes: s.size }] });
        } catch {
          // gone
        }
      }
    }
    this.units.recordings = recs.sort((a, b) => a.ts - b.ts);
  }

  // The store reports what it wrote (bytes may be a difference after a merge).
  // Only an estimate for usage and growth between runs; run() recounts.
  // `growth: false`: usage only, not growth (the clips repair fetches old
  // recordings back: a one-off, not the rate the disk fills at).
  noteWritten(kind: FileKind, bytes: number, files: number, o: { growth?: boolean } = {}): void {
    const now = this.now();
    if (o.growth !== false) this.writes.push({ at: now, kind, bytes: Math.max(0, bytes) });
    while (this.writes.length && this.writes[0].at < now - GROWTH_WINDOW) this.writes.shift();
    // A written minute: a unit for the latest minute (exact paths come with the next recount).
    const list = this.units[kind];
    const ts = Math.floor(now / 60_000) * 60_000;
    const lastUnit = list[list.length - 1];
    if (lastUnit && lastUnit.ts === ts) lastUnit.files.push({ path: '', bytes });
    else list.push({ ts, files: [{ path: '', bytes }, ...Array.from({ length: Math.max(0, files - 1) }, () => ({ path: '', bytes: 0 }))] });
  }

  usage(): Record<FileKind | 'catalog' | 'audit', KindUsage> & { free: number; size: number; budget: number; used: number; daysUntilFull: number | null } {
    const now = this.now();
    this.recountRecordings();
    const out = {} as Record<FileKind | 'catalog' | 'audit', KindUsage>;
    let used = 0;
    let growth = 0;
    for (const kind of KINDS) {
      const list = this.units[kind];
      const bytes = list.reduce((n, u) => n + unitBytes(u), 0);
      const g = this.writes.filter((w) => w.kind === kind).reduce((n, w) => n + w.bytes, 0) / (GROWTH_WINDOW / DAY);
      out[kind] = { bytes, files: list.reduce((n, u) => n + u.files.length, 0), oldest: list[0]?.ts ?? null, newest: list[list.length - 1]?.ts ?? null, growthPerDay: Math.round(g) };
      used += bytes;
      // The recordings cache is capped and evicts itself: its writes never fill the disk.
      if (kind !== 'recordings') growth += g;
    }
    const cat = this.d.catalog.sizeBytes();
    out.catalog = { bytes: cat, files: 1, oldest: null, newest: now, growthPerDay: 0 };
    used += cat;
    out.audit = this.d.audit?.usage() ?? { bytes: 0, files: 0, oldest: null, newest: null, growthPerDay: 0 };
    used += out.audit.bytes;
    growth += out.audit.growthPerDay;
    const disk = this.disk();
    const budget = this.budget();
    return { ...out, free: disk.free, size: disk.size, budget, used, daysUntilFull: growth > 0 ? Math.max(0, (budget - used) / growth) : null };
  }

  paused(): boolean {
    return this.isPaused;
  }

  // The hard floor: below storage.minFreeBytes, writers must not write.
  // A change writes a `storage-paused` or `storage-resumed` audit record: the
  // stills inventory explains gaps by them (#106).
  check(): boolean {
    const free = this.disk().free;
    const minFreeBytes = this.d.config().storage.minFreeBytes;
    const p = free < minFreeBytes;
    if (p !== this.isPaused) {
      this.isPaused = p;
      logger.warn({ paused: p }, p ? 'storage_full_writing_paused' : 'storage_writing_resumed');
      const mb = (b: number) => `${Math.round(b / 2 ** 20)} MB`;
      this.d.audit?.write({
        action: p ? 'storage-paused' : 'storage-resumed', category: ['host'], type: ['change'], outcome: p ? 'failure' : 'success', user: 'system',
        message: p
          ? `Storage paused: ${mb(free)} free, below storage.minFreeBytes (${mb(minFreeBytes)}); stills, clips and recordings are not written`
          : `Storage resumed: ${mb(free)} free, storage.minFreeBytes is ${mb(minFreeBytes)}`,
        details: { free, minFreeBytes },
      });
      this.emit('paused', p);
    }
    return p;
  }

  run(opts: { dryRun?: boolean }): StorageRun {
    // Work from the disk as it is: files written since the last count (known
    // only by size through noteWritten) get their real paths.
    this.recount();
    const now = this.now();
    const cfg = this.d.config();
    const dry = !!opts.dryRun;
    const deleted: Record<string, number> = {};
    const reason: string[] = [];
    let freed = 0;
    const sim: Record<FileKind, Unit[]> = { stills: [...this.units.stills], previews: [...this.units.previews], clips: [...this.units.clips], recordings: [...this.units.recordings] };
    const drop = (kind: FileKind, u: Unit) => {
      deleted[kind] = (deleted[kind] ?? 0) + u.files.length;
      freed += unitBytes(u);
      if (dry) return;
      for (const f of u.files) {
        if (!f.path) continue;
        if (kind === 'recordings') {
          try {
            unlinkSync(f.path);
          } catch {
            // gone
          }
          continue;
        }
        removeFile(f.path);
        if (kind === 'clips') deleteClip(this.d.catalog, f.path); // the row (or the snapshot link)
      }
    };

    // 1. Age, per kind (whole UTC days).
    const days: Record<MinuteKind, number> = { stills: cfg.retention.stillsDays, previews: cfg.retention.previewsDays, clips: cfg.retention.clipsDays };
    for (const kind of MINUTE_KINDS) {
      const cutoff = dayStart(now - days[kind] * DAY);
      while (sim[kind].length && sim[kind][0].ts < cutoff) {
        drop(kind, sim[kind].shift()!);
        if (!reason.includes('age')) reason.push('age');
      }
    }
    // Rows.
    const eventsBefore = now - cfg.retention.eventsDays * DAY;
    const logBefore = now - cfg.retention.streamLogDays * DAY;
    const db = this.d.catalog.db;
    if (dry) {
      deleted.events = (db.prepare('SELECT COUNT(*) AS n FROM events WHERE start_ts < ?').get(eventsBefore) as { n: number }).n;
      deleted.streamLog = (db.prepare('SELECT COUNT(*) AS n FROM stream_log WHERE ts < ?').get(logBefore) as { n: number }).n;
    } else {
      deleted.events = deleteEventsBefore(this.d.catalog, eventsBefore);
      // Analysis images whose analysis is gone (deleted with its event).
      const keep = analysisImages(this.d.catalog);
      const dir = join(cfg.server.dataDir, 'analytics', cfg.camera.id);
      for (const f of existsSync(dir) ? readdirSync(dir) : []) {
        const path = join(dir, f);
        if (!keep.has(path)) try { unlinkSync(path); } catch { /* gone */ }
      }
      pruneUsage(this.d.catalog, new Date(now - 400 * DAY).toISOString().slice(0, 10));
      deleted.streamLog = this.d.log.deleteBefore(logBefore);
    }

    // The audit log keeps whole UTC days; only retention removes them, never the budget.
    if (this.d.audit) deleted.audit = this.d.audit.deleteBefore(new Date(dayStart(now - cfg.retention.auditDays * DAY)).toISOString().slice(0, 10), dry);

    // 2. Per-kind caps, then the budget: the oldest hour of the next kind in
    // order, never touching the newest keepHours of a kind.
    const bytesOf = (kind: FileKind) => sim[kind].reduce((n, u) => n + unitBytes(u), 0);
    const dropOldestHour = (kind: MinuteKind): boolean => {
      const keepFrom = now - cfg.storage.keepHours[kind] * HOUR;
      const first = sim[kind][0];
      if (!first || first.ts >= keepFrom) return false;
      const hour = Math.floor(first.ts / HOUR) * HOUR;
      while (sim[kind].length && sim[kind][0].ts < hour + HOUR && sim[kind][0].ts < keepFrom) drop(kind, sim[kind].shift()!);
      return true;
    };
    const caps: Partial<Record<MinuteKind, number | undefined>> = { stills: cfg.stills.maxGB, previews: cfg.previews.maxGB, clips: cfg.ftp.maxGB };
    for (const kind of MINUTE_KINDS) {
      const cap = caps[kind];
      if (cap === undefined) continue;
      while (bytesOf(kind) > cap * 2 ** 30 && dropOldestHour(kind)) if (!reason.includes('cap')) reason.push('cap');
    }
    // The recordings cache: its own cap, then first in line for the budget,
    // least recently used first, never a file in use.
    const dropRecording = (): boolean => {
      const i = sim.recordings.findIndex((u) => !u.files.some((f) => f.path && this.d.recordingsBusy?.(f.path)));
      if (i < 0) return false;
      drop('recordings', sim.recordings.splice(i, 1)[0]);
      return true;
    };
    const recCap = cfg.recordings.cacheMB * 2 ** 20;
    while (bytesOf('recordings') > recCap && dropRecording()) if (!reason.includes('cap')) reason.push('cap');
    const budget = this.budget();
    const catalog = this.d.catalog.sizeBytes() + (this.d.audit?.usage().bytes ?? 0); // audit bytes count, are never dropped
    const used = () => KINDS.reduce((n, k) => n + bytesOf(k), 0) + catalog;
    while (used() > budget) {
      if (!(dropRecording() || BUDGET_ORDER.some((k) => dropOldestHour(k)))) {
        if (!reason.includes('budget_unreachable')) reason.push('budget_unreachable');
        break;
      }
      if (!reason.includes('budget')) reason.push('budget');
    }

    if (!dry) {
      removeStaleUploads(join(cfg.server.dataDir, 'ftp', '.incoming'), now - DAY);
      this.units.stills = sim.stills;
      this.units.previews = sim.previews;
      this.units.clips = sim.clips;
      this.units.recordings = sim.recordings;
      this.last = now;
      for (const [k, n] of Object.entries(deleted)) this.total[k] = (this.total[k] ?? 0) + n;
      this.check();
    }
    const run: StorageRun = { dryRun: dry, at: now, deleted, freedBytes: freed, reason };
    if (!dry) this.emit('run', run);
    return run;
  }

  // Every retention.intervalMin (a failed run is logged and retried), and a
  // floor check every 10 s.
  start(t: { firstMs?: number; everyMs?: number } = {}): void {
    const tick = () => {
      try {
        this.run({});
      } catch (err) {
        const msg = (err as Error).message;
        logger.error({ err: msg }, 'storage_run_failed');
        this.emit('failed', msg);
      }
      this.timer = setTimeout(tick, t.everyMs ?? this.d.config().retention.intervalMin * 60_000);
    };
    this.timer = setTimeout(tick, t.firstMs ?? 5_000);
    this.floorTimer = setInterval(() => {
      try {
        this.check();
      } catch {
        // statfs failed: keep the last state
      }
    }, 10_000);
  }

  stop(): void {
    clearTimeout(this.timer);
    clearInterval(this.floorTimer);
  }

  lastRun(): number | null {
    return this.last;
  }

  totals(): Record<string, number> {
    return { ...this.total };
  }
}

function safeDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// Uploads cut off without the FTP server noticing (a crash) stay in
// .incoming; they go after a day. Uploads in progress are never counted.
function removeStaleUploads(dir: string, before: number): void {
  for (const name of safeDir(dir)) {
    try {
      const path = join(dir, name);
      if (statSync(path).mtimeMs < before) unlinkSync(path);
    } catch {
      // gone
    }
  }
}

// Deletes a file, and its folders up to the kind folder when they are empty.
function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    return;
  }
  let dir = join(path, '..');
  for (let i = 0; i < 4; i++) {
    try {
      rmdirSync(dir); // only succeeds when empty
    } catch {
      return;
    }
    dir = join(dir, '..');
  }
}
