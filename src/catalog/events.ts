import type { Catalog } from './db';

// 'recovered': added by the events inventory's repair from the camera's SD
// recordings (#75, spec 2026-10-02-inventory-design §5), closed at once with
// end_reason 'recovered'. Never sent over SSE or the stream log, never
// analysed, and left out of the FTP stall check and the daily event counts.
export type EventSource = 'onvif' | 'poll' | 'recovered';
export type EndReason = 'state' | 'timeout' | 'restart' | 'recovered';
export interface EventRow {
  id: number;
  cam: string;
  source: EventSource;
  kind: string;
  start_ts: number;
  end_ts: number | null;
  end_reason: EndReason | null;
  raw: unknown;
}

type DbRow = Omit<EventRow, 'raw'> & { raw: string | null };
const fromDb = (r: DbRow): EventRow => ({ ...r, raw: r.raw === null ? null : JSON.parse(r.raw) });
const MAX_LIST = 1000;

export function insertEvent(c: Catalog, e: Pick<EventRow, 'cam' | 'source' | 'kind' | 'start_ts' | 'raw'>): EventRow {
  const r = c.db
    .prepare('INSERT INTO events (cam, source, kind, start_ts, raw) VALUES (?, ?, ?, ?, ?) RETURNING *')
    .get(e.cam, e.source, e.kind, e.start_ts, e.raw === undefined ? null : JSON.stringify(e.raw)) as DbRow;
  return fromDb(r);
}

export function closeEvent(c: Catalog, id: number, end_ts: number, reason: 'state' | 'timeout' | 'restart'): EventRow {
  const r = c.db.prepare('UPDATE events SET end_ts = ?, end_reason = ? WHERE id = ? RETURNING *').get(end_ts, reason, id) as DbRow | undefined;
  if (!r) throw new Error(`no event ${id}`);
  return fromDb(r);
}

export function eventById(c: Catalog, id: number): EventRow | undefined {
  const r = c.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as DbRow | undefined;
  return r ? fromDb(r) : undefined;
}

export function openEvents(c: Catalog, cam: string): EventRow[] {
  return (c.db.prepare('SELECT * FROM events WHERE cam = ? AND end_ts IS NULL ORDER BY start_ts, id').all(cam) as DbRow[]).map(fromDb);
}

export function listEvents(c: Catalog, q: { cam: string; from?: number; to?: number; kind?: string; limit?: number }): EventRow[] {
  const where = ['cam = ?'];
  const args: (string | number)[] = [q.cam];
  if (q.from !== undefined) (where.push('start_ts >= ?'), args.push(q.from));
  if (q.to !== undefined) (where.push('start_ts <= ?'), args.push(q.to));
  if (q.kind !== undefined) (where.push('kind = ?'), args.push(q.kind));
  const limit = Math.min(Math.max(1, q.limit ?? MAX_LIST), MAX_LIST);
  const sql = `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY start_ts DESC, id DESC LIMIT ${limit}`;
  return (c.db.prepare(sql).all(...args) as DbRow[]).map(fromDb);
}

// The newest event's start, recovered ones left out (#75): a reconstruction
// from the SD card is no fresh activity (the client API's lastEventTs).
export function lastLiveEventTs(c: Catalog, cam: string): number | null {
  const r = c.db.prepare("SELECT start_ts FROM events WHERE cam = ? AND source != 'recovered' ORDER BY start_ts DESC, id DESC LIMIT 1").get(cam) as { start_ts: number } | undefined;
  return r?.start_ts ?? null;
}

export function deleteEventsBefore(c: Catalog, ts: number): number {
  return Number(c.db.prepare('DELETE FROM events WHERE start_ts < ?').run(ts).changes);
}

// Events a previous run left open are closed at `at` (e.g. the last known
// time); returns the closed events.
export function closeAllOpen(c: Catalog, cam: string, at: number, reason: 'restart' | 'timeout' | 'state'): EventRow[] {
  const rows = c.db.prepare('UPDATE events SET end_ts = MAX(start_ts, ?), end_reason = ? WHERE cam = ? AND end_ts IS NULL RETURNING *').all(at, reason, cam) as DbRow[];
  return rows.map(fromDb);
}

// Events per kind that started in [from, to) (the daily audit record);
// recovered ones are counted apart (countRecoveredEvents).
export function countEventsByKind(c: Catalog, cam: string, from: number, to: number): Record<string, number> {
  const rows = c.db.prepare("SELECT kind, COUNT(*) AS n FROM events WHERE cam = ? AND start_ts >= ? AND start_ts < ? AND source != 'recovered' GROUP BY kind").all(cam, from, to) as { kind: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
}

// Recovered events (#75) that started in [from, to).
export function countRecoveredEvents(c: Catalog, cam: string, from: number, to: number): number {
  return Number((c.db.prepare("SELECT COUNT(*) AS n FROM events WHERE cam = ? AND start_ts >= ? AND start_ts < ? AND source = 'recovered'").get(cam, from, to) as { n: number }).n);
}

// Events of the given kinds that started in [from, to), recovered ones left
// out: an event recovered from the SD card is no sign that FTP should have
// delivered a clip (#75).
export function countEventsOfKinds(c: Catalog, cam: string, kinds: readonly string[], from: number, to: number): number {
  if (!kinds.length) return 0;
  const r = c.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE cam = ? AND start_ts >= ? AND start_ts < ? AND source != 'recovered' AND kind IN (${kinds.map(() => '?').join(', ')})`).get(cam, from, to, ...kinds) as { n: number };
  return Number(r.n);
}

// One event to recover: its kind, bounds and raw (what it came from).
export interface RecoveredEvent { kind: string; start_ts: number; end_ts: number; raw: unknown }

// Adds recovered events (#75) in one transaction. Each one only when no event
// of its kind (any source; an open one counts up to `openMs` long) overlaps
// [start − beforeMs, end + afterMs] by now: one the live intake or an earlier
// repair stored meanwhile wins (`matched`). Existing rows are never changed.
export function addRecoveredEvents(c: Catalog, cam: string, list: RecoveredEvent[], o: { beforeMs: number; afterMs: number; openMs: number }): { added: EventRow[]; matched: number } {
  const exists = c.db.prepare('SELECT 1 AS x FROM events WHERE cam = ? AND kind = ? AND start_ts <= ? AND COALESCE(end_ts, start_ts + ?) >= ? LIMIT 1');
  const insert = c.db.prepare("INSERT INTO events (cam, source, kind, start_ts, end_ts, end_reason, raw) VALUES (?, 'recovered', ?, ?, ?, 'recovered', ?) RETURNING *");
  const added: EventRow[] = [];
  let matched = 0;
  c.db.exec('BEGIN');
  try {
    for (const e of list) {
      if (exists.get(cam, e.kind, e.end_ts + o.afterMs, o.openMs, e.start_ts - o.beforeMs)) {
        matched++;
        continue;
      }
      added.push(fromDb(insert.get(cam, e.kind, e.start_ts, e.end_ts, JSON.stringify(e.raw ?? null)) as DbRow));
    }
    c.db.exec('COMMIT');
  } catch (err) {
    c.db.exec('ROLLBACK');
    throw err;
  }
  return { added, matched };
}
