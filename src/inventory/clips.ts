import { access } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { setImmediate as yieldToLoop } from 'timers/promises';
import type { AuditLog } from '../audit/audit-log';
import type { Catalog } from '../catalog/db';
import { localDate, settlesAt, type Kind, type Stream } from '../recordings/names';
import type { RecordingEntry } from '../recordings/list';
import { listCamera, type CameraListDeps } from './camera-list';
import { coverage, pairByStart, START_SLACK_MS } from './match';
import { MAX_ITEMS, MAX_TOP, type Check, type CheckResult } from './runner';
import { records } from './stills';
import { DAY, dayStart, HOUR, utcDayParts } from '../time-units';
import { listDir } from '../fs-util';

// The clips inventory (#74, spec 2026-10-02-inventory-design §4). Part 1,
// local: the clip rows and files of the clips retention window, and the
// recording-kind events without a clip (and clips without an event). Part 2,
// with `camera: true`: the SD recordings of the window on `ftp.stream`
// (camera-list.ts) paired with the local clips of that stream (match.ts).
// Recordings on the camera but not here are the repair's candidates (the
// first items, oldest first). A day whose Search failed is `unknown`: its
// recordings never count as missing, its clips never as gone.

// What may still be on its way is not judged: an event or recording that
// ended less than this long ago (the FTP upload follows the recording's end).
export const SETTLE_MS = 5 * 60_000;
// The event kinds the camera records for (a clip is expected for each).
export const RECORDING_KINDS = ['motion', 'person', 'vehicle', 'pet'] as const;
const FTP_OFF_NOTE = 'FTP is off in the proxy: no clips arrive, so every event is without a clip';
const UNJUDGED_NOTE = (n: number) => `${n} local clips not on the camera were not judged: the SD card's oldest day is unknown, or the clip is at the window start or next to a day the camera did not list`;
const PRUNED_NOTE = (n: number, day: string) => `${n} recordings older than the oldest clip here (${day}) are not offered: the storage budget or ftp.maxGB deleted clips that old, and would delete them again`;
const OTHER_STREAM_NOTE = (n: number, stream: string) => `${n} local clips of another stream than ${stream} (ftp.stream) only keep their recordings from counting as missing`;

// eventMaxOpenMin: events.maxOpenMin, how long an open event can last.
export interface ClipsSettings { cam: string; clipsDays: number; stream: Stream; ftpEnabled: boolean; eventMaxOpenMin: number }
export interface ClipsInventoryDeps {
  dataDir: string;
  catalog: Catalog;
  settings: () => ClipsSettings; // read when a run starts
  camera: CameraListDeps;
  // The daily storage records tell whether the budget (or ftp.maxGB) has
  // been pruning clips, as for the stills; without it, never assumed.
  audit?: Pick<AuditLog, 'list'>;
}
export type ClipItem =
  // A repair candidate: `date` is the camera-local day the recording is listed under.
  | { type: 'missing-locally'; id: string; date: string; start: number; end: number; size: number; stream: Stream; kinds: Kind[] }
  | { type: 'gone-from-camera'; clipId: number; start: number }
  | { type: 'row-without-file'; clipId: number; start: number; file: string }
  | { type: 'file-without-row'; file: string }
  // An FTP picture (.jpg) that no clip row links (#111: its clip never came, or was deleted).
  | { type: 'snapshot-without-clip'; file: string }
  | { type: 'event-without-clip'; eventId: number; kind: string; start: number }
  | { type: 'clip-without-event'; clipId: number; start: number };
// The camera days with problems, the most missing first (the report's `top`).
export interface CameraDayRow { date: string; state: 'listed' | 'unknown'; recordings: number; missingLocally: number; goneFromCamera: number }

interface Row { id: number; start_ts: number; end_ts: number | null; path: string; snapshot: string | null; stream: string; origin: string }

export const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MB`;

interface EventSpan { id: number; kind: string; start_ts: number; end_ts: number | null }
async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function clipsCheck(d: ClipsInventoryDeps): Check {
  return async (ctx): Promise<CheckResult> => {
    const s = d.settings();
    const now = ctx.now;
    const from = dayStart(now - s.clipsDays * DAY);
    const to = now;
    const root = join(d.dataDir, 'clips', s.cam);
    const db = d.catalog.db;
    const counts: Record<string, number> = {
      clipsDays: s.clipsDays, clips: 0, fromCamera: 0, rowsWithoutFile: 0, filesWithoutRow: 0, snapshotsWithoutClip: 0,
      events: 0, eventsWithoutClip: 0, clipsWithoutEvent: 0,
    };
    const local: ClipItem[] = [];
    const add = (it: ClipItem) => {
      if (local.length <= MAX_ITEMS) local.push(it); // one more than kept: the runner flags the cut
    };
    const rel = (file: string) => file.startsWith(`${d.dataDir}/`) ? file.slice(d.dataDir.length + 1) : file;
    const notes: string[] = s.ftpEnabled ? [] : [FTP_OFF_NOTE];

    // Part 1: rows and files, one UTC day folder at a time.
    const rowsOf = db.prepare('SELECT id, start_ts, end_ts, path, snapshot, stream, origin FROM clips WHERE cam = ? AND start_ts >= ? AND start_ts < ? ORDER BY start_ts, id');
    const byPath = db.prepare('SELECT 1 AS x FROM clips WHERE path = ? LIMIT 1');
    const bySnapshot = db.prepare('SELECT 1 AS x FROM clips WHERE snapshot = ? LIMIT 1');
    const days: number[] = [];
    for (let t = from; t < to; t += DAY) days.push(t);
    const rows: Row[] = [];
    let cancelled = false;
    ctx.progress({ phase: 'clips', done: 0, total: days.length });
    for (const [i, day] of days.entries()) {
      if (ctx.signal.aborted) {
        cancelled = true;
        break;
      }
      const folder = join(root, ...utcDayParts(day));
      const files = new Set(await listDir(folder));
      const dayRows = rowsOf.all(s.cam, day, Math.min(day + DAY, to)) as unknown as Row[];
      const known = new Set<string>();
      for (const r of dayRows) {
        rows.push(r);
        counts.clips++;
        if (r.origin === 'camera') counts.fromCamera++;
        for (const f of [r.path, r.snapshot]) if (f && dirname(f) === folder) known.add(basename(f));
        const present = dirname(r.path) === folder ? files.has(basename(r.path)) : await exists(r.path);
        if (!present) {
          counts.rowsWithoutFile++;
          add({ type: 'row-without-file', clipId: r.id, start: r.start_ts, file: rel(r.path) });
        }
      }
      for (const n of [...files].sort()) {
        if (known.has(n) || !/\.(mp4|jpg)$/.test(n)) continue;
        const path = join(folder, n);
        const video = n.endsWith('.mp4');
        if ((video ? byPath : bySnapshot).get(path)) continue; // a row of another day points here
        if (video) {
          counts.filesWithoutRow++;
          add({ type: 'file-without-row', file: rel(path) });
        } else {
          counts.snapshotsWithoutClip++;
          add({ type: 'snapshot-without-clip', file: rel(path) });
        }
      }
      ctx.progress({ phase: 'clips', done: i + 1, total: days.length, note: new Date(day).toISOString().slice(0, 10) });
      await yieldToLoop();
    }

    // Events and clips that should overlap: recording-kind events that ended
    // SETTLE_MS ago or earlier, each with a clip; each clip with an event of
    // any kind. Sorted sweeps in JS (#74 review): a NOT EXISTS per row over
    // 30 days of events blocked the event loop for seconds. An event still
    // open covers its start plus events.maxOpenMin only (the tracker closes
    // it then; one older is stale, from a proxy that was down).
    if (!cancelled) {
      const settled = now - SETTLE_MS;
      const openCap = s.eventMaxOpenMin * 60_000;
      const recordingKind = new Set<string>(RECORDING_KINDS);
      // The window's events, and earlier ones that run into it.
      const evs = [
        ...(db.prepare('SELECT id, kind, start_ts, end_ts FROM events WHERE cam = ? AND start_ts < ? AND (end_ts IS NULL OR end_ts >= ?) ORDER BY start_ts, id').all(s.cam, from, from - openCap) as unknown as EventSpan[]),
        ...(db.prepare('SELECT id, kind, start_ts, end_ts FROM events WHERE cam = ? AND start_ts >= ? AND start_ts < ? ORDER BY start_ts, id').all(s.cam, from, to) as unknown as EventSpan[]),
      ];
      await yieldToLoop();
      const evCover = coverage(evs.map((e) => ({ start: e.start_ts, end: e.end_ts ?? e.start_ts + openCap })));
      // The window's clips, and earlier ones that run into it.
      const before = db.prepare('SELECT start_ts, end_ts FROM clips WHERE cam = ? AND start_ts < ? AND COALESCE(end_ts, start_ts) >= ? ORDER BY start_ts').all(s.cam, from, from) as unknown as { start_ts: number; end_ts: number | null }[];
      const clipCover = coverage([...before, ...rows].map((c) => ({ start: c.start_ts, end: c.end_ts ?? c.start_ts })));
      for (const e of evs) {
        if (!recordingKind.has(e.kind) || e.start_ts < from || e.end_ts === null || e.end_ts > settled) continue;
        counts.events++;
        if (clipCover(e.start_ts, e.end_ts)) continue;
        counts.eventsWithoutClip++;
        add({ type: 'event-without-clip', eventId: e.id, kind: e.kind, start: e.start_ts });
      }
      for (const c of rows) {
        if (evCover(c.start_ts, c.end_ts ?? c.start_ts)) continue;
        counts.clipsWithoutEvent++;
        add({ type: 'clip-without-event', clipId: c.id, start: c.start_ts });
      }
    }

    let message =
      `${counts.clips} clips in the last ${s.clipsDays} days (since ${new Date(from).toISOString().slice(0, 10)} UTC): ${counts.rowsWithoutFile} rows without file, ${counts.filesWithoutRow} files without row, ${counts.snapshotsWithoutClip} snapshots without a clip, ` +
      `${counts.eventsWithoutClip} of ${counts.events} events without clip, ${counts.clipsWithoutEvent} clips without event`;
    const window: CheckResult['window'] = { from, to, reason: 'retention', notes };
    if (!ctx.options?.camera || cancelled || ctx.signal.aborted) return { window, counts, top: [], items: local, message };

    // Part 2: the camera's recordings of the window on ftp.stream.
    const cameraTo = now - SETTLE_MS;
    let listing;
    try {
      listing = await listCamera(d.camera, {
        from, to, stream: s.stream, signal: ctx.signal,
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
    // Everything pairs (#74 review): the recordings of every listed day and the
    // clips around the window (also on unknown days, also those ending after
    // cameraTo, also those up to START_SLACK_MS before `from`), so a pair that
    // straddles a bound is still a pair. Only what is left over is judged,
    // with the strict bounds: inside the window, ended by cameraTo, on a
    // listed day.
    const pool = listing.days.flatMap((x) => x.recordings);
    const edge = db.prepare('SELECT id, start_ts, end_ts, stream FROM clips WHERE cam = ? AND start_ts >= ? AND start_ts < ?').all(s.cam, from - START_SLACK_MS, from) as unknown as Pick<Row, 'id' | 'start_ts' | 'end_ts' | 'stream'>[];
    const near = [...edge, ...rows].map((r) => ({ id: r.id, start: r.start_ts, end: r.end_ts ?? r.start_ts, stream: r.stream }));
    const judgedRec = (r: RecordingEntry) => r.start >= from && settlesAt(r) <= cameraTo;
    const judgedClip = (c: { start: number; end: number }) => c.start >= from && c.end <= cameraTo && listed.has(localDate(c.start, t));
    // A clip whose recording may have started outside what was listed (before
    // the window, or on an unknown or unlisted neighbour day) can't be called
    // gone: it is not judged (#74 review).
    const clearOfEdges = (c: { start: number }) =>
      c.start >= from + START_SLACK_MS && listed.has(localDate(c.start - START_SLACK_MS, t)) && listed.has(localDate(c.start + START_SLACK_MS, t));
    const pairing = pairByStart(pool, near.filter((c) => c.stream === s.stream));
    // After an ftp.stream change the clips of the old stream still hold their
    // recordings: the recordings left over pair with them (same ±5 s) and are
    // never missing, so the repair never fetches a duplicate.
    const other = pairByStart(pairing.recsAlone, near.filter((c) => c.stream !== s.stream).map((c) => ({ ...c, stream: s.stream })));
    const recs = pool.filter(judgedRec);
    // Oldest first (#74 review): the item cut keeps the recordings the SD card
    // overwrites next, the ones the repair takes first.
    // While the storage budget (or ftp.maxGB) prunes clips, a recording
    // older than the oldest clip here was most likely deleted for space: a
    // repair would fetch it and the next prune delete it again. Such ones
    // count as prunedHere, never missing (#74 final review). Pruning shows
    // as for the stills: the store is younger than the window by an hour or
    // more, and a daily storage record inside the window saw older clips.
    const oldestHere = (db.prepare('SELECT MIN(start_ts) AS t FROM clips WHERE cam = ?').get(s.cam) as { t: number | null } | undefined)?.t ?? null;
    const pruning =
      d.audit !== undefined && oldestHere !== null && oldestHere - from >= HOUR &&
      (await records(d.audit, ['storage-daily'], from, now)).some((r) => {
        const v = (r.cam_proxy as { kinds?: { clips?: { oldest?: unknown } } } | undefined)?.kinds?.clips?.oldest;
        return typeof v === 'number' && v < oldestHere - HOUR;
      });
    const prunedHereFrom = pruning ? oldestHere! : -Infinity;
    const alone = other.recsAlone.filter((r) => judgedRec(r) && r.kinds.length > 0);
    const prunedHere = alone.filter((r) => r.start < prunedHereFrom).length;
    const missing = alone.filter((r) => r.start >= prunedHereFrom).sort((a, b) => a.start - b.start);
    const otherStream = rows.filter((r) => r.stream !== s.stream).length;
    // A clip left over on a day the SD card covers is gone from the camera;
    // one before the card's oldest day is older than the SD. The card
    // overwrites from its oldest end, so its oldest day keeps only its later
    // hours: there, a clip before the day's first recording is older too.
    // When the oldest day is unknown (an earlier month's overview failed), the
    // oldest listed day with recordings bounds "gone" the same way; the clips
    // before that are not judged (a note says how many).
    const sdFrom = listing.oldestSdDay;
    const bound = sdFrom ?? listing.days.find((x) => x.state === 'listed' && x.recordings.length > 0)?.date ?? null;
    const firstOnBound = Math.min(...pool.filter((r) => dayOf.get(r.id) === bound).map((r) => r.start));
    const gone: typeof near = [];
    let olderThanSd = 0;
    let unjudged = 0;
    for (const c of pairing.clipsAlone.filter(judgedClip)) {
      const day = localDate(c.start, t);
      if (!clearOfEdges(c)) unjudged++;
      else if (bound !== null && (day > bound || (day === bound && c.start >= firstOnBound))) gone.push(c);
      else if (sdFrom !== null) olderThanSd++;
      else unjudged++;
    }
    // Not judged either way (no logic, on purpose): a row whose file is gone
    // still pairs, so its recording is not offered again (conservative).
    const camera = {
      cameraDays: listing.days.length,
      unknownDays: unknown.length,
      recordings: recs.filter((r) => r.kinds.length > 0).length,
      timerOnly: recs.filter((r) => r.kinds.length === 0).length,
      paired: pairing.pairs.filter((p) => judgedRec(p.rec) && p.rec.kinds.length > 0).length,
      pairedOtherStream: other.pairs.filter((p) => judgedRec(p.rec) && p.rec.kinds.length > 0).length,
      missingLocally: missing.length,
      missingLocallyBytes: missing.reduce((n, r) => n + r.size, 0),
      prunedHere,
      goneFromCamera: gone.length,
      olderThanSd,
      otherStream,
    };
    Object.assign(counts, camera);
    const items: ClipItem[] = [
      ...missing.map((r): ClipItem => ({ type: 'missing-locally', id: r.id, date: dayOf.get(r.id)!, start: r.start, end: r.end, size: r.size, stream: r.stream, kinds: r.kinds })),
      ...gone.map((c): ClipItem => ({ type: 'gone-from-camera', clipId: c.id, start: c.start })),
      ...local,
    ];
    const perDay = new Map<string, CameraDayRow>(listing.days.map((x) => [x.date, { date: x.date, state: x.state, recordings: x.recordings.filter((r) => judgedRec(r) && r.kinds.length > 0).length, missingLocally: 0, goneFromCamera: 0 }]));
    for (const r of missing) perDay.get(dayOf.get(r.id)!)!.missingLocally++;
    for (const c of gone) {
      const row = perDay.get(localDate(c.start, t));
      if (row) row.goneFromCamera++;
    }
    const top = [...perDay.values()]
      .filter((x) => x.state === 'unknown' || x.missingLocally || x.goneFromCamera)
      .sort((a, b) => b.missingLocally - a.missingLocally || b.goneFromCamera - a.goneFromCamera || a.date.localeCompare(b.date))
      .slice(0, MAX_TOP);
    if (otherStream) notes.push(OTHER_STREAM_NOTE(otherStream, s.stream));
    if (unjudged) notes.push(UNJUDGED_NOTE(unjudged));
    if (prunedHere) notes.push(PRUNED_NOTE(prunedHere, new Date(oldestHere!).toISOString().slice(0, 10)));
    message +=
      `; camera (${s.stream}): ${camera.recordings} recordings, ${camera.missingLocally} missing locally (${mb(camera.missingLocallyBytes)}), ` +
      `${camera.goneFromCamera} local clips gone from the camera, ${camera.unknownDays} days unknown`;
    return {
      window: { ...window, camera: { stream: s.stream, to: cameraTo, oldestSdDay: sdFrom, unknownDays: unknown } },
      counts, top, items, message,
    };
  };
}
