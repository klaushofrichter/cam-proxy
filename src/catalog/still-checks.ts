import type { Catalog } from './db';

// Still checks (cams #179, spec 2026-10-04-still-checks-design §1): Vision on
// a second picked by hand, stored apart from events. Only successful calls
// are rows.
export interface StillCheckRow {
  id: number;
  cam: string;
  still_ts: number;
  provider: string;
  requested_at: number;
  requested_via: 'token' | 'session';
  took_ms: number | null;
  image: string | null; // data/analytics/<cam>/check-<id>.jpg, set after the row exists
  objects: string; // JSON [{name, mid, score, box}]
  raw: string | null; // JSON, the provider's answer
  summary: string; // JSON SummaryEntry[]
}
export type StillCheckInput = Omit<StillCheckRow, 'id' | 'image'>;

// Throws on a second check of the same camera, second and provider (UNIQUE).
export function insertCheck(c: Catalog, r: StillCheckInput): StillCheckRow {
  return c.db
    .prepare(
      `INSERT INTO still_checks (cam, still_ts, provider, requested_at, requested_via, took_ms, objects, raw, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(r.cam, r.still_ts, r.provider, r.requested_at, r.requested_via, r.took_ms, r.objects, r.raw, r.summary) as unknown as StillCheckRow;
}

export function setCheckImage(c: Catalog, id: number, image: string): void {
  c.db.prepare('UPDATE still_checks SET image = ? WHERE id = ?').run(image, id);
}

export function checkById(c: Catalog, id: number): StillCheckRow | undefined {
  return c.db.prepare('SELECT * FROM still_checks WHERE id = ?').get(id) as unknown as StillCheckRow | undefined;
}

export function checkAt(c: Catalog, cam: string, stillTs: number, provider = 'google-vision'): StillCheckRow | undefined {
  return c.db.prepare('SELECT * FROM still_checks WHERE cam = ? AND still_ts = ? AND provider = ?').get(cam, stillTs, provider) as unknown as StillCheckRow | undefined;
}

// Oldest first; at most `limit`, 1000 at most.
export function checksInRange(c: Catalog, cam: string, from: number, to: number, limit = 1000): StillCheckRow[] {
  return c.db
    .prepare('SELECT * FROM still_checks WHERE cam = ? AND still_ts >= ? AND still_ts <= ? ORDER BY still_ts, id LIMIT ?')
    .all(cam, from, to, Math.min(Math.max(1, Math.floor(limit)), 1000)) as unknown as StillCheckRow[];
}

// Retention: checks of seconds before `ts` (all cameras, like the events).
export function deleteChecksBefore(c: Catalog, ts: number): number {
  return Number(c.db.prepare('DELETE FROM still_checks WHERE still_ts < ?').run(ts).changes);
}

export function countChecksBefore(c: Catalog, ts: number): number {
  return (c.db.prepare('SELECT COUNT(*) AS n FROM still_checks WHERE still_ts < ?').get(ts) as { n: number }).n;
}

// The image files the rows name (retention's keep-set, with the analyses').
export function checkImages(c: Catalog): Set<string> {
  return new Set((c.db.prepare('SELECT image FROM still_checks WHERE image IS NOT NULL').all() as { image: string }[]).map((r) => r.image));
}

// The kinds a check can confirm: Vision has no "motion".
const CONFIRMABLE = new Set(['person', 'vehicle', 'pet']);
export interface LinkedEvent { id: number; kind: string; confirmed: boolean }

// The camera's events a second sits in, computed when read (§1.2): start ≤ ts
// ≤ end, an open event counting `maxOpenMs` from its start. Confirmed: a
// person, vehicle or pet event whose category is in the check's summary (any
// score). Oldest start first.
export function linkedEvents(c: Catalog, cam: string, ts: number, summary: unknown[], maxOpenMs: number): LinkedEvent[] {
  const found = new Set(summary.map((s) => (s && typeof s === 'object' ? (s as { category?: unknown }).category : undefined)).filter((x): x is string => typeof x === 'string'));
  const rows = c.db
    .prepare('SELECT id, kind FROM events WHERE cam = ? AND start_ts <= ? AND start_ts >= ? AND COALESCE(end_ts, start_ts + ?) >= ? ORDER BY start_ts, id')
    // start_ts ≥ ts − 1 day bounds the index scan: no event is longer (an open one ends after maxOpen).
    .all(cam, ts, ts - Math.max(maxOpenMs, 86_400_000), maxOpenMs, ts) as { id: number; kind: string }[];
  return rows.map((r) => ({ id: Number(r.id), kind: r.kind, confirmed: CONFIRMABLE.has(r.kind) && found.has(r.kind) }));
}
