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
}

// Stores (or replaces) the result for an event and provider. Null when the
// event was deleted meanwhile (retention): the result is dropped.
export function saveAnalysis(c: Catalog, r: Omit<AnalysisRow, 'id'>): AnalysisRow | null {
  const exists = c.db.prepare('SELECT 1 FROM events WHERE id = ?').get(r.event_id);
  if (!exists) return null;
  return c.db
    .prepare(
      `INSERT INTO analyses (event_id, provider, status, reason, still_ts, image, requested_at, took_ms, objects, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id, provider) DO UPDATE SET status = excluded.status, reason = excluded.reason, still_ts = excluded.still_ts,
         image = excluded.image, requested_at = excluded.requested_at, took_ms = excluded.took_ms, objects = excluded.objects, raw = excluded.raw
       RETURNING *`,
    )
    .get(r.event_id, r.provider, r.status, r.reason, r.still_ts, r.image, r.requested_at, r.took_ms, r.objects, r.raw) as unknown as AnalysisRow;
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
