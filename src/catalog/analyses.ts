import type { Catalog } from './db';

// External analytics results and call counts (spec 2026-09-30-analytics-design).
export type AnalysisStatus = 'ok' | 'skipped' | 'failed';
export interface AnalysisRow {
  id: number;
  event_id: number;
  provider: string;
  status: AnalysisStatus;
  reason: string | null;
  still_ts: number | null;
  image: string | null;
  requested_at: number;
  took_ms: number | null;
  objects: string | null; // JSON [{name, score, box}]
  raw: string | null; // JSON
  summary: string | null; // JSON SummaryEntry[]
}

// Stores (or replaces) the result for an event and provider. Null when the
// event was deleted meanwhile (retention): the result is dropped.
export function saveAnalysis(c: Catalog, r: Omit<AnalysisRow, 'id'>): AnalysisRow | null {
  const exists = c.db.prepare('SELECT 1 FROM events WHERE id = ?').get(r.event_id);
  if (!exists) return null;
  return c.db
    .prepare(
      `INSERT INTO analyses (event_id, provider, status, reason, still_ts, image, requested_at, took_ms, objects, raw, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id, provider) DO UPDATE SET status = excluded.status, reason = excluded.reason, still_ts = excluded.still_ts,
         image = excluded.image, requested_at = excluded.requested_at, took_ms = excluded.took_ms, objects = excluded.objects, raw = excluded.raw,
         summary = excluded.summary
       RETURNING *`,
    )
    .get(r.event_id, r.provider, r.status, r.reason, r.still_ts, r.image, r.requested_at, r.took_ms, r.objects, r.raw, r.summary) as unknown as AnalysisRow;
}

export function analysisFor(c: Catalog, eventId: number): AnalysisRow | undefined {
  return c.db.prepare('SELECT * FROM analyses WHERE event_id = ? ORDER BY requested_at DESC, id DESC LIMIT 1').get(eventId) as unknown as AnalysisRow | undefined;
}

export function analysesFor(c: Catalog, eventIds: number[]): Map<number, AnalysisRow> {
  const out = new Map<number, AnalysisRow>();
  if (!eventIds.length) return out;
  const rows = c.db
    .prepare(`SELECT * FROM analyses WHERE event_id IN (${eventIds.map(() => '?').join(',')}) ORDER BY requested_at, id`)
    .all(...eventIds) as unknown as AnalysisRow[];
  for (const r of rows) out.set(r.event_id, r); // the latest wins
  return out;
}

export function addUsage(c: Catalog, provider: string, day: string): void {
  c.db.prepare('INSERT INTO analytics_usage (provider, day, calls) VALUES (?, ?, 1) ON CONFLICT (provider, day) DO UPDATE SET calls = calls + 1').run(provider, day);
}

export function usageBetween(c: Catalog, provider: string, fromDay: string, toDay: string): number {
  const r = c.db.prepare('SELECT COALESCE(SUM(calls), 0) AS n FROM analytics_usage WHERE provider = ? AND day >= ? AND day <= ?').get(provider, fromDay, toDay) as { n: number };
  return r.n;
}

export function pruneUsage(c: Catalog, beforeDay: string): number {
  return Number(c.db.prepare('DELETE FROM analytics_usage WHERE day < ?').run(beforeDay).changes);
}

// Events of the given kinds since a time that have no analysis (any provider).
export function unanalysed(c: Catalog, cam: string, kinds: string[], since: number): { id: number; kind: string; start_ts: number }[] {
  if (!kinds.length) return [];
  return c.db
    .prepare(
      `SELECT e.id, e.kind, e.start_ts FROM events e
       WHERE e.cam = ? AND e.start_ts >= ? AND e.kind IN (${kinds.map(() => '?').join(',')})
         AND NOT EXISTS (SELECT 1 FROM analyses a WHERE a.event_id = e.id)
       ORDER BY e.start_ts, e.id`,
    )
    .all(cam, since, ...kinds) as { id: number; kind: string; start_ts: number }[];
}

export function analysisImages(c: Catalog): Set<string> {
  return new Set((c.db.prepare('SELECT image FROM analyses WHERE image IS NOT NULL').all() as { image: string }[]).map((r) => r.image));
}

export interface AnalysisInRange extends AnalysisRow { kind: string; start_ts: number; end_ts: number | null }

// The latest analysis of each event of a camera that starts in [from, to],
// oldest event first (spec: GET /api/cameras/{cam}/analyses).
export function analysesInRange(c: Catalog, cam: string, from: number, to: number, limit = 1000): AnalysisInRange[] {
  return c.db
    .prepare(
      `SELECT a.*, e.kind AS kind, e.start_ts AS start_ts, e.end_ts AS end_ts FROM analyses a JOIN events e ON e.id = a.event_id
       WHERE e.cam = ? AND e.start_ts >= ? AND e.start_ts <= ?
         AND a.id = (SELECT a2.id FROM analyses a2 WHERE a2.event_id = a.event_id ORDER BY a2.requested_at DESC, a2.id DESC LIMIT 1)
       ORDER BY e.start_ts, e.id LIMIT ?`,
    )
    .all(cam, from, to, Math.min(Math.max(1, limit), 1000)) as unknown as AnalysisInRange[];
}

export function withoutSummary(c: Catalog): AnalysisRow[] {
  return c.db.prepare("SELECT * FROM analyses WHERE status = 'ok' AND summary IS NULL ORDER BY id").all() as unknown as AnalysisRow[];
}

export function setSummary(c: Catalog, id: number, summary: string): void {
  c.db.prepare('UPDATE analyses SET summary = ? WHERE id = ?').run(summary, id);
}

// Objects the category map doesn't know, counted per mid (per name when there is none).
export function countUnmapped(c: Catalog, items: { mid: string; name: string }[], ts: number): void {
  const st = c.db.prepare(
    `INSERT INTO analytics_unmapped (key, mid, name, count, last_seen) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen, name = excluded.name`,
  );
  // One answer's objects count together, in one write.
  c.db.exec('BEGIN');
  try {
    for (const i of items) st.run(i.mid || `name:${i.name.toLowerCase()}`, i.mid, i.name, ts);
    c.db.exec('COMMIT');
  } catch (err) {
    c.db.exec('ROLLBACK');
    throw err;
  }
}

// At most 1000 (a negative LIMIT would mean none in SQLite).
export function listUnmapped(c: Catalog, limit = 1000): { mid: string; name: string; count: number; lastSeen: number }[] {
  return (
    c.db.prepare('SELECT mid, name, count, last_seen FROM analytics_unmapped ORDER BY count DESC, last_seen DESC, name LIMIT ?').all(Math.min(Math.max(1, Math.floor(limit)), 1000)) as {
      mid: string;
      name: string;
      count: number;
      last_seen: number;
    }[]
  ).map((r) => ({ mid: r.mid, name: r.name, count: r.count, lastSeen: r.last_seen }));
}

export function clearUnmapped(c: Catalog): number {
  return Number(c.db.prepare('DELETE FROM analytics_unmapped').run().changes);
}
