import type { Catalog } from './db';

export interface ClipRow {
  id: number;
  cam: string;
  start_ts: number;
  end_ts: number | null;
  path: string;
  stream: string;
  size: number;
  received_at: number;
  snapshot: string | null;
}

const MAX_LIST = 2000;

export function insertClip(c: Catalog, r: Omit<ClipRow, 'id'>): ClipRow {
  return c.db
    .prepare('INSERT INTO clips (cam, start_ts, end_ts, path, stream, size, received_at, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
    .get(r.cam, r.start_ts, r.end_ts, r.path, r.stream, r.size, r.received_at, r.snapshot) as unknown as ClipRow;
}

// Clips that overlap [from, to], oldest first.
export function listClips(c: Catalog, cam: string, from: number, to: number): ClipRow[] {
  return c.db
    .prepare(`SELECT * FROM clips WHERE cam = ? AND start_ts <= ? AND COALESCE(end_ts, start_ts) >= ? ORDER BY start_ts, id LIMIT ${MAX_LIST}`)
    .all(cam, to, from) as unknown as ClipRow[];
}

// The start of the oldest clip kept for a camera, or null.
export function oldestClip(c: Catalog, cam: string): number | null {
  const r = c.db.prepare('SELECT MIN(start_ts) AS t FROM clips WHERE cam = ?').get(cam) as { t: number | null } | undefined;
  return r?.t ?? null;
}

export function clipById(c: Catalog, id: number): ClipRow | undefined {
  return c.db.prepare('SELECT * FROM clips WHERE id = ?').get(id) as unknown as ClipRow | undefined;
}

export function clipByPath(c: Catalog, path: string): ClipRow | undefined {
  return c.db.prepare('SELECT * FROM clips WHERE path = ?').get(path) as unknown as ClipRow | undefined;
}

// The clip a picture taken at `ts` belongs to: the one that started last,
// at most `windowMs` before it.
export function clipForSnapshot(c: Catalog, cam: string, ts: number, windowMs: number): ClipRow | undefined {
  return c.db
    .prepare('SELECT * FROM clips WHERE cam = ? AND start_ts <= ? AND start_ts >= ? ORDER BY start_ts DESC, id DESC LIMIT 1')
    .get(cam, ts, ts - windowMs) as unknown as ClipRow | undefined;
}

export function clipsWithoutSnapshot(c: Catalog, cam: string): ClipRow[] {
  return c.db.prepare('SELECT * FROM clips WHERE cam = ? AND snapshot IS NULL ORDER BY start_ts').all(cam) as unknown as ClipRow[];
}

export function setSnapshot(c: Catalog, id: number, snapshot: string | null): void {
  c.db.prepare('UPDATE clips SET snapshot = ? WHERE id = ?').run(snapshot, id);
}

// Removes the rows of a deleted file: the clip itself, or a snapshot.
export function deleteClip(c: Catalog, path: string): number {
  c.db.prepare('UPDATE clips SET snapshot = NULL WHERE snapshot = ?').run(path);
  return Number(c.db.prepare('DELETE FROM clips WHERE path = ?').run(path).changes);
}

// Ids of the events of a camera that overlap [from, to] (open events count).
export function overlappingEvents(c: Catalog, cam: string, from: number, to: number): number[] {
  return (c.db.prepare('SELECT id FROM events WHERE cam = ? AND start_ts <= ? AND (end_ts IS NULL OR end_ts >= ?) ORDER BY start_ts, id').all(cam, to, from) as { id: number }[]).map(
    (r) => r.id,
  );
}

// Clips received in [from, to) (the daily audit record).
export function countClips(c: Catalog, cam: string, from: number, to: number): number {
  return Number((c.db.prepare('SELECT COUNT(*) AS n FROM clips WHERE cam = ? AND received_at >= ? AND received_at < ?').get(cam, from, to) as { n: number }).n);
}
