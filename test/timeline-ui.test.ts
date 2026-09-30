import { describe, expect, it } from 'vitest';
import { analysedSeconds, analysedStills, eventsInMinute, minuteMarks, secondKinds, stepMinute } from '../web/src/lib/timeline';

// The Timeline's minute view (Klaus, 2026-09-30): it opens under its hour,
// steps ◀ ▶ within that hour only, and marks the seconds of its events.
const M = Date.parse('2026-09-30T14:07:00Z');
const hour = [M - 120_000, M, M + 60_000, M + 180_000].map((minute) => ({ minute }));

describe('stepMinute', () => {
  it('goes to the neighbouring minute that has previews, skipping gaps', () => {
    expect(stepMinute(hour, M, 1)).toBe(M + 60_000);
    expect(stepMinute(hour, M + 60_000, 1)).toBe(M + 180_000);
    expect(stepMinute(hour, M, -1)).toBe(M - 120_000);
  });
  it('stops at the ends of the hour', () => {
    expect(stepMinute(hour, M - 120_000, -1)).toBeNull();
    expect(stepMinute(hour, M + 180_000, 1)).toBeNull();
  });
  it('is null for a minute not in the hour', () => {
    expect(stepMinute(hour, M + 999, 1)).toBeNull();
  });
});

describe('events of a minute', () => {
  const m = { minute: M, intervalS: 1, present: Array(60).fill(true) as boolean[] };
  const events = [
    { id: 1, kind: 'motion', start: M + 5_000, end: M + 20_000 },
    { id: 2, kind: 'person', start: M + 10_000, end: M + 12_500 },
    { id: 3, kind: 'pet', start: M + 58_000, end: null }, // still open
    { id: 4, kind: 'vehicle', start: M - 30_000, end: M - 1 }, // before this minute
  ];

  it('lists the events that overlap the minute, by start', () => {
    expect(eventsInMinute(m, events, M + 120_000).map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('gives each second the kind of the event covering it, person first', () => {
    const k = secondKinds(m, events, M + 120_000);
    expect(k).toHaveLength(60);
    expect(k[4]).toBeNull();
    expect(k[5]).toBe('motion');
    expect(k[10]).toBe('person'); // person over motion
    expect(k[12]).toBe('person');
    expect(k[13]).toBe('motion');
    expect(k[20]).toBe('motion');
    expect(k[21]).toBeNull();
    expect(k[58]).toBe('pet'); // open: runs to now
    expect(k[59]).toBe('pet');
  });

  it('works with tiles longer than a second', () => {
    const k = secondKinds({ minute: M, intervalS: 2, present: Array(30).fill(true) }, events, M + 120_000);
    expect(k).toHaveLength(30);
    expect(k[5]).toBe('person'); // tile 10-12 s
  });
});

describe('analytics marks on the Timeline', () => {
  const m = { minute: M, intervalS: 1, present: Array(60).fill(true) as boolean[] };
  it('counts a minute\'s events and whether one was analysed', () => {
    const evs = [
      { id: 1, kind: 'person', start: M + 1000, end: M + 5000, analysis: { status: 'ok' } },
      { id: 2, kind: 'motion', start: M + 1000, end: M + 5000, analysis: null },
      { id: 3, kind: 'person', start: M + 40_000, end: M + 42_000, analysis: { status: 'skipped' } },
    ];
    expect(minuteMarks(m, evs, M + 60_000)).toEqual({ count: 3, analysed: true });
    expect(minuteMarks(m, evs.slice(1), M + 60_000)).toEqual({ count: 2, analysed: false });
  });
  it('marks tiles only for ok analyses, not skipped or failed ones', () => {
    const evs = [
      { id: 1, kind: 'person', start: M, end: null, analysis: { status: 'ok', stillTs: M + 2000 } },
      { id: 2, kind: 'person', start: M, end: null, analysis: { status: 'skipped', stillTs: M + 3000 } },
      { id: 3, kind: 'person', start: M, end: null, analysis: { status: 'failed', stillTs: M + 4000 } },
      { id: 4, kind: 'person', start: M, end: null, analysis: { status: 'ok' } },
      { id: 5, kind: 'motion', start: M, end: null, analysis: null },
    ];
    expect(analysedStills(evs)).toEqual([{ eventId: 1, stillTs: M + 2000 }]);
  });
  it('marks the tiles whose still was analysed', () => {
    const t = analysedSeconds(m, [{ eventId: 1, stillTs: M + 2000 }, { eventId: 9, stillTs: M + 90_000 }]);
    expect(t[2]).toBe(1);
    expect(t.filter((x) => x !== null)).toHaveLength(1);
  });
});
