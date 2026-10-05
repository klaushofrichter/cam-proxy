import type { SQLInputValue } from 'node:sqlite';
import type { Catalog } from './db';

// The Archive's rows (spec 2026-10-05-archive-design §1.1). JSON columns are
// strings here; src/archive/ turns them into the API's shapes.
export interface ArchiveRow {
  id: number;
  cam: string;
  name: string;
  labels: string; // JSON string[]
  retention_days: number | null; // null: forever
  created_at: number;
  expires_at: number | null;
  recorded_from: number;
  recorded_to: number;
  quality: string;
  original: number; // 1: the camera's own file
  duration_s: number;
  bytes: number;
  files: string; // JSON {clip:{bytes,crc32}, thumb:{bytes,crc32}|null}
  source: string; // JSON
  thumb_from: string;
  thumb_at: number | null;
  created_by: string;
  metadata: string; // JSON snapshot
}
export type ArchiveInput = Omit<ArchiveRow, 'id' | 'labels' | 'expires_at'> & { labels: string[] };

const DAY = 86_400_000;
const expiresAt = (created: number, days: number | null) => (days === null ? null : created + days * DAY);

export function insertArchive(c: Catalog, r: ArchiveInput): ArchiveRow {
  return c.db
    .prepare(
      `INSERT INTO archive (cam, name, labels, retention_days, created_at, expires_at, recorded_from, recorded_to, quality, original, duration_s, bytes, files, source, thumb_from, thumb_at, created_by, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(r.cam, r.name, JSON.stringify(r.labels), r.retention_days, r.created_at, expiresAt(r.created_at, r.retention_days), r.recorded_from, r.recorded_to, r.quality, r.original, r.duration_s, r.bytes, r.files, r.source, r.thumb_from, r.thumb_at, r.created_by, r.metadata) as unknown as ArchiveRow;
}

export function archiveById(c: Catalog, id: number): ArchiveRow | undefined {
  return c.db.prepare('SELECT * FROM archive WHERE id = ?').get(id) as unknown as ArchiveRow | undefined;
}

// The rows of these ids that exist, by id.
export function archiveByIds(c: Catalog, ids: number[]): ArchiveRow[] {
  if (!ids.length) return [];
  return c.db.prepare(`SELECT * FROM archive WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) as unknown as ArchiveRow[];
}

export function allArchive(c: Catalog): ArchiveRow[] {
  return c.db.prepare('SELECT * FROM archive ORDER BY id').all() as unknown as ArchiveRow[];
}

export type ArchiveSort = 'created' | 'recorded' | 'name' | 'size' | 'expires' | 'cam' | 'quality' | 'duration' | 'labels';
export const ARCHIVE_SORTS: ArchiveSort[] = ['created', 'recorded', 'name', 'size', 'expires', 'cam', 'quality', 'duration', 'labels'];
export interface ArchiveQuery {
  cam?: string;
  labels?: string[]; // all of them, case-insensitive
  q?: string; // in the name, case-insensitive (ASCII)
  from?: number; // recorded_from within [from, to]
  to?: number;
  quality?: string[];
  sort?: ArchiveSort;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

// By resolution (sd is 896×512: between 360p and 720p).
const QUALITY_RANK = "CASE quality WHEN '360p' THEN 1 WHEN 'sd' THEN 2 WHEN '720p' THEN 3 WHEN '1080p' THEN 4 WHEN '4k' THEN 5 ELSE 6 END";
const FIRST_LABEL = '(SELECT lower(value) FROM json_each(archive.labels) ORDER BY lower(value) LIMIT 1)';
// A key's expression and whether it can be NULL (NULLs: forever is the
// latest expiry; no label sorts last both ways).
const SORT_SQL: Record<ArchiveSort, string> = {
  created: 'created_at',
  recorded: 'recorded_from',
  name: 'name COLLATE NOCASE',
  size: 'bytes',
  expires: 'expires_at',
  cam: 'cam',
  quality: QUALITY_RANK,
  duration: 'duration_s',
  labels: FIRST_LABEL,
};

function orderBy(sort: ArchiveSort, order: 'asc' | 'desc'): string {
  const dir = order === 'asc' ? 'ASC' : 'DESC';
  const key = SORT_SQL[sort];
  const head =
    sort === 'expires' ? `(expires_at IS NULL) ${dir}, ${key} ${dir}`
    : sort === 'labels' ? `(${key} IS NULL) ASC, ${key} ${dir}`
    : `${key} ${dir}`;
  // Ties: the recording's time, newest first, then the id (stable pages).
  return `${head}, recorded_from DESC, id DESC`;
}

// One page and the number of rows that match.
export function listArchive(c: Catalog, q: ArchiveQuery): { total: number; rows: ArchiveRow[] } {
  const where: string[] = [];
  const args: SQLInputValue[] = [];
  if (q.cam !== undefined) (where.push('cam = ?'), args.push(q.cam));
  for (const l of q.labels ?? []) (where.push('EXISTS (SELECT 1 FROM json_each(archive.labels) WHERE lower(value) = lower(?))'), args.push(l));
  if (q.q) (where.push('instr(lower(name), lower(?)) > 0'), args.push(q.q));
  if (q.from !== undefined) (where.push('recorded_from >= ?'), args.push(q.from));
  if (q.to !== undefined) (where.push('recorded_from <= ?'), args.push(q.to));
  if (q.quality?.length) (where.push(`quality IN (${q.quality.map(() => '?').join(',')})`), args.push(...q.quality));
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (c.db.prepare(`SELECT COUNT(*) AS n FROM archive ${w}`).get(...args) as { n: number }).n;
  const limit = Math.min(Math.max(1, Math.floor(q.limit ?? 100)), 500);
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const rows = c.db.prepare(`SELECT * FROM archive ${w} ORDER BY ${orderBy(q.sort ?? 'created', q.order ?? 'desc')} LIMIT ? OFFSET ?`).all(...args, limit, offset) as unknown as ArchiveRow[];
  return { total, rows };
}

// Name, labels and retention; expires_at follows the retention. Undefined
// when there is no such row.
export function updateArchive(c: Catalog, id: number, f: { name?: string; labels?: string[]; retention_days?: number | null }): ArchiveRow | undefined {
  const row = archiveById(c, id);
  if (!row) return undefined;
  const name = f.name ?? row.name;
  const labels = f.labels ? JSON.stringify(f.labels) : row.labels;
  const days = f.retention_days !== undefined ? f.retention_days : row.retention_days;
  return c.db
    .prepare('UPDATE archive SET name = ?, labels = ?, retention_days = ?, expires_at = ? WHERE id = ? RETURNING *')
    .get(name, labels, days, expiresAt(row.created_at, days), id) as unknown as ArchiveRow;
}

export function deleteArchive(c: Catalog, id: number): boolean {
  return Number(c.db.prepare('DELETE FROM archive WHERE id = ?').run(id).changes) > 0;
}

// Rows whose time is up at `now` (expires_at ≤ now), oldest expiry first.
export function expiredArchive(c: Catalog, now: number): ArchiveRow[] {
  return c.db.prepare('SELECT * FROM archive WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at, id').all(now) as unknown as ArchiveRow[];
}

export function countExpiringBy(c: Catalog, ts: number): number {
  return (c.db.prepare('SELECT COUNT(*) AS n FROM archive WHERE expires_at IS NOT NULL AND expires_at <= ?').get(ts) as { n: number }).n;
}

export function archiveTotals(c: Catalog): { count: number; bytes: number; forever: number; oldest: number | null; newest: number | null } {
  const r = c.db
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(retention_days IS NULL), 0) AS forever, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM archive')
    .get() as { count: number; bytes: number; forever: number; oldest: number | null; newest: number | null };
  return { count: r.count, bytes: r.bytes, forever: r.forever, oldest: r.oldest, newest: r.newest };
}

// Each label (case-insensitive) with its number of clips; the spelling is
// the first one stored (by id).
export function archiveLabelCounts(c: Catalog): Map<string, number> {
  const out = new Map<string, number>();
  const spelling = new Map<string, string>();
  for (const r of c.db.prepare('SELECT a.id, j.value AS label FROM archive a, json_each(a.labels) j ORDER BY a.id, j.key').all() as { label: string }[]) {
    const k = r.label.toLowerCase();
    if (!spelling.has(k)) spelling.set(k, r.label);
    const s = spelling.get(k)!;
    out.set(s, (out.get(s) ?? 0) + 1);
  }
  return out;
}
