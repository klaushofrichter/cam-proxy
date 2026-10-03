import { addRecoveredEvents } from '../catalog/events';
import { byKindText, compareEvents, SPAN_AFTER_MS, SPAN_BEFORE_MS, type EventsInventoryDeps } from './events';
import type { InventoryReport, RepairEntry, RepairResult } from './runner';

// The events repair (#75, spec 2026-10-02-inventory-design §5): add the
// events a recent check found missing. The check is the dry run; the repair
// compares again (the report keeps 500 items, a run adds up to 1000, and
// what changed since counts), judging only spans that ended by the check's
// bound, so it never adds what the check could not have shown. Each missing
// span becomes one event of its kind: source and end_reason 'recovered',
// the span's start and end (the recordings', pre- and post-record
// included), raw {runId, check, recordings, stream, bounds}. Oldest first,
// at most RECOVER_MAX per run, in one transaction; a span whose kind got an
// event meanwhile is skipped. Existing rows are never changed or deleted;
// no SSE, no stream log, no analytics (decision 3).

export const RECOVER_MAX = 1000;
const BOUNDS = "the recordings' start and end, pre- and post-record included";

export type EventsRepairDeps = EventsInventoryDeps;

const cameraTo = (r: InventoryReport): number | undefined => {
  const c = (r.window as { camera?: { to?: unknown } } | null)?.camera;
  return typeof c?.to === 'number' ? c.to : undefined;
};

export function eventsRepair(d: EventsRepairDeps, limits: { events?: number } = {}): RepairEntry {
  const ready = (source: InventoryReport): string | null => (source.counts.missingEvents ? null : 'no events are missing');

  const run = async (ctx: Parameters<RepairEntry['run']>[0]): Promise<RepairResult> => {
    const max = limits.events ?? RECOVER_MAX;
    const cmp = await compareEvents(d, ctx, cameraTo(ctx.source));
    const list = cmp.missing.slice(0, max);
    const counts: Record<string, number> = { checked: ctx.source.counts.missingEvents ?? 0, candidates: cmp.missing.length, requested: 0, done: 0, failed: 0, skipped: 0 };
    if (cmp.cancelled || ctx.signal.aborted) return { counts, top: [], items: [], message: 'nothing added', stopped: null };
    counts.requested = list.length;
    ctx.progress({ phase: 'repair', done: 0, total: list.length });
    const cam = d.settings().cam;
    const { added, matched } = addRecoveredEvents(
      d.catalog, cam,
      list.map((m) => ({ kind: m.kind, start_ts: m.start, end_ts: m.end, raw: { runId: ctx.runId, check: ctx.source.runId, recordings: m.recordings, stream: cmp.stream, bounds: BOUNDS } })),
      { beforeMs: SPAN_BEFORE_MS, afterMs: SPAN_AFTER_MS, openMs: d.settings().eventMaxOpenMin * 60_000 },
    );
    counts.done = added.length;
    counts.skipped = matched;
    for (const k of ['person', 'vehicle', 'pet', 'motion']) counts[`done${k[0].toUpperCase()}${k.slice(1)}`] = added.filter((e) => e.kind === k).length;
    ctx.progress({ phase: 'repair', done: list.length, total: list.length });
    const stopped = cmp.missing.length > list.length ? 'event-cap' : null;
    const items = added.map((e) => ({ eventId: e.id, kind: e.kind, start: e.start_ts, end: e.end_ts, result: 'ok' as const }));
    const message =
      `${added.length} of ${list.length} missing events added (${byKindText(counts, 'done')}), ${matched} had an event by then` +
      `${stopped ? `; stopped: the ${max}-event cap` : ''}`;
    return { counts, top: [], items, message, stopped };
  };

  return { run, ready };
}
