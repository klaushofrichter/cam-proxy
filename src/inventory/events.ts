import { setImmediate as yieldToLoop } from 'timers/promises';
import type { Catalog } from '../catalog/db';
import { localDate, type Kind, type Stream } from '../recordings/names';
import type { RecordingEntry } from '../recordings/list';
import { listCamera, type CameraListDeps } from './camera-list';
import { RECORDING_KINDS, SETTLE_MS } from './clips';
import { coverage, spansByKind } from './match';
import { MAX_TOP, type Check, type CheckContext, type CheckResult, type InventoryWindow } from './runner';

// The events inventory (#75, spec 2026-10-02-inventory-design §5): the SD
// recordings are the camera's own list of what it saw. Per trigger kind,
// overlapping recordings are merged into spans; a span needs an event of the
// same kind overlapping [start − 10 s, end + 5 s] (decision 7), else it is
// missing (one event per kind per span is what the repair adds). Timer-only
// recordings are ignored and counted. Recording-kind events with no
// triggered recording near them are reported only. The window is the SD
// card's reach, at most the events retention (decision 12); the report says
// which. Always against the camera: there is no local-only part.

const DAY = 86_400_000;
// The tolerance around a span (decision 7): an event may start up to 10 s
// before the recording (the camera's pre-record) and up to 5 s after its end.
export const SPAN_BEFORE_MS = 10_000;
export const SPAN_AFTER_MS = 5_000;
const YIELD_EVERY = 1_000;
const KIND_NAMES = ['person', 'vehicle', 'pet', 'motion'] as const;
const cap = (k: string) => k[0].toUpperCase() + k.slice(1);

// eventMaxOpenMin: events.maxOpenMin, how long an open event can last.
export interface EventsSettings { cam: string; eventsDays: number; stream: Stream; eventMaxOpenMin: number }
export interface EventsInventoryDeps {
  catalog: Catalog;
  settings: () => EventsSettings; // read when a run starts
  camera: CameraListDeps;
}
// A missing span: `date` is the camera-local day of its first recording;
// `recordings` are the SD ids merged into it.
export interface MissingSpan { type: 'missing-event'; kind: Kind; start: number; end: number; date: string; recordings: string[] }
export type EventItem = MissingSpan | { type: 'event-without-recording'; eventId: number; kind: string; start: number; end: number; source: string };
// The camera days with problems, the most missing first (the report's `top`).
export interface EventsDayRow { date: string; state: 'listed' | 'unknown'; spans: number; missing: number }
export interface EventsComparison {
  window: InventoryWindow;
  counts: Record<string, number>;
  top: EventsDayRow[];
  missing: MissingSpan[]; // all of them, oldest first
  withoutRecording: EventItem[];
  stream: Stream;
  cancelled: boolean;
}

const UNJUDGED_NOTE = (n: number) => `${n} recording spans or events next to a day the camera did not list were not judged`;
const REACH_NOTE = (eventsDays: number) => `The window is the SD card's reach, shorter than the ${eventsDays}-day events retention: older recordings are overwritten`;
const BOUNDS_NOTE = 'A recovered event spans its recordings, pre- and post-record included, so it starts a few seconds before what the camera saw';

interface EventSpan { id: number; kind: string; source: string; start_ts: number; end_ts: number | null }

// The comparison the check reports and the repair works from. `until`
// (the repair): judge only spans that ended by then, the check's bound.
export async function compareEvents(d: EventsInventoryDeps, ctx: Pick<CheckContext, 'signal' | 'progress' | 'now'>, until?: number): Promise<EventsComparison> {
  const s = d.settings();
  const now = ctx.now;
  const retentionFrom = now - s.eventsDays * DAY; // as the storage retention deletes them
  const settled = Math.min(now - SETTLE_MS, until ?? Infinity);
  const openCap = s.eventMaxOpenMin * 60_000;
  let listing;
  try {
    listing = await listCamera(d.camera, {
      from: retentionFrom, to: now, stream: s.stream, signal: ctx.signal,
      progress: (done, total, date) => ctx.progress({ phase: 'camera', done, total, note: date }),
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'camera_offline') throw new Error(`camera_offline: ${(err as Error).message}`);
    throw err;
  }
  const t = listing.time;
  const listed = new Set(listing.days.filter((x) => x.state === 'listed').map((x) => x.date));
  const unknown = listing.days.filter((x) => x.state === 'unknown').map((x) => x.date);
  const dayOf = new Map(listing.days.flatMap((x) => x.recordings.map((r) => [r.id, x.date] as const)));
  const pool: RecordingEntry[] = listing.days.flatMap((x) => x.recordings).filter((r) => r.end >= retentionFrom);
  const triggered = pool.filter((r) => r.kinds.length > 0);
  // The SD card's reach: its oldest recording in the window (the card
  // overwrites from its oldest end, so that day keeps only its later hours).
  const reach = pool.length ? Math.min(...pool.map((r) => r.start)) : null;
  const from = reach === null ? null : Math.max(retentionFrom, reach);
  const reason = from === null ? 'empty' : from > retentionFrom ? 'sd-card' : 'retention';
  const notes: string[] = reason === 'sd-card' ? [REACH_NOTE(s.eventsDays), BOUNDS_NOTE] : [BOUNDS_NOTE];
  const window: InventoryWindow = {
    from, to: now, reason, retentionFrom, eventsDays: s.eventsDays, notes,
    camera: { stream: s.stream, to: settled, oldestSdDay: listing.oldestSdDay, unknownDays: unknown },
  };
  // Judged: inside [from, settled], and both tolerance edges on listed days
  // (a recording on a day the camera did not list could change the answer).
  const clear = (lo: number, hi: number) => listed.has(localDate(lo, t)) && listed.has(localDate(hi, t));
  let unjudged = 0;
  const spans = spansByKind(triggered).filter((x) => {
    if (from === null || x.start < from || x.end > settled) return false;
    if (clear(x.start - SPAN_BEFORE_MS, x.end + SPAN_AFTER_MS)) return true;
    unjudged++;
    return false;
  });
  await yieldToLoop();

  // The events near the window, per kind; an open one covers its start plus
  // events.maxOpenMin (the tracker closes it then).
  const lo = (from ?? now) - SPAN_BEFORE_MS - openCap;
  const evs = d.catalog.db
    .prepare('SELECT id, kind, source, start_ts, end_ts FROM events WHERE cam = ? AND start_ts <= ? AND COALESCE(end_ts, start_ts + ?) >= ? ORDER BY start_ts, id')
    .all(s.cam, now + SPAN_AFTER_MS, openCap, lo) as unknown as EventSpan[];
  // Yields between the steps and every YIELD_EVERY events: 30 days of events
  // (30k rows) in one step held the event loop for 60 ms (the bench).
  await yieldToLoop();
  const byKind = new Map<string, { start: number; end: number }[]>();
  for (const e of evs) {
    const list = byKind.get(e.kind) ?? [];
    list.push({ start: e.start_ts, end: e.end_ts ?? e.start_ts + openCap });
    byKind.set(e.kind, list);
  }
  const covers = new Map([...byKind].map(([k, list]) => [k, coverage(list)]));
  await yieldToLoop();
  const missing: MissingSpan[] = [];
  for (const x of spans) {
    if (covers.get(x.kind)?.(x.start - SPAN_BEFORE_MS, x.end + SPAN_AFTER_MS)) continue;
    missing.push({ type: 'missing-event', kind: x.kind as Kind, start: x.start, end: x.end, date: dayOf.get(x.recs[0].id)!, recordings: x.recs.map((r) => r.id) });
  }

  // Recording-kind events with no triggered recording near them (any kind: a
  // person event in a recording flagged only for motion has its recording).
  // Report only: the recording may be off, or the event a false one.
  const recCover = coverage(triggered.map((r) => ({ start: r.start, end: r.end })));
  const recordingKind = new Set<string>(RECORDING_KINDS);
  const withoutRecording: EventItem[] = [];
  let events = 0;
  for (const [i, e] of evs.entries()) {
    if (i && i % YIELD_EVERY === 0) await yieldToLoop();
    if (from === null || !recordingKind.has(e.kind) || e.end_ts === null || e.start_ts < from || e.end_ts > settled) continue;
    if (!clear(e.start_ts - SPAN_AFTER_MS, e.end_ts + SPAN_BEFORE_MS)) {
      unjudged++;
      continue;
    }
    events++;
    if (recCover(e.start_ts - SPAN_AFTER_MS, e.end_ts + SPAN_BEFORE_MS)) continue;
    withoutRecording.push({ type: 'event-without-recording', eventId: e.id, kind: e.kind, start: e.start_ts, end: e.end_ts, source: e.source });
  }
  if (unjudged) notes.push(UNJUDGED_NOTE(unjudged));

  const judged = (r: RecordingEntry) => from !== null && r.start >= from && r.end <= settled;
  const counts: Record<string, number> = {
    eventsDays: s.eventsDays,
    cameraDays: listing.days.length,
    unknownDays: unknown.length,
    recordings: triggered.filter(judged).length,
    timerOnly: pool.filter((r) => r.kinds.length === 0 && judged(r)).length,
    spans: spans.length,
    matched: spans.length - missing.length,
    missingEvents: missing.length,
    ...Object.fromEntries(KIND_NAMES.map((k) => [`missing${cap(k)}`, missing.filter((m) => m.kind === k).length])),
    events,
    eventsWithoutRecording: withoutRecording.length,
  };
  const perDay = new Map<string, EventsDayRow>(listing.days.map((x) => [x.date, { date: x.date, state: x.state, spans: 0, missing: 0 }]));
  for (const x of spans) perDay.get(dayOf.get(x.recs[0].id)!)!.spans++;
  for (const m of missing) perDay.get(m.date)!.missing++;
  const top = [...perDay.values()]
    .filter((x) => x.state === 'unknown' || x.missing)
    .sort((a, b) => b.missing - a.missing || a.date.localeCompare(b.date))
    .slice(0, MAX_TOP);
  return { window, counts, top, missing, withoutRecording, stream: s.stream, cancelled: ctx.signal.aborted };
}

// "person 3, motion 9" (the kinds with any), or "none".
export function byKindText(counts: Record<string, number>, prefix: string): string {
  return KIND_NAMES.filter((k) => counts[`${prefix}${cap(k)}`]).map((k) => `${k} ${counts[`${prefix}${cap(k)}`]}`).join(', ') || 'none';
}

export function eventsCheck(d: EventsInventoryDeps): Check {
  return async (ctx): Promise<CheckResult> => {
    const r = await compareEvents(d, ctx);
    const c = r.counts;
    const w = r.window;
    const since = w.from === null ? null : new Date(w.from).toISOString().slice(0, 10);
    const message = w.from === null
      ? `no recordings on the SD card (${r.stream}) in the last ${c.eventsDays} days`
      : `${c.missingEvents} of ${c.spans} recording spans without an event (${byKindText(c, 'missing')}) since ${since} (${w.reason === 'sd-card' ? "the SD card's reach" : `the ${c.eventsDays}-day retention`}), ` +
        `${c.eventsWithoutRecording} of ${c.events} events without a recording, ${c.unknownDays} days unknown`;
    return { window: w, counts: c, top: r.top, items: [...r.missing, ...r.withoutRecording], message };
  };
}
