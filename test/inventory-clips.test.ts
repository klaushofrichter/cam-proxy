import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { insertClip, type ClipOrigin } from '../src/catalog/clips';
import { closeEvent, insertEvent } from '../src/catalog/events';
import { clipsCheck, SETTLE_MS, type ClipsInventoryDeps, type ClipsSettings } from '../src/inventory/clips';
import type { CameraListDeps } from '../src/inventory/camera-list';
import { SearchError, type RecordingEntry } from '../src/recordings/list';
import type { Kind } from '../src/recordings/names';
import { MAX_ITEMS, type CheckContext } from '../src/inventory/runner';
import { ReolinkClient } from '../src/camera/client';
import { RecordingList } from '../src/recordings/list';
import { createCamSim, type SeedClip } from 'cam-sim';
import { AuditLog } from '../src/audit/audit-log';

// Camera time is UTC here (offset 0): camera-local dates are UTC dates.
const NOW = Date.UTC(2026, 9, 2, 12, 0);
const T = (iso: string) => Date.parse(`${iso}Z`);
let dir: string;
let catalog: Catalog;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-invclips-'));
  catalog = openCatalog(join(dir, 'catalog.sqlite'));
});
afterEach(() => {
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

const pad = (n: number) => String(n).padStart(2, '0');
// The indexer's own layout: clips/<cam>/YYYY/MM/DD/HHMM-<start>.mp4 (UTC).
const clipPath = (start: number, ext = 'mp4') => {
  const d = new Date(start);
  return join(dir, 'clips', 'cam1', String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()), `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}-${start}.${ext}`);
};
const touch = (file: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, 'x');
};
function clip(start: number, o: { file?: boolean; snapshot?: boolean; stream?: string; origin?: ClipOrigin } = {}) {
  const path = clipPath(start);
  if (o.file !== false) touch(path);
  const snapshot = o.snapshot ? clipPath(start + 3000, 'jpg') : null;
  if (snapshot) touch(snapshot);
  return insertClip(catalog, { cam: 'cam1', start_ts: start, end_ts: start + 30_000, path, stream: o.stream ?? 'sub', size: 1, received_at: start + 60_000, snapshot, origin: o.origin });
}
function event(kind: string, start: number, end: number | null) {
  const e = insertEvent(catalog, { cam: 'cam1', source: 'onvif', kind, start_ts: start, raw: null });
  if (end !== null) closeEvent(catalog, e.id, end, 'state');
  return e;
}
const rec = (start: number, kinds: Kind[] = ['motion'], size = 0x100000): RecordingEntry => ({
  id: `RecS0A_${new Date(start).toISOString().slice(0, 10).replaceAll('-', '')}_${new Date(start).toISOString().slice(11, 19).replaceAll(':', '')}_000000_0_55148000000000_${size.toString(16)}.mp4`,
  path: `/mnt/sda/x/${start}.mp4`, start, end: start + 30_000, stream: 'sub', size, kinds,
});
function camera(o: { months: Record<string, number[]>; recs: Record<string, RecordingEntry[]>; failing?: string[]; offline?: boolean }) {
  const searched: string[] = [];
  const deps: CameraListDeps = {
    timeInfo: async () => ({ stdOffsetMinutes: 0, dstOffsetMinutes: 0 }),
    sleep: async () => undefined,
    list: {
      monthDays: async (m) => o.months[m] ?? [],
      day: async (date) => {
        searched.push(date);
        if (o.offline) throw new SearchError('camera_offline', 'the camera does not answer');
        if (o.failing?.includes(date)) throw new SearchError('search_failed', 'rspCode -17');
        return o.recs[date] ?? [];
      },
    },
  };
  return { deps, searched };
}
const settings = (o: Partial<ClipsSettings> = {}): ClipsSettings => ({ cam: 'cam1', clipsDays: 2, stream: 'sub', ftpEnabled: true, eventMaxOpenMin: 10, ...o });
const deps = (cam: CameraListDeps, o: Partial<ClipsInventoryDeps> = {}): ClipsInventoryDeps => ({ dataDir: dir, catalog, settings: () => settings(), camera: cam, ...o });
const ctx = (o: Partial<CheckContext> = {}): CheckContext => ({ signal: new AbortController().signal, progress: () => undefined, now: NOW, options: {}, ...o });

// The window is 2026-09-30T00:00Z (clipsDays 2) to NOW.
function fixture() {
  const c1 = clip(T('2026-10-01T08:00:00'), { snapshot: true }); // paired with r1, has an event
  const c2 = clip(T('2026-10-01T09:00:00'), { file: false }); // row without file, paired with r2
  const c3 = clip(T('2026-10-01T10:00:00')); // no event, not on the camera
  const c4 = clip(T('2026-09-30T07:00:00'), { stream: 'main' }); // another stream, no event
  clip(T('2026-09-29T23:00:00')); // before the window
  const c6 = clip(T('2026-10-02T06:00:00'), { origin: 'camera' }); // fetched by an earlier repair, paired with r6
  touch(join(dir, 'clips', 'cam1', '2026', '10', '01', `0700-${T('2026-10-01T07:00:00')}.mp4`)); // file without row
  touch(join(dir, 'clips', 'cam1', '2026', '10', '01', `0701-${T('2026-10-01T07:01:00')}.jpg`)); // picture without row
  const e1 = event('person', T('2026-10-01T08:00:05'), T('2026-10-01T08:00:20'));
  event('motion', T('2026-10-01T09:00:02'), T('2026-10-01T09:00:10'));
  const e3 = event('vehicle', T('2026-10-01T11:00:00'), T('2026-10-01T11:00:20')); // no clip
  event('motion', NOW - 60_000, NOW - 30_000); // ended less than SETTLE_MS ago: not judged
  event('person', NOW - 100_000, null); // still open: not judged
  const recs = {
    '2026-10-01': [rec(T('2026-10-01T08:00:03'), ['person']), rec(T('2026-10-01T09:00:00')), rec(T('2026-10-01T11:00:00'), ['vehicle'], 0x200000), rec(T('2026-10-01T13:00:00'), [])],
    '2026-10-02': [rec(T('2026-10-02T06:00:02')), { ...rec(NOW - 120_000), end: NOW - 90_000 }],
  };
  return { c1, c2, c3, c4, c6, e1, e3, recs };
}

describe('clips inventory, local (part 1)', () => {
  it('finds rows without file, files without row, events without clip and clips without event', async () => {
    const f = fixture();
    const cam = camera({ months: {}, recs: {} });
    const r = await clipsCheck(deps(cam.deps))(ctx());
    expect(SETTLE_MS).toBe(300_000);
    expect(cam.searched).toEqual([]); // local only: no camera contact
    expect(r.window).toEqual({ from: T('2026-09-30T00:00:00'), to: NOW, reason: 'retention', notes: [] });
    expect(r.counts).toEqual({ clipsDays: 2, clips: 5, fromCamera: 1, rowsWithoutFile: 1, filesWithoutRow: 1, snapshotsWithoutClip: 1, events: 3, eventsWithoutClip: 1, clipsWithoutEvent: 3 });
    expect(r.items).toEqual([
      { type: 'row-without-file', clipId: f.c2.id, start: f.c2.start_ts, file: `clips/cam1/2026/10/01/0900-${f.c2.start_ts}.mp4` },
      { type: 'file-without-row', file: `clips/cam1/2026/10/01/0700-${T('2026-10-01T07:00:00')}.mp4` },
      // A picture no clip row links: a snapshot without a clip (#111), not a clip file.
      { type: 'snapshot-without-clip', file: `clips/cam1/2026/10/01/0701-${T('2026-10-01T07:01:00')}.jpg` },
      { type: 'event-without-clip', eventId: f.e3.id, kind: 'vehicle', start: f.e3.start_ts },
      { type: 'clip-without-event', clipId: f.c4.id, start: f.c4.start_ts },
      { type: 'clip-without-event', clipId: f.c3.id, start: f.c3.start_ts },
      { type: 'clip-without-event', clipId: f.c6.id, start: f.c6.start_ts },
    ]);
    expect(r.top).toEqual([]);
    expect(r.message).toBe('5 clips in the last 2 days (since 2026-09-30 UTC): 1 rows without file, 1 files without row, 1 snapshots without a clip, 1 of 3 events without clip, 3 clips without event');
  });

  it('notes that FTP is off', async () => {
    const r = await clipsCheck(deps(camera({ months: {}, recs: {} }).deps, { settings: () => settings({ ftpEnabled: false }) }))(ctx());
    expect(r.window.notes).toEqual(['FTP is off in the proxy: no clips arrive, so every event is without a clip']);
  });

  it('stops between days when cancelled, with partial counts and no camera contact', async () => {
    fixture();
    const ac = new AbortController();
    const cam = camera({ months: {}, recs: {} });
    const r = await clipsCheck(deps(cam.deps))(ctx({ signal: ac.signal, options: { camera: true }, progress: (p) => p.done === 1 && ac.abort() }));
    expect(r.counts.clips).toBe(1); // the first day only
    expect(cam.searched).toEqual([]);
  });
});

describe('clips inventory, against the camera (part 2)', () => {
  it('pairs by start on ftp.stream: missing locally, gone from the camera, timer-only, unknown days', async () => {
    const f = fixture();
    const cam = camera({ months: { '2026-09': [28, 30], '2026-10': [1, 2] }, recs: f.recs, failing: ['2026-09-30'] });
    const progress: string[] = [];
    const r = await clipsCheck(deps(cam.deps))(ctx({ options: { camera: true }, progress: (p) => progress.push(`${p.phase} ${p.done}/${p.total}`) }));
    expect(cam.searched).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
    expect(progress).toEqual(['clips 0/3', 'clips 1/3', 'clips 2/3', 'clips 3/3', 'camera 1/3', 'camera 2/3', 'camera 3/3']);
    expect(r.counts).toMatchObject({ cameraDays: 3, unknownDays: 1, recordings: 4, timerOnly: 1, paired: 3, missingLocally: 1, missingLocallyBytes: 0x200000, goneFromCamera: 1, olderThanSd: 0, otherStream: 1 });
    expect(r.window).toMatchObject({ camera: { stream: 'sub', to: NOW - SETTLE_MS, oldestSdDay: '2026-09-28', unknownDays: ['2026-09-30'] } });
    expect(r.window.notes).toEqual(['1 local clips of another stream than sub (ftp.stream) only keep their recordings from counting as missing']);
    // The repair's candidates first, then the clips gone from the camera, then the local findings.
    expect(r.items.slice(0, 2)).toEqual([
      { type: 'missing-locally', id: f.recs['2026-10-01'][2].id, date: '2026-10-01', start: T('2026-10-01T11:00:00'), end: T('2026-10-01T11:00:30'), size: 0x200000, stream: 'sub', kinds: ['vehicle'] },
      { type: 'gone-from-camera', clipId: f.c3.id, start: f.c3.start_ts },
    ]);
    expect(r.items).toHaveLength(9);
    expect(r.top).toEqual([
      { date: '2026-10-01', state: 'listed', recordings: 3, missingLocally: 1, goneFromCamera: 1 },
      { date: '2026-09-30', state: 'unknown', recordings: 0, missingLocally: 0, goneFromCamera: 0 },
    ]);
    expect(r.message).toBe(
      '5 clips in the last 2 days (since 2026-09-30 UTC): 1 rows without file, 1 files without row, 1 snapshots without a clip, 1 of 3 events without clip, 3 clips without event; ' +
        'camera (sub): 4 recordings, 1 missing locally (2.0 MB), 1 local clips gone from the camera, 1 days unknown',
    );
  });

  it('a local clip on an unknown day is never gone; one before the SD card\'s oldest day is older than the SD', async () => {
    clip(T('2026-09-30T05:00:00')); // before the SD card's oldest day (2026-10-01)
    clip(T('2026-10-01T05:00:00')); // on an unknown day
    const cam = camera({ months: { '2026-09': [], '2026-10': [1] }, recs: {}, failing: ['2026-10-01'] });
    const r = await clipsCheck(deps(cam.deps))(ctx({ options: { camera: true } }));
    expect(r.counts).toMatchObject({ goneFromCamera: 0, olderThanSd: 1, unknownDays: 1, missingLocally: 0 });
    expect(cam.searched).toEqual(['2026-10-01']); // 09-30 and 10-02 have no recordings: no Search
  });

  it('fails the run with camera_offline when the camera does not answer', async () => {
    const cam = camera({ months: { '2026-10': [1] }, recs: {}, offline: true });
    await expect(clipsCheck(deps(cam.deps))(ctx({ options: { camera: true } }))).rejects.toThrow(/^camera_offline: /);
  });

  it('an unknown oldest SD day: clips before the oldest day seen are not judged, later ones are gone', async () => {
    clip(T('2026-09-30T05:00:00')); // the September overview failed: maybe older than the SD
    const c2 = clip(T('2026-10-01T15:00:00')); // after a day the SD has: gone
    const cam = camera({ months: { '2026-10': [1] }, recs: { '2026-10-01': [rec(T('2026-10-01T08:00:00'))] } });
    cam.deps.list.monthDays = async (m) => {
      if (m === '2026-09') throw new SearchError('search_failed', 'rspCode -17');
      return m === '2026-10' ? [1] : [];
    };
    const r = await clipsCheck(deps(cam.deps))(ctx({ options: { camera: true } }));
    expect(cam.searched).toEqual(['2026-09-30', '2026-10-01']);
    expect(r.window).toMatchObject({ camera: { oldestSdDay: null, unknownDays: [] } });
    expect(r.counts).toMatchObject({ goneFromCamera: 1, olderThanSd: 0, missingLocally: 1 });
    expect(r.items.filter((x) => (x as { type: string }).type === 'gone-from-camera')).toEqual([{ type: 'gone-from-camera', clipId: c2.id, start: c2.start_ts }]);
    expect(r.window.notes).toEqual(["1 local clips not on the camera were not judged: the SD card's oldest day is unknown, or the clip is at the window start or next to a day the camera did not list"]);
  });
});

type Item = { type: string; [k: string]: unknown };
const NOT_JUDGED = "1 local clips not on the camera were not judged: the SD card's oldest day is unknown, or the clip is at the window start or next to a day the camera did not list";
const ofType = (items: unknown[], type: string) => (items as Item[]).filter((x) => x.type === type);

describe('clips inventory: the edges (review of task 4)', () => {
  // #117 review: a recording that starts at 23:55 or later and is listed with
  // end 000000 may still be being written; it is judged from 01:00 on.
  it('a late-night recording that may still be written is not judged until 01:00 the next day', async () => {
    const late = { ...rec(T('2026-10-01T23:56:00')), end: T('2026-10-02T00:00:00') };
    const cam = camera({ months: { '2026-10': [1] }, recs: { '2026-10-01': [late] } });
    const early = await clipsCheck(deps(cam.deps))(ctx({ now: T('2026-10-02T00:20:00'), options: { camera: true } }));
    expect(early.counts).toMatchObject({ missingLocally: 0 });
    const later = await clipsCheck(deps(cam.deps))(ctx({ now: T('2026-10-02T01:06:00'), options: { camera: true } }));
    expect(later.counts).toMatchObject({ missingLocally: 1 });
  });

  it('the oldest SD day keeps only its later hours: a clip before its first recording is older than the SD', async () => {
    clip(T('2026-10-01T05:00:00')); // overwritten on the card
    const late = clip(T('2026-10-01T16:00:00')); // after the first recording that day: gone
    const cam = camera({ months: { '2026-09': [], '2026-10': [1] }, recs: { '2026-10-01': [rec(T('2026-10-01T15:00:00'))] } });
    const r = await clipsCheck(deps(cam.deps))(ctx({ options: { camera: true } }));
    expect(r.counts).toMatchObject({ olderThanSd: 1, goneFromCamera: 1, missingLocally: 1 });
    expect(ofType(r.items, 'gone-from-camera')).toEqual([{ type: 'gone-from-camera', clipId: late.id, start: late.start_ts }]);
  });

  it('the same on the fallback day when the oldest SD day is unknown: the early clip is not judged', async () => {
    clip(T('2026-10-01T05:00:00'));
    clip(T('2026-10-01T16:00:00'));
    const cam = camera({ months: { '2026-10': [1] }, recs: { '2026-10-01': [rec(T('2026-10-01T15:00:00'))] } });
    cam.deps.list.monthDays = async (m) => {
      if (m === '2026-09') throw new SearchError('search_failed', 'rspCode -17');
      return m === '2026-10' ? [1] : [];
    };
    const r = await clipsCheck(deps(cam.deps))(ctx({ options: { camera: true } }));
    expect(r.counts).toMatchObject({ olderThanSd: 0, goneFromCamera: 1 });
    expect(r.window.notes).toEqual(["1 local clips not on the camera were not judged: the SD card's oldest day is unknown, or the clip is at the window start or next to a day the camera did not list"]);
  });

  it('the missing recordings come oldest first, so the item cut keeps the ones the SD overwrites next', async () => {
    const recs = Array.from({ length: 700 }, (_, i) => rec(T('2026-10-01T00:00:00') + i * 60_000));
    const cam = camera({ months: { '2026-10': [1] }, recs: { '2026-10-01': recs } });
    const r = await clipsCheck(deps(cam.deps))(ctx({ options: { camera: true } }));
    expect(r.counts.missingLocally).toBe(700);
    expect(r.counts.missingLocallyBytes).toBe(700 * 0x100000);
    expect((r.items.slice(0, MAX_ITEMS) as Item[]).map((x) => x.start)).toEqual(recs.slice(0, MAX_ITEMS).map((x) => x.start));
  });

  // #74 final review: a repair would fetch them, and the next prune delete them again.
  it('while the storage budget prunes clips, recordings older than the oldest clip here are prunedHere, not missing', async () => {
    clip(T('2026-10-01T12:00:00'));
    const recs = [rec(T('2026-09-30T10:00:00')), rec(T('2026-10-01T11:00:00')), rec(T('2026-10-01T12:00:02')), rec(T('2026-10-01T14:00:00'))];
    const cam = () => camera({ months: { '2026-09': [30], '2026-10': [1] }, recs: { '2026-09-30': [recs[0]], '2026-10-01': recs.slice(1) } }).deps;
    // No sign of pruning: all three are missing.
    const quiet = new AuditLog({ dir: join(dir, 'audit-quiet'), version: 't', camera: () => 'cam1', now: () => NOW - 3 * 3_600_000 });
    quiet.write({ action: 'storage-daily', category: ['host'], type: ['info'], outcome: 'success', user: 'system', message: 'Storage', details: { kinds: { clips: { oldest: T('2026-10-01T12:00:00') } } } });
    const r0 = await clipsCheck(deps(cam(), { audit: quiet }))(ctx({ options: { camera: true } }));
    expect(r0.counts).toMatchObject({ missingLocally: 3, prunedHere: 0 });
    // A daily storage record inside the window saw older clips than are kept: the budget (or ftp.maxGB) pruned them.
    const pruned = new AuditLog({ dir: join(dir, 'audit-pruned'), version: 't', camera: () => 'cam1', now: () => NOW - 3 * 3_600_000 });
    pruned.write({ action: 'storage-daily', category: ['host'], type: ['info'], outcome: 'success', user: 'system', message: 'Storage', details: { kinds: { clips: { oldest: T('2026-09-30T09:00:00') } } } });
    const r = await clipsCheck(deps(cam(), { audit: pruned }))(ctx({ options: { camera: true } }));
    expect(r.counts).toMatchObject({ missingLocally: 1, prunedHere: 2, missingLocallyBytes: 0x100000 });
    expect(ofType(r.items, 'missing-locally').map((x) => x.start)).toEqual([T('2026-10-01T14:00:00')]);
    expect(r.window.notes).toContain('2 recordings older than the oldest clip here (2026-10-01) are not offered: the storage budget or ftp.maxGB deleted clips that old, and would delete them again');
  });

  it('a recording whose clip came on another stream (ftp.stream changed) is not missing', async () => {
    clip(T('2026-10-01T08:00:01'), { stream: 'main' });
    const cam = camera({ months: { '2026-10': [1] }, recs: { '2026-10-01': [rec(T('2026-10-01T08:00:00')), rec(T('2026-10-01T09:00:00'))] } });
    const r = await clipsCheck(deps(cam.deps))(ctx({ options: { camera: true } }));
    expect(r.counts).toMatchObject({ otherStream: 1, pairedOtherStream: 1, paired: 0, missingLocally: 1, goneFromCamera: 0 });
    expect(ofType(r.items, 'missing-locally').map((x) => x.start)).toEqual([T('2026-10-01T09:00:00')]);
  });

  it('pairs across the edges: the settle bound, an unknown day and the window start', async () => {
    const cameraTo = NOW - SETTLE_MS;
    clip(cameraTo - 29_000); // its recording ended before cameraTo, the clip a second after it
    clip(T('2026-10-02T00:00:01')); // on an unknown day; its recording started on the day before
    clip(T('2026-09-29T23:59:58')); // before the window; its recording started in it
    const cam = camera({
      months: { '2026-09': [30], '2026-10': [1, 2] },
      recs: { '2026-09-30': [rec(T('2026-09-30T00:00:01'))], '2026-10-01': [rec(T('2026-10-01T23:59:58'))], '2026-10-02': [rec(cameraTo - 31_000)] },
      failing: [],
    });
    cam.deps.list.day = async (date) => {
      if (date === '2026-10-02') throw new SearchError('search_failed', 'rspCode -17');
      return { '2026-09-30': [rec(T('2026-09-30T00:00:01'))], '2026-10-01': [rec(T('2026-10-01T23:59:58'))] }[date] ?? [];
    };
    const r = await clipsCheck(deps(cam.deps))(ctx({ options: { camera: true } }));
    expect(r.counts).toMatchObject({ missingLocally: 0, goneFromCamera: 0, unknownDays: 1 });

    // And the settle bound on a listed day: the recording and its clip pair though the clip ends after cameraTo.
    const cam2 = camera({ months: { '2026-10': [2] }, recs: { '2026-10-02': [rec(cameraTo - 31_000)] } });
    const r2 = await clipsCheck(deps(cam2.deps))(ctx({ options: { camera: true } }));
    expect(r2.counts).toMatchObject({ missingLocally: 0, goneFromCamera: 0, recordings: 1, paired: 1 });
  });

  it('a clip next to an unknown day is not judged: its recording may start on that day', async () => {
    clip(T('2026-10-01T23:59:58')); // its recording starts 2026-10-02 00:00:01, a day whose Search failed
    const alone = clip(T('2026-10-01T12:00:00')); // well inside a listed day: gone
    const cam = camera({ months: { '2026-09': [], '2026-10': [1, 2] }, recs: { '2026-10-01': [rec(T('2026-10-01T08:00:00'))] }, failing: ['2026-10-02'] });
    const r = await clipsCheck(deps(cam.deps))(ctx({ options: { camera: true } }));
    expect(r.counts).toMatchObject({ goneFromCamera: 1, olderThanSd: 0, unknownDays: 1 });
    expect(ofType(r.items, 'gone-from-camera').map((x) => x.clipId)).toEqual([alone.id]);
    expect(r.window.notes).toEqual([NOT_JUDGED]);
  });

  it('a clip at the window start is not judged: its recording may start before the window', async () => {
    clip(T('2026-09-30T00:00:02')); // its recording starts 2026-09-29 23:59:59, a day outside the listing
    const cam = camera({ months: { '2026-09': [29, 30], '2026-10': [] }, recs: { '2026-09-30': [rec(T('2026-09-30T08:00:00'))] } });
    const r = await clipsCheck(deps(cam.deps))(ctx({ options: { camera: true } }));
    expect(r.window).toMatchObject({ camera: { oldestSdDay: '2026-09-29' } });
    expect(r.counts).toMatchObject({ goneFromCamera: 0, olderThanSd: 0 });
    expect(r.window.notes).toEqual([NOT_JUDGED]);
  });

  it('a stale open event covers its start plus the event cap only', async () => {
    event('person', T('2026-09-30T01:00:00'), null); // never closed (the proxy was down)
    const c = clip(T('2026-09-30T05:00:00'));
    const r = await clipsCheck(deps(camera({ months: {}, recs: {} }).deps))(ctx());
    expect(ofType(r.items, 'clip-without-event')).toEqual([{ type: 'clip-without-event', clipId: c.id, start: c.start_ts }]);
    const early = clip(T('2026-09-30T01:05:00')); // inside the cap: covered
    const r2 = await clipsCheck(deps(camera({ months: {}, recs: {} }).deps))(ctx());
    expect(ofType(r2.items, 'clip-without-event').map((x) => x.clipId)).not.toContain(early.id);
  });

  it('an event that began before the window still covers the first clip; a clip before the window still covers the first event', async () => {
    event('motion', T('2026-09-29T23:50:00'), T('2026-09-30T00:20:00'));
    const c = clip(T('2026-09-30T00:10:00'));
    insertClip(catalog, { cam: 'cam1', start_ts: T('2026-10-01T09:59:00'), end_ts: T('2026-10-01T10:30:00'), path: clipPath(T('2026-10-01T09:59:00')), stream: 'sub', size: 1, received_at: 0, snapshot: null });
    const e = event('person', T('2026-10-01T10:10:00'), T('2026-10-01T10:10:20'));
    const r = await clipsCheck(deps(camera({ months: {}, recs: {} }).deps))(ctx());
    expect(ofType(r.items, 'clip-without-event').map((x) => x.clipId)).not.toContain(c.id);
    expect(ofType(r.items, 'event-without-clip').map((x) => x.eventId)).not.toContain(e.id);
  });

  it('2,400 clips against 30k events: no step blocks the event loop long', async () => {
    const days = 30;
    const start = NOW - days * 86_400_000;
    const db = catalog.db;
    db.exec('BEGIN');
    const ev = db.prepare("INSERT INTO events (cam, source, kind, start_ts, end_ts, raw) VALUES ('cam1', 'onvif', ?, ?, ?, NULL)");
    for (let i = 0; i < 30_000; i++) {
      const t = start + Math.floor((i / 30_000) * days * 86_400_000);
      ev.run(['motion', 'person', 'visitor'][i % 3], t, t + 20_000);
    }
    const cl = db.prepare("INSERT INTO clips (cam, start_ts, end_ts, path, stream, size, received_at, snapshot) VALUES ('cam1', ?, ?, ?, 'sub', 1, ?, NULL)");
    for (let i = 0; i < 2_400; i++) {
      const t = start + Math.floor((i / 2_400) * days * 86_400_000) + 5_000;
      cl.run(t, t + 30_000, join(dir, 'x', `${t}.mp4`), t);
    }
    db.exec('COMMIT');
    let last = performance.now();
    let worst = 0;
    const timer = setInterval(() => {
      const t = performance.now();
      worst = Math.max(worst, t - last);
      last = t;
    }, 1);
    try {
      const r = await clipsCheck(deps(camera({ months: {}, recs: {} }).deps, { settings: () => settings({ clipsDays: days }) }))(ctx());
      worst = Math.max(worst, performance.now() - last);
      expect(r.counts.clips).toBe(2400);
      expect(r.counts.events).toBeGreaterThan(19_990); // the last few are still settling
    } finally {
      clearInterval(timer);
    }
    expect(worst).toBeLessThan(250);
  }, 30_000);
});

// The real cam-sim: seeded SD recordings (camera time UTC, its clock at NOW),
// listed through RecordingList and the HTTP Search like the proxy does.
describe('clips inventory against cam-sim', () => {
  it('finds the recordings missing locally and the local clip gone from the SD card', async () => {
    const seed: SeedClip[] = [
      { daysAgo: 2, start: '070000', end: '070030', triggers: ['motion'] }, // 2026-09-30: missing locally
      { daysAgo: 1, start: '080000', end: '080030', triggers: ['person'] }, // 2026-10-01: here
      { daysAgo: 1, start: '090000', end: '090030', triggers: ['motion'] }, // 2026-10-01: missing locally
      { daysAgo: 0, start: '060000', end: '060020', triggers: ['vehicle'] }, // 2026-10-02: here (an earlier repair)
    ];
    const sim = await createCamSim({ users: [{ name: 'proxy', level: 'admin', password: 'proxy-pw' }], seedClips: seed, tz: 'UTC', clock: { now: () => new Date(NOW) } });
    const ports = await sim.listen({ http: 0, https: 0, control: 0, rtsp: 0, onvif: 0, baichuan: 0 }, '127.0.0.1');
    try {
      const client = new ReolinkClient({ id: 'cam1', host: `127.0.0.1:${ports.http}`, protocol: 'http', user: 'proxy', password: 'proxy-pw' });
      const list = new RecordingList({ search: (param) => client.command('Search', param), timeInfo: () => client.timeInfo() });
      const here = clip(T('2026-10-01T08:00:02'));
      clip(T('2026-10-02T06:00:01'), { origin: 'camera' });
      const gone = clip(T('2026-10-01T10:00:00'));
      clip(T('2026-09-29T23:00:00')); // before the window
      const r = await clipsCheck(deps({ list, timeInfo: () => client.timeInfo() }))(ctx({ options: { camera: true } }));
      expect(r.window).toMatchObject({ camera: { stream: 'sub', oldestSdDay: '2026-09-30', unknownDays: [] } });
      expect(r.counts).toMatchObject({ clips: 3, fromCamera: 1, cameraDays: 3, unknownDays: 0, recordings: 4, timerOnly: 0, paired: 2, missingLocally: 2, goneFromCamera: 1, olderThanSd: 0, otherStream: 0 });
      const missing = r.items.filter((x) => (x as { type: string }).type === 'missing-locally') as { id: string; date: string; start: number; size: number; stream: string; kinds: string[] }[];
      expect(missing.map((x) => [x.date, x.start, x.stream, x.kinds])).toEqual([
        ['2026-09-30', T('2026-09-30T07:00:00'), 'sub', ['motion']],
        ['2026-10-01', T('2026-10-01T09:00:00'), 'sub', ['motion']],
      ]);
      for (const x of missing) expect(x.id).toMatch(/^RecS0A_\d{8}_\d{6}_\d{6}_/);
      expect(r.counts.missingLocallyBytes).toBe(missing.reduce((n, x) => n + x.size, 0));
      expect(r.counts.missingLocallyBytes).toBeGreaterThan(0);
      expect(r.items).toContainEqual({ type: 'gone-from-camera', clipId: gone.id, start: gone.start_ts });
      expect(r.items).not.toContainEqual(expect.objectContaining({ clipId: here.id, type: 'gone-from-camera' }));
    } finally {
      await sim.close();
    }
  }, 20_000);
});
