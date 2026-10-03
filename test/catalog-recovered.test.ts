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

  it('the guard ignores the rows this call just added: two close spans of one kind get one event each', () => {
    const { added, matched } = addRecoveredEvents(c, 'cam1', [rec('motion', 100_000, 130_000), rec('motion', 140_000, 170_000)], TOL);
    expect(matched).toBe(0);
    expect(added.map((e) => e.start_ts)).toEqual([100_000, 140_000]);
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

describe('addRecoveredEvents at scale', () => {
  // The old guard probed once per span with no lower bound on start_ts:
  // 911 ms for this test (M-series Mac; 1,535 ms in the review), all of it one
  // synchronous transaction. The guard now reads the rows near the spans once:
  // 24 ms, the inserts included.
  it('1,000 spans against 30k events: fast, and the same answers as a per-span probe', () => {
    const DAY = 86_400_000;
    const days = 30;
    const start = Date.UTC(2026, 8, 1);
    c.db.exec('BEGIN');
    const ev = c.db.prepare("INSERT INTO events (cam, source, kind, start_ts, end_ts, raw) VALUES (?, 'onvif', ?, ?, ?, NULL)");
    for (let i = 0; i < 30_000; i++) {
      const t = start + Math.floor((i / 30_000) * days * DAY);
      // Every 97th one open, every 50th of another camera.
      ev.run(i % 50 === 0 ? 'cam2' : 'cam1', ['motion', 'person', 'Visitor'][i % 3], t, i % 97 === 0 ? null : t + 20_000);
    }
    c.db.exec('COMMIT');
    const spans: RecoveredEvent[] = [];
    for (let i = 0; i < 1_000; i++) {
      const t = start + 7_919 * i + Math.floor((i / 1_000) * days * DAY);
      spans.push(rec(['motion', 'person', 'vehicle', 'Visitor'][i % 4], t, t + 15_000 + (i % 7) * 10_000));
    }
    // The old guard, one probe per span (rows before the call only).
    const probe = c.db.prepare('SELECT 1 AS x FROM events WHERE cam = ? AND kind = ? AND start_ts <= ? AND COALESCE(end_ts, start_ts + ?) >= ? LIMIT 1');
    const expected = spans.filter((e) => !probe.get('cam1', e.kind, e.end_ts + TOL.afterMs, TOL.openMs, e.start_ts - TOL.beforeMs)).map((e) => `${e.kind}@${e.start_ts}`);
    const t0 = performance.now();
    const { added, matched } = addRecoveredEvents(c, 'cam1', spans, TOL);
    const ms = performance.now() - t0;
    expect(added.map((e) => `${e.kind}@${e.start_ts}`)).toEqual(expected);
    expect(matched).toBe(spans.length - expected.length);
    expect(matched).toBeGreaterThan(100);
    expect(added.length).toBeGreaterThan(100);
    expect(ms).toBeLessThan(250);
  }, 30_000);
});
