import type { Catalog } from '../catalog/db';
import type { MoveRecord } from './journal';

// The high water of a camera's content on this proxy (move step 4, ruling 7):
// recorded by the target at a cancel after the switch-over, before the
// camera's node leaves. The copy back (the return) serves only rows at or
// below these ids, and only row-less files (stills, previews) written up to
// `at` (this proxy's own clock): a camera re-added under the same id after
// the cancel (Review Focus 1) is neither copied back nor deleted by it.
// Per camera, not per table: a row of this camera written later always gets
// a larger id than any of its rows now. A table without rows of it: 0.
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
