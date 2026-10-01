import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog } from '../src/catalog/db';
import { closeEvent, deleteEventsBefore, insertEvent } from '../src/catalog/events';
import { addUsage, analysesFor, analysesInRange, analysisFor, analysisImages, clearUnmapped, countUnmapped, listUnmapped, pruneUsage, saveAnalysis, setSummary, unanalysed, usageBetween, withoutSummary } from '../src/catalog/analyses';

const fresh = () => openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-an-')), 'catalog.sqlite'));
const row = (event_id: number, over: object = {}) => ({
  event_id, provider: 'google-vision', status: 'ok' as const, reason: null, still_ts: 1000, image: `/d/${event_id}.jpg`,
  requested_at: 2000, took_ms: 300, objects: '[{"name":"Person","score":0.9,"box":{"x0":0,"y0":0,"x1":1,"y1":1}}]', raw: '{}', summary: '[]', ...over,
});

describe('analyses', () => {
  it('migrate to version 4', () => {
    expect(fresh().schemaVersion()).toBe(4);
  });

  it('store one per event and provider, the latest winning', () => {
    const c = fresh();
    const e = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 1000, raw: null });
    saveAnalysis(c, row(e.id, { status: 'skipped', reason: 'limit', objects: null }));
    saveAnalysis(c, row(e.id));
    expect(analysisFor(c, e.id)).toMatchObject({ status: 'ok', reason: null });
    expect(analysesFor(c, [e.id, 999]).size).toBe(1);
  });

  it('drop a result whose event is gone, instead of failing', () => {
    const c = fresh();
    expect(saveAnalysis(c, row(424242))).toBeNull();
  });

  it('are deleted with their event', () => {
    const c = fresh();
    const e = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 1000, raw: null });
    saveAnalysis(c, row(e.id));
    expect(analysisImages(c)).toEqual(new Set([`/d/${e.id}.jpg`]));
    deleteEventsBefore(c, 5000);
    expect(analysisFor(c, e.id)).toBeUndefined();
    expect(analysisImages(c).size).toBe(0);
  });

  it('list events of the chosen kinds without an analysis, since a time', () => {
    const c = fresh();
    const a = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 10_000, raw: null });
    const b = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 20_000, raw: null });
    insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'motion', start_ts: 20_000, raw: null });
    insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: 1_000, raw: null }); // too old
    saveAnalysis(c, row(a.id));
    expect(unanalysed(c, 'cam1', ['person'], 5_000).map((e) => e.id)).toEqual([b.id]);
    expect(unanalysed(c, 'cam1', [], 5_000)).toEqual([]);
  });
});

describe('usage', () => {
  it('counts calls per provider per day, summed over a range', () => {
    const c = fresh();
    addUsage(c, 'google-vision', '2026-09-30');
    addUsage(c, 'google-vision', '2026-09-30');
    addUsage(c, 'google-vision', '2026-10-01');
    expect(usageBetween(c, 'google-vision', '2026-09-01', '2026-09-30')).toBe(2);
    expect(usageBetween(c, 'google-vision', '2026-10-01', '2026-10-31')).toBe(1);
    expect(usageBetween(c, 'other', '2026-01-01', '2026-12-31')).toBe(0);
    expect(pruneUsage(c, '2026-10-01')).toBe(1);
  });
});

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
