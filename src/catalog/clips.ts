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
  origin: ClipOrigin;
}

// 'ftp': uploaded by the camera; 'camera': fetched from its SD card by an inventory repair (#74).
export type ClipOrigin = 'ftp' | 'camera';

const MAX_LIST = 2000;

export function insertClip(c: Catalog, r: Omit<ClipRow, 'id' | 'origin'> & { origin?: ClipOrigin }): ClipRow {
  return c.db
    .prepare('INSERT INTO clips (cam, start_ts, end_ts, path, stream, size, received_at, snapshot, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *')
    .get(r.cam, r.start_ts, r.end_ts, r.path, r.stream, r.size, r.received_at, r.snapshot, r.origin ?? 'ftp') as unknown as ClipRow;
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

// The FTP copy of an SD recording: same camera and stream, the closest start
// within `slackMs` (cams' 5 s), or undefined.
export function clipNear(c: Catalog, cam: string, stream: string, ts: number, slackMs: number): ClipRow | undefined {
  return c.db
    .prepare('SELECT * FROM clips WHERE cam = ? AND stream = ? AND start_ts BETWEEN ? AND ? ORDER BY ABS(start_ts - ?), id LIMIT 1')
    .get(cam, stream, ts - slackMs, ts + slackMs, ts) as unknown as ClipRow | undefined;
}

// clipNear for many starts at once (one query, not one per start): for each
// [stream, ts], the same clip clipNear would answer, or undefined.
export function clipsNear(c: Catalog, cam: string, wanted: { stream: string; ts: number }[], slackMs: number): (ClipRow | undefined)[] {
  if (!wanted.length) return [];
  const lo = Math.min(...wanted.map((w) => w.ts)) - slackMs;
  const hi = Math.max(...wanted.map((w) => w.ts)) + slackMs;
  const rows = c.db.prepare('SELECT * FROM clips WHERE cam = ? AND start_ts BETWEEN ? AND ? ORDER BY start_ts, id').all(cam, lo, hi) as unknown as ClipRow[];
  return wanted.map(({ stream, ts }) => {
    let best: ClipRow | undefined;
    for (const r of rows) {
      if (r.stream !== stream || r.start_ts < ts - slackMs || r.start_ts > ts + slackMs) continue;
      const d = Math.abs(r.start_ts - ts), bd = best && Math.abs(best.start_ts - ts);
      if (!best || d < bd! || (d === bd && r.id < best.id)) best = r;
    }
    return best;
  });
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
// `live`: recovered events (#75) left out, for the SSE clip message (SSE
// never carries a recovered event).
export function overlappingEvents(c: Catalog, cam: string, from: number, to: number, o: { live?: boolean } = {}): number[] {
  const live = o.live ? " AND source != 'recovered'" : '';
  return (c.db.prepare(`SELECT id FROM events WHERE cam = ? AND start_ts <= ? AND (end_ts IS NULL OR end_ts >= ?)${live} ORDER BY start_ts, id`).all(cam, to, from) as { id: number }[]).map(
    (r) => r.id,
  );
}

// overlappingEvents for many spans at once (one query, not one per span):
// for each [from, to], the same ids in the same order.
export function overlappingEventsOf(c: Catalog, cam: string, spans: { from: number; to: number }[]): number[][] {
  if (!spans.length) return [];
  const lo = Math.min(...spans.map((s) => s.from));
  const hi = Math.max(...spans.map((s) => s.to));
  const rows = c.db.prepare('SELECT id, start_ts, end_ts FROM events WHERE cam = ? AND start_ts <= ? AND (end_ts IS NULL OR end_ts >= ?) ORDER BY start_ts, id').all(cam, hi, lo) as {
    id: number;
    start_ts: number;
    end_ts: number | null;
  }[];
  return spans.map(({ from, to }) => rows.filter((r) => r.start_ts <= to && (r.end_ts === null || r.end_ts >= from)).map((r) => r.id));
}

// Clips received by FTP in [from, to) (the daily audit record); repaired ones are not received.
export function countClips(c: Catalog, cam: string, from: number, to: number): number {
  return Number((c.db.prepare("SELECT COUNT(*) AS n FROM clips WHERE cam = ? AND origin = 'ftp' AND received_at >= ? AND received_at < ?").get(cam, from, to) as { n: number }).n);
}

// When the newest clip of a camera arrived (received_at), or null; kept
// after retention deletes the clip (clip_arrivals, #93).
export function lastClipReceived(c: Catalog, cam: string): number | null {
  const r = c.db.prepare('SELECT last_received AS t FROM clip_arrivals WHERE cam = ?').get(cam) as { t: number | null } | undefined;
  return r?.t ?? null;
}
