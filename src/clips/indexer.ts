import { execFile } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { promisify } from 'util';
import type { DstRule, TimeInfo } from '../camera/time';
import { clipByPath, deleteClip, insertClip, overlappingEvents, setSnapshot, type ClipRow } from '../catalog/clips';
import type { Catalog } from '../catalog/db';
import type { Config } from '../config/defaults';
import { logger } from '../log';
import type { StreamLog } from '../stream/log';
import type { Upload } from './ftp-server';

const run = promisify(execFile);
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
function dstBounds(year: number, r: DstRule, std: number, dst: number): [number, number] {
  const start = Date.UTC(year, r.startMon - 1, nthWeekday(year, r.startMon, r.startWeek, r.startWeekday), r.startHour, r.startMin) - std * 60_000;
  const end = Date.UTC(year, r.endMon - 1, nthWeekday(year, r.endMon, r.endWeek, r.endWeekday), r.endHour, r.endMin) - (std + dst) * 60_000;
  return [start, end];
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
}

// Turns a finished upload into a stored, indexed clip (or its snapshot).
export class ClipIndexer {
  private failed = 0;
  private last: number | null = null;

  constructor(private readonly d: ClipIndexerDeps) {}

  failures(): number {
    return this.failed;
  }

  lastIndexed(): number | null {
    return this.last;
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

  private async index(u: Upload): Promise<ClipRow | null> {
    const parsed = parseClipName(u.name);
    if (!parsed) {
      this.failed++;
      logger.warn({ name: u.name }, 'clip_name_unknown');
      return null;
    }
    const start = localToUtc(parsed.local, await this.d.timeInfo());
    const t = new Date(start);
    const folder = join(this.d.dataDir, 'clips', this.d.cam, String(t.getUTCFullYear()), pad(t.getUTCMonth() + 1), pad(t.getUTCDate()));
    const stem = join(folder, `${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}-${start}`);
    const { catalog } = this.d;

    if (parsed.ext === 'jpg') {
      move(u.tmpFile, `${stem}.jpg`);
      const clip = clipByPath(catalog, `${stem}.mp4`);
      if (clip) setSnapshot(catalog, clip.id, `${stem}.jpg`);
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
    deleteClip(catalog, path); // a repeated upload replaces the row
    const end = start + Math.round(probe.durationS * 1000);
    const row = insertClip(catalog, {
      cam: this.d.cam,
      start_ts: start,
      end_ts: end,
      path,
      stream: this.d.config().ftp.stream,
      size: u.bytes,
      received_at: Date.now(),
      snapshot: existsSync(`${stem}.jpg`) ? `${stem}.jpg` : null,
    });
    const events = overlappingEvents(catalog, this.d.cam, start, end);
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
