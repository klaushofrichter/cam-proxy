import { lstatSync } from 'fs';
import { join } from 'path';
import { CAM_ID } from '../archive/paths';
import type { Catalog } from '../catalog/db';
import { MINUTE, utcDayParts, utcHhmm } from '../time-units';
import { allChunkParts } from './chunk-parts';
import { rowKey } from './import';
import type { ItemFilter } from './inventory';
import type { MoveRecord } from './journal';
import { landedFiles } from './purge';

// The high water of a camera's content on this proxy (move step 4, ruling 7):
// recorded by the target at a cancel after the switch-over, before the
// camera's node leaves. The copy back (the return) serves only rows at or
// below these ids, and only row-less files (stills, previews) written up to
// `at` (this proxy's own clock): a camera re-added under the same id after
// the cancel (Review Focus 1) is neither copied back nor deleted by it.
// The ids alone are not enough: clips, events, analyses and still_checks have
// no AUTOINCREMENT, so once retention removed every row at or above the mark
// a new row can get an id at or below it. A row is also bounded by its own
// time on this proxy's clock (TIME_COLUMN, at most `at`). A table without
// rows of the camera: 0.
export type CapturedTable = 'clips' | 'events' | 'analyses' | 'still_checks' | 'archive';
export type Captured = NonNullable<MoveRecord['captured']>;

const QUERIES: Record<CapturedTable, string> = {
  clips: 'SELECT COALESCE(MAX(id), 0) AS n FROM clips WHERE cam = ?',
  events: 'SELECT COALESCE(MAX(id), 0) AS n FROM events WHERE cam = ?',
  // Analyses have no camera of their own: theirs is their event's.
  analyses: 'SELECT COALESCE(MAX(a.id), 0) AS n FROM analyses a JOIN events e ON e.id = a.event_id WHERE e.cam = ?',
  still_checks: 'SELECT COALESCE(MAX(id), 0) AS n FROM still_checks WHERE cam = ?',
  archive: 'SELECT COALESCE(MAX(id), 0) AS n FROM archive WHERE cam = ?',
};

export function capturedMark(catalog: Pick<Catalog, 'db'>, cam: string, now: number): Captured {
  const maxIds: Captured['maxIds'] = {};
  for (const [t, sql] of Object.entries(QUERIES) as [CapturedTable, string][]) maxIds[t] = Number((catalog.db.prepare(sql).get(cam) as { n: number | bigint }).n);
  return { at: now, maxIds };
}

// The row's own time on this proxy (ms): when a clip arrived, an event began,
// an analysis or a still check was asked for, an Archive item was made.
const TIME_COLUMN: Record<CapturedTable, string> = { clips: 'received_at', events: 'start_ts', analyses: 'requested_at', still_checks: 'requested_at', archive: 'created_at' };

// A still minute's file (stills/<cam>/YYYY/MM/DD/HHMM.pack, previews/<cam>/
// .../HHMM.jpg|.json; stills/store.ts minutePath, UTC): the minute's start
// (ms), or null for any other path.
const MINUTE_FILE = /^(?:stills|previews)\/[^/]+\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})(\d{2})\.(?:pack|jpg|json)$/;
export function minuteOf(rel: string): number | null {
  const m = MINUTE_FILE.exec(rel);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Number.isFinite(t) ? t : null;
}

// What the copy back serves (step 4 Task 9, spec §1): the camera's content
// this proxy captured itself, i.e. not what the cancelled move imported. A row
// is in when its id is not in an import map of the move's chunk parts with a
// natural key that still matches (an imported Archive item renamed here goes
// back), its id is at most the high water and its own time at most `at`. A
// row-less file is in when the move did not land it (the landed log) and its
// still minute ended by `at` (the cancel minute is not: it is captured by
// both proxies and stays here, cancelMinuteFiles). Not by the file's mtime:
// a minute is written when it is flushed, after it ended (the next minute's
// first frame, the camera's stop), so the last whole minute before the cancel
// can be written a moment after `at` (localstack scenario 5: 16 ms). Any other
// row-less file: last written at or before `at`. Read once: build one per request.
export function capturedFilter(dataDir: string, cancelled: MoveRecord): ItemFilter {
  const cap = cancelled.captured;
  if (!cap) throw new Error('capturedFilter: no high water');
  const imported = new Map<string, Map<number, string>>();
  for (const part of allChunkParts(dataDir, cancelled.id)) {
    for (const [t, list] of Object.entries(part.imported ?? {})) {
      const m = imported.get(t) ?? new Map<number, string>();
      for (const e of list ?? []) if (Array.isArray(e) && Number.isSafeInteger(e[1]) && typeof e[2] === 'string') m.set(e[1], e[2]);
      imported.set(t, m);
    }
  }
  const landed = landedFiles(dataDir, cancelled.id);
  return {
    row(table, row) {
      if (!(table in TIME_COLUMN)) return false;
      const t = table as CapturedTable;
      const id = Number(row.id);
      const max = cap.maxIds[t];
      const ts = Number(row[TIME_COLUMN[t]]);
      if (!Number.isSafeInteger(id) || max === undefined || id > max || !Number.isFinite(ts) || ts > cap.at) return false;
      const key = imported.get(t)?.get(id);
      return key === undefined || rowKey(t, row) !== key;
    },
    file(rel) {
      if (landed.has(rel)) return false;
      const minute = minuteOf(rel);
      if (minute !== null) return minute + MINUTE <= cap.at && isFile(join(dataDir, ...rel.split('/')));
      try {
        const st = lstatSync(join(dataDir, ...rel.split('/')));
        return st.isFile() && Math.floor(st.mtimeMs) <= cap.at;
      } catch {
        return false;
      }
    },
  };
}

const isFile = (abs: string): boolean => {
  try {
    return lstatSync(abs).isFile();
  } catch {
    return false;
  }
};

// The cancel minute's still files of the camera on this proxy (the minute
// holding the high water's `at`, not landed by the move): never copied back
// (capturedFilter), they stay here and age out; the return's finish counts
// them kept (concern 2 of the localstack run). dataDir-relative posix paths.
export function cancelMinuteFiles(dataDir: string, cancelled: MoveRecord): string[] {
  const cap = cancelled.captured;
  if (!cap || !CAM_ID.test(cancelled.camera)) return [];
  const minute = Math.floor(cap.at / MINUTE) * MINUTE;
  const day = utcDayParts(minute).join('/');
  const hhmm = utcHhmm(minute);
  const landed = landedFiles(dataDir, cancelled.id);
  const out: string[] = [];
  for (const rel of [`stills/${cancelled.camera}/${day}/${hhmm}.pack`, `previews/${cancelled.camera}/${day}/${hhmm}.jpg`, `previews/${cancelled.camera}/${day}/${hhmm}.json`]) {
    if (!landed.has(rel) && isFile(join(dataDir, ...rel.split('/')))) out.push(rel);
  }
  return out;
}
