import { access, readdir } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { setImmediate as yieldToLoop } from 'timers/promises';
import type { Catalog } from '../catalog/db';
import { localDate, type Kind, type Stream } from '../recordings/names';
import type { RecordingEntry } from '../recordings/list';
import { listCamera, type CameraListDeps } from './camera-list';
import { pairByStart } from './match';
import { MAX_ITEMS, MAX_TOP, type Check, type CheckResult } from './runner';

// The clips inventory (#74, spec 2026-10-02-inventory-design §4). Part 1,
// local: the clip rows and files of the clips retention window, and the
// recording-kind events without a clip (and clips without an event). Part 2,
// with `camera: true`: the SD recordings of the window on `ftp.stream`
// (camera-list.ts) paired with the local clips of that stream (match.ts).
// Recordings on the camera but not here are the repair's candidates (the
// first items, newest first). A day whose Search failed is `unknown`: its
// recordings never count as missing, its clips never as gone.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// What may still be on its way is not judged: an event or recording that
// ended less than this long ago (the FTP upload follows the recording's end).
export const SETTLE_MS = 5 * 60_000;
// The event kinds the camera records for (a clip is expected for each).
export const RECORDING_KINDS = ['motion', 'person', 'vehicle', 'pet'] as const;
const FTP_OFF_NOTE = 'FTP is off in the proxy: no clips arrive, so every event is without a clip';
const UNJUDGED_NOTE = (n: number) => `${n} local clips not on the camera were not judged: the SD card's oldest day is unknown`;
const OTHER_STREAM_NOTE = (n: number, stream: string) => `${n} local clips of another stream than ${stream} (ftp.stream) were left out of the camera compare`;

export interface ClipsSettings { cam: string; clipsDays: number; stream: Stream; ftpEnabled: boolean }
export interface ClipsInventoryDeps {
  dataDir: string;
  catalog: Catalog;
  settings: () => ClipsSettings; // read when a run starts
  camera: CameraListDeps;
}
export type ClipItem =
  // A repair candidate: `date` is the camera-local day the recording is listed under.
  | { type: 'missing-locally'; id: string; date: string; start: number; end: number; size: number; stream: Stream; kinds: Kind[] }
  | { type: 'gone-from-camera'; clipId: number; start: number }
  | { type: 'row-without-file'; clipId: number; start: number; file: string }
  | { type: 'file-without-row'; file: string }
  | { type: 'event-without-clip'; eventId: number; kind: string; start: number }
  | { type: 'clip-without-event'; clipId: number; start: number };
// The camera days with problems, the most missing first (the report's `top`).
export interface CameraDayRow { date: string; state: 'listed' | 'unknown'; recordings: number; missingLocally: number; goneFromCamera: number }

interface Row { id: number; start_ts: number; end_ts: number | null; path: string; snapshot: string | null; stream: string; origin: string }

const pad = (n: number) => String(n).padStart(2, '0');
const dayStart = (ts: number) => Math.floor(ts / DAY) * DAY;
const dayFolder = (root: string, ts: number) => {
  const d = new Date(ts);
  return join(root, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()));
};
export const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MB`;

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
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
      clipsDays: s.clipsDays, clips: 0, fromCamera: 0, rowsWithoutFile: 0, filesWithoutRow: 0,
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
      const folder = dayFolder(root, day);
      const files = new Set(await names(folder));
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
        if ((n.endsWith('.mp4') ? byPath : bySnapshot).get(path)) continue; // a row of another day points here
        counts.filesWithoutRow++;
        add({ type: 'file-without-row', file: rel(path) });
      }
      ctx.progress({ phase: 'clips', done: i + 1, total: days.length, note: new Date(day).toISOString().slice(0, 10) });
      await yieldToLoop();
    }

    // Events and clips that should overlap: recording-kind events that ended
    // SETTLE_MS ago or earlier; any event for a clip.
    const kinds = RECORDING_KINDS.map(() => '?').join(', ');
    if (!cancelled) {
      const settled = now - SETTLE_MS;
      counts.events = Number((db.prepare(`SELECT COUNT(*) AS n FROM events WHERE cam = ? AND kind IN (${kinds}) AND start_ts >= ? AND end_ts IS NOT NULL AND end_ts <= ?`).get(s.cam, ...RECORDING_KINDS, from, settled) as { n: number }).n);
      const lonely = db
        .prepare(`SELECT e.id, e.kind, e.start_ts FROM events e WHERE e.cam = ? AND e.kind IN (${kinds}) AND e.start_ts >= ? AND e.end_ts IS NOT NULL AND e.end_ts <= ?
          AND NOT EXISTS (SELECT 1 FROM clips c WHERE c.cam = e.cam AND c.start_ts <= e.end_ts AND COALESCE(c.end_ts, c.start_ts) >= e.start_ts) ORDER BY e.start_ts, e.id`)
        .all(s.cam, ...RECORDING_KINDS, from, settled) as { id: number; kind: string; start_ts: number }[];
      counts.eventsWithoutClip = lonely.length;
      for (const e of lonely) add({ type: 'event-without-clip', eventId: e.id, kind: e.kind, start: e.start_ts });
      const bare = db
        .prepare(`SELECT c.id, c.start_ts FROM clips c WHERE c.cam = ? AND c.start_ts >= ? AND c.start_ts < ?
          AND NOT EXISTS (SELECT 1 FROM events e WHERE e.cam = c.cam AND e.start_ts <= COALESCE(c.end_ts, c.start_ts) AND (e.end_ts IS NULL OR e.end_ts >= c.start_ts)) ORDER BY c.start_ts, c.id`)
        .all(s.cam, from, to) as { id: number; start_ts: number }[];
      counts.clipsWithoutEvent = bare.length;
      for (const c of bare) add({ type: 'clip-without-event', clipId: c.id, start: c.start_ts });
    }

    let message =
      `${counts.clips} clips since ${new Date(from).toISOString()}: ${counts.rowsWithoutFile} rows without file, ${counts.filesWithoutRow} files without row, ` +
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
    const recs: RecordingEntry[] = listing.days.flatMap((x) => x.recordings).filter((r) => r.start >= from && r.end <= cameraTo);
    const mine = rows.filter((r) => r.stream === s.stream && (r.end_ts ?? r.start_ts) <= cameraTo && listed.has(localDate(r.start_ts, t)));
    const otherStream = rows.filter((r) => r.stream !== s.stream).length;
    const pairing = pairByStart(recs, mine.map((r) => ({ id: r.id, start: r.start_ts, stream: r.stream })));
    const missing = pairing.recsAlone.filter((r) => r.kinds.length > 0).sort((a, b) => b.start - a.start);
    // A clip alone on a day the SD card still covers is gone from the camera;
    // one before the card's oldest day is older than the SD. When the oldest
    // day is unknown (an earlier month's overview failed), the oldest listed
    // day with recordings is a safe bound for "gone"; the clips before it are
    // not judged (a note says how many).
    const sdFrom = listing.oldestSdDay;
    const goneFrom = sdFrom ?? listing.days.find((x) => x.state === 'listed' && x.recordings.length > 0)?.date ?? null;
    const gone = pairing.clipsAlone.filter((c) => goneFrom !== null && localDate(c.start, t) >= goneFrom);
    const olderThanSd = sdFrom === null ? 0 : pairing.clipsAlone.length - gone.length;
    const unjudged = pairing.clipsAlone.length - gone.length - olderThanSd;
    const camera = {
      cameraDays: listing.days.length,
      unknownDays: unknown.length,
      recordings: recs.filter((r) => r.kinds.length > 0).length,
      timerOnly: recs.filter((r) => r.kinds.length === 0).length,
      paired: pairing.pairs.filter((p) => p.rec.kinds.length > 0).length,
      missingLocally: missing.length,
      missingLocallyBytes: missing.reduce((n, r) => n + r.size, 0),
      goneFromCamera: gone.length,
      olderThanSd,
      otherStream,
    };
    Object.assign(counts, camera);
    const dayOf = new Map(listing.days.flatMap((x) => x.recordings.map((r) => [r.id, x.date] as const)));
    const items: ClipItem[] = [
      ...missing.map((r): ClipItem => ({ type: 'missing-locally', id: r.id, date: dayOf.get(r.id)!, start: r.start, end: r.end, size: r.size, stream: r.stream, kinds: r.kinds })),
      ...gone.map((c): ClipItem => ({ type: 'gone-from-camera', clipId: c.id, start: c.start })),
      ...local,
    ];
    const perDay = new Map<string, CameraDayRow>(listing.days.map((x) => [x.date, { date: x.date, state: x.state, recordings: x.recordings.filter((r) => r.kinds.length > 0).length, missingLocally: 0, goneFromCamera: 0 }]));
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
    message +=
      `; camera (${s.stream}): ${camera.recordings} recordings, ${camera.missingLocally} missing locally (${mb(camera.missingLocallyBytes)}), ` +
      `${camera.goneFromCamera} local clips gone from the camera, ${camera.unknownDays} days unknown`;
    return {
      window: { ...window, camera: { stream: s.stream, to: cameraTo, oldestSdDay: sdFrom, unknownDays: unknown } },
      counts, top, items, message,
    };
  };
}
