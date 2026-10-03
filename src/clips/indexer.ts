import { execFile } from 'child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, unlinkSync } from 'fs';
import { copyFile, link, stat, unlink } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import { promisify } from 'util';
import type { DstRule, TimeInfo } from '../camera/time';
import { clipByPath, clipForSnapshot, clipsWithoutSnapshot, deleteClip, insertClip, overlappingEvents, setSnapshot, type ClipRow } from '../catalog/clips';
import type { Catalog } from '../catalog/db';
import type { Config } from '../config/defaults';
import { logger } from '../log';
import type { Stream } from '../recordings/names';
import type { StreamLog } from '../stream/log';
import type { Upload } from './ftp-server';

const run = promisify(execFile);

export class InvalidStartError extends Error {
  constructor() {
    super('start is not a timestamp');
    this.name = 'InvalidStartError';
  }
}
export class NotAVideoError extends Error {
  constructor() {
    super('the recording is not a video');
    this.name = 'NotAVideoError';
  }
}
// reason: a catalog row, or only a file, sits at the clip's path.
export class ClipExistsError extends Error {
  constructor(readonly reason: 'row' | 'file') {
    super('a clip with that start exists');
    this.name = 'ClipExistsError';
  }
}
const pad = (n: number) => String(n).padStart(2, '0');

// The camera names uploads <Name>_00_YYYYMMDDHHMMSS.(mp4|jpg), in its local time.
export function parseClipName(name: string): { local: string; ext: 'mp4' | 'jpg' } | null {
  const m = /_00_(\d{14})\.(mp4|jpg)$/.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = partsOf(m[1]);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || t.getUTCHours() !== h || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== s) return null;
  return { local: m[1], ext: m[2] as 'mp4' | 'jpg' };
}

function partsOf(local: string): number[] {
  return [local.slice(0, 4), local.slice(4, 6), local.slice(6, 8), local.slice(8, 10), local.slice(10, 12), local.slice(12, 14)].map(Number);
}

// The day of the nth weekday of a month (week 5, or past the month's end: the last).
function nthWeekday(year: number, mon: number, week: number, weekday: number): number {
  const first = new Date(Date.UTC(year, mon - 1, 1)).getUTCDay();
  let day = 1 + ((weekday - first + 7) % 7) + (Math.max(1, week) - 1) * 7;
  const days = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  while (day > days) day -= 7;
  return day;
}

// The UTC instants DST starts and ends in a year.
export function dstBounds(year: number, r: DstRule, std: number, dst: number): [number, number] {
  const start = Date.UTC(year, r.startMon - 1, nthWeekday(year, r.startMon, r.startWeek, r.startWeekday), r.startHour, r.startMin) - std * 60_000;
  const end = Date.UTC(year, r.endMon - 1, nthWeekday(year, r.endMon, r.endWeek, r.endWeekday), r.endHour, r.endMin) - (std + dst) * 60_000;
  return [start, end];
}

// Both readings of a camera-local time: [DST, standard] in the repeated
// autumn hour, else the one reading.
export function localToUtcCandidates(local: string, t: TimeInfo): number[] {
  const [y, mo, d, h, mi, s] = partsOf(local);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const asStd = wall - t.stdOffsetMinutes * 60_000;
  if (!t.dstRule || !t.dstOffsetMinutes) return [asStd];
  const asDst = asStd - t.dstOffsetMinutes * 60_000;
  const [start, end] = dstBounds(y, t.dstRule, t.stdOffsetMinutes, t.dstOffsetMinutes);
  const inDst = (u: number) => (start < end ? u >= start && u < end : u >= start || u < end);
  if (inDst(asDst) && !inDst(asStd)) return [asDst, asStd];
  return [localToUtc(local, t)];
}

// Camera-local YYYYMMDDHHMMSS → UTC ms. In the repeated fall hour the DST
// reading wins (the first pass); a time in the skipped spring hour reads as
// standard time.
export function localToUtc(local: string, t: TimeInfo): number {
  const [y, mo, d, h, mi, s] = partsOf(local);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const asStd = wall - t.stdOffsetMinutes * 60_000;
  if (!t.dstRule || !t.dstOffsetMinutes) return asStd;
  const asDst = asStd - t.dstOffsetMinutes * 60_000;
  const [start, end] = dstBounds(y, t.dstRule, t.stdOffsetMinutes, t.dstOffsetMinutes);
  const inDst = (u: number) => (start < end ? u >= start && u < end : u >= start || u < end);
  return inDst(asDst) ? asDst : asStd;
}

export interface ClipIndexerDeps {
  catalog: Catalog;
  log: StreamLog;
  config: () => Config;
  timeInfo: () => Promise<TimeInfo>;
  dataDir: string;
  cam: string;
  stored?: (bytes: number) => void; // a file was added to clips/ (for storage accounting)
}

// The camera names a clip's picture after the event that started it, 3-5 s
// after the clip's own start (its pre-record; measured on cam1 2026-09-28 to
// 30), never with the same time. A picture belongs to the clip that started
// last at most this long before it.
export const SNAPSHOT_WINDOW_MS = 10_000;

// Turns a finished upload into a stored, indexed clip (or its snapshot).
export class ClipIndexer {
  private failed = 0;
  private last: number | null = null;

  private now: () => number = Date.now;

  constructor(private readonly d: ClipIndexerDeps) {}

  setClock(now: () => number): void {
    this.now = now;
  }

  failures(): number {
    return this.failed;
  }

  lastIndexed(): number | null {
    return this.last;
  }

  // Clips stored without their picture (before the pairing above, or the
  // picture came late): link them now. Returns how many were linked.
  relinkSnapshots(): number {
    let n = 0;
    for (const clip of clipsWithoutSnapshot(this.d.catalog, this.d.cam)) {
      const pic = this.pictureFor(clip.start_ts);
      if (pic) {
        setSnapshot(this.d.catalog, clip.id, pic);
        n++;
      }
    }
    if (n) logger.info({ cam: this.d.cam, linked: n }, 'snapshots_relinked');
    return n;
  }

  // The earliest stored picture taken in a clip's first SNAPSHOT_WINDOW_MS.
  private pictureFor(start: number): string | null {
    let best: { ts: number; path: string } | null = null;
    for (const folder of new Set([this.folder(start), this.folder(start + SNAPSHOT_WINDOW_MS)])) {
      let names: string[];
      try {
        names = readdirSync(folder);
      } catch {
        continue;
      }
      for (const name of names) {
        const m = /^\d{4}-(\d{1,15})\.jpg$/.exec(name);
        const ts = m ? Number(m[1]) : NaN;
        if (ts >= start && ts <= start + SNAPSHOT_WINDOW_MS && (!best || ts < best.ts)) best = { ts, path: join(folder, name) };
      }
    }
    return best?.path ?? null;
  }

  private folder(ts: number): string {
    const t = new Date(ts);
    return join(this.d.dataDir, 'clips', this.d.cam, String(t.getUTCFullYear()), pad(t.getUTCMonth() + 1), pad(t.getUTCDate()));
  }

  // An upload that isn't kept (the disk is full).
  discard(u: Upload): void {
    remove(u.tmpFile);
  }

  async add(u: Upload): Promise<ClipRow | null> {
    try {
      return await this.index(u);
    } catch (err) {
      this.failed++;
      logger.warn({ err: (err as Error).message, name: u.name }, 'clip_index_failed');
      return null;
    } finally {
      remove(u.tmpFile); // moved already when it was kept
    }
  }

  // A recording fetched from the camera's SD card by an inventory repair
  // (#74): `file` stays where it is (the recordings cache; the caller keeps it
  // pinned), a copy goes into clips/ under the FTP layout, and the row has
  // origin 'camera'. No stream-log entry (so no SSE), no FTP arrival or failure
  // count. Throws InvalidStartError, NotAVideoError, or ClipExistsError.
  //
  // "Exists" is the exact path (same second). The repair's +-5 s pre-check
  // covers near-duplicates; the FTP side has no slack check (by design for now).
  // The copy goes to <path>.part and is hard-linked into place (link fails with
  // EEXIST, never overwrites), so an FTP clip landing meanwhile always wins.
  // A video file at the path with no row (a crash between link and insert) is
  // adopted instead of skipped forever.
  async addRecording(file: string, r: { start: number; stream: Stream }): Promise<ClipRow> {
    if (!Number.isSafeInteger(r.start) || r.start < 0 || Number.isNaN(new Date(r.start).getTime())) throw new InvalidStartError();
    const t = new Date(r.start);
    const root = resolve(this.d.dataDir, 'clips');
    const path = resolve(this.folder(r.start), `${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}-${r.start}.mp4`);
    if (!path.startsWith(root + sep)) throw new Error('the clip path is outside the clips folder');
    const probe = await probeVideo(file);
    if (!probe) throw new NotAVideoError();
    if (clipByPath(this.d.catalog, path)) throw new ClipExistsError('row');
    const row = (size: number, durationS: number): ClipRow => {
      if (clipByPath(this.d.catalog, path)) throw new ClipExistsError('row'); // an FTP arrival indexed it meanwhile
      return insertClip(this.d.catalog, {
        cam: this.d.cam,
        start_ts: r.start,
        end_ts: r.start + Math.round(durationS * 1000),
        path,
        stream: r.stream,
        size,
        received_at: this.now(),
        snapshot: this.pictureFor(r.start), // the camera's FTP picture may have come without its clip
        origin: 'camera',
      });
    };
    if (existsSync(path)) {
      // An orphan: adopt it when it is a video, else leave it alone.
      const own = await probeVideo(path);
      if (!own) throw new ClipExistsError('file');
      const size = (await stat(path)).size;
      const adopted = row(size, own.durationS);
      this.d.stored?.(size);
      logger.info({ clipId: adopted.id, start: r.start, bytes: size }, 'clip_adopted');
      return adopted;
    }
    mkdirSync(dirname(path), { recursive: true });
    const part = `${path}.part`;
    let size: number;
    try {
      await copyFile(file, part);
      size = (await stat(part)).size;
      await link(part, path); // EEXIST: an FTP clip landed meanwhile, it wins
    } catch (err) {
      await unlink(part).catch(() => undefined);
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new ClipExistsError('file');
      throw err;
    }
    await unlink(part).catch(() => undefined);
    let inserted: ClipRow;
    try {
      inserted = row(size, probe.durationS);
    } catch (err) {
      // Ours (we created the path), unless a row appeared: then it is not ours to delete.
      if (!(err instanceof ClipExistsError)) await unlink(path).catch(() => undefined);
      throw err;
    }
    this.d.stored?.(size);
    logger.info({ clipId: inserted.id, start: r.start, durationS: probe.durationS, bytes: size }, 'clip_repaired');
    return inserted;
  }

  private async index(u: Upload): Promise<ClipRow | null> {
    // The camera's FTP test (TestFtp) uploads <Name>_00_<time>.txt: not a clip,
    // not a failure (removed in add()'s finally).
    if (/_00_\d{14}\.txt$/.test(u.name)) {
      logger.debug({ name: u.name }, 'ftp_test_file');
      return null;
    }
    const parsed = parseClipName(u.name);
    if (!parsed) {
      this.failed++;
      logger.warn({ name: u.name }, 'clip_name_unknown');
      return null;
    }
    // In the repeated autumn hour a local name has two readings an hour
    // apart (issue #5). A clip is uploaded right after it ends, so the later
    // reading that isn't in the future is the right one (5 min for clock drift).
    const candidates = localToUtcCandidates(parsed.local, await this.d.timeInfo());
    const start = candidates.findLast((c) => c <= this.now() + 5 * 60_000) ?? candidates[0];
    const t = new Date(start);
    const folder = this.folder(start);
    const stem = join(folder, `${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}-${start}`);
    const { catalog } = this.d;

    if (parsed.ext === 'jpg') {
      if (!isJpeg(u.tmpFile)) {
        this.failed++;
        logger.warn({ name: u.name, bytes: u.bytes }, 'snapshot_not_a_jpeg');
        return null;
      }
      move(u.tmpFile, `${stem}.jpg`);
      this.d.stored?.(u.bytes);
      const clip = clipForSnapshot(catalog, this.d.cam, start, SNAPSHOT_WINDOW_MS);
      if (clip && !clip.snapshot) setSnapshot(catalog, clip.id, `${stem}.jpg`);
      // Logged so it shows whether the camera still sends pictures (2026-09-30).
      logger.info({ ts: start, bytes: u.bytes, clipId: clip?.id ?? null }, 'snapshot_stored');
      return null;
    }

    const probe = await probeVideo(u.tmpFile);
    if (!probe) {
      this.failed++;
      logger.warn({ name: u.name, bytes: u.bytes }, 'clip_not_a_video');
      return null;
    }
    const path = `${stem}.mp4`;
    move(u.tmpFile, path);
    this.d.stored?.(u.bytes);
    deleteClip(catalog, path); // a repeated upload replaces the row
    const end = start + Math.round(probe.durationS * 1000);
    const row = insertClip(catalog, {
      cam: this.d.cam,
      start_ts: start,
      end_ts: end,
      path,
      stream: this.d.config().ftp.stream,
      size: u.bytes,
      received_at: this.now(),
      snapshot: this.pictureFor(start),
    });
    const events = overlappingEvents(catalog, this.d.cam, start, end, { live: true });
    this.d.log.append(this.d.cam, 'clip', {
      clipId: row.id,
      start,
      end,
      stream: row.stream,
      size: row.size,
      codec: probe.codec,
      events,
      url: `/api/cameras/${this.d.cam}/clips/${row.id}.mp4`,
      snapshotUrl: `/api/cameras/${this.d.cam}/clips/${row.id}.jpg`,
    });
    this.last = Date.now();
    logger.info({ clipId: row.id, start, durationS: probe.durationS, bytes: row.size }, 'clip_indexed');
    return row;
  }
}

async function probeVideo(file: string): Promise<{ durationS: number; codec: string } | null> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name', '-of', 'json', file], { timeout: 30_000 });
    const j = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string; codec_name?: string }[] };
    const video = j.streams?.find((s) => s.codec_type === 'video');
    const durationS = Number(j.format?.duration);
    if (!video || !Number.isFinite(durationS) || durationS <= 0) return null;
    return { durationS, codec: video.codec_name ?? 'unknown' };
  } catch {
    return null;
  }
}

// A JPEG starts with FF D8 FF.
function isJpeg(file: string): boolean {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(3);
    return readSync(fd, b, 0, 3, 0) === 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  } finally {
    closeSync(fd);
  }
}

function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

function remove(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // gone
  }
}
