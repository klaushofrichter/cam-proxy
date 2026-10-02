import { describe, expect, it } from 'vitest';
import { duration, gapRows, progressText, stillsLines, stillsNotes, type StillsReport } from '../web/src/lib/inventory';

const fmt = (ms: number) => new Date(ms).toISOString().slice(11, 19);
const T = Date.UTC(2026, 8, 27, 0, 10);
const report: StillsReport = {
  runId: 'stills-1-abcdef', kind: 'stills', startedAt: T, tookMs: 812, outcome: 'ok', message: 'Stills inventory: 3 min 40 s of 10 min missing (36.67%)',
  window: { from: T, to: T + 600_000, reason: 'store-younger' },
  counts: { missingSeconds: 220, expectedSeconds: 600, missingPct: 36.67, gaps: 4, explainedSeconds: 150, unexplainedSeconds: 70, restorableSeconds: 20, unreadablePacks: 1, packsWithoutSprite: 1, spritesWithoutPack: 1 },
  top: [
    { from: T + 420_000, to: T + 510_000, seconds: 90, explained: 'crash', explainedSeconds: 90 },
    { from: T + 70_000, to: T + 80_000, seconds: 10, explained: null, explainedSeconds: 0 },
  ],
  items: [],
  itemsTruncated: false,
};

describe('Inventory box helpers', () => {
  it('formats durations', () => {
    expect(duration(0)).toBe('0 s');
    expect(duration(59)).toBe('59 s');
    expect(duration(60)).toBe('1 min');
    expect(duration(605)).toBe('10 min 5 s');
    expect(duration(3600)).toBe('1 h');
    expect(duration(5430)).toBe('1 h 30 min');
  });

  it('describes the progress of a run', () => {
    expect(progressText({ runId: 'x', kind: 'stills', startedAt: 0, outcome: 'running', progress: { phase: 'stills', done: 3, total: 8, note: '2026-09-25' } })).toBe('Checking stills… day 3 of 8 (2026-09-25)');
    expect(progressText({ runId: 'x', kind: 'stills', startedAt: 0, outcome: 'running', progress: { phase: 'starting', done: 0, total: 0 } })).toBe('Checking stills…');
  });

  it('sums up a stills report', () => {
    expect(stillsLines(report, fmt)).toEqual([
      'Window: 00:10:00 to 00:20:00 (shorter: the store is younger than the retention)',
      'Missing: 3 min 40 s of 10 min (36.67%) in 4 gaps',
      'Explained (proxy stop or crash, camera reboot or power cycle): 2 min 30 s; unexplained: 1 min 10 s',
      'Restorable from local clips: 20 s',
      'Files: 1 unreadable packs, 1 packs without sprite, 1 sprites without pack',
    ]);
    expect(stillsLines({ ...report, outcome: 'cancelled' }, fmt)[0]).toBe('Cancelled: the counts are partial');
    expect(stillsLines({ ...report, outcome: 'failed', error: 'disk gone' }, fmt)).toEqual(['Failed: disk gone']);
    expect(stillsLines({ ...report, window: { from: null, to: T, reason: 'empty' } }, fmt)).toEqual(['No stills stored']);
  });

  it('names every gap cause in words', () => {
    const g = (explained: 'stop' | 'crash' | 'reboot' | 'powercycle') => ({ from: T, to: T + 60_000, seconds: 60, explained, explainedSeconds: 60 });
    expect(gapRows({ ...report, top: [g('stop'), g('crash'), g('reboot'), g('powercycle')] }, fmt).map((x) => x.why)).toEqual([
      'proxy stopped (1 min)', 'proxy crashed (1 min)', 'camera reboot (1 min)', 'power cycle (1 min)',
    ]);
  });

  it('keeps the pruned-previews count and the clock note as quiet notes', () => {
    expect(stillsNotes(report)).toEqual([]);
    const noted = { ...report, counts: { ...report.counts, previewsPruned: 3 }, window: { ...report.window!, notes: ['Clock note'] } };
    expect(stillsNotes(noted)).toEqual(['3 packs without sprite were previews already pruned by their own retention; not counted as problems', 'Clock note']);
    expect(stillsNotes({ ...report, outcome: 'failed' })).toEqual([]);
  });

  it('lists the top gaps with their cause', () => {
    expect(gapRows(report, fmt)).toEqual([
      { from: '00:17:00', to: '00:18:30', length: '1 min 30 s', why: 'proxy crashed (1 min 30 s)' },
      { from: '00:11:10', to: '00:11:20', length: '10 s', why: '—' },
    ]);
  });
});
