# Inventory PR 3: the events inventory and the recovered events (#75) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can check the stored events against the camera's SD recordings ("Check events", the dry run) and add the events the proxy missed ("Add N missing events"), from the Maintenance page or the control API; recovered events are marked everywhere, never sent over SSE or the stream log, never analysed, and never counted as live events.

**Architecture:** PR 2's pieces are reused as they are: `listCamera()` (`src/inventory/camera-list.ts`: the month overview, one Search per day with recordings, failed days `unknown`, `oldestSdDay`), the runner's repair op (one lock, `<kind>repair` folder, `inventory-repair` record), `SETTLE_MS` and `RECORDING_KINDS` (`src/inventory/clips.ts`). New: `coverage()` moves from `clips.ts` into `match.ts` next to a new `spansByKind()` (the per-kind merge); `src/inventory/events.ts` (`compareEvents()`, shared by the check and the repair, and `eventsCheck()`); `src/inventory/repair-events.ts` (`eventsRepair()`: compares again, then `addRecoveredEvents()` in one transaction). The catalog gets `source`/`end_reason` `recovered` (no migration: the columns are TEXT without CHECK) and leaves recovered rows out of `unanalysed()`, `countEventsOfKinds()` (the FTP stall check) and `countEventsByKind()` (the daily activity record, which counts them apart). The runner hands a repair its own `runId` (the rows carry it). The Inventory box gets "Check events" and the offer; the Events page and the Timeline mark recovered events.

**Tech Stack:** Node 26+ (engines `>=26`), TypeScript, Express 5, `node:sqlite`, Svelte 5 runes, Vitest, Playwright, cam-sim v2026.10.02.1 (already pinned: SD card with trigger flags, Search, the `offline` fault; no bump).

**Spec:** `docs/superpowers/specs/2026-10-02-inventory-design.md` (§0 correction 10; §1; §2; §5 events; §7 the admin UI; decisions 3, 4, 5, 6, 7, 8, 9, 12; error handling; risks "Wrong recovered events"; "Rulings during the build" for PR 1 and PR 2, which this PR follows: not-judged edges, settle time, a busy Search tried 3 times, repair runs kept apart). Issues #75 (the feature), #106 and #111 (deferred items; none blocks this PR, see "Spec corrections and choices").

## Global Constraints

- No new runtime or dev dependency; cam-sim stays at v2026.10.02.1. No catalog migration: the schema stays at version 6 (`events.source` and `events.end_reason` are TEXT without CHECK).
- Start the check: `POST /control/actions/inventory` `{"kind":"events"}` → 202 `{runId}` (`events-<ms>-<6 hex>`); 400 `invalid` (`kind is one of: stills, clips, events`); `camera` is not an option of this kind (it always compares with the camera); 409 `inventory_busy`; 503 `stopping`.
- Start the repair: `POST /control/actions/inventory-repair` `{"kind":"events","runId":"events-…"}` → 202 `{runId}` (`eventsrepair-<ms>-<6 hex>`); 400 `invalid` (`kind is one of: clips, events`); 404 `not_found`; 409 `report_stale` (1 h or older), `not_repairable` (not `ok`, or `no events are missing`), `inventory_busy`; 503 `stopping`. Button only, never scheduled.
- Window: `retentionFrom = now − retention.eventsDays · 86 400 000` (exactly as `src/storage.ts` deletes events); `from = max(retentionFrom, the oldest listed SD recording's start)` (the SD card's reach); `reason` `sd-card` (the reach is shorter), `retention`, or `empty` (no recordings, `from: null`); judged only what ended by `window.camera.to = now − SETTLE_MS` (300 000 ms); the report states the window (decision 12).
- Camera list: `listCamera()` on `ftp.stream` at run time, from `retentionFrom` to now; a day whose Search fails is `unknown`; an offline camera fails the run with `camera_offline: …`.
- Matching (decision 7): per trigger kind (`person`, `vehicle`, `pet`, `motion`) the recordings that overlap or touch are merged into one span; a recording with several kinds is in one span per kind; a span is matched by an event of the same kind (any source, an open one counting `events.maxOpenMin` from its start) overlapping `[start − SPAN_BEFORE_MS, end + SPAN_AFTER_MS]`, `SPAN_BEFORE_MS = 10_000`, `SPAN_AFTER_MS = 5_000`; timer-only recordings are ignored and counted (`timerOnly`, decision 8); a span or event whose tolerance edges touch a day the camera did not list is not judged (a note gives the count).
- Recovered event (decision 9): one per kind per missing span; `source: 'recovered'`, `end_reason: 'recovered'`, `start_ts`/`end_ts` = the span's (the recordings', pre- and post-record included); `raw: {runId (the repair's), check (the check's run id), recordings: [SD ids], stream, bounds: "the recordings' start and end, pre- and post-record included"}`.
- Repair: compares again with the check's `window.camera.to` as the upper bound; oldest first; at most `RECOVER_MAX = 1000` per run (`stopped: 'event-cap'` when more are missing); all inserts in one transaction; a span whose kind has an event by then is skipped (`skipped`); existing rows are never changed or deleted.
- Kept out (decision 3, §0 correction 10): no SSE message and no stream-log entry; `unanalysed()` skips `recovered` (no Google Vision call, paid); `clipsStalled()` (via `countEventsOfKinds`) and the `activity-daily` `events` counts leave them out; `activity-daily` gives `events.recovered` apart.
- Recovered events are served by `GET /api/cameras/:cam/events` with `source: "recovered"`, `endReason: "recovered"` (cams sees them marked; cams reads `/analyses` and SSE today, not `/events`).
- Audit: `inventory` (kind `events`) per check, `inventory-repair` (kind `events`, host / change) per repair, as PR 2.
- UI: "Check events"; under a check less than an hour old with `missingEvents > 0` that no repair used: "Add N missing events" (N = min(missingEvents, 1000)), confirmed through the Maintenance page's shared dialog like the clips repair; the Events page and the Timeline mark recovered events.
- CHANGELOG entries go under `## Unreleased`; never write a version number. Never print secrets or read `.env`. Work on a feature branch, PR to `main`; stage files explicitly (`git add <paths>`).

## Review Focus

- A repair run twice, or after a live event arrived since the check, must not add a duplicate: the repair compares again, and `addRecoveredEvents()` checks each span inside the transaction (Task 1 "a second run adds nothing", "skips one whose kind already has an event"; Task 3 "compares again").
- A day whose Search failed (or a span whose tolerance reaches into such a day) must never produce a missing event or an event "without a recording" (Task 2 "a day whose Search failed is unknown").
- A recording still being written or just ended (the live event may still close) must not be called missing: judged only up to `now − SETTLE_MS`, and the repair never goes past the check's bound (Task 2 fixture `fresh`; Task 2 "the repair's bound"; Task 3 "nothing past the check's bound").
- A restart right after a repair must not send recovered events to Google Vision (paid): `unanalysed()` skips them (Task 1 "analytics never picks them up").
- Recovered events must not hide an FTP stall nor inflate the daily live counts (Task 1 "they never make the FTP check stall", "the daily counts leave them out"; Task 1 `activity-daily` test).

## Spec corrections and choices

Checked against PR 2's code (`origin/feat/inventory-clips`, dfd936a); each is in the code below.

1. **The window starts at the oldest recording, not the oldest SD day.** The card overwrites from its oldest end, so that day keeps only its later hours (PR 2's ruling for "gone"); an event before the first recording would otherwise count as "without a recording".
2. **The events retention bound is `now − eventsDays · 1 day`**, not a whole UTC day: `src/storage.ts` deletes events by `start_ts < now − eventsDays · DAY`, so a recovered event never lands where the next retention run deletes it.
3. **The repair compares again** instead of reading the check's items: the report keeps 500 items, a run adds up to 1000. It stays inside what the check showed by judging only spans that ended by the check's `window.camera.to`; `checked` (the check's count) and `candidates` (now) are both in the report.
4. **Removal by run id** is a documented SQL statement (`json_extract(raw, '$.runId')`), not an API route (the spec says "can be removed if needed"; nothing removes them automatically).
5. **Events without a recording** match a triggered recording of any kind (a person event inside a recording flagged only for motion has its recording), with the mirrored tolerance (`[start − 5 s, end + 10 s]`). Report only.
6. **#75's text says "nothing is sent to cams"**; Klaus's decision for this PR: recovered events are served by `/api/cameras/:cam/events`, marked `source: 'recovered'`. Today cams reads `/analyses` and SSE only, so nothing changes there; Task 4 files a cams issue as the note.
7. **#106 and #111:** none of their items blocks this PR. #111's "late-night recording still being written" also applies here (a span from such a recording could be judged after 00:05); its "oldestSdDay is the window month's oldest" only shortens the window (a false negative, never a false missing). Both stay in #111.

---

## File structure

| File | Responsibility |
|---|---|
| `src/catalog/events.ts` (modify) | `EventSource`/`EndReason` with `recovered`; `addRecoveredEvents()` (one transaction, re-check per span); `countRecoveredEvents()`; `countEventsByKind()`/`countEventsOfKinds()` leave recovered out. |
| `src/catalog/analyses.ts`, `src/events/tracker.ts`, `src/audit/daily.ts`, `src/proxy.ts` (modify) | `unanalysed()` skips recovered; the tracker's close takes the wider source type; `activity-daily` counts recovered apart. |
| `src/inventory/match.ts`, `src/inventory/clips.ts` (modify) | `coverage()` moves to `match.ts` (shared); `spansByKind()`. |
| `src/inventory/events.ts` (new) | `compareEvents()` (window, spans, matching, items, top) and `eventsCheck()`. |
| `src/inventory/runner.ts` (modify) | `RepairContext.runId`: a repair knows its own run id. |
| `src/inventory/repair-events.ts` (new) | `eventsRepair()`: compare again, add up to 1000 in one transaction. |
| `src/proxy.ts` (modify) | The `events` kind with its repair. |
| `README.md`, `openapi.yaml`, `docs/audit-log.md`, `CHANGELOG.md` (modify) | The routes, the `source`/`endReason` values, the records, the change. |
| `web/src/lib/inventory.ts`, `web/src/lib/timeline.ts`, `web/src/components/InventoryCard.svelte`, `web/src/pages/Maintenance.svelte`, `web/src/pages/Events.svelte`, `web/src/pages/Timeline.svelte` (modify) | The events lines and offer, the confirm, the marks. |
| Tests: `test/catalog-recovered.test.ts`, `test/inventory-events.test.ts`, `test/inventory-repair-events.test.ts`, `test/inventory-events-api.test.ts` (new); `test/ftp-health.test.ts`, `test/inventory-match.test.ts`, `test/inventory-runner.test.ts`, `test/inventory-repair-clips.test.ts`, `test/inventory-api.test.ts`, `test/inventory-clips-api.test.ts`, `test/inventory-ui.test.ts`, `test/timeline-ui.test.ts`, `e2e/inventory.spec.ts` (modify) | |

---

### Task 1: Recovered events in the catalog, kept out of analytics, the stall check and the daily counts

**Files:**
- Modify: `src/catalog/events.ts` (types, the two counts, two new functions), `src/catalog/analyses.ts` (`unanalysed`), `src/events/tracker.ts` (`close`'s source type), `src/audit/daily.ts` (`activityDaily`), `src/proxy.ts` (the activity record)
- Create: `test/catalog-recovered.test.ts`
- Test: `test/ftp-health.test.ts` (the `activity-daily` describe)

**Interfaces:**
- Consumes: nothing new.
- Produces (in `src/catalog/events.ts`): `export type EventSource = 'onvif' | 'poll' | 'recovered'`; `export type EndReason = 'state' | 'timeout' | 'restart' | 'recovered'`; `EventRow.source: EventSource`, `EventRow.end_reason: EndReason | null`; `export interface RecoveredEvent { kind: string; start_ts: number; end_ts: number; raw: unknown }`; `export function addRecoveredEvents(c: Catalog, cam: string, list: RecoveredEvent[], o: { beforeMs: number; afterMs: number; openMs: number }): { added: EventRow[]; matched: number }`; `export function countRecoveredEvents(c: Catalog, cam: string, from: number, to: number): number`. `activityDaily(day, a)` takes an optional `a.recovered?: number` and reports `details.events.recovered`.

- [ ] **Step 1: Write the failing tests**

Create `test/catalog-recovered.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { addRecoveredEvents, closeAllOpen, closeEvent, countEventsByKind, countEventsOfKinds, countRecoveredEvents, insertEvent, listEvents, type RecoveredEvent } from '../src/catalog/events';
import { unanalysed } from '../src/catalog/analyses';
import { clipsStalled } from '../src/clips/ftp-health';

// Recovered events (#75, spec 2026-10-02-inventory-design §5): added from
// the SD recordings by the events repair, marked, closed at once, and kept
// out of analytics, the FTP stall check and the daily event counts.
let dir: string;
let c: Catalog;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-recovered-'));
  c = openCatalog(join(dir, 'catalog.sqlite'));
});
afterEach(() => {
  c.close();
  rmSync(dir, { recursive: true, force: true });
});

const TOL = { beforeMs: 10_000, afterMs: 5_000, openMs: 600_000 };
const live = (kind: string, start: number, end: number | null) => {
  const e = insertEvent(c, { cam: 'cam1', source: 'onvif', kind, start_ts: start, raw: null });
  return end === null ? e : closeEvent(c, e.id, end, 'state');
};
const rec = (kind: string, start: number, end: number, runId = 'eventsrepair-1-abcdef'): RecoveredEvent => ({ kind, start_ts: start, end_ts: end, raw: { runId, recordings: [`R${start}`] } });

describe('addRecoveredEvents', () => {
  it('adds closed, marked events with their raw', () => {
    const { added, matched } = addRecoveredEvents(c, 'cam1', [rec('person', 100_000, 130_000), rec('motion', 100_000, 130_000)], TOL);
    expect(matched).toBe(0);
    expect(added.map((e) => [e.kind, e.source, e.start_ts, e.end_ts, e.end_reason])).toEqual([
      ['person', 'recovered', 100_000, 130_000, 'recovered'],
      ['motion', 'recovered', 100_000, 130_000, 'recovered'],
    ]);
    expect(added[0].raw).toEqual({ runId: 'eventsrepair-1-abcdef', recordings: ['R100000'] });
    expect(listEvents(c, { cam: 'cam1' })).toHaveLength(2);
  });

  it('skips one whose kind already has an event in [start − 10 s, end + 5 s], open ones included; never changes that event', () => {
    const before = live('person', 80_000, 90_000); // ends exactly 10 s before the start
    const after = live('motion', 135_000, 140_000); // starts exactly 5 s after the end
    live('pet', 50_000, null); // open since 50 s: counts up to 10 min
    const { added, matched } = addRecoveredEvents(c, 'cam1', [rec('person', 100_000, 130_000), rec('motion', 100_000, 130_000), rec('pet', 100_000, 130_000), rec('vehicle', 100_000, 130_000)], TOL);
    expect(matched).toBe(3);
    expect(added.map((e) => e.kind)).toEqual(['vehicle']);
    expect(listEvents(c, { cam: 'cam1', kind: 'person' })).toEqual([before]);
    expect(listEvents(c, { cam: 'cam1', kind: 'motion' })).toEqual([after]);
  });

  it('adds one when the nearest event of its kind is just outside the tolerance, or of another camera', () => {
    live('person', 80_000, 89_999); // 10.001 s before
    live('motion', 135_001, 140_000); // 5.001 s after
    insertEvent(c, { cam: 'cam2', source: 'onvif', kind: 'pet', start_ts: 100_000, raw: null });
    const { added } = addRecoveredEvents(c, 'cam1', [rec('person', 100_000, 130_000), rec('motion', 100_000, 130_000), rec('pet', 100_000, 130_000)], TOL);
    expect(added.map((e) => e.kind)).toEqual(['person', 'motion', 'pet']);
  });

  it('a second run adds nothing: the first run\'s events match', () => {
    addRecoveredEvents(c, 'cam1', [rec('person', 100_000, 130_000)], TOL);
    expect(addRecoveredEvents(c, 'cam1', [rec('person', 100_000, 130_000, 'eventsrepair-2-abcdef')], TOL)).toEqual({ added: [], matched: 1 });
  });

  it('is one transaction: a failure adds none', () => {
    const bad: RecoveredEvent = { kind: 'motion', start_ts: 200_000, end_ts: 230_000, raw: { n: 1n } }; // JSON.stringify throws on a BigInt
    expect(() => addRecoveredEvents(c, 'cam1', [rec('person', 100_000, 130_000), bad], TOL)).toThrow();
    expect(listEvents(c, { cam: 'cam1' })).toEqual([]);
  });

  it('a run\'s events can be found (and removed) by its run id', () => {
    addRecoveredEvents(c, 'cam1', [rec('person', 100_000, 130_000, 'eventsrepair-1-abcdef'), rec('person', 300_000, 330_000, 'eventsrepair-2-abcdef')], TOL);
    const sql = "DELETE FROM events WHERE source = 'recovered' AND json_extract(raw, '$.runId') = ?";
    expect(Number(c.db.prepare(sql).run('eventsrepair-1-abcdef').changes)).toBe(1);
    expect(listEvents(c, { cam: 'cam1' }).map((e) => e.start_ts)).toEqual([300_000]);
  });
});

describe('recovered events are kept apart', () => {
  it('the daily counts leave them out and count them apart', () => {
    live('person', 1000, 2000);
    addRecoveredEvents(c, 'cam1', [rec('person', 30_000, 40_000), rec('motion', 30_000, 40_000)], TOL);
    expect(countEventsByKind(c, 'cam1', 0, 50_000)).toEqual({ person: 1 });
    expect(countRecoveredEvents(c, 'cam1', 0, 50_000)).toBe(2);
    expect(countRecoveredEvents(c, 'cam1', 0, 30_000)).toBe(0);
    expect(countEventsOfKinds(c, 'cam1', ['person', 'motion'], 0, 50_000)).toBe(1);
  });

  it('analytics never picks them up (a Vision call costs money)', () => {
    const l = live('person', 100_000, 110_000);
    addRecoveredEvents(c, 'cam1', [rec('person', 300_000, 310_000)], TOL);
    expect(unanalysed(c, 'cam1', ['person'], 0).map((e) => e.id)).toEqual([l.id]);
  });

  it('they never make the FTP check stall: no clip was due for them', () => {
    const H = 3_600_000;
    const NOW = Date.UTC(2026, 9, 1, 21, 0, 0);
    addRecoveredEvents(c, 'cam1', [rec('person', NOW - 3 * H, NOW - 3 * H + 30_000)], TOL);
    expect(clipsStalled(c, 'cam1', NOW, 6)).toMatchObject({ stalled: false, events: 0 });
  });

  it('a restart closes no recovered event (they are closed already)', () => {
    addRecoveredEvents(c, 'cam1', [rec('person', 100_000, 130_000)], TOL);
    expect(closeAllOpen(c, 'cam1', 999_999, 'restart')).toEqual([]);
  });
});
```

In `test/ftp-health.test.ts`, in `describe('activity-daily (#93): clipsReceived next to the events', …)`, add before `it('a quiet day: no events, no clips, no flag', …)`:

```ts
  it('counts events recovered from the SD card apart (#75)', () => {
    const a = activityDaily('2026-09-30', { events: { person: 3 }, recovered: 2, clips: 3, vision, analyses: {}, sseClients: 0 });
    expect(a.details).toMatchObject({ events: { total: 3, byKind: { person: 3 }, recovered: 2 }, recordingEvents: 3 });
    expect(a.message).toBe('Activity 2026-09-30: 3 events (person 3), 2 recovered from the SD card, 3 clips received, Vision 3 of 100 this month');
    expect(activityDaily('2026-09-30', { events: {}, clips: 0, vision, analyses: {}, sseClients: 0 }).details).toMatchObject({ events: { recovered: 0 } });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/catalog-recovered.test.ts test/ftp-health.test.ts`
Expected: FAIL (`addRecoveredEvents` and `countRecoveredEvents` are not exported; the activity record has no `recovered`).

- [ ] **Step 3: Write the implementation**

`src/catalog/events.ts`: replace the `EventRow` interface with

```ts
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
```

and replace everything from `// Events per kind that started in [from, to) (the daily audit record).` to the end of the file with

```ts
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
```

`src/catalog/analyses.ts`, `unanalysed()`: add the comment line and the `source` condition:

```ts
// Events of the given kinds since a time that have no analysis (any provider).
// Recovered events (#75) are never analysed: a Vision call costs money.
export function unanalysed(c: Catalog, cam: string, kinds: string[], since: number): { id: number; kind: string; start_ts: number }[] {
  if (!kinds.length) return [];
  return c.db
    .prepare(
      `SELECT e.id, e.kind, e.start_ts FROM events e
       WHERE e.cam = ? AND e.start_ts >= ? AND e.source != 'recovered' AND e.kind IN (${kinds.map(() => '?').join(',')})
         AND NOT EXISTS (SELECT 1 FROM analyses a WHERE a.event_id = e.id)
       ORDER BY e.start_ts, e.id`,
    )
    .all(cam, since, ...kinds) as { id: number; kind: string; start_ts: number }[];
}
```

`src/events/tracker.ts`: the tracker passes an open event's `source` to `close()`, now typed `EventSource` (a recovered event is never open; `apply()` keeps taking `'onvif' | 'poll'` only). Change the import and `close`'s parameter:

```ts
import { closeEvent, insertEvent, openEvents, type EventSource } from '../catalog/events';
```

```ts
  private close(id: number, kind: string, ts: number, reason: 'state' | 'timeout', source: EventSource): void {
```

`src/audit/daily.ts`: replace `activityDaily` (and its comment) with

```ts
// The activity-daily record of a camera day. `clipsReceived` (#93) next to
// the events: a day with recording events but no clips stands out (`noClips`
// and the message), as 2026-09-30 would have. `clips` is the same count,
// kept for readers of older records. `events` are the live ones; events
// recovered from the SD card (#75) are counted apart (`events.recovered`).
export function activityDaily(day: string, a: { events: Record<string, number>; recovered?: number; clips: number; vision: { day: number; monthToDate: number; monthlyLimit: number }; analyses: Record<string, number>; sseClients: number }): ActivityDaily {
  const total = Object.values(a.events).reduce((x, y) => x + y, 0);
  const recovered = a.recovered ?? 0;
  const recordingEvents = RECORDING_KINDS.reduce((n, k) => n + (a.events[k] ?? 0), 0);
  const noClips = recordingEvents > 0 && a.clips === 0;
  const kinds = Object.entries(a.events).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
  const clips = noClips ? `NO clips received for ${recordingEvents} recording events (is the camera's FTP upload on?)` : `${a.clips} clips received`;
  return {
    message: `Activity ${day}: ${total} events (${kinds})${recovered ? `, ${recovered} recovered from the SD card` : ''}, ${clips}, Vision ${a.vision.monthToDate} of ${a.vision.monthlyLimit} this month`,
    details: { events: { total, byKind: a.events, recovered }, recordingEvents, clips: a.clips, clipsReceived: a.clips, ...(noClips ? { noClips: true } : {}), analytics: { vision: a.vision, analyses: a.analyses }, stream: { clients: a.sseClients } },
  };
}
```

`src/proxy.ts`: import `countRecoveredEvents` and pass it to the activity record:

```ts
import { closeAllOpen, countEventsByKind, countRecoveredEvents } from './catalog/events';
```

```ts
      return activityDaily(day, { events: countEventsByKind(catalog, cam, from, to), recovered: countRecoveredEvents(catalog, cam, from, to), clips: countClips(catalog, cam, from, to), vision, analyses: countAnalysesByStatus(catalog, cam, from, to), sseClients: sse.clients() });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/catalog-recovered.test.ts test/ftp-health.test.ts test/catalog-counts.test.ts test/catalog-analyses.test.ts test/events-intake.test.ts test/audit-daily.test.ts && npx tsc --noEmit -p tsconfig.check.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/catalog/events.ts src/catalog/analyses.ts src/events/tracker.ts src/audit/daily.ts src/proxy.ts test/catalog-recovered.test.ts test/ftp-health.test.ts
git commit -m "feat(catalog): recovered events, kept out of analytics, the stall check and the daily counts (#75)"
```

### Task 2: The events check (the dry run)

**Files:**
- Modify: `src/inventory/match.ts` (receives `coverage()`, adds `spansByKind()`), `src/inventory/clips.ts` (imports `coverage` from `match.ts`)
- Create: `src/inventory/events.ts`
- Test: `test/inventory-match.test.ts` (modify), `test/inventory-events.test.ts` (create)

**Interfaces:**
- Consumes: from PR 2, `listCamera(d: CameraListDeps, o: {from, to, stream, signal, progress?}): Promise<CameraListing>` and `CameraListDeps` (`src/inventory/camera-list.ts`); `SETTLE_MS`, `RECORDING_KINDS` (`src/inventory/clips.ts`); `MAX_TOP`, `Check`, `CheckContext`, `CheckResult`, `InventoryWindow` (`src/inventory/runner.ts`); `localDate` (`src/recordings/names.ts`). From Task 1, `addRecoveredEvents` (tests only).
- Produces: in `src/inventory/match.ts`, `export function coverage(spans: { start: number; end: number }[]): (start: number, end: number) => boolean` and `export interface KindSpan<R> { kind: string; start: number; end: number; recs: R[] }`, `export function spansByKind<R extends { start: number; end: number; kinds: readonly string[] }>(recs: R[]): KindSpan<R>[]`. In `src/inventory/events.ts`: `SPAN_BEFORE_MS = 10_000`, `SPAN_AFTER_MS = 5_000`; `interface EventsSettings { cam: string; eventsDays: number; stream: Stream; eventMaxOpenMin: number }`; `interface EventsInventoryDeps { catalog: Catalog; settings: () => EventsSettings; camera: CameraListDeps }`; `interface MissingSpan { type: 'missing-event'; kind: Kind; start: number; end: number; date: string; recordings: string[] }`; `interface EventsComparison { window: InventoryWindow; counts: Record<string, number>; top: EventsDayRow[]; missing: MissingSpan[]; withoutRecording: EventItem[]; stream: Stream; cancelled: boolean }`; `compareEvents(d: EventsInventoryDeps, ctx: Pick<CheckContext, 'signal' | 'progress' | 'now'>, until?: number): Promise<EventsComparison>`; `byKindText(counts: Record<string, number>, prefix: string): string`; `eventsCheck(d: EventsInventoryDeps): Check`. Report: `window {from, to, reason: 'sd-card'|'retention'|'empty', retentionFrom, eventsDays, notes, camera: {stream, to, oldestSdDay, unknownDays}}`; counts `eventsDays, cameraDays, unknownDays, recordings, timerOnly, spans, matched, missingEvents, missingPerson, missingVehicle, missingPet, missingMotion, events, eventsWithoutRecording`; items `missing-event` (oldest first) then `event-without-recording` `{eventId, kind, start, end, source}`; top `EventsDayRow {date, state, spans, missing}`.

- [ ] **Step 1: Write the failing tests**

In `test/inventory-match.test.ts`, change the import to

```ts
import { coverage, pairByStart, spansByKind, START_SLACK_MS } from '../src/inventory/match';
```

and append

```ts
describe('coverage', () => {
  it('tells whether any span overlaps a range, ends inclusive, also a long early span', () => {
    const covers = coverage([{ start: 100, end: 200 }, { start: 0, end: 1000 }, { start: 5000, end: 5000 }]);
    expect(covers(1000, 1200)).toBe(true); // touches the long one's end
    expect(covers(1001, 4999)).toBe(false);
    expect(covers(4000, 5000)).toBe(true); // touches the point span
    expect(covers(-50, -1)).toBe(false);
    expect(coverage([])(0, 10)).toBe(false);
  });
});

describe('spansByKind', () => {
  const r = (id: string, start: number, end: number, kinds: string[]) => ({ id, start, end, kinds });
  it('merges overlapping or touching recordings per kind; a recording with two kinds is in a span of each', () => {
    const recs = [r('a', 0, 30, ['motion']), r('b', 30, 60, ['motion', 'person']), r('c', 61, 90, ['motion']), r('d', 10, 20, ['person']), r('t', 0, 100, [])];
    expect(spansByKind(recs).map((s) => [s.kind, s.start, s.end, s.recs.map((x) => x.id)])).toEqual([
      ['motion', 0, 60, ['a', 'b']],
      ['person', 10, 20, ['d']],
      ['person', 30, 60, ['b']],
      ['motion', 61, 90, ['c']],
    ]);
  });
  it('keeps a recording inside a longer one in the same span, and ignores timer-only ones', () => {
    expect(spansByKind([r('a', 0, 100, ['pet']), r('b', 10, 20, ['pet']), r('c', 50, 150, ['pet'])]).map((s) => [s.start, s.end, s.recs.length])).toEqual([[0, 150, 3]]);
    expect(spansByKind([r('t', 0, 100, [])])).toEqual([]);
  });
});
```

Create `test/inventory-events.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { addRecoveredEvents, closeEvent, insertEvent } from '../src/catalog/events';
import { compareEvents, eventsCheck, SPAN_AFTER_MS, SPAN_BEFORE_MS, type EventsInventoryDeps, type EventsSettings } from '../src/inventory/events';
import type { CameraListDeps } from '../src/inventory/camera-list';
import { SearchError, type RecordingEntry } from '../src/recordings/list';
import type { Kind } from '../src/recordings/names';
import type { CheckContext } from '../src/inventory/runner';

// Camera time is UTC here (offset 0): camera-local dates are UTC dates.
const NOW = Date.UTC(2026, 9, 2, 12, 0);
const T = (iso: string) => Date.parse(`${iso}Z`);
let dir: string;
let catalog: Catalog;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-invevents-'));
  catalog = openCatalog(join(dir, 'catalog.sqlite'));
});
afterEach(() => {
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

function event(kind: string, start: number, end: number | null, cam = 'cam1') {
  const e = insertEvent(catalog, { cam, source: 'onvif', kind, start_ts: start, raw: null });
  return end === null ? e : closeEvent(catalog, e.id, end, 'state');
}
const rec = (start: number, kinds: Kind[] = ['motion'], len = 30_000): RecordingEntry => ({
  id: `RecS0A_${new Date(start).toISOString().slice(0, 10).replaceAll('-', '')}_${new Date(start).toISOString().slice(11, 19).replaceAll(':', '')}_000000_0_55148000000000_100000.mp4`,
  path: `/mnt/sda/x/${start}.mp4`, start, end: start + len, stream: 'sub', size: 0x100000, kinds,
});
function camera(o: { months: Record<string, number[]>; recs: Record<string, RecordingEntry[]>; failing?: string[]; offline?: boolean; onDay?: (date: string) => void }) {
  const searched: string[] = [];
  const deps: CameraListDeps = {
    timeInfo: async () => ({ stdOffsetMinutes: 0, dstOffsetMinutes: 0 }),
    sleep: async () => undefined,
    list: {
      monthDays: async (m) => o.months[m] ?? [],
      day: async (date) => {
        searched.push(date);
        o.onDay?.(date);
        if (o.offline) throw new SearchError('camera_offline', 'the camera does not answer');
        if (o.failing?.includes(date)) throw new SearchError('search_failed', 'rspCode -17');
        return o.recs[date] ?? [];
      },
    },
  };
  return { deps, searched };
}
const settings = (o: Partial<EventsSettings> = {}): EventsSettings => ({ cam: 'cam1', eventsDays: 30, stream: 'sub', eventMaxOpenMin: 10, ...o });
const deps = (cam: CameraListDeps, o: Partial<EventsSettings> = {}): EventsInventoryDeps => ({ catalog, settings: () => settings(o), camera: cam });
const ctx = (o: Partial<CheckContext> = {}): CheckContext => ({ signal: new AbortController().signal, progress: () => undefined, now: NOW, options: {}, ...o });
const MONTHS = { '2026-09': [30], '2026-10': [1, 2] };

// The SD card reaches back to 2026-09-30 08:00 (its oldest recording).
function fixture() {
  const r = {
    oldest: rec(T('2026-09-30T08:00:00')), // matched by a motion event
    both: rec(T('2026-10-01T09:00:00'), ['motion', 'person']), // motion event only: person missing
    a: rec(T('2026-10-01T10:00:00')), // a and b touch: one motion span, no event
    b: rec(T('2026-10-01T10:00:30')),
    vehicle: rec(T('2026-10-01T11:00:00'), ['vehicle']), // an event 8 s before: matched
    pet: rec(T('2026-10-01T12:00:00'), ['pet']), // an event 6 s after its end: missing
    timer: rec(T('2026-10-01T13:00:00'), []), // timer only: ignored, counted
    fresh: { ...rec(NOW - 120_000), end: NOW - 90_000 }, // ended less than 5 min ago: not judged
  };
  event('motion', T('2026-09-30T08:00:05'), T('2026-09-30T08:00:20'));
  event('motion', T('2026-10-01T09:00:02'), T('2026-10-01T09:00:10'));
  event('vehicle', T('2026-10-01T10:59:52'), T('2026-10-01T10:59:55'));
  const latePet = event('pet', T('2026-10-01T12:00:36'), T('2026-10-01T12:00:40'));
  const lonely = event('person', T('2026-10-01T14:00:00'), T('2026-10-01T14:00:10')); // no recording
  event('Visitor', T('2026-10-01T15:00:00'), T('2026-10-01T15:00:05')); // not a recording kind
  event('person', T('2026-09-30T07:00:00'), T('2026-09-30T07:00:05')); // before the SD card's reach: not judged
  event('person', T('2026-10-01T09:00:00'), null, 'cam2'); // another camera's
  const recs = { '2026-09-30': [r.oldest], '2026-10-01': [r.both, r.a, r.b, r.vehicle, r.pet, r.timer], '2026-10-02': [r.fresh] };
  return { r, recs, latePet, lonely };
}

describe('events inventory', () => {
  it('finds the recording spans without an event and the events without a recording, in the SD card\'s reach', async () => {
    const f = fixture();
    const cam = camera({ months: MONTHS, recs: f.recs });
    const res = await eventsCheck(deps(cam.deps))(ctx());
    expect([SPAN_BEFORE_MS, SPAN_AFTER_MS]).toEqual([10_000, 5_000]);
    expect(cam.searched).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']); // only the days with recordings
    expect(res.window).toEqual({
      from: T('2026-09-30T08:00:00'), to: NOW, reason: 'sd-card', retentionFrom: NOW - 30 * 86_400_000, eventsDays: 30,
      notes: [
        "The window is the SD card's reach, shorter than the 30-day events retention: older recordings are overwritten",
        'A recovered event spans its recordings, pre- and post-record included, so it starts a few seconds before what the camera saw',
      ],
      camera: { stream: 'sub', to: NOW - 300_000, oldestSdDay: '2026-09-30', unknownDays: [] },
    });
    expect(res.counts).toEqual({
      eventsDays: 30, cameraDays: 31, unknownDays: 0, recordings: 6, timerOnly: 1, spans: 6, matched: 3, missingEvents: 3,
      missingPerson: 1, missingVehicle: 0, missingPet: 1, missingMotion: 1, events: 5, eventsWithoutRecording: 2,
    });
    expect(res.items).toEqual([
      { type: 'missing-event', kind: 'person', start: f.r.both.start, end: f.r.both.end, date: '2026-10-01', recordings: [f.r.both.id] },
      { type: 'missing-event', kind: 'motion', start: f.r.a.start, end: f.r.b.end, date: '2026-10-01', recordings: [f.r.a.id, f.r.b.id] },
      { type: 'missing-event', kind: 'pet', start: f.r.pet.start, end: f.r.pet.end, date: '2026-10-01', recordings: [f.r.pet.id] },
      // Symmetric tolerance: the pet event starts 6 s after its recording ended.
      { type: 'event-without-recording', eventId: f.latePet.id, kind: 'pet', start: f.latePet.start_ts, end: f.latePet.end_ts, source: 'onvif' },
      { type: 'event-without-recording', eventId: f.lonely.id, kind: 'person', start: f.lonely.start_ts, end: f.lonely.end_ts, source: 'onvif' },
    ]);
    expect(res.top).toEqual([{ date: '2026-10-01', state: 'listed', spans: 5, missing: 3 }]);
    expect(res.message).toBe("3 of 6 recording spans without an event (person 1, pet 1, motion 1) since 2026-09-30 (the SD card's reach), 2 of 5 events without a recording, 0 days unknown");
  });

  it('an open event covers a span up to events.maxOpenMin after its start', async () => {
    const r = rec(T('2026-10-01T09:05:00'));
    event('motion', T('2026-10-01T09:00:00'), null); // open, counts to 09:10
    const cam = camera({ months: { '2026-10': [1] }, recs: { '2026-10-01': [r] } });
    expect((await eventsCheck(deps(cam.deps))(ctx())).counts).toMatchObject({ spans: 1, matched: 1, missingEvents: 0 });
    const late = await eventsCheck(deps(cam.deps, { eventMaxOpenMin: 4 }))(ctx());
    expect(late.counts).toMatchObject({ spans: 1, missingEvents: 1 });
  });

  it('recovered events match, so a check after a repair finds nothing missing', async () => {
    const r = rec(T('2026-10-01T09:00:00'), ['person']);
    const cam = camera({ months: { '2026-10': [1] }, recs: { '2026-10-01': [r] } });
    addRecoveredEvents(catalog, 'cam1', [{ kind: 'person', start_ts: r.start, end_ts: r.end, raw: null }], { beforeMs: SPAN_BEFORE_MS, afterMs: SPAN_AFTER_MS, openMs: 600_000 });
    expect((await eventsCheck(deps(cam.deps))(ctx())).counts).toMatchObject({ spans: 1, matched: 1, missingEvents: 0, events: 1, eventsWithoutRecording: 0 });
  });

  it('a day whose Search failed is unknown: nothing on it, or next to it, is judged', async () => {
    const f = fixture();
    const edge = rec(T('2026-09-30T23:59:50')); // its tolerance runs into the unknown day
    const cam = camera({ months: MONTHS, recs: { ...f.recs, '2026-09-30': [f.r.oldest, edge] }, failing: ['2026-10-01'] });
    const res = await eventsCheck(deps(cam.deps))(ctx());
    expect(res.counts).toMatchObject({ unknownDays: 1, spans: 1, matched: 1, missingEvents: 0, events: 1, eventsWithoutRecording: 0 });
    expect(res.window.camera).toEqual({ stream: 'sub', to: NOW - 300_000, oldestSdDay: '2026-09-30', unknownDays: ['2026-10-01'] });
    expect(res.window.notes).toContain('5 recording spans or events next to a day the camera did not list were not judged');
    expect(res.top).toEqual([{ date: '2026-10-01', state: 'unknown', spans: 0, missing: 0 }]);
    expect(res.message).toMatch(/, 1 days unknown$/);
  });

  it('the events retention bounds the window when it is shorter than the SD card\'s reach', async () => {
    const f = fixture();
    const cam = camera({ months: MONTHS, recs: f.recs });
    const res = await eventsCheck(deps(cam.deps, { eventsDays: 1 }))(ctx());
    expect(res.window).toMatchObject({ from: NOW - 86_400_000, reason: 'retention', retentionFrom: NOW - 86_400_000, eventsDays: 1 });
    expect(cam.searched).toEqual(['2026-10-01', '2026-10-02']);
    expect(res.counts).toMatchObject({ spans: 1, missingEvents: 1, missingPet: 1, events: 2, eventsWithoutRecording: 2 });
    expect(res.message).toMatch(/ since 2026-10-01 \(the 1-day retention\), /);
  });

  it('an empty SD card: nothing judged', async () => {
    event('person', T('2026-10-01T14:00:00'), T('2026-10-01T14:00:10'));
    const cam = camera({ months: {}, recs: {} });
    const res = await eventsCheck(deps(cam.deps))(ctx());
    expect(res.window).toMatchObject({ from: null, reason: 'empty' });
    expect(res.counts).toMatchObject({ spans: 0, missingEvents: 0, events: 0 });
    expect(res.items).toEqual([]);
    expect(res.message).toBe('no recordings on the SD card (sub) in the last 30 days');
  });

  it('fails with camera_offline when the camera does not answer', async () => {
    const cam = camera({ months: MONTHS, recs: {}, offline: true });
    await expect(eventsCheck(deps(cam.deps))(ctx())).rejects.toThrow(/^camera_offline: /);
  });

  it('a cancel ends the listing; the result is partial', async () => {
    const f = fixture();
    const ac = new AbortController();
    const cam = camera({ months: MONTHS, recs: f.recs, onDay: (d) => d === '2026-09-30' && ac.abort() });
    const res = await compareEvents(deps(cam.deps), ctx({ signal: ac.signal }));
    expect(res.cancelled).toBe(true);
    expect(cam.searched).toEqual(['2026-09-30']);
    expect(res.counts.cameraDays).toBeLessThan(31);
  });

  it('the repair\'s bound leaves out spans that ended after the check', async () => {
    const f = fixture();
    const cam = camera({ months: MONTHS, recs: f.recs });
    const res = await compareEvents(deps(cam.deps), ctx(), T('2026-10-01T11:00:00'));
    expect(res.missing.map((m) => m.kind)).toEqual(['person', 'motion']);
    expect(res.window.camera).toMatchObject({ to: T('2026-10-01T11:00:00') });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/inventory-match.test.ts test/inventory-events.test.ts`
Expected: FAIL (`coverage` and `spansByKind` are not exported from `match.ts`; `src/inventory/events.ts` does not exist).

- [ ] **Step 3: Write the implementation**

`src/inventory/clips.ts`: delete the local `coverage()` function and its comment (from `// Whether any span overlaps [start, end]: the spans sorted by start, with the` to the closing `}` before `async function names`), and import it:

```ts
import { coverage, pairByStart, START_SLACK_MS } from './match';
```

`src/inventory/match.ts`: append

```ts

// Whether any span overlaps [start, end] (both ends inclusive): the spans
// sorted by start, with the running maximum of their ends; the last span
// starting at or before `end` tells (binary search). Linear to build,
// logarithmic per question. Shared by the clips and the events checks.
export function coverage(spans: { start: number; end: number }[]): (start: number, end: number) => boolean {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const starts = sorted.map((x) => x.start);
  const maxEnd: number[] = [];
  for (const [i, x] of sorted.entries()) maxEnd.push(Math.max(x.end, i ? maxEnd[i - 1] : -Infinity));
  return (start, end) => {
    let lo = 0;
    let hi = starts.length; // the first span starting after `end`
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= end) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && maxEnd[lo - 1] >= start;
  };
}

// The events rule (spec §5, decision 9): per trigger kind, recordings whose
// times overlap (or touch) are one span; a recording with several kinds is
// in a span of each kind. Timer-only recordings (no kind) are in none.
// Oldest first; on a tie by kind name.
export interface KindSpan<R> { kind: string; start: number; end: number; recs: R[] }
export function spansByKind<R extends { start: number; end: number; kinds: readonly string[] }>(recs: R[]): KindSpan<R>[] {
  const byKind = new Map<string, R[]>();
  for (const r of recs) {
    for (const k of new Set(r.kinds)) {
      const list = byKind.get(k) ?? [];
      list.push(r);
      byKind.set(k, list);
    }
  }
  const out: KindSpan<R>[] = [];
  for (const [kind, list] of byKind) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    let cur: KindSpan<R> | null = null;
    for (const r of list) {
      if (cur && r.start <= cur.end) {
        cur.end = Math.max(cur.end, r.end);
        cur.recs.push(r);
      } else {
        cur = { kind, start: r.start, end: r.end, recs: [r] };
        out.push(cur);
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
}
```

Create `src/inventory/events.ts`:

```ts
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
  const byKind = new Map<string, { start: number; end: number }[]>();
  for (const e of evs) {
    const list = byKind.get(e.kind) ?? [];
    list.push({ start: e.start_ts, end: e.end_ts ?? e.start_ts + openCap });
    byKind.set(e.kind, list);
  }
  const covers = new Map([...byKind].map(([k, list]) => [k, coverage(list)]));
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
  for (const e of evs) {
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/inventory-match.test.ts test/inventory-events.test.ts test/inventory-clips.test.ts && npx tsc --noEmit -p tsconfig.check.json`
Expected: PASS (the clips check is unchanged: it imports the moved `coverage()`).

- [ ] **Step 5: Commit**

```bash
git add src/inventory/match.ts src/inventory/clips.ts src/inventory/events.ts test/inventory-match.test.ts test/inventory-events.test.ts
git commit -m "feat(inventory): the events check against the SD recordings (#75)"
```

### Task 3: The events repair: add the missing events

**Files:**
- Modify: `src/inventory/runner.ts` (`RepairContext.runId`)
- Create: `src/inventory/repair-events.ts`
- Test: `test/inventory-runner.test.ts`, `test/inventory-repair-clips.test.ts` (modify), `test/inventory-repair-events.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 `addRecoveredEvents()`; Task 2 `compareEvents()`, `byKindText()`, `SPAN_BEFORE_MS`, `SPAN_AFTER_MS`, `EventsInventoryDeps`; PR 2's `RepairEntry`, `RepairResult`, `InventoryReport` (`src/inventory/runner.ts`).
- Produces: `RepairContext` gains `runId: string` (the repair's own id); in `src/inventory/repair-events.ts`, `export const RECOVER_MAX = 1000`, `export type EventsRepairDeps = EventsInventoryDeps`, `export function eventsRepair(d: EventsRepairDeps, limits?: { events?: number }): RepairEntry`. `ready(source)` answers `'no events are missing'` when `source.counts.missingEvents` is 0. Result counts: `checked, candidates, requested, done, failed (always 0), skipped, donePerson, doneVehicle, donePet, doneMotion`; `stopped`: `'event-cap'` or null; items `{eventId, kind, start, end, result: 'ok'}`; message `"<done> of <requested> missing events added (<kinds>), <skipped> had an event by then[; stopped: the 1000-event cap]"`.

- [ ] **Step 1: Write the failing tests**

`test/inventory-runner.test.ts`, test `'runs a repair from a recent check report: saved apart, audited as inventory-repair'`: capture the context's `runId` too. Replace

```ts
    let seen: string | undefined;
    const { runner, audit, dir } = setup({ clips: clipsKind(async (ctx) => ((seen = ctx.source.runId), repaired(2))) });
```

with

```ts
    let seen: string | undefined;
    let own: string | undefined;
    const { runner, audit, dir } = setup({ clips: clipsKind(async (ctx) => ((seen = ctx.source.runId), (own = ctx.runId), repaired(2))) });
```

and after `expect(seen).toBe(check.runId);` add

```ts
    expect(own).toBe(runId); // the repair knows its own run id (#75 marks its rows with it)
```

`test/inventory-repair-clips.test.ts`: the context now has `runId`; replace the `ctx` helper with

```ts
const ctx = (source: InventoryReport, o: Partial<RepairContext> = {}): RepairContext => ({ signal: new AbortController().signal, progress: () => undefined, now: NOW, runId: 'clipsrepair-1-abcdef', source, ...o });
```

Create `test/inventory-repair-events.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { closeEvent, insertEvent, listEvents } from '../src/catalog/events';
import { eventsCheck, type EventsInventoryDeps } from '../src/inventory/events';
import { eventsRepair, RECOVER_MAX } from '../src/inventory/repair-events';
import type { CameraListDeps } from '../src/inventory/camera-list';
import type { RecordingEntry } from '../src/recordings/list';
import type { Kind } from '../src/recordings/names';
import type { InventoryReport, RepairContext } from '../src/inventory/runner';

// Camera time is UTC here (offset 0).
const NOW = Date.UTC(2026, 9, 2, 12, 0);
const T = (iso: string) => Date.parse(`${iso}Z`);
let dir: string;
let catalog: Catalog;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-repairevents-'));
  catalog = openCatalog(join(dir, 'catalog.sqlite'));
});
afterEach(() => {
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

const rec = (start: number, kinds: Kind[] = ['motion']): RecordingEntry => ({
  id: `RecS0A_${new Date(start).toISOString().slice(0, 10).replaceAll('-', '')}_${new Date(start).toISOString().slice(11, 19).replaceAll(':', '')}_000000_0_55148000000000_100000.mp4`,
  path: `/mnt/sda/x/${start}.mp4`, start, end: start + 30_000, stream: 'sub', size: 0x100000, kinds,
});
// 2026-10-01: four recordings without events (one with two kinds: five spans).
const RECS = [rec(T('2026-10-01T08:00:00'), ['motion', 'person']), rec(T('2026-10-01T09:00:00')), rec(T('2026-10-01T10:00:00'), ['vehicle']), rec(T('2026-10-01T11:00:00'), ['pet'])];
let recs: RecordingEntry[];
const camera: CameraListDeps = {
  timeInfo: async () => ({ stdOffsetMinutes: 0, dstOffsetMinutes: 0 }),
  sleep: async () => undefined,
  list: { monthDays: async (m) => (m === '2026-10' ? [1] : []), day: async (date) => (date === '2026-10-01' ? recs : []) },
};
const deps = (): EventsInventoryDeps => ({ catalog, settings: () => ({ cam: 'cam1', eventsDays: 30, stream: 'sub', eventMaxOpenMin: 10 }), camera });
const ctx = (source: InventoryReport, o: Partial<RepairContext> = {}): RepairContext => ({ signal: new AbortController().signal, progress: () => undefined, now: NOW + 60_000, runId: 'eventsrepair-1-abcdef', source, ...o });
async function check(): Promise<InventoryReport> {
  const r = await eventsCheck(deps())({ signal: new AbortController().signal, progress: () => undefined, now: NOW });
  return { runId: 'events-1-abcdef', kind: 'events', op: 'check', camera: 'cam1', startedAt: NOW, tookMs: 5, outcome: 'ok', requestedBy: 'token', itemsTruncated: false, ...r };
}
beforeEach(() => {
  recs = [...RECS];
});

describe('events repair', () => {
  it('is ready only when the check found events missing', async () => {
    const r = eventsRepair(deps());
    const source = await check();
    expect(source.counts.missingEvents).toBe(5);
    expect(r.ready(source)).toBeNull();
    expect(r.ready({ ...source, counts: { ...source.counts, missingEvents: 0 } })).toBe('no events are missing');
  });

  it('adds one recovered event per missing span, oldest first, marked with the run; a check afterwards finds none missing', async () => {
    const source = await check();
    const res = await eventsRepair(deps()).run(ctx(source));
    expect(res.counts).toEqual({ checked: 5, candidates: 5, requested: 5, done: 5, failed: 0, skipped: 0, donePerson: 1, doneVehicle: 1, donePet: 1, doneMotion: 2 });
    expect(res.stopped).toBeNull();
    expect(res.message).toBe('5 of 5 missing events added (person 1, vehicle 1, pet 1, motion 2), 0 had an event by then');
    const rows = listEvents(catalog, { cam: 'cam1' }).reverse();
    expect(rows.map((e) => [e.kind, e.source, e.start_ts, e.end_ts, e.end_reason])).toEqual([
      ['motion', 'recovered', RECS[0].start, RECS[0].end, 'recovered'],
      ['person', 'recovered', RECS[0].start, RECS[0].end, 'recovered'],
      ['motion', 'recovered', RECS[1].start, RECS[1].end, 'recovered'],
      ['vehicle', 'recovered', RECS[2].start, RECS[2].end, 'recovered'],
      ['pet', 'recovered', RECS[3].start, RECS[3].end, 'recovered'],
    ]);
    expect(rows[0].raw).toEqual({ runId: 'eventsrepair-1-abcdef', check: 'events-1-abcdef', recordings: [RECS[0].id], stream: 'sub', bounds: "the recordings' start and end, pre- and post-record included" });
    expect(res.items).toEqual(rows.map((e) => ({ eventId: e.id, kind: e.kind, start: e.start_ts, end: e.end_ts, result: 'ok' })));
    expect((await check()).counts).toMatchObject({ spans: 5, matched: 5, missingEvents: 0 });
  });

  it('compares again: a span that got its event since the check is not added, and nothing past the check\'s bound', async () => {
    const source = await check();
    const live = insertEvent(catalog, { cam: 'cam1', source: 'onvif', kind: 'pet', start_ts: RECS[3].start + 2000, raw: null });
    closeEvent(catalog, live.id, RECS[3].start + 9000, 'state');
    recs.push({ ...rec(NOW - 60_000, ['person']) }); // ended after the check's bound (NOW − 5 min)
    const res = await eventsRepair(deps()).run(ctx(source));
    expect(res.counts).toMatchObject({ checked: 5, candidates: 4, requested: 4, done: 4 });
    expect(listEvents(catalog, { cam: 'cam1', kind: 'pet' })).toEqual([expect.objectContaining({ id: live.id, source: 'onvif' })]);
    expect(listEvents(catalog, { cam: 'cam1', kind: 'person' }).map((e) => e.start_ts)).toEqual([RECS[0].start]);
  });

  it('adds at most the cap per run, the oldest first, and says it stopped there', async () => {
    expect(RECOVER_MAX).toBe(1000);
    const source = await check();
    const res = await eventsRepair(deps(), { events: 2 }).run(ctx(source));
    expect(res).toMatchObject({ stopped: 'event-cap', counts: { candidates: 5, requested: 2, done: 2 } });
    expect(res.message).toMatch(/; stopped: the 2-event cap$/);
    expect(listEvents(catalog, { cam: 'cam1' }).map((e) => e.start_ts)).toEqual([RECS[0].start, RECS[0].start]);
  });

  it('a cancel during the compare adds nothing', async () => {
    const source = await check();
    const ac = new AbortController();
    ac.abort();
    const res = await eventsRepair(deps()).run(ctx(source, { signal: ac.signal }));
    expect(res).toMatchObject({ counts: { requested: 0, done: 0 }, message: 'nothing added', stopped: null });
    expect(listEvents(catalog, { cam: 'cam1' })).toEqual([]);
  });

  it('fails when the camera is offline, adding nothing', async () => {
    const source = await check();
    const offline: EventsInventoryDeps = { ...deps(), camera: { ...camera, timeInfo: async () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) } };
    await expect(eventsRepair(offline).run(ctx(source))).rejects.toThrow(/^camera_offline: /);
    expect(listEvents(catalog, { cam: 'cam1' })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/inventory-runner.test.ts test/inventory-repair-events.test.ts`
Expected: FAIL (`own` is undefined; `src/inventory/repair-events.ts` does not exist).

- [ ] **Step 3: Write the implementation**

`src/inventory/runner.ts`: replace the `RepairContext` line with

```ts
// `runId`: the repair's own run id (the events repair marks its rows with it).
export interface RepairContext { signal: AbortSignal; progress: (p: Progress) => void; now: number; runId: string; source: InventoryReport }
```

in `interface Job`, the `work` context gains `runId`:

```ts
  work: (ctx: { signal: AbortSignal; progress: (p: Progress) => void; now: number; runId: string }) => Promise<CheckResult | (RepairResult & { window: InventoryWindow | null })>;
```

and in `run()`, pass it:

```ts
        res = await job.work({ signal: cur.ac.signal, now: startedAt, runId, progress: (p) => void (cur.view.progress = p) });
```

(`repair()` spreads `ctx` into the repair's context already, so it arrives there; a check gets it too and ignores it.)

Create `src/inventory/repair-events.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/inventory-runner.test.ts test/inventory-repair-clips.test.ts test/inventory-repair-events.test.ts && npx tsc --noEmit -p tsconfig.check.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/inventory/runner.ts src/inventory/repair-events.ts test/inventory-runner.test.ts test/inventory-repair-clips.test.ts test/inventory-repair-events.test.ts
git commit -m "feat(inventory): the events repair adds the missing events as recovered (#75)"
```

### Task 4: Wire it up: the proxy, the API test, the docs

**Files:**
- Modify: `src/proxy.ts` (the `events` kind), `README.md`, `openapi.yaml`, `docs/audit-log.md`, `CHANGELOG.md`
- Create: `test/inventory-events-api.test.ts`
- Test: `test/inventory-api.test.ts`, `test/inventory-clips-api.test.ts` (the kind lists)

**Interfaces:**
- Consumes: Task 2 `eventsCheck()`, Task 3 `eventsRepair()`; the proxy's `running` settings (`retention.eventsDays`, `ftp.stream`, `events.maxOpenMin`), `recordings.list`, `client.timeInfo()`.
- Produces: the runner's check table has `events: { label: 'Events', run, repair }` (no `camera` flag: `{"kind":"events","camera":true}` is a 400 like for stills); `GET /control/inventory` lists `runs.events` and `repairs.events`. No control API change: the routes take any kind in the table.

- [ ] **Step 1: Write the failing tests**

Create `test/inventory-events-api.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// The events inventory and its repair (#75) against cam-sim's SD card: the
// recordings of yesterday have no events here (the proxy did not run then).
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  sim = await startSim();
  const sd = sim.sim.engine.sd;
  sd.clear();
  sd.seed([
    { daysAgo: 1, start: '070000', end: '070030', triggers: ['motion'] },
    { daysAgo: 1, start: '071000', end: '071030', triggers: ['person', 'motion'] },
    { daysAgo: 1, start: '072000', end: '072030', triggers: [] },
  ]);
  p = await startProxy(sim, { settings: { ftp: { stream: 'sub' } } });
  await until(() => p.proxy.status.state().online, 15_000);
}, 30_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});
const admin = () => auth(ADMIN_TOKEN);
const lines = (text: string) => text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const report = async (id: string) => (await request(p.base).get(`/control/inventory/runs/${id}`).set(admin())).body;
async function run(path: string, body: object) {
  const r = await request(p.base).post(`/control/actions/${path}`).set(admin()).send(body);
  expect(r.status).toBe(202);
  await until(async () => (await report(r.body.runId)).outcome !== 'running', 20_000);
  return report(r.body.runId);
}
const cameraEvents = () => Number((p.proxy.catalog.db.prepare("SELECT COUNT(*) AS n FROM stream_log WHERE type = 'camera-event'").get() as { n: number }).n);

describe('events inventory API', () => {
  it('checks against the camera, adds the missing events as recovered, and then finds none missing', async () => {
    const chk = await run('inventory', { kind: 'events' });
    expect(chk).toMatchObject({ kind: 'events', op: 'check', outcome: 'ok', window: { reason: 'sd-card', eventsDays: 30, camera: { stream: 'sub' } }, counts: { recordings: 2, timerOnly: 1, spans: 3, missingEvents: 3, missingPerson: 1, missingMotion: 2, unknownDays: 0 } });
    expect(chk.items.filter((x: { type: string }) => x.type === 'missing-event')).toHaveLength(3);
    expect(chk.message).toMatch(/^Events inventory: 3 of 3 recording spans without an event \(person 1, motion 2\) since \d{4}-\d\d-\d\d \(the SD card's reach\), /);
    const logged = cameraEvents();
    const rep = await run('inventory-repair', { kind: 'events', runId: chk.runId });
    expect(rep).toMatchObject({ kind: 'events', op: 'repair', outcome: 'ok', source: chk.runId, stopped: null, counts: { candidates: 3, requested: 3, done: 3, skipped: 0 } });
    expect(rep.runId).toMatch(/^eventsrepair-/);
    expect(rep.message).toBe('Events repair: 3 of 3 missing events added (person 1, motion 2), 0 had an event by then');
    // cams sees them through the client API, marked; no SSE or stream-log entry was made.
    const from = Math.min(...rep.items.map((x: { start: number }) => x.start));
    const evs = (await request(p.base).get(`/api/cameras/cam1/events?from=${from}&to=${from + 86_400_000}`).set(auth())).body;
    expect(evs.map((e: { kind: string; source: string; endReason: string }) => [e.kind, e.source, e.endReason])).toEqual([
      ['person', 'recovered', 'recovered'], // newest first
      ['motion', 'recovered', 'recovered'],
      ['motion', 'recovered', 'recovered'],
    ]);
    expect(cameraEvents()).toBe(logged);
    // One inventory-repair record, no control-action for the start.
    const recs = lines((await request(p.base).get('/control/audit?action=inventory-repair,control-action').set(admin())).text);
    expect(recs.filter((x) => x.event.action === 'inventory-repair')).toEqual([
      expect.objectContaining({ event: expect.objectContaining({ action: 'inventory-repair', type: ['change'], outcome: 'success' }), cam_proxy: expect.objectContaining({ runId: rep.runId, kind: 'events', source: chk.runId, counts: expect.objectContaining({ done: 3 }) }) }),
    ]);
    expect(recs.some((x) => x.cam_proxy?.action === 'inventory-repair')).toBe(false);
    const list = (await request(p.base).get('/control/inventory').set(admin())).body;
    expect(list.repairs.events[0]).toMatchObject({ runId: rep.runId, outcome: 'ok' });
    p.proxy.recordings.list.clear(); // the day list is cached 30 s
    const again = await run('inventory', { kind: 'events' });
    expect(again.counts).toMatchObject({ spans: 3, matched: 3, missingEvents: 0 });
    // Nothing missing now: a repair from it is refused and writes nothing.
    const r = await request(p.base).post('/control/actions/inventory-repair').set(admin()).send({ kind: 'events', runId: again.runId });
    expect([r.status, r.body]).toEqual([409, { error: 'not_repairable', detail: 'no events are missing' }]);
  });

  it('fails the check with camera_offline when the camera does not answer', async () => {
    sim.sim.engine.faults.set({ name: 'offline' });
    try {
      p.proxy.recordings.list.clear();
      const rep = await run('inventory', { kind: 'events' });
      expect(rep.outcome).toBe('failed');
      expect(rep.error).toMatch(/^camera_offline: /);
    } finally {
      sim.sim.engine.faults.clear('offline');
    }
  }, 60_000);
});
```

`test/inventory-api.test.ts`, test `'refuses an unknown or missing kind with 400'`: the detail is now `'kind is one of: stills, clips, events'`.

`test/inventory-clips-api.test.ts`, test `'refuses a repair from a bad, unknown, local-only or other-kind run'`: the first detail is now `'kind is one of: clips, events'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/inventory-events-api.test.ts test/inventory-api.test.ts test/inventory-clips-api.test.ts`
Expected: FAIL (400 `kind is one of: stills, clips` for `events`).

- [ ] **Step 3: Write the implementation**

`src/proxy.ts`: import the check and the repair after the clips repair's import:

```ts
import { eventsCheck } from './inventory/events';
import { eventsRepair } from './inventory/repair-events';
```

before `const inventory = new InventoryRunner({`, add

```ts
  const eventsDeps = {
    catalog,
    settings: () => ({ cam: running.camera.id, eventsDays: running.retention.eventsDays, stream: running.ftp.stream, eventMaxOpenMin: running.events.maxOpenMin }),
    camera: { list: recordings.list, timeInfo: () => client.timeInfo() },
  };
```

and add the kind after `clips: { … },` in `checks`:

```ts
      // #75: always against the camera (no local-only part); its repair adds
      // recovered events, never sent over SSE or the stream log.
      events: {
        label: 'Events',
        run: eventsCheck(eventsDeps),
        repair: eventsRepair(eventsDeps),
      },
```

`README.md`, the client API's events item: replace the `source` and `endReason` lines with

```md
  - `source` is `onvif`, `poll` for the fallback, or `recovered`: added
    afterwards from the camera's SD recordings by the events repair (#75),
    never sent over SSE, never analysed; its start and end are the
    recording's, pre- and post-record included.
  - `endReason` is `state` (the camera said so), `timeout` (still open after
    `events.maxOpenMin`), `restart` (the proxy stopped while it was open) or
    `recovered`.
```

`README.md`, the control API table: in the `POST /control/actions/inventory` row replace `` `{"kind":"stills"}`, `{"kind":"clips"}` or `{"kind":"clips","camera":true}` (compare with the camera's SD card on `ftp.stream`): `` with

```md
`{"kind":"stills"}`, `{"kind":"clips"}`, `{"kind":"clips","camera":true}` (compare with the camera's SD card on `ftp.stream`) or `{"kind":"events"}` (the events against the SD card's recordings on `ftp.stream`, always with the camera):
```

after the clips `POST /control/actions/inventory-repair` row add

```md
| `POST /control/actions/inventory-repair` (events) | `{"kind":"events","runId":"events-…"}`: adds the events that events run (finished, less than an hour old) found missing. It compares with the camera again and adds only spans that ended by the check's `window.camera.to`: one event per kind per missing span, `source` and `endReason` `recovered`, start and end of the span's recordings, `raw` `{runId, check, recordings, stream, bounds}`; the oldest first, at most 1000 per run (`stopped: "event-cap"`), in one transaction; a span whose kind has an event by then is skipped. Existing events are never changed. 202 `{runId}` (`eventsrepair-…`); 409 `not_repairable` (`no events are missing`), otherwise as for clips. Audited as `inventory-repair` |
```

and in the `GET /control/inventory` row replace `` clips: […]}, repairs: {clips: […]}}` `` with `` clips: […], events: […]}, repairs: {clips: […], events: […]}}` ``.

`README.md`, the admin UI's Maintenance item: after `page marks them "from camera".` add

```md
  "Check events" compares the stored events with the SD card's recordings
  (the camera's own record of what it saw) in the SD card's reach, at most
  `retention.eventsDays`: per trigger kind, a recording (overlapping ones
  merged) needs an event of its kind from 10 s before its start to 5 s after
  its end. Under a check less than an hour old with events missing, "Add N
  missing events" adds them after a confirmation (at most 1000 per run), as
  events with `source: "recovered"`, marked on the Events page and the
  Timeline. They send no SSE message, are never analysed, and don't count
  in the FTP stall check or the daily event counts. A repair's events can be
  removed by its run id: `DELETE FROM events WHERE source = 'recovered' AND
  json_extract(raw, '$.runId') = '<eventsrepair-…>'` in the catalog.
```

`openapi.yaml`:
- `/api/cameras/{cam}/events` 200: replace `[{ id, kind, source, start, end, endReason, analysis:` with `[{ id, kind, source (onvif, poll, or recovered: added from the SD recordings by the events repair, never sent over SSE), start, end, endReason (state, timeout, restart, recovered), analysis:`.
- `POST /control/actions/{name}` description: replace the two `inventory` lines with

```yaml
        inventory starts an inventory ({"kind":"stills"}, {"kind":"clips"}, {"kind":"clips","camera":true} to
        compare with the camera's SD card, or {"kind":"events"}: the events against the SD recordings) in the
        background; poll GET /control/inventory/runs/{id}.
```

  and replace `recordings missing locally over Baichuan (at most 50 or 200 MB per run). One run of either at a time.` with

```yaml
        recordings missing locally over Baichuan (at most 50 or 200 MB per run); {"kind":"events","runId":<an events
        run less than an hour old>} adds the missing events as recovered ones (at most 1000 per run). One run of
        either at a time.
```

- `GET /control/inventory/runs/{id}` 200 description, four replacements:
  - `refused, camera_offline, or null), window: { from, to, reason (retention|budget|store-younger|empty), retentionFrom, protectedFrom, notes (caveats on the counts); clips with the camera: camera: { stream, to, oldestSdDay, unknownDays } }` → `refused, camera_offline, event-cap (an events repair: more than 1000 missing), or null), window: { from, to, reason (retention|budget|store-younger|empty|sd-card: the SD card's reach, shorter than the events retention), retentionFrom, protectedFrom, notes (caveats on the counts); clips with the camera and events: camera: { stream, to (judged up to here), oldestSdDay, unknownDays }; events: eventsDays }`
  - `olderThanSd, otherStream; a repair: candidates, requested, done, failed, skipped, bytes)` → `olderThanSd, otherStream; events: eventsDays, cameraDays, unknownDays, recordings, timerOnly, spans, matched, missingEvents, missingPerson, missingVehicle, missingPet, missingMotion, events, eventsWithoutRecording; a repair: candidates, requested, done, failed, skipped, bytes; an events repair: checked (missing in the check), candidates (missing now), requested, done, skipped (an event of the kind by then), failed, donePerson, doneVehicle, donePet, doneMotion)`
  - `clips: the camera days with the most missing; a repair: up to 10 failures)` → `clips: the camera days with the most missing; events: the camera days with the most missing spans {date, state, spans, missing}; a repair: up to 10 failures)`
  - `clip-without-event; a repair: one per recording tried,` → `clip-without-event; events: missing-event {kind, start, end, date, recordings} oldest first, then event-without-recording {eventId, kind, start, end, source}; an events repair: one per event added {eventId, kind, start, end, result: ok}; a clips repair: one per recording tried,`

`docs/audit-log.md`, five replacements in the record table:
- `activity-daily` row: `` `day`, `forDay`, `events`, `recordingEvents` (motion, person, vehicle, pet), `` → `` `day`, `forDay`, `events` (`total` and `byKind`: live events only; `recovered`: events of the day recovered from the SD card by then, #75), `recordingEvents` (motion, person, vehicle, pet; live only), ``
- `inventory` row: `` `kind` (`stills`, `clips`) `` → `` `kind` (`stills`, `clips`, `events`) ``
- `inventory` row: after `` the window has `camera: {stream, to, oldestSdDay, unknownDays}`. `` add `` Events (always with the camera): the window is the SD card's reach, at most `retention.eventsDays` (`reason` `sd-card`, `retention` or `empty`; `eventsDays`, `retentionFrom`, `camera` as for clips); `counts`: `eventsDays`, `cameraDays`, `unknownDays`, `recordings`, `timerOnly`, `spans` (per kind, overlapping recordings merged), `matched`, `missingEvents`, `missingPerson`, `missingVehicle`, `missingPet`, `missingMotion`, `events` (recording kinds, judged), `eventsWithoutRecording`; `top`: the camera days with the most missing spans (`date`, `state`, `spans`, `missing`). ``
- `inventory-repair` row: `` `runId` (`clipsrepair-…`), `kind` (`clips`), `source` (the clips run it repaired from), `` → `` `runId` (`clipsrepair-…`, `eventsrepair-…`), `kind` (`clips`, `events`), `source` (the check run it repaired from), ``
- `inventory-repair` row: `` `counts` (`candidates`, `requested`, `done`, `failed`, `skipped`, `bytes`), `failures` `` → `` `counts` (`candidates`, `requested`, `done`, `failed`, `skipped`, `bytes`; events: `checked`, `candidates`, `requested`, `done` (events added), `skipped` (a span whose kind had an event by then), `failed`, `donePerson`, `doneVehicle`, `donePet`, `doneMotion`, and `stopped` `event-cap` past 1000), `failures` ``

`CHANGELOG.md`, under `## Unreleased`, after the clips entries:

```md
- Events inventory (#75, spec 2026-10-02-inventory-design §5): "Check events" (`POST /control/actions/inventory` `{"kind":"events"}`) compares the stored events with the camera's SD recordings on `ftp.stream`, in the SD card's reach (at most `retention.eventsDays`, the report says which): per trigger kind, overlapping recordings are merged and each span needs an event of its kind from 10 s before to 5 s after it; timer-only recordings are counted, not matched; events of a recording kind without a recording are reported. "Add N missing events" (`POST /control/actions/inventory-repair` `{"kind":"events","runId":…}`, after a confirmation) adds one event per missing span and kind, at most 1000 per run in one transaction, with `source` and `endReason` `recovered` and the recordings' start and end (pre- and post-record included); existing events are never changed. Recovered events reach cams through `GET /api/cameras/:cam/events` (marked `source: "recovered"`) but send no SSE or stream-log message, are never analysed (no Vision calls), and don't count in the FTP stall check or the daily event counts (`activity-daily` counts them apart as `events.recovered`). The Events page and the Timeline mark them. Each repair writes an `inventory-repair` record.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/inventory-events-api.test.ts test/inventory-api.test.ts test/inventory-clips-api.test.ts test/openapi.test.ts test/control-api.test.ts test/client-api.test.ts && npx tsc --noEmit -p tsconfig.check.json`
Expected: PASS (the events API file runs in about 3 s).

- [ ] **Step 5: Commit**

```bash
git add src/proxy.ts README.md openapi.yaml docs/audit-log.md CHANGELOG.md test/inventory-events-api.test.ts test/inventory-api.test.ts test/inventory-clips-api.test.ts
git commit -m "feat(inventory): the events kind in the proxy and the API; docs (#75)"
```

- [ ] **Step 6: Note it for cams**

Recovered events reach cams through `GET /api/cameras/:cam/events`, marked. cams reads `/analyses` and SSE today, not `/events`, so nothing changes there; leave a note for the cams session (don't edit the cams repo from here):

```bash
gh issue create -R klaushofrichter/cams --title "cam-proxy: recovered events (source: 'recovered') in /api/cameras/:cam/events" --body "cam-proxy's events inventory (#75 there) adds events it missed from the camera's SD recordings. They come back from GET /api/cameras/:cam/events with source 'recovered' and endReason 'recovered'; their start and end are the recording's (pre- and post-record included). They are never sent over SSE and never analysed (no /analyses entry). cams does not read /events today; if it ever does, show them marked or leave them out. Nothing to do now."
```

### Task 5: The admin UI: "Check events", "Add N missing events", the marks

**Files:**
- Modify: `web/src/lib/inventory.ts`, `web/src/lib/timeline.ts`, `web/src/components/InventoryCard.svelte`, `web/src/pages/Maintenance.svelte`, `web/src/pages/Events.svelte`, `web/src/pages/Timeline.svelte`
- Test: `test/inventory-ui.test.ts`, `test/timeline-ui.test.ts`, `e2e/inventory.spec.ts`

**Interfaces:**
- Consumes: the reports of Tasks 2-4 (`GET /control/inventory`: `runs.events`, `repairs.events`; `GET /control/inventory/runs/:id`), `POST /control/actions/inventory` `{kind: 'events'}`, `POST /control/actions/inventory-repair` `{kind: 'events', runId}`; the client API's event `source`.
- Produces: in `web/src/lib/inventory.ts`, `RECOVER_MAX = 1000`, `EventsDayRow`, `EventsReport`, `kindsText(counts, prefix): string`, `eventsLines(r, fmt?): string[]`, `eventsOffer(r, now, repair?): { count: number } | null`, `eventsRepairLines(r: RepairReport): string[]`; `progressText` shows "Comparing … with the camera" for a repair in its `camera` phase. In `web/src/lib/timeline.ts`, `TimelineEvent.source?: string`, `RECOVERED_NOTE`, `isRecovered(e)`, `eventLabel(e)`. `InventoryCard` takes `onrecover: (offer: { count: number }) => void` and exports `addMissing()`; test ids `inventory-events`, `inventory-events-result`, `inventory-events-days`, `inventory-recover`, `inventory-recover-stale`, `inventory-recover-result`, `event-recovered`, `minute-event`.

- [ ] **Step 1: Write the failing tests**

`test/inventory-ui.test.ts`: change the import to

```ts
import { clipsLines, duration, eventsLines, eventsOffer, eventsRepairLines, gapRows, kindsText, mb, progressText, RECOVER_MAX, repairLines, repairOffer, repairRows, stillsLines, stillsNotes, type ClipsReport, type EventsReport, type RepairReport, type StillsReport } from '../web/src/lib/inventory';
```

and append

```ts
describe('Inventory box helpers, events (#75)', () => {
  const eventsReport: EventsReport = {
    runId: 'events-1-abcdef', kind: 'events', startedAt: T, tookMs: 2100, outcome: 'ok', message: 'Events inventory: 12 of 80 recording spans without an event',
    window: { from: T, to: T + 600_000, reason: 'sd-card', eventsDays: 30, notes: [], camera: { stream: 'sub', to: T + 300_000, oldestSdDay: '2026-09-25', unknownDays: ['2026-09-26'] } },
    counts: { eventsDays: 30, recordings: 70, timerOnly: 3, spans: 80, matched: 68, missingEvents: 12, missingPerson: 3, missingVehicle: 0, missingPet: 0, missingMotion: 9, events: 75, eventsWithoutRecording: 2 },
    top: [{ date: '2026-09-27', state: 'listed', spans: 40, missing: 12 }],
    items: [],
    itemsTruncated: false,
  };

  it('describes the progress of a check and of a repair that compares again first', () => {
    expect(progressText({ runId: 'x', kind: 'events', op: 'check', startedAt: 0, outcome: 'running', progress: { phase: 'camera', done: 3, total: 31, note: '2026-09-04' } })).toBe('Comparing events with the camera… day 3 of 31 (2026-09-04)');
    expect(progressText({ runId: 'x', kind: 'events', op: 'repair', startedAt: 0, outcome: 'running', progress: { phase: 'camera', done: 3, total: 31, note: '2026-09-04' } })).toBe('Comparing events with the camera… day 3 of 31 (2026-09-04)');
    expect(progressText({ runId: 'x', kind: 'events', op: 'repair', startedAt: 0, outcome: 'running', progress: { phase: 'repair', done: 0, total: 12 } })).toBe('Repairing events… 0 of 12');
  });

  it('sums up an events report', () => {
    expect(kindsText(eventsReport.counts, 'missing')).toBe('person 3, motion 9');
    expect(kindsText({}, 'missing')).toBe('none');
    expect(eventsLines(eventsReport, fmt)).toEqual([
      "Window: 00:10:00 to 00:20:00 (the SD card's reach; events are kept 30 days)",
      'Camera (sub): 70 recordings with a trigger in 80 spans by kind, 3 timer-only (ignored)',
      'Missing: 12 spans without an event (person 3, motion 9); 68 have one',
      'Events without a recording: 2 of 75 (report only)',
      'Not listed (the Search failed, nothing judged): 2026-09-26',
    ]);
    expect(eventsLines({ ...eventsReport, window: { ...eventsReport.window!, from: null, reason: 'empty' } }, fmt)).toEqual(['No recordings on the SD card (sub) in the last 30 days']);
    expect(eventsLines({ ...eventsReport, outcome: 'failed', error: 'camera_offline: x' }, fmt)).toEqual(['Failed: camera_offline: x']);
    expect(eventsLines({ ...eventsReport, outcome: 'cancelled' }, fmt)[0]).toBe('Cancelled: the counts are partial');
  });

  it('offers to add the missing events only under a recent, finished, unused check; at most 1000', () => {
    expect(RECOVER_MAX).toBe(1000);
    expect(eventsOffer(eventsReport, T + 60_000)).toEqual({ count: 12 });
    expect(eventsOffer({ ...eventsReport, counts: { ...eventsReport.counts, missingEvents: 4000 } }, T)).toEqual({ count: 1000 });
    expect(eventsOffer(eventsReport, T + 3_600_000)).toBeNull(); // an hour old
    expect(eventsOffer({ ...eventsReport, outcome: 'cancelled' }, T)).toBeNull();
    expect(eventsOffer({ ...eventsReport, counts: { ...eventsReport.counts, missingEvents: 0 } }, T)).toBeNull();
    expect(eventsOffer(null, T)).toBeNull();
    expect(eventsOffer(eventsReport, T, { source: 'events-1-abcdef' })).toBeNull(); // already used
  });

  it('words an events repair result', () => {
    const rep: RepairReport = { runId: 'eventsrepair-2-abcdef', kind: 'events', startedAt: T, tookMs: 900, outcome: 'ok', message: '', source: 'events-1-abcdef', stopped: null, top: [], counts: { checked: 12, candidates: 12, requested: 12, done: 11, skipped: 1, failed: 0, donePerson: 3, doneMotion: 8 } };
    expect(eventsRepairLines(rep)).toEqual(['Added: 11 of 12 (person 3, motion 8); had an event by then: 1']);
    expect(eventsRepairLines({ ...rep, stopped: 'event-cap', counts: { ...rep.counts, candidates: 1500, checked: 1400 } })).toEqual([
      'Added: 11 of 12 (person 3, motion 8); had an event by then: 1',
      'Missing when added: 1500 (the check found 1400)',
      'Stopped: the 1000-event cap; check again for the rest',
    ]);
    expect(eventsRepairLines({ ...rep, outcome: 'cancelled' })).toEqual(['Cancelled: nothing was added']);
    expect(eventsRepairLines({ ...rep, outcome: 'failed', error: 'camera_offline: x' })).toEqual(['Failed: camera_offline: x']);
  });
});
```

`test/timeline-ui.test.ts`: change the import to

```ts
import { analysedSeconds, analysedStills, eventLabel, eventsInMinute, isRecovered, marksByMinute, minuteMarks, RECOVERED_NOTE, secondKinds, stepMinute } from '../web/src/lib/timeline';
```

and append

```ts
describe('recovered events (#75)', () => {
  it('are told apart by their source and labelled so', () => {
    expect(isRecovered({ source: 'recovered' })).toBe(true);
    expect(isRecovered({ source: 'onvif' })).toBe(false);
    expect(isRecovered({})).toBe(false); // an older proxy sends no source to the Timeline type
    expect(eventLabel({ kind: 'person', source: 'recovered' })).toBe('person (recovered)');
    expect(eventLabel({ kind: 'person', source: 'poll' })).toBe('person');
    expect(RECOVERED_NOTE).toMatch(/SD recordings/);
  });
});
```

`e2e/inventory.spec.ts`: append

```ts
// The events check (#75): cam-sim's demo recordings of yesterday have no
// events here, so the box offers to add them. The offer is not confirmed:
// added events would change the Events page and the Timeline for the specs
// after this one (the API test covers the repair).
test('Check events: the result and the offer to add missing events show', async ({ page }) => {
  await page.goto('/#/maintenance');
  await expect(page.getByTestId('inventory-events')).toBeEnabled();
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/control/actions/inventory') && r.request().method() === 'POST'),
    page.getByTestId('inventory-events').click(),
  ]);
  expect(resp.status()).toBe(202);
  await expect(page.getByTestId('inventory-events-result')).toContainText('Events inventory', { timeout: 30_000 });
  await expect(page.getByTestId('inventory-events-result')).toContainText('Camera (sub):');
  await expect(page.getByTestId('inventory-recover')).toHaveText(/^Add \d+ missing events$/);
  // The offer asks first, with the count; Cancel sends nothing.
  await page.getByTestId('inventory-recover').click();
  await expect(page.getByTestId('confirm-message')).toContainText(/Add \d+ missing events from the camera's SD recordings/);
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  await expect(page.getByTestId('inventory-recover-result')).toHaveCount(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/inventory-ui.test.ts test/timeline-ui.test.ts`
Expected: FAIL (`eventsLines`, `eventsOffer`, `isRecovered` … are not exported).

- [ ] **Step 3: Write the implementation**

`web/src/lib/inventory.ts`: in `progressText`, replace the repair line with

```ts
  // The events repair compares with the camera again first (phase 'camera').
  if (r.op === 'repair' && p.phase !== 'camera') return p.total ? `Repairing ${r.kind}… ${p.done} of ${p.total}` : `Repairing ${r.kind}…`;
```

and append

```ts
// The events inventory (#75) and its repair.
export const RECOVER_MAX = 1000; // the server's cap per run (src/inventory/repair-events.ts)
export interface EventsDayRow { date: string; state: 'listed' | 'unknown'; spans: number; missing: number }
export interface EventsReport extends RunSummary {
  window: { from: number | null; to: number; reason: string; notes?: string[]; eventsDays?: number; camera?: { stream: string; to: number; oldestSdDay: string | null; unknownDays: string[] } } | null;
  top: EventsDayRow[];
  items: { type: string; kind?: string; start?: number }[];
  itemsTruncated: boolean;
  error?: string;
}
const KINDS = ['person', 'vehicle', 'pet', 'motion'];
// "person 3, motion 9" from counts named <prefix><Kind>, or "none".
export function kindsText(counts: Record<string, number>, prefix: string): string {
  return KINDS.map((k) => [k, counts[`${prefix}${k[0].toUpperCase()}${k.slice(1)}`] ?? 0] as const).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
}
const EVENT_WINDOWS: Record<string, string> = { 'sd-card': "the SD card's reach", retention: 'the events retention' };

export function eventsLines(r: EventsReport, fmt: (ms: number) => string = local): string[] {
  if (r.outcome === 'failed') return [`Failed: ${r.error ?? 'unknown error'}`];
  if (!r.window) return [];
  const c = r.counts;
  const cam = r.window.camera;
  if (r.window.from === null) return [`No recordings on the SD card${cam ? ` (${cam.stream})` : ''} in the last ${c.eventsDays} days`];
  return [
    ...(r.outcome === 'cancelled' ? ['Cancelled: the counts are partial'] : []),
    `Window: ${fmt(r.window.from)} to ${fmt(r.window.to)} (${EVENT_WINDOWS[r.window.reason] ?? r.window.reason}; events are kept ${c.eventsDays} days)`,
    `Camera${cam ? ` (${cam.stream})` : ''}: ${c.recordings} recordings with a trigger in ${c.spans} spans by kind, ${c.timerOnly} timer-only (ignored)`,
    `Missing: ${c.missingEvents} spans without an event (${kindsText(c, 'missing')}); ${c.matched} have one`,
    `Events without a recording: ${c.eventsWithoutRecording} of ${c.events} (report only)`,
    ...(cam?.unknownDays.length ? [`Not listed (the Search failed, nothing judged): ${cam.unknownDays.join(', ')}`] : []),
  ];
}

// The repair the newest events report allows: a finished check less than an
// hour old with events missing, that no repair has used yet. `count` is
// what one run adds at most.
export function eventsOffer(r: EventsReport | null, now: number, repair: { source?: string } | null = null): { count: number } | null {
  if (!r || repair?.source === r.runId || r.outcome !== 'ok' || now - r.startedAt >= REPAIR_MAX_AGE_MS || !r.counts.missingEvents) return null;
  return { count: Math.min(r.counts.missingEvents, RECOVER_MAX) };
}

export function eventsRepairLines(r: RepairReport): string[] {
  if (r.outcome === 'failed') return [`Failed: ${r.error ?? 'unknown error'}`];
  if (r.outcome === 'cancelled') return ['Cancelled: nothing was added'];
  const c = r.counts;
  return [
    `Added: ${c.done ?? 0} of ${c.requested ?? 0} (${kindsText(c, 'done')}); had an event by then: ${c.skipped ?? 0}`,
    ...(c.candidates !== c.checked ? [`Missing when added: ${c.candidates ?? 0} (the check found ${c.checked ?? 0})`] : []),
    ...(r.stopped === 'event-cap' ? [`Stopped: the ${RECOVER_MAX}-event cap; check again for the rest`] : []),
  ];
}
```

`web/src/lib/timeline.ts`: in `TimelineEvent`, after `kind: string;` add

```ts
  source?: string; // 'recovered': added from the SD recordings (#75)
```

and append

```ts
// Events recovered from the camera's SD recordings by an inventory repair
// (#75): marked on the Timeline and the Events page.
export const RECOVERED_NOTE = "Recovered from the camera's SD recordings by an inventory repair: start and end are the recording's";
export const isRecovered = (e: { source?: string }): boolean => e.source === 'recovered';
export const eventLabel = (e: { kind: string; source?: string }): string => (isRecovered(e) ? `${e.kind} (recovered)` : e.kind);
```

`web/src/components/InventoryCard.svelte`:
- the import from `../lib/inventory`:

```ts
  import { clipsLines, eventsLines, eventsOffer, eventsRepairLines, gapRows, mb, progressText, repairLines, repairOffer, repairRows, stillsLines, stillsNotes, type ClipsReport, type EventsReport, type InventoryState, type RepairReport, type StillsReport } from '../lib/inventory';
```

- the props (replace the line `// hands it the dry-run numbers); fetchLost() runs after the confirm.` and the `let { onrepair } …` line):

```ts
  // hands it the dry-run numbers); fetchLost() runs after the confirm. The
  // events check (#75) is the dry run of "Add N missing events": onrecover
  // asks, addMissing() runs after the confirm.
  let { onrepair, onrecover }: { onrepair: (offer: { count: number; bytes: number }) => void; onrecover: (offer: { count: number }) => void } = $props();
```

- after `let repair = $state<RepairReport | null>(null);`:

```ts
  let events = $state<EventsReport | null>(null);
  let recover = $state<RepairReport | null>(null);
```

- after `const offer = $derived(repairOffer(clips, now, repair));`:

```ts
  const recoverOffer = $derived(eventsOffer(events, now, recover));
```

- in `load()`, after the line that loads `repair`:

```ts
    const ev = s.runs.events?.[0];
    if (ev && ev.runId !== events?.runId) events = await fetchReport<EventsReport>(ev.runId);
    const rc = s.repairs?.events?.[0];
    if (rc && rc.runId !== recover?.runId) recover = await fetchReport<RepairReport>(rc.runId);
```

- after `export const fetchLost = …`:

```ts
  export const addMissing = () => events && post('/control/actions/inventory-repair', { kind: 'events', runId: events.runId }, 'Repair');
```

- the box's description:

```svelte
  <p class="small">Checks the local stills and clips against what the store should hold for the retention window. "Compare clips with the camera" also reads the camera's SD card list, and a repair fetches lost clips from it. "Check events" compares the events with the SD card's recordings, and a repair adds the missing ones. One run at a time.</p>
```

- after the "Compare clips with the camera" button:

```svelte
    <button onclick={() => void start('events')} disabled={starting || busy} data-testid="inventory-events">Check events</button>
```

- after the clips repair's result block (`{#if repair} … {/if}`), before the card's closing `</div>`:

```svelte
  {#if events}
    <div class="result" data-testid="inventory-events-result">
      <p class="line">{events.message}</p>
      <p class="small">{new Date(events.startedAt).toLocaleString()}, took {(events.tookMs / 1000).toFixed(1)} s</p>
      <ul>
        {#each eventsLines(events) as l, i (i)}<li>{l}</li>{/each}
      </ul>
      {#each events.window?.notes ?? [] as n, i (i)}<p class="small">{n}</p>{/each}
      {#if events.top.length}
        <table data-testid="inventory-events-days">
          <thead><tr><th>camera day</th><th>spans</th><th>without event</th></tr></thead>
          <tbody>
            {#each events.top as d (d.date)}<tr><td class="mono">{d.date}</td><td>{d.state === 'unknown' ? 'unknown' : d.spans}</td><td>{d.missing}</td></tr>{/each}
          </tbody>
        </table>
      {/if}
      {#if !recoverOffer && events.outcome === 'ok' && events.counts.missingEvents}
        <p class="small" role="status" data-testid="inventory-recover-stale">Check again first: adding events needs a check less than an hour old, and one that no repair has used yet.</p>
      {/if}
      {#if recoverOffer}
        <div class="buttons">
          <button onclick={() => onrecover(recoverOffer)} disabled={starting || busy} data-testid="inventory-recover">Add {recoverOffer.count} missing events</button>
        </div>
        <p class="small">Adds one event per kind and missing recording span, marked "recovered"; no SSE message, no analysis. At most 1000 per run; existing events are not changed.</p>
      {/if}
    </div>
  {/if}
  {#if recover}
    <div class="result" data-testid="inventory-recover-result">
      <p class="line">{recover.message}</p>
      <p class="small">{new Date(recover.startedAt).toLocaleString()}, took {(recover.tookMs / 1000).toFixed(1)} s</p>
      <ul>
        {#each eventsRepairLines(recover) as l, i (i)}<li role={/^Stopped/.test(l) ? 'status' : undefined}>{l}</li>{/each}
      </ul>
    </div>
  {/if}
```

`web/src/pages/Maintenance.svelte`:
- in `DIALOGS`, before `'restart-proxy': {`:

```ts
    'inventory-recover': {
      title: 'Add missing events',
      message: `Add ${recoverCount} missing events from the camera's SD recordings? Each one gets the kind, start and end of its recordings (pre- and post-record included) and is marked "recovered" on the Events page and the Timeline; cams sees it marked too. No SSE message is sent and it is never analysed. At most 1000 per run; existing events are not changed.`,
      confirmLabel: 'Add events',
    },
```

- `asking` gains the new dialog:

```ts
  let asking = $state<'camera-reboot' | 'camera-powercycle' | 'restart-proxy' | 'inventory-repair' | 'inventory-recover' | null>(null);
```

- replace `let inventory = $state<{ fetchLost: () => void } | undefined>();` and the `offer` line after it with

```ts
  let inventory = $state<{ fetchLost: () => void; addMissing: () => void } | undefined>();
  let offer = $state({ count: 0, bytes: 0 });
  // The events repair (#75): the check's count goes into the message.
  let recoverCount = $state(0);
```

- after `function fetchLost() { … }`:

```ts
  function addMissing() {
    asking = null;
    inventory?.addMissing();
  }
```

- the card and the dialog's confirm:

```svelte
  <InventoryCard bind:this={inventory} onrepair={(o) => { offer = o; asking = 'inventory-repair'; }} onrecover={(o) => { recoverCount = o.count; asking = 'inventory-recover'; }} />
```

```svelte
  <ConfirmDialog title={dlg.title} message={dlg.message} confirmLabel={dlg.confirmLabel} oncancel={() => (asking = null)} onconfirm={() => void (asking === 'inventory-repair' ? fetchLost() : asking === 'inventory-recover' ? addMissing() : asking === 'camera-reboot' ? rebootCamera() : asking === 'camera-powercycle' ? powerCycleCamera() : restartProxy())} />
```

`web/src/pages/Events.svelte`:
- after the analytics import:

```ts
  import { isRecovered, RECOVERED_NOTE } from '../lib/timeline';
```

- the row of the "Last 100 events" table (the `endReason` suffix leaves `recovered` out; the source cell shows a chip):

```svelte
          <tr class:recovered={isRecovered(e)} title={isRecovered(e) ? RECOVERED_NOTE : undefined}><td>{e.kind}</td><td>{time(e.start)}</td><td>{time(e.end)}{e.endReason && e.endReason !== 'state' && e.endReason !== 'recovered' ? ` (${e.endReason})` : ''}</td><td>{#if isRecovered(e)}<span class="chip" data-testid="event-recovered">recovered</span>{:else}{e.source}{/if}</td><td>{#if tagText(e.analysis)}<button class="tag" class:grey={e.analysis?.status !== 'ok'} data-testid="analysis-tag" onclick={() => (shown = e)}>{tagText(e.analysis)}</button>{/if}</td></tr>
```

- in `<style>`, after `.tag.grey { … }`:

```css
  /* Recovered from the SD recordings (#75): not seen live. */
  tr.recovered td { font-style: italic; color: var(--muted); }
  .chip { border: 1px dashed var(--border); border-radius: 999px; padding: 0 8px; font-size: 12px; font-style: normal; }
```

`web/src/pages/Timeline.svelte`:
- the import:

```ts
  import { analysedSeconds, analysedStills, eventLabel, eventsInMinute, isRecovered, marksByMinute, RECOVERED_NOTE, secondKinds, stepMinute } from '../lib/timeline';
```

- `interface Ev` gains `source?: string;` after `kind: string;`:

```ts
  interface Ev { id: number; kind: string; source?: string; start: number; end: number | null; analysis?: { status: string; stillTs?: number } | null }
```

- the hour grid's thumbnail: add `class:recovered={!!e && isRecovered(e)}` after its `class="thumb …"` attribute, and in its `title` replace `` ` · ${e.kind}` `` with `` ` · ${eventLabel(e)}` ``.
- the minute detail's event tag:

```svelte
              {#each evs as e (e.id)}<span class="evtag ev-{e.kind}" class:recovered={isRecovered(e)} title={isRecovered(e) ? RECOVERED_NOTE : undefined} data-testid="minute-event">{eventLabel(e)} {fmt(e.start)}–{e.end === null ? 'now' : fmt(e.end)}{#if e.analysis}{' '}<button class="link" data-testid="minute-analysis-link" onclick={() => (shown = e)}>✦ Vision</button>{/if}</span>{/each}
```

- in `<style>`, after `.evtag { … }`:

```css
  /* Recovered from the SD recordings (#75): a dashed edge. */
  .evtag.recovered { border-left-style: dashed; font-style: italic; }
  .thumb.recovered { border-style: dashed; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/inventory-ui.test.ts test/timeline-ui.test.ts && npm run check && npm run build && npm run test:e2e -- e2e/inventory.spec.ts`
Expected: PASS (the e2e run: the stills test, "Compare clips with the camera: …" and "Check events: the result and the offer to add missing events show"). The e2e test does not confirm the offer: added events would show on the Events page and the Timeline in later specs.

- [ ] **Step 5: Run everything**

Run: `npm run lint:types && npm run check && npm test && npm run test:e2e`
Expected: PASS (all 82 vitest files, 1048 tests; 33 e2e tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/inventory.ts web/src/lib/timeline.ts web/src/components/InventoryCard.svelte web/src/pages/Maintenance.svelte web/src/pages/Events.svelte web/src/pages/Timeline.svelte test/inventory-ui.test.ts test/timeline-ui.test.ts e2e/inventory.spec.ts
git commit -m "feat(ui): check events, add missing events, mark recovered events (#75)"
```

- [ ] **Step 7: On the real camera (after the merge, on the Pi)**

Run "Check events" once on the Pi and note the report's `tookMs`, `counts.cameraDays`, `spans` and `missingEvents` in the PR (or in #75). The proxy ran through most of the SD card's reach, so `missingEvents` should be small and fall on known outages (proxy stops, the ONVIF subscription down); a large count means the matching rule is off for the real camera, so don't add them then: tell Klaus first.
