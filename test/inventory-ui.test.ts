import { describe, expect, it } from 'vitest';
import { clipsLines, duration, eventsLines, eventsOffer, eventsRepairLines, gapRows, kindsText, mb, progressText, RECOVER_MAX, repairLines, repairOffer, repairRows, stillsLines, stillsNotes, type ClipsReport, type EventsReport, type RepairReport, type StillsReport } from '../web/src/lib/inventory';

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

// #74: the clips report, the repair offer, the repair's failures.
const clipsReport: ClipsReport = {
  runId: 'clips-1-abcdef', kind: 'clips', startedAt: T, tookMs: 2100, outcome: 'ok', message: 'Clips inventory: …',
  options: { camera: true },
  window: { from: T, to: T + 600_000, reason: 'retention', notes: [], camera: { stream: 'sub', to: T + 300_000, oldestSdDay: '2026-09-25', unknownDays: ['2026-09-26'] } },
  counts: { clipsDays: 7, clips: 40, fromCamera: 2, rowsWithoutFile: 1, filesWithoutRow: 0, events: 50, eventsWithoutClip: 3, clipsWithoutEvent: 4, recordings: 45, paired: 40, missingLocally: 60, missingLocallyBytes: 3 * 2 ** 20, timerOnly: 2, goneFromCamera: 1, olderThanSd: 5 },
  top: [],
  items: [...Array.from({ length: 60 }, () => ({ type: 'missing-locally', size: 2 ** 20 })), { type: 'gone-from-camera' }],
  itemsTruncated: false,
};

describe('Inventory box helpers, clips', () => {
  it('describes the progress of a compare and of a repair', () => {
    expect(progressText({ runId: 'x', kind: 'clips', op: 'check', startedAt: 0, outcome: 'running', progress: { phase: 'camera', done: 2, total: 8, note: '2026-09-27' } })).toBe('Comparing clips with the camera… day 2 of 8 (2026-09-27)');
    expect(progressText({ runId: 'x', kind: 'clips', op: 'repair', startedAt: 0, outcome: 'running', progress: { phase: 'repair', done: 3, total: 18, note: 'RecS…' } })).toBe('Repairing clips… 3 of 18');
    expect(progressText({ runId: 'x', kind: 'clips', op: 'repair', startedAt: 0, outcome: 'running', progress: { phase: 'starting', done: 0, total: 0 } })).toBe('Repairing clips…');
  });

  it('sums up a clips report, with the camera part only after a compare', () => {
    expect(mb(3 * 2 ** 20)).toBe('3.0 MB');
    expect(clipsLines(clipsReport, fmt)).toEqual([
      'Window: 00:10:00 to 00:20:00 (the clips retention, 7 days)',
      'Clips: 40 (2 from the camera); 1 without their file, 0 files without a clip',
      'Events: 3 of 50 recording events without a clip; 4 clips without an event',
      'Camera (sub): 45 recordings, 40 here, 60 missing here (3.0 MB), 2 timer-only (ignored)',
      "Gone from the camera: 1 local clips; 5 older than the SD card's oldest day (2026-09-25)",
      'Not listed (the Search failed, nothing counted as missing): 2026-09-26',
    ]);
    const local = { ...clipsReport, options: undefined, window: { from: T, to: T + 600_000, reason: 'retention' } };
    expect(clipsLines(local, fmt)).toHaveLength(3);
    expect(clipsLines({ ...clipsReport, outcome: 'failed', error: 'camera_offline: the camera does not answer' }, fmt)).toEqual(['Failed: camera_offline: the camera does not answer']);
  });

  it('offers a repair only under a recent, finished compare with something missing; at most 50 clips', () => {
    expect(repairOffer(clipsReport, T + 60_000)).toEqual({ count: 50, bytes: 50 * 2 ** 20, tooBig: 0 });
    expect(repairOffer(clipsReport, T + 3_600_000)).toBeNull(); // an hour old
    expect(repairOffer({ ...clipsReport, options: undefined }, T)).toBeNull();
    expect(repairOffer({ ...clipsReport, outcome: 'cancelled' }, T)).toBeNull();
    expect(repairOffer({ ...clipsReport, counts: { ...clipsReport.counts, missingLocally: 0 } }, T)).toBeNull();
    expect(repairOffer(null, T)).toBeNull();
    expect(repairOffer(clipsReport, T, { source: 'clips-1-abcdef' })).toBeNull(); // already repaired from this compare
    expect(repairOffer(clipsReport, T, { source: 'clips-0-other' })).not.toBeNull();
  });

  it('offers what the server fetches: oldest first, the 50-clip cap, the 200 MB cap skipping too-big ones (#74 final review)', () => {
    const MB = 2 ** 20;
    const item = (start: number, size: number) => ({ type: 'missing-locally', start, size });
    // Listed newest first: the offer goes oldest first like the repair.
    const r = { ...clipsReport, counts: { ...clipsReport.counts, missingLocally: 5 }, items: [item(5, 30 * MB), item(4, 40 * MB), item(3, 80 * MB), item(2, 150 * MB), item(1, 250 * MB)] };
    // 250 too big (skipped); 150 + 80 = 230 > 200: 80 skipped; 150 + 40 = 190; + 30 = 220: skipped.
    expect(repairOffer(r, T)).toEqual({ count: 2, bytes: 190 * MB, tooBig: 1 });
    // The 50-clip cap counts the skipped ones too (the server's first 50, oldest first).
    const many = { ...clipsReport, counts: { ...clipsReport.counts, missingLocally: 52 }, items: [item(0, 300 * MB), ...Array.from({ length: 51 }, (_, i) => item(i + 1, MB))] };
    expect(repairOffer(many, T)).toEqual({ count: 49, bytes: 49 * MB, tooBig: 1 });
  });

  it('words the skips for size and a busy camera', () => {
    const rep: RepairReport = {
      runId: 'clipsrepair-1-abcdef', kind: 'clips', startedAt: T, tookMs: 5000, outcome: 'ok', message: 'x', stopped: null, top: [],
      counts: { candidates: 3, requested: 3, done: 0, failed: 0, skipped: 3, bytes: 0 },
      items: [{ id: 'a', start: T, result: 'skipped', reason: 'too-big' }, { id: 'b', start: T, result: 'skipped', reason: 'byte-cap' }, { id: 'c', start: T, result: 'skipped', reason: 'busy' }],
    };
    expect(repairLines(rep).slice(1)).toEqual(["Skipped, larger than one run's 200 MB: 1", "Skipped, would pass this run's 200 MB: 1", "Skipped, the camera's Search stayed busy: 1"]);
  });

  it('lists the failures of a repair', () => {
    const rep: RepairReport = { runId: 'clipsrepair-1-abcdef', kind: 'clips', startedAt: T, tookMs: 5000, outcome: 'ok', counts: {}, message: 'Clips repair: …', stopped: 'refused', top: [{ id: 'RecS0A_x.mp4', start: T + 60_000, error: 'the camera refused the download' }] };
    expect(repairRows(rep, fmt)).toEqual([{ at: '00:11:00', error: 'the camera refused the download' }]);
  });

  it('words a repair result: counts, skip reasons, the stop reason', () => {
    const rep: RepairReport = {
      runId: 'clipsrepair-1-abcdef', kind: 'clips', startedAt: T, tookMs: 5000, outcome: 'ok', message: 'x', stopped: 'byte-cap', top: [],
      counts: { candidates: 9, requested: 9, done: 5, failed: 1, skipped: 3, bytes: 5 * 2 ** 20 },
      items: [{ id: 'a', start: T, result: 'skipped', reason: 'viewer' }, { id: 'b', start: T, result: 'skipped', reason: 'viewer' }, { id: 'c', start: T, result: 'skipped', reason: 'already-local' }, { id: 'd', start: T, result: 'ok' }],
    };
    expect(repairLines(rep)).toEqual(['Fetched: 5 of 9 (5.0 MB); failed: 1; skipped: 3', 'Skipped, a viewer was downloading it: 2', 'Skipped, already here: 1', 'Stopped: the 200 MB cap']);
    expect(repairLines({ ...rep, stopped: 'max-gb' }).at(-1)).toBe('Stopped: ftp.maxGB would be exceeded');
    expect(repairLines({ ...rep, outcome: 'failed', error: 'camera_offline: x' })).toEqual(['Failed: camera_offline: x']);
  });

  it('mentions recordings not offered because the storage budget pruned clips that old', () => {
    const l = clipsLines({ ...clipsReport, counts: { ...clipsReport.counts, prunedHere: 3 } }, fmt);
    expect(l).toContain('3 recordings are older than the oldest clip here, deleted for space (not offered: they would be deleted again)');
    expect(clipsLines(clipsReport, fmt).some((x) => x.includes('deleted for space'))).toBe(false);
  });

  it('mentions recordings paired with the other stream', () => {
    const l = clipsLines({ ...clipsReport, counts: { ...clipsReport.counts, pairedOtherStream: 4 } }, fmt);
    expect(l).toContain('4 recordings are here as clips of the other stream (not counted as missing)');
  });
});

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
