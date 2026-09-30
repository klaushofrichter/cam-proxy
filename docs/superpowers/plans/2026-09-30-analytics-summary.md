# Analytics Summary (cam-proxy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every analysis gets a summary: persons, vehicles and pets only, one entry per category and subtype, duplicates merged, best score kept. cam-proxy logs objects that don't map, pushes the summary with the `analysis` stream message, serves a day's analyses to cams, and shows the summary in its own UI.

**Architecture:**
- **Mapping:** a pure module (`src/analytics/classes.ts`) maps Google's objects to categories by Open Images class id (`mid`), falling back to the name, and merges duplicates.
- **Storing:** the service stores the summary next to the full answer, counts unmapped objects, and sends a richer stream message.
- **Serving:** a new client API route gives a day's analyses in the message's shape.
- **UI:** the web UI switches from the full object list to the summary, keeping a "Show all objects" switch.

**Tech Stack:** TypeScript (Node 24, `node:sqlite`), Express 5, Svelte 5 (runes), Vitest, Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-analytics-in-cams-design.md` (the cam-proxy parts; the cams parts have their own plan in the cams repo).

## Global Constraints

- **Categories:** exactly `person`, `vehicle`, `pet`. The subtype is the Open Images class name in lower case, e.g. `dog`, `van`, `land vehicle`.
- **Mapping is by `mid`,** with a case-insensitive name fallback when an object has no `mid`. The starting table is the spec's; nothing else maps.
- **Merging:**
  - Two summary entries with the same category merge when their boxes overlap by more than 90% intersection over union. The higher score and its subtype and box win.
  - Different categories never merge.
  - The summary is ordered by score, highest first.
- **Only `ok` analyses get a summary.** Skipped and failed ones get `[]` and count nothing as unmapped.
- **Unchanged:** the raw answer and the full object list (`objects`), and existing API fields. Additions only.
- **The `analysis` stream message carries** `{ eventId, kind, start, end, provider, status, reason, stillTs, summary, objects }`; `end` is null while the event is open.
- **`GET /api/cameras/{cam}/analyses?from&to`:**
  - Returns the analyses of events that start in `[from, to]`, in the message's shape, oldest first.
  - At most one day per request and 1000 items.
  - Protected by the client token, like the other client API routes.
- **Unmapped objects:**
  - Table `analytics_unmapped (mid, name, count, last_seen)`.
  - The Status card shows the 20 most frequent.
  - `GET /control/analytics/unmapped` gives the full list; `DELETE` clears it. Both are admin only.
- **Analytics colour** purple `#a855f7`. The key never appears anywhere.
- **Tests:** the mock server never calls Google, and real calls never run in CI. Test content (stills, clips) is never committed; the fixtures are JSON only.

## Review Focus

1. **Analyses stored before this change** have objects without `mid`. The startup backfill must give them a summary through the name fallback, and "Person" must still map. (Task 3, test "backfills summaries of older analyses by name".)
2. **An analysis stored while its event is still open:** the stream message has `end: null`, and the `/analyses` route later returns the real end. (Task 3, test "the message carries the event's kind, start and a null end while open"; Task 4, test "returns the event's end once it closed".)
3. **Two categories on one box** (a person holding a dog picture, as in our tablet tests) stay two entries. Only same-category duplicates merge. (Task 1, test "keeps different categories on the same box apart".)
4. **A reversed, missing or over-a-day range** on `/analyses` answers 400 with a message, never an empty 200 that would look like "no analyses". (Task 4, test "rejects a reversed, missing or longer-than-a-day range".)
5. **Unmapped counting repeats on re-analysis or backfill.** The backfill must not count unmapped objects a second time; only new analyses count. (Task 3, test "the backfill counts nothing as unmapped".)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/analytics/classes.ts` (create) | the class table, `mapObject`, `summarize` (mapping + merging) |
| `src/analytics/providers.ts` (modify) | `Found` gains `mid?: string` |
| `src/analytics/google-vision.ts` (modify) | keep each annotation's `mid` |
| `src/catalog/migrations.ts` (modify) | migration 4: `analyses.summary`, `analytics_unmapped` |
| `src/catalog/analyses.ts` (modify) | summary in `saveAnalysis`; `analysesInRange`; backfill helpers; unmapped helpers |
| `src/analytics/service.ts` (modify) | compute and store the summary; count unmapped; richer message; `backfillSummaries()` |
| `src/proxy.ts` (modify) | call the backfill on start; control deps for unmapped |
| `src/api/client-api.ts` (modify) | `summary` in events; `GET /cameras/:cam/analyses` |
| `src/api/control-api.ts` (modify) | `GET/DELETE /control/analytics/unmapped`; `analyticsUnmapped` in `/control/status` |
| `openapi.yaml`, `README.md`, `CHANGELOG.md` (modify) | docs |
| `docs/analytics-classes.md` (create), `docs/open-images-boxable-classes.csv` (exists) | the class table, its source, the full list |
| `web/src/lib/analytics.ts` (modify) | `tagText` from the summary; `SummaryEntry` type |
| `web/src/lib/timeline.ts` (modify) | analysed = ok and a non-empty summary |
| `web/src/components/AnalysisModal.svelte` (modify) | summary boxes by default; "Show all objects" |
| `web/src/pages/Status.svelte`, `web/src/lib/state.ts` (modify) | the unmapped card |
| `test/helpers/vision-mock.ts` (modify) | answers carry `mid`; the default person has one |
| Tests: `test/analytics-classes.test.ts` (create), `test/catalog-analyses.test.ts`, `test/analytics-service.test.ts`, `test/analytics-api.test.ts`, `test/analytics-ui.test.ts`, `test/timeline-ui.test.ts`, `e2e/analytics.spec.ts` (modify) | |

---

### Task 1: Classes, mapping and merging

**Files:**
- Create: `src/analytics/classes.ts`, `docs/analytics-classes.md`, `test/analytics-classes.test.ts`, `test/fixtures/vision-cam1-2026-09-30.json`
- Modify: `src/analytics/providers.ts:17` (`Found`), `src/analytics/google-vision.ts:4,39-48`, `test/helpers/vision-mock.ts`

**Interfaces:**
- Produces:
  - `type Category = 'person' | 'vehicle' | 'pet'`
  - `interface SummaryEntry { category: Category; subtype: string; score: number; box: Box }`
  - `mapObject(o: { mid?: string; name: string }): { category: Category; subtype: string } | null`
  - `summarize(objects: Found[]): { summary: SummaryEntry[]; unmapped: { mid: string; name: string }[] }` (`unmapped` holds one entry per object that didn't map, duplicates included; `mid` is `''` when missing)
  - `iou(a: Box, b: Box): number`
  - `Found` becomes `{ mid?: string; name: string; score: number; box: Box }`
  - `MockAnswer.objects[]` gains `mid?: string`. The default PERSON answer has `mid: '/m/01g317'`.

- [ ] **Step 1: The fixture from today's real answers** (JSON only, no images)

Create `test/fixtures/vision-cam1-2026-09-30.json` with the objects of the 15:26:25 analysis on cam1, as `Found[]`. The values are Google's answer as Klaus pasted it; the boxes are the min/max of `normalizedVertices`:

```json
[
  { "mid": "/m/03ldnb", "name": "Ceiling fan", "score": 0.8967012, "box": { "x0": 0.13671875, "y0": 0.32617188, "x1": 0.31054688, "y1": 0.515625 } },
  { "mid": "/m/01g317", "name": "Person", "score": 0.7380147, "box": { "x0": 0.1640625, "y0": 0.625, "x1": 0.23339844, "y1": 0.9921875 } },
  { "mid": "/m/01g317", "name": "Person", "score": 0.65371454, "box": { "x0": 0.1640625, "y0": 0.625, "x1": 0.23339844, "y1": 0.9921875 } },
  { "mid": "/m/09j2d", "name": "Clothing", "score": 0.65355515, "box": { "x0": 0.17480469, "y0": 0.671875, "x1": 0.22851563, "y1": 0.8203125 } },
  { "mid": "/m/02x984l", "name": "Mechanical fan", "score": 0.5710339, "box": { "x0": 0.13671875, "y0": 0.32617188, "x1": 0.31054688, "y1": 0.515625 } }
]
```

- [ ] **Step 2: Write the failing test**

```ts
// test/analytics-classes.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { iou, mapObject, summarize } from '../src/analytics/classes';
import type { Found } from '../src/analytics/providers';

const real = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'vision-cam1-2026-09-30.json'), 'utf8')) as Found[];
const box = (x0: number, y0: number, x1: number, y1: number) => ({ x0, y0, x1, y1 });

describe('mapObject', () => {
  it('maps by mid to the spec table, subtype = class name in lower case', () => {
    expect(mapObject({ mid: '/m/01g317', name: 'Person' })).toEqual({ category: 'person', subtype: 'person' });
    expect(mapObject({ mid: '/m/03bt1vf', name: 'Woman' })).toEqual({ category: 'person', subtype: 'woman' });
    expect(mapObject({ mid: '/m/0h2r6', name: 'Van' })).toEqual({ category: 'vehicle', subtype: 'van' });
    expect(mapObject({ mid: '/m/01prls', name: 'Land vehicle' })).toEqual({ category: 'vehicle', subtype: 'land vehicle' });
    expect(mapObject({ mid: '/m/0bt9lr', name: 'Dog' })).toEqual({ category: 'pet', subtype: 'dog' });
    expect(mapObject({ mid: '/m/0jbk', name: 'Animal' })).toEqual({ category: 'pet', subtype: 'animal' });
  });
  it('uses the mid over the name, and the name (any case) when there is no mid', () => {
    expect(mapObject({ mid: '/m/0bt9lr', name: 'Something else' })).toEqual({ category: 'pet', subtype: 'dog' });
    expect(mapObject({ name: 'person' })).toEqual({ category: 'person', subtype: 'person' });
    expect(mapObject({ name: 'CAR' })).toEqual({ category: 'vehicle', subtype: 'car' });
  });
  it('maps nothing outside the table', () => {
    for (const o of [{ mid: '/m/03ldnb', name: 'Ceiling fan' }, { mid: '/m/0199g', name: 'Bicycle' }, { mid: '/m/015p6', name: 'Bird' }, { mid: '/m/0dzct', name: 'Human face' }, { name: 'Baby' }, { name: 'SUV' }]) {
      expect(mapObject(o)).toBeNull();
    }
  });
});

describe('summarize', () => {
  it('reduces the real 15:26 answer to one person with the higher score, and lists the rest as unmapped', () => {
    const { summary, unmapped } = summarize(real);
    expect(summary).toEqual([{ category: 'person', subtype: 'person', score: 0.7380147, box: box(0.1640625, 0.625, 0.23339844, 0.9921875) }]);
    expect(unmapped).toEqual([
      { mid: '/m/03ldnb', name: 'Ceiling fan' },
      { mid: '/m/09j2d', name: 'Clothing' },
      { mid: '/m/02x984l', name: 'Mechanical fan' },
    ]);
  });
  it('merges same-category boxes that overlap by more than 90%, keeping the higher score and its subtype', () => {
    const { summary } = summarize([
      { mid: '/m/04yx4', name: 'Man', score: 0.6, box: box(0.1, 0.1, 0.5, 0.9) },
      { mid: '/m/01g317', name: 'Person', score: 0.8, box: box(0.1, 0.1, 0.51, 0.9) },
    ]);
    expect(summary).toEqual([{ category: 'person', subtype: 'person', score: 0.8, box: box(0.1, 0.1, 0.51, 0.9) }]);
  });
  it('keeps two persons apart when their boxes overlap less', () => {
    const { summary } = summarize([
      { mid: '/m/01g317', name: 'Person', score: 0.8, box: box(0.1, 0.1, 0.3, 0.9) },
      { mid: '/m/01g317', name: 'Person', score: 0.7, box: box(0.5, 0.1, 0.7, 0.9) },
    ]);
    expect(summary.map((s) => s.score)).toEqual([0.8, 0.7]);
  });
  // Review focus 3.
  it('keeps different categories on the same box apart', () => {
    const { summary } = summarize([
      { mid: '/m/01g317', name: 'Person', score: 0.7, box: box(0.1, 0.1, 0.5, 0.9) },
      { mid: '/m/0bt9lr', name: 'Dog', score: 0.6, box: box(0.1, 0.1, 0.5, 0.9) },
    ]);
    expect(summary.map((s) => s.category)).toEqual(['person', 'pet']);
  });
  it('orders by score and handles an empty answer', () => {
    const { summary } = summarize([
      { mid: '/m/0bt9lr', name: 'Dog', score: 0.5, box: box(0, 0, 0.2, 0.2) },
      { mid: '/m/0k4j', name: 'Car', score: 0.9, box: box(0.5, 0.5, 0.9, 0.9) },
    ]);
    expect(summary.map((s) => s.subtype)).toEqual(['car', 'dog']);
    expect(summarize([])).toEqual({ summary: [], unmapped: [] });
  });
  it('iou is 1 for identical boxes, 0 for disjoint and zero-area ones', () => {
    expect(iou(box(0, 0, 1, 1), box(0, 0, 1, 1))).toBe(1);
    expect(iou(box(0, 0, 0.1, 0.1), box(0.5, 0.5, 0.6, 0.6))).toBe(0);
    expect(iou(box(0, 0, 0, 0), box(0, 0, 0, 0))).toBe(0);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run test/analytics-classes.test.ts`
Expected: FAIL, `Cannot find module '../src/analytics/classes'`.

- [ ] **Step 4: Implement**

`src/analytics/providers.ts:17`: change `Found` to

```ts
export interface Found { mid?: string; name: string; score: number; box: Box }
```

`src/analytics/google-vision.ts`: add `mid?: unknown` to the annotation type at line 4, and in the mapping (lines 43-47) add `...(typeof a.mid === 'string' && a.mid ? { mid: a.mid } : {}),` before `name:`.

Create `src/analytics/classes.ts`:

```ts
import type { Box, Found } from './providers';

// Which of Google's objects count, and as what (spec
// 2026-09-30-analytics-in-cams-design, "The classes"). Vision's object classes
// match the Open Images boxable classes by id (docs/analytics-classes.md), so
// objects map by `mid`; the name is a fallback when an answer has no mid.
export type Category = 'person' | 'vehicle' | 'pet';
export interface SummaryEntry { category: Category; subtype: string; score: number; box: Box }

const TABLE: { mid: string; name: string; category: Category }[] = [
  { mid: '/m/01g317', name: 'Person', category: 'person' },
  { mid: '/m/04yx4', name: 'Man', category: 'person' },
  { mid: '/m/03bt1vf', name: 'Woman', category: 'person' },
  { mid: '/m/01bl7v', name: 'Boy', category: 'person' },
  { mid: '/m/05r655', name: 'Girl', category: 'person' },
  { mid: '/m/0k4j', name: 'Car', category: 'vehicle' },
  { mid: '/m/07r04', name: 'Truck', category: 'vehicle' },
  { mid: '/m/0h2r6', name: 'Van', category: 'vehicle' },
  { mid: '/m/01bjv', name: 'Bus', category: 'vehicle' },
  { mid: '/m/0pg52', name: 'Taxi', category: 'vehicle' },
  { mid: '/m/012n7d', name: 'Ambulance', category: 'vehicle' },
  { mid: '/m/01lcw4', name: 'Limousine', category: 'vehicle' },
  { mid: '/m/04_sv', name: 'Motorcycle', category: 'vehicle' },
  { mid: '/m/0323sq', name: 'Golf cart', category: 'vehicle' },
  { mid: '/m/01prls', name: 'Land vehicle', category: 'vehicle' },
  { mid: '/m/07yv9', name: 'Vehicle', category: 'vehicle' },
  { mid: '/m/0bt9lr', name: 'Dog', category: 'pet' },
  { mid: '/m/01yrx', name: 'Cat', category: 'pet' },
  { mid: '/m/0jbk', name: 'Animal', category: 'pet' },
  { mid: '/m/04rky', name: 'Mammal', category: 'pet' },
  { mid: '/m/01lrl', name: 'Carnivore', category: 'pet' },
];
const BY_MID = new Map(TABLE.map((t) => [t.mid, t]));
const BY_NAME = new Map(TABLE.map((t) => [t.name.toLowerCase(), t]));
const MERGE_IOU = 0.9;

export function mapObject(o: { mid?: string; name: string }): { category: Category; subtype: string } | null {
  const t = (o.mid && BY_MID.get(o.mid)) || (!o.mid ? BY_NAME.get(o.name.trim().toLowerCase()) : undefined);
  return t ? { category: t.category, subtype: t.name.toLowerCase() } : null;
}

export function iou(a: Box, b: Box): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const inter = w > 0 && h > 0 ? w * h : 0;
  const area = (x: Box) => Math.max(0, x.x1 - x.x0) * Math.max(0, x.y1 - x.y0);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

// Persons, vehicles and pets only; same-category boxes overlapping by more
// than 90% merge (the higher score, with its subtype and box, wins); highest
// score first. Objects that don't map are returned for the unmapped count.
export function summarize(objects: Found[]): { summary: SummaryEntry[]; unmapped: { mid: string; name: string }[] } {
  const unmapped: { mid: string; name: string }[] = [];
  const mapped: SummaryEntry[] = [];
  for (const o of objects) {
    const m = mapObject(o);
    if (!m) unmapped.push({ mid: o.mid ?? '', name: o.name });
    else mapped.push({ category: m.category, subtype: m.subtype, score: o.score, box: o.box });
  }
  const summary: SummaryEntry[] = [];
  for (const e of [...mapped].sort((a, b) => b.score - a.score)) {
    if (!summary.some((s) => s.category === e.category && iou(s.box, e.box) > MERGE_IOU)) summary.push(e);
  }
  return { summary, unmapped };
}
```

(Sorting before merging makes the kept entry the higher-scoring one, and keeps the output ordered.)

`test/helpers/vision-mock.ts`: add `mid?: string` to `MockAnswer['objects']` items, give `PERSON` `mid: '/m/01g317'`, and emit `mid` in the answer: `...(x.mid ? { mid: x.mid } : {})` in the annotation object.

Create `docs/analytics-classes.md` with these sections:
1. **"Where the classes come from":** the spec's "The classes" section, including the three links and the four matching ids.
2. **"Mapping":** the table from `src/analytics/classes.ts`, as a markdown table of category, class and mid.
3. **"Not mapped (yet)":** Human face, Bicycle, Bird, Horse, other animals and all other classes, and why.
4. **"Extending":** pick a class from `open-images-boxable-classes.csv` (600 rows `mid,name`, fetched 2026-09-30 from https://storage.googleapis.com/openimages/v5/class-descriptions-boxable.csv), add it to `TABLE` in `src/analytics/classes.ts` with a test, and check the Status card "objects seen, not mapped" for candidates.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/analytics-classes.test.ts test/analytics-google.test.ts`
Expected: PASS. `analytics-google.test.ts` may compare objects exactly. If it does, the mock's default now carries `mid`: update those expectations to include `mid: '/m/01g317'` where the default person is used, and add one assertion that a `mid` in Google's answer reaches `objects[0].mid`.

- [ ] **Step 6: Commit**

```bash
git add src/analytics/classes.ts src/analytics/providers.ts src/analytics/google-vision.ts test/helpers/vision-mock.ts test/analytics-classes.test.ts test/analytics-google.test.ts test/fixtures/vision-cam1-2026-09-30.json docs/analytics-classes.md docs/open-images-boxable-classes.csv
git commit
```
Message: subject `feat(analytics): map objects to person/vehicle/pet by Open Images id; merge duplicates`, blank line, body, blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01FWQXK7pQ7ZaUZbCn6oqPEe`.

---

### Task 2: Storage for the summary and unmapped objects

**Files:**
- Modify: `src/catalog/migrations.ts` (append migration 4 before the closing `];`), `src/catalog/analyses.ts`
- Test: `test/catalog-analyses.test.ts`

**Interfaces:**
- Consumes: `SummaryEntry` (Task 1).
- Produces:
  - `AnalysisRow` gains `summary: string | null` (JSON `SummaryEntry[]`).
  - `saveAnalysis(c, r: Omit<AnalysisRow, 'id'>)`: unchanged signature; stores `summary`.
  - `interface AnalysisInRange extends AnalysisRow { kind: string; start_ts: number; end_ts: number | null }`
  - `analysesInRange(c: Catalog, cam: string, from: number, to: number, limit?: number): AnalysisInRange[]` (events that start in `[from, to]`; oldest first; latest analysis per event; limit ≤ 1000)
  - `withoutSummary(c: Catalog): AnalysisRow[]` (status `ok` and `summary IS NULL`)
  - `setSummary(c: Catalog, id: number, summary: string): void`
  - `countUnmapped(c: Catalog, items: { mid: string; name: string }[], ts: number): void`
  - `listUnmapped(c: Catalog, limit?: number): { mid: string; name: string; count: number; lastSeen: number }[]` (by count desc, then last_seen desc)
  - `clearUnmapped(c: Catalog): number`

- [ ] **Step 1: Write the failing tests** (append to `test/catalog-analyses.test.ts`, reusing its `fresh()` and `row()` helpers)

```ts
import { analysesInRange, clearUnmapped, countUnmapped, listUnmapped, setSummary, withoutSummary } from '../src/catalog/analyses';
import { closeEvent } from '../src/catalog/events';

describe('summary storage', () => {
  it('migrates to version 4 and stores the summary', () => {
    const c = fresh();
    expect(c.schemaVersion()).toBe(4);
    const e = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 1000, raw: null });
    const saved = saveAnalysis(c, row(e.id, { summary: '[{"category":"person"}]' }))!;
    expect(saved.summary).toBe('[{"category":"person"}]');
  });

  it('lists ok analyses without a summary, and sets one', () => {
    const c = fresh();
    const a = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 1000, raw: null });
    const b = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 2000, raw: null });
    const ra = saveAnalysis(c, row(a.id, { summary: null }))!;
    saveAnalysis(c, row(b.id, { status: 'skipped', reason: 'limit', objects: null, summary: null }));
    expect(withoutSummary(c).map((r) => r.id)).toEqual([ra.id]);
    setSummary(c, ra.id, '[]');
    expect(withoutSummary(c)).toEqual([]);
  });

  it('lists a range with the event kind, start and end, oldest first', () => {
    const c = fresh();
    const a = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 10_000, raw: null });
    const b = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'pet', start_ts: 20_000, raw: null });
    insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 90_000, raw: null }); // no analysis
    saveAnalysis(c, row(b.id));
    saveAnalysis(c, row(a.id));
    closeEvent(c, a.id, 15_000, 'state');
    const r = analysesInRange(c, 'cam1', 0, 50_000);
    expect(r.map((x) => [x.event_id, x.kind, x.start_ts, x.end_ts])).toEqual([[a.id, 'person', 10_000, 15_000], [b.id, 'pet', 20_000, null]]);
    expect(analysesInRange(c, 'cam1', 15_000, 50_000).map((x) => x.event_id)).toEqual([b.id]);
    expect(analysesInRange(c, 'other', 0, 50_000)).toEqual([]);
  });

  it('counts unmapped objects by mid (name when there is none), lists and clears them', () => {
    const c = fresh();
    countUnmapped(c, [{ mid: '/m/03ldnb', name: 'Ceiling fan' }, { mid: '/m/09j2d', name: 'Clothing' }], 1000);
    countUnmapped(c, [{ mid: '/m/03ldnb', name: 'Ceiling fan' }, { mid: '', name: 'Thing' }], 2000);
    expect(listUnmapped(c)).toEqual([
      { mid: '/m/03ldnb', name: 'Ceiling fan', count: 2, lastSeen: 2000 },
      { mid: '', name: 'Thing', count: 1, lastSeen: 2000 },
      { mid: '/m/09j2d', name: 'Clothing', count: 1, lastSeen: 1000 },
    ]);
    expect(listUnmapped(c, 1)).toHaveLength(1);
    expect(clearUnmapped(c)).toBe(3);
    expect(listUnmapped(c)).toEqual([]);
  });
});
```

Also add `summary: '[]'` to the `row()` helper's defaults, so earlier tests keep compiling.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/catalog-analyses.test.ts`
Expected: FAIL (schema version 3; missing exports).

- [ ] **Step 3: Implement**

Append to `MIGRATIONS` in `src/catalog/migrations.ts`:

```ts
  // 4: the analytics summary (spec 2026-09-30-analytics-in-cams-design): the
  // persons, vehicles and pets of an analysis; objects that didn't map.
  `
  ALTER TABLE analyses ADD COLUMN summary TEXT;
  CREATE TABLE analytics_unmapped (
    key TEXT PRIMARY KEY,
    mid TEXT NOT NULL,
    name TEXT NOT NULL,
    count INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  `,
```

(`key` is the mid, or `name:<lower-case name>` when there is none, so objects without a mid still count per name.)

In `src/catalog/analyses.ts`:
- add `summary: string | null; // JSON SummaryEntry[]` to `AnalysisRow`;
- add `summary` to the INSERT column list, the VALUES and the `ON CONFLICT … DO UPDATE SET` list of `saveAnalysis` (`summary = excluded.summary`), passing `r.summary`;
- add:

```ts
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

export function countUnmapped(c: Catalog, items: { mid: string; name: string }[], ts: number): void {
  const st = c.db.prepare(
    `INSERT INTO analytics_unmapped (key, mid, name, count, last_seen) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen, name = excluded.name`,
  );
  for (const i of items) st.run(i.mid || `name:${i.name.toLowerCase()}`, i.mid, i.name, ts);
}

export function listUnmapped(c: Catalog, limit = 1000): { mid: string; name: string; count: number; lastSeen: number }[] {
  return (c.db.prepare('SELECT mid, name, count, last_seen FROM analytics_unmapped ORDER BY count DESC, last_seen DESC, name LIMIT ?').all(limit) as {
    mid: string; name: string; count: number; last_seen: number;
  }[]).map((r) => ({ mid: r.mid, name: r.name, count: r.count, lastSeen: r.last_seen }));
}

export function clearUnmapped(c: Catalog): number {
  return Number(c.db.prepare('DELETE FROM analytics_unmapped').run().changes);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/catalog-analyses.test.ts test/catalog.test.ts`
Expected: PASS. If `test/catalog.test.ts` asserts the schema version is 3, change it to 4.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit -p .`
Expected: errors only where `saveAnalysis` is called without `summary` (the service; `test/analytics-api.test.ts`). Add `summary: null` in `test/analytics-api.test.ts`'s `saveAnalysis` call now. The service is Task 3's: add `summary: null` in its `store()` call now so the build stays green; Task 3 replaces it.

```bash
git add src/catalog/migrations.ts src/catalog/analyses.ts src/analytics/service.ts test/catalog-analyses.test.ts test/catalog.test.ts test/analytics-api.test.ts
git commit
```
Message: `feat(analytics): store the summary and count unmapped objects` plus the two trailer lines.

---

### Task 3: The service stores the summary and sends it

**Files:**
- Modify: `src/analytics/service.ts` (`store`, `storeOk`, new `backfillSummaries`), `src/catalog/events.ts` (add `eventById`), `src/proxy.ts` (start)
- Test: `test/analytics-service.test.ts`

**Interfaces:**
- Consumes: `summarize` (Task 1); `saveAnalysis` with `summary`, `countUnmapped`, `withoutSummary`, `setSummary` (Task 2).
- Produces:
  - The `analysis` stream message: `{ eventId, kind, start, end, provider, status, reason, stillTs, summary, objects }`.
  - `AnalyticsService.backfillSummaries(): number` (the number of analyses given a summary).
  - `eventById(c: Catalog, id: number): EventRow | undefined` in `src/catalog/events.ts`.

- [ ] **Step 1: Write the failing tests** (append inside `describe('AnalyticsService')`)

The fake provider in this file returns a Person object without a mid, and the name fallback maps it. Add a second fake for the mixed case:

```ts
  it('stores the summary with the analysis and counts unmapped objects', async () => {
    still(T0 + 1000, 7);
    const s = service();
    const mixed: AnalyticsProvider = {
      id: 'google-vision', name: 'Google Vision',
      async analyze() {
        return { objects: [
          { mid: '/m/03ldnb', name: 'Ceiling fan', score: 0.9, box: { x0: 0.1, y0: 0.3, x1: 0.3, y1: 0.5 } },
          { mid: '/m/01g317', name: 'Person', score: 0.74, box: { x0: 0.16, y0: 0.62, x1: 0.23, y1: 0.99 } },
          { mid: '/m/01g317', name: 'Person', score: 0.65, box: { x0: 0.16, y0: 0.62, x1: 0.23, y1: 0.99 } },
        ], raw: {} };
      },
    };
    const s2 = new AnalyticsService({ ...(s as unknown as { d: AnalyticsDeps }).d, provider: () => mixed });
    const e = event('person');
    s2.onEvent(e);
    await s2.idle();
    const a = analysisFor(c, e.id)!;
    expect(JSON.parse(a.summary!)).toEqual([{ category: 'person', subtype: 'person', score: 0.74, box: { x0: 0.16, y0: 0.62, x1: 0.23, y1: 0.99 } }]);
    expect(listUnmapped(c)).toEqual([expect.objectContaining({ mid: '/m/03ldnb', name: 'Ceiling fan', count: 1 })]);
  });

  // Review focus 2.
  it('the message carries the event kind, start, a null end while open, the still time and the summary', async () => {
    still(T0 + 1000, 7);
    const s = service();
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    const m = log.since(0, { types: ['analysis'] }, 10)[0].data;
    expect(m).toMatchObject({ eventId: e.id, kind: 'person', start: T0, end: null, status: 'ok', stillTs: T0 + 1000, summary: [expect.objectContaining({ category: 'person' })] });
    expect(Array.isArray(m.objects)).toBe(true);
  });

  it('a skipped analysis gets an empty summary and counts nothing as unmapped', async () => {
    config.analytics.googleVision.monthlyLimit = 0;
    still(T0 + 1000, 7);
    const s = service();
    const e = event('person');
    s.onEvent(e);
    await s.idle();
    expect(analysisFor(c, e.id)).toMatchObject({ status: 'skipped', summary: '[]' });
    expect(log.since(0, { types: ['analysis'] }, 10)[0].data.summary).toEqual([]);
    expect(listUnmapped(c)).toEqual([]);
  });

  // Review focus 1 and 5.
  it('backfills summaries of older analyses by name, and the backfill counts nothing as unmapped', () => {
    const e = event('person');
    saveAnalysis(c, { event_id: e.id, provider: 'google-vision', status: 'ok', reason: null, still_ts: T0 + 1000, image: null, requested_at: T0, took_ms: 300,
      objects: JSON.stringify([{ name: 'Ceiling fan', score: 0.9, box: { x0: 0, y0: 0, x1: 0.1, y1: 0.1 } }, { name: 'Person', score: 0.7, box: { x0: 0.2, y0: 0.2, x1: 0.4, y1: 0.9 } }]),
      raw: '{}', summary: null });
    const s = service();
    expect(s.backfillSummaries()).toBe(1);
    expect(JSON.parse(analysisFor(c, e.id)!.summary!)).toEqual([expect.objectContaining({ category: 'person', subtype: 'person', score: 0.7 })]);
    expect(listUnmapped(c)).toEqual([]);
    expect(s.backfillSummaries()).toBe(0);
  });
```

Add the imports `listUnmapped, saveAnalysis` from `../src/catalog/analyses` and `type AnalyticsDeps` from the service. If the service keeps its deps private under another name than `d`, build `s2` with the same deps object the `service()` helper passes instead: refactor the helper into `deps(over)` plus `new AnalyticsService(deps(over))`, and use `new AnalyticsService({ ...deps(), provider: () => mixed })`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/analytics-service.test.ts`
Expected: FAIL (no summary; message lacks kind/start; `backfillSummaries` missing).

- [ ] **Step 3: Implement**

`src/catalog/events.ts`: add

```ts
export function eventById(c: Catalog, id: number): EventRow | undefined {
  const r = c.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as (Omit<EventRow, 'raw'> & { raw: string | null }) | undefined;
  return r ? { ...r, raw: r.raw === null ? null : JSON.parse(r.raw) } : undefined;
}
```

(Match the existing row mapping in this file: if `listEvents` parses `raw` through a helper, use that helper.)

`src/analytics/service.ts`:
- imports: `summarize` from `./classes`; `countUnmapped, setSummary, withoutSummary` from `../catalog/analyses`; `eventById` from `../catalog/events`; `type Found` from `./providers`;
- in `store(...)`: compute the summary for `ok` results and store it; build the richer message:

```ts
  private store(job: Job, r: { status: 'ok' | 'skipped' | 'failed'; reason: string | null; stillTs: number | null; image: string | null; tookMs: number | null; objects: unknown; raw: unknown }): void {
    const sum = r.status === 'ok' && Array.isArray(r.objects) ? summarize(r.objects as Found[]) : { summary: [], unmapped: [] };
    const row = saveAnalysis(this.d.catalog, {
      event_id: job.id, provider: 'google-vision', status: r.status, reason: r.reason, still_ts: r.stillTs, image: r.image,
      requested_at: this.now(), took_ms: r.tookMs, objects: r.objects === null ? null : JSON.stringify(r.objects), raw: r.raw === null ? null : JSON.stringify(r.raw),
      summary: JSON.stringify(sum.summary),
    });
    if (!row) {
      if (r.image) try { unlinkSync(r.image); } catch { /* already gone */ }
      return;
    }
    if (sum.unmapped.length) countUnmapped(this.d.catalog, sum.unmapped, this.now());
    const ev = eventById(this.d.catalog, job.id);
    this.d.log.append(this.d.cam, 'analysis', {
      eventId: job.id, kind: ev?.kind ?? job.kind, start: ev?.start_ts ?? job.start_ts, end: ev?.end_ts ?? null,
      provider: 'google-vision', status: r.status, reason: r.reason, stillTs: r.stillTs, summary: sum.summary, objects: r.objects ?? [],
    });
  }
```

- add the public method:

```ts
  // Analyses stored before summaries existed (or whose summary failed) get
  // one, from their stored objects. Nothing is counted as unmapped: only new
  // analyses count, so a restart can't inflate the list.
  backfillSummaries(): number {
    let n = 0;
    for (const a of withoutSummary(this.d.catalog)) {
      let objects: Found[] = [];
      try {
        objects = a.objects ? (JSON.parse(a.objects) as Found[]) : [];
      } catch {
        objects = [];
      }
      setSummary(this.d.catalog, a.id, JSON.stringify(summarize(objects).summary));
      n++;
    }
    if (n) logger.info({ cam: this.d.cam, summarised: n }, 'analytics_summaries_backfilled');
    return n;
  }
```

`src/proxy.ts`, in `start()` right before `analytics.catchUp();`: `analytics.backfillSummaries();`, wrapped in `try { … } catch (err) { logger.warn({ err: (err as Error).message }, 'analytics_backfill_failed'); }`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/analytics-service.test.ts test/catalog-analyses.test.ts`
Expected: PASS. Then run the full suite once (`npm test`) and `npx tsc --noEmit -p .`. Known pre-existing timing flakes: `test/grabber.test.ts` and `test/control-api.test.ts` (issue #44). Re-run once and note.

- [ ] **Step 5: Commit**

```bash
git add src/analytics/service.ts src/catalog/events.ts src/proxy.ts test/analytics-service.test.ts
git commit
```
Message: `feat(analytics): summary with each analysis; the stream message carries it` plus the two trailer lines.

---

### Task 4: API, control API and docs

**Files:**
- Modify: `src/api/client-api.ts`, `src/api/control-api.ts`, `src/proxy.ts` (control deps), `openapi.yaml`, `README.md`, `CHANGELOG.md`
- Test: `test/analytics-api.test.ts`

**Interfaces:**
- Consumes: `analysesInRange`, `listUnmapped`, `clearUnmapped` (Task 2).
- Produces:
  - `analysisSummary(a)` gains `summary: SummaryEntry[]`: the parsed column, or `[]` when null.
  - `GET /api/cameras/:cam/analyses?from&to` returns `{ eventId, kind, start, end, provider, status, reason, stillTs, summary }[]`, oldest first. It has no `objects`; cams doesn't need them.
  - `GET /control/analytics/unmapped` returns `{ mid, name, count, lastSeen }[]`.
  - `DELETE /control/analytics/unmapped` returns `{ cleared: number }`.
  - `/control/status` gains `analyticsUnmapped`: the top 20.
  - `ControlDeps` gains `unmapped: { list(limit?: number): {mid,name,count,lastSeen}[]; clear(): number }`.

- [ ] **Step 1: Write the failing tests** (append to `test/analytics-api.test.ts`; reuse its setup)

```ts
describe('analytics summary API', () => {
  const at = Date.now() - 3_600_000;
  it('serves a day of analyses in the message shape, oldest first, with the summary', async () => {
    const c = p.proxy.catalog;
    const a = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: at, raw: null });
    const b = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'pet', start_ts: at + 60_000, raw: null });
    const summary = [{ category: 'person', subtype: 'person', score: 0.84, box: { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.9 } }];
    saveAnalysis(c, { event_id: b.id, provider: 'google-vision', status: 'skipped', reason: 'limit', still_ts: null, image: null, requested_at: at, took_ms: null, objects: null, raw: null, summary: '[]' });
    saveAnalysis(c, { event_id: a.id, provider: 'google-vision', status: 'ok', reason: null, still_ts: at + 1000, image: null, requested_at: at, took_ms: 300, objects: '[]', raw: '{}', summary: JSON.stringify(summary) });
    const r = await request(p.proxy.app).get(`/api/cameras/cam1/analyses?from=${at - 1}&to=${at + 120_000}`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      { eventId: a.id, kind: 'person', start: at, end: null, provider: 'google-vision', status: 'ok', reason: null, stillTs: at + 1000, summary },
      { eventId: b.id, kind: 'pet', start: at + 60_000, end: null, provider: 'google-vision', status: 'skipped', reason: 'limit', stillTs: null, summary: [] },
    ]);
  });

  // Review focus 2 (the API half).
  it('returns the event\'s end once it closed', async () => {
    const c = p.proxy.catalog;
    const e = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: at + 200_000, raw: null });
    saveAnalysis(c, { event_id: e.id, provider: 'google-vision', status: 'ok', reason: null, still_ts: at + 201_000, image: null, requested_at: at, took_ms: 300, objects: '[]', raw: '{}', summary: '[]' });
    closeEvent(c, e.id, at + 206_000, 'state');
    const r = await request(p.proxy.app).get(`/api/cameras/cam1/analyses?from=${at + 199_000}&to=${at + 202_000}`).set(auth());
    expect(r.body[0]).toMatchObject({ eventId: e.id, end: at + 206_000 });
  });

  // Review focus 4.
  it('rejects a reversed, missing or longer-than-a-day range, and needs the client token', async () => {
    for (const q of ['', `?from=${at}`, `?from=${at}&to=${at - 1}`, `?from=${at}&to=${at + 86_400_001}`]) {
      const r = await request(p.proxy.app).get(`/api/cameras/cam1/analyses${q}`).set(auth());
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid');
    }
    expect((await request(p.proxy.app).get(`/api/cameras/cam1/analyses?from=0&to=1`)).status).toBe(401);
    expect((await request(p.proxy.app).get(`/api/cameras/other/analyses?from=0&to=1`).set(auth())).status).toBe(404);
  });

  it('events carry the summary', async () => {
    const list = await request(p.proxy.app).get(`/api/cameras/cam1/events?from=${at - 1}&to=${at + 120_000}&limit=10`).set(auth());
    const withSummary = list.body.find((x: { analysis: { status: string } | null }) => x.analysis?.status === 'ok');
    expect(withSummary.analysis.summary[0]).toMatchObject({ category: 'person', score: 0.84 });
  });

  it('lists and clears unmapped objects for admins; status has the top 20', async () => {
    countUnmapped(p.proxy.catalog, [{ mid: '/m/03ldnb', name: 'Ceiling fan' }], Date.now());
    const l = await request(p.proxy.app).get('/control/analytics/unmapped').set(auth(ADMIN_TOKEN));
    expect(l.body).toEqual([expect.objectContaining({ mid: '/m/03ldnb', name: 'Ceiling fan', count: 1 })]);
    expect((await request(p.proxy.app).get('/control/status').set(auth(ADMIN_TOKEN))).body.analyticsUnmapped[0]).toMatchObject({ name: 'Ceiling fan' });
    expect((await request(p.proxy.app).get('/control/analytics/unmapped').set(auth(CLIENT_TOKEN))).status).toBe(403);
    expect((await request(p.proxy.app).delete('/control/analytics/unmapped').set(auth(ADMIN_TOKEN))).body).toEqual({ cleared: 1 });
    expect((await request(p.proxy.app).get('/control/analytics/unmapped').set(auth(ADMIN_TOKEN))).body).toEqual([]);
  });
});
```

Imports to add: `closeEvent` from `../src/catalog/events`, `countUnmapped` from `../src/catalog/analyses`. The token-less 401 assumes the client API answers 401 without a token; check an existing test for the exact status and use it.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/analytics-api.test.ts`
Expected: FAIL (404 on `/analyses`; no `summary`; no unmapped routes).

- [ ] **Step 3: Implement**

`src/api/client-api.ts`:
- `analysisSummary`: add `summary: parse(a.summary ?? null) ?? []`;
- after the analysis routes, reusing `range` (it is defined later in the function today; move the `range` helper above the events routes so both can use it):

```ts
  // A day of analyses in the stream message's shape (spec
  // 2026-09-30-analytics-in-cams-design), for cams when it loads a day.
  r.get('/cameras/:cam/analyses', (req, res) => {
    if (!known(req, res)) return;
    const rg = range(req, res);
    if (!rg) return;
    res.json(analysesInRange(d.catalog, cam().id, rg[0], rg[1]).map((a) => ({
      eventId: a.event_id, kind: a.kind, start: a.start_ts, end: a.end_ts, provider: a.provider, status: a.status, reason: a.reason,
      stillTs: a.still_ts, summary: parse(a.summary ?? null) ?? [],
    })));
  });
```

`src/api/control-api.ts`:
- add `unmapped: { list(limit?: number): { mid: string; name: string; count: number; lastSeen: number }[]; clear(): number };` to `ControlDeps`;
- `/status`: add `analyticsUnmapped: d.unmapped.list(20),`;
- routes:

```ts
  r.get('/analytics/unmapped', (_req, res) => void res.json(d.unmapped.list()));
  r.delete('/analytics/unmapped', (_req, res) => void res.json({ cleared: d.unmapped.clear() }));
```

`src/proxy.ts`: in the `controlApi({...})` deps, add `unmapped: { list: (limit) => listUnmapped(catalog, limit), clear: () => clearUnmapped(catalog) },` (import both).

`openapi.yaml` (2-space path indent, 4-space method indent; `test/openapi.test.ts` requires exactly the registered routes):
- after `/api/cameras/{cam}/events/{id}/analysis.jpg`, add path `/api/cameras/{cam}/analyses` with `get`, parameters `cam` (path) and `from`/`to` (query, required). Responses: `'200'` "the analyses of events starting in [from, to], oldest first: [{ eventId, kind, start, end, provider, status, reason, stillTs, summary:[{category, subtype, score, box}] }]", plus `'400'`, `'401'`, `'404'`;
- in the events 200 description add `summary` to `analysis`, and in the stream description name the `analysis` message's fields;
- add path `/control/analytics/unmapped` with `get` ("objects seen, not mapped: [{ mid, name, count, lastSeen }], most frequent first") and `delete` ("clears the list: { cleared }");
- the `/control/status` description adds `analyticsUnmapped: top 20`.

`README.md`, section "Analytics (optional)": add a paragraph "Summary" covering:
- persons, vehicles and pets only, mapped by Open Images id (link `docs/analytics-classes.md`);
- duplicates merged at more than 90% overlap, highest score first;
- where it appears: events, the stream message and `/analyses`;
- the unmapped list on the Status page and its control routes.

Add `/analyses` to the Client API section's list.

`CHANGELOG.md` under `## Unreleased`: "Analytics summary: each analysis keeps persons, vehicles and pets only (by Open Images class id, duplicates merged), sent with the `analysis` stream message and served per day at `/api/cameras/{cam}/analyses` for cams; objects that don't map are counted (Status, `/control/analytics/unmapped`)."

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/analytics-api.test.ts test/openapi.test.ts test/control-api.test.ts test/client-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api/client-api.ts src/api/control-api.ts src/proxy.ts openapi.yaml README.md CHANGELOG.md test/analytics-api.test.ts
git commit
```
Message: `feat(analytics): /analyses for cams, summary on events, unmapped objects in the control API` plus the two trailer lines.

---

### Task 5: The web UI uses the summary

**Files:**
- Modify: `web/src/lib/analytics.ts`, `web/src/lib/timeline.ts`, `web/src/components/AnalysisModal.svelte`, `web/src/pages/Status.svelte`, `web/src/lib/state.ts`, `web/src/pages/Events.svelte` (type only), `web/src/pages/Timeline.svelte` (type only)
- Test: `test/analytics-ui.test.ts`, `test/timeline-ui.test.ts`, `e2e/analytics.spec.ts`

**Interfaces:**
- Consumes: events' `analysis.summary` (Task 4); the full record `/events/{id}/analysis` (it has `objects` and now `summary`, since the record route returns the row's fields: add `summary: parse(a.summary ?? null) ?? []` to that route's JSON in `src/api/client-api.ts`); `/control/status`'s `analyticsUnmapped`.
- Produces:
  - `UiSummaryEntry = { category: 'person'|'vehicle'|'pet'; subtype: string; score: number; box: { x0: number; y0: number; x1: number; y1: number } }`
  - `UiAnalysis` gains `summary?: UiSummaryEntry[]`
  - `tagText(a)` works from the summary
  - `TimelineEvent.analysis` gains `summary?: unknown[]`
  - `analysedStills` and `minuteMarks` count only `ok` analyses with a non-empty summary

- [ ] **Step 1: Write the failing tests**

In `test/analytics-ui.test.ts`, replace the tag tests with:

```ts
  it('writes the Events tag from the summary: subtype and score, best first; "nothing relevant"; or why not', () => {
    const s = (subtype: string, score: number, category: 'person' | 'vehicle' | 'pet' = 'person') => ({ category, subtype, score, box: { x0: 0, y0: 0, x1: 1, y1: 1 } });
    expect(tagText(null)).toBeNull();
    expect(tagText({ status: 'ok', reason: null, objects: [], summary: [s('person', 0.84), s('dog', 0.7, 'pet')] })).toBe('✦ Vision: Person 0.84, Dog 0.70');
    expect(tagText({ status: 'ok', reason: null, objects: [{ name: 'Ceiling fan', score: 0.9 }], summary: [] })).toBe('✦ Vision: nothing relevant');
    expect(tagText({ status: 'skipped', reason: 'limit', objects: [] })).toBe('✦ not analysed (limit)');
    // an older record without a summary falls back to the objects
    expect(tagText({ status: 'ok', reason: null, objects: [{ name: 'Person', score: 0.9 }] })).toBe('✦ Vision: Person 0.90');
  });
```

In `test/timeline-ui.test.ts`, add:

```ts
describe('analysed means a relevant finding', () => {
  const m = { minute: M, intervalS: 1, present: Array(60).fill(true) as boolean[] };
  it('counts only ok analyses with a non-empty summary', () => {
    const evs = [
      { id: 1, kind: 'person', start: M + 1000, end: M + 5000, analysis: { status: 'ok', stillTs: M + 2000, summary: [{}] } },
      { id: 2, kind: 'person', start: M + 10_000, end: M + 12_000, analysis: { status: 'ok', stillTs: M + 11_000, summary: [] } },
    ];
    expect(minuteMarks(m, evs, M + 60_000).analysed).toBe(true);
    expect(minuteMarks(m, evs.slice(1), M + 60_000).analysed).toBe(false);
    expect(analysedStills(evs)).toEqual([{ eventId: 1, stillTs: M + 2000 }]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/analytics-ui.test.ts test/timeline-ui.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`web/src/lib/analytics.ts`:

```ts
export interface UiSummaryEntry { category: 'person' | 'vehicle' | 'pet'; subtype: string; score: number; box: { x0: number; y0: number; x1: number; y1: number } }
export interface UiAnalysis { provider?: string; status: string; reason: string | null; objects: UiObject[]; summary?: UiSummaryEntry[] }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function tagText(a: UiAnalysis | null): string | null {
  if (!a) return null;
  if (a.status !== 'ok') return `✦ not analysed (${a.reason ?? a.status})`;
  if (a.summary) {
    if (!a.summary.length) return '✦ Vision: nothing relevant';
    return `✦ Vision: ${a.summary.slice(0, 3).map((e) => `${cap(e.subtype)} ${e.score.toFixed(2)}`).join(', ')}`;
  }
  if (!a.objects.length) return '✦ Vision: nothing found';
  const top = [...a.objects].sort((x, y) => y.score - x.score).slice(0, 3);
  return `✦ Vision: ${top.map((o) => `${o.name} ${o.score.toFixed(2)}`).join(', ')}`;
}
```

`web/src/lib/timeline.ts`:
- `TimelineEvent.analysis` becomes `{ status: string; stillTs?: number; summary?: unknown[] } | null`;
- a helper `const relevant = (a) => a?.status === 'ok' && (a.summary === undefined || a.summary.length > 0);` (an undefined summary counts, for older proxies);
- use it in `minuteMarks` (`analysed: list.some((e) => relevant(e.analysis))`) and in `analysedStills` (filter `relevant(e.analysis) && e.analysis.stillTs`).

`web/src/components/AnalysisModal.svelte`:
- `Full` gains `summary?: UiSummaryEntry[]`;
- `let showAll = $state(false);`;
- `const boxes = $derived(a ? (showAll || !a.summary ? a.objects.map((o) => ({ label: o.name, score: o.score, box: o.box })) : a.summary.map((e) => ({ label: e.subtype.charAt(0).toUpperCase() + e.subtype.slice(1), score: e.score, box: e.box }))) : []);`;
- draw the rects and labels from `boxes` (keep `drawn()` for the zero-area check, applied to `.box`);
- above the object table, when `a.summary` exists:

```svelte
<label class="small"><input type="checkbox" bind:checked={showAll} data-testid="analysis-show-all" /> Show all objects</label>
```

- The object table lists `boxes` (label, score). "Raw answer" is unchanged.

`web/src/lib/state.ts`: add `analyticsUnmapped?: { mid: string; name: string; count: number; lastSeen: number }[];` to `Status`.

`web/src/pages/Status.svelte`: after the analytics cards,

```svelte
      {#if $status.analyticsUnmapped?.length}
        <div class="card" data-testid="card-analytics-unmapped">
          <h3>Analytics · objects seen, not mapped</h3>
          <p class="muted small">Candidates for the class table (docs/analytics-classes.md).</p>
          <dl>
            {#each $status.analyticsUnmapped as u (u.mid || u.name)}<dt>{u.name}{u.mid ? ` · ${u.mid}` : ''}</dt><dd>{u.count}</dd>{/each}
          </dl>
        </div>
      {/if}
```

Add the `.muted` and `.small` styles if the page lacks them. In `Events.svelte` and `Timeline.svelte`, the event types pick up `summary` through `UiAnalysis` and `TimelineEvent`; no markup change beyond what the helpers do.

In `e2e/analytics.spec.ts`, second test: the mock's default person now has a mid. Extend the mock script for this test to add a Ceiling fan (`mid: '/m/03ldnb'`, box elsewhere) through the mock's control, if it has one; if it doesn't, add a `POST /script` route to the mock that sets `script`. Then assert:
- the tag is `✦ Vision: Person 0.90` (unchanged text);
- the modal shows **one** rect by default, and two after checking `analysis-show-all`;
- the Status page's `card-analytics-unmapped` lists "Ceiling fan".

Reset the mock script in `afterAll`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/analytics-ui.test.ts test/timeline-ui.test.ts`, then `npm run check`, `npm run build`, `npx playwright test e2e/analytics.spec.ts e2e/timeline.spec.ts`
Expected: PASS. Then the whole e2e suite once: `npx playwright test`.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/analytics.ts web/src/lib/timeline.ts web/src/components/AnalysisModal.svelte web/src/pages/Status.svelte web/src/lib/state.ts web/src/pages/Events.svelte web/src/pages/Timeline.svelte src/api/client-api.ts test/analytics-ui.test.ts test/timeline-ui.test.ts test/helpers/vision-mock.ts e2e/analytics.spec.ts
git commit
```
Message: `feat(analytics): the UI shows the summary; show all objects on demand; unmapped objects on Status` plus the two trailer lines.

---

## After the plan (not tasks for the implementer)

- **Release cam-proxy, then the Pi:** `docker compose pull && docker compose up -d`. The backfill runs once and logs `analytics_summaries_backfilled`.
- **Then the cams plan** (`docs/superpowers/plans/2026-09-30-analytics-in-cams.md` in the cams repo) consumes `/analyses` and the richer `analysis` message.
