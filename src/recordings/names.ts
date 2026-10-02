// src/recordings/names.ts
// The camera's SD recording names (ported from cams
// server/recordings/clipNames.ts): RecS0A_DST20261001_211129_211207_0_5514C080000000_108CE9.mp4 =
// stream, name version, DST flag, camera-local date, start, end, an optional
// animal-type field, trigger flags (hex), size in bytes (hex).
import type { TimeInfo } from '../camera/time';
import { localDay } from '../analytics/local-day';

export type Stream = 'main' | 'sub';
export type Kind = 'person' | 'vehicle' | 'pet' | 'motion';
export interface SdName { id: string; stream: Stream; dst: boolean; date: string; start: string; end: string; size: number; kinds: Kind[] }

export const SD_ID = /^Rec[MS][0-9A-Za-z]{2}_(DST)?\d{8}_\d{6}_\d{6}_[0-9A-Za-z_]+\.mp4$/;
const NAME = /^Rec([MS])[0-9A-Za-z]{2}_(DST)?(\d{8})_(\d{6})_(\d{6})_(?:\d+_)?([0-9A-Fa-f]+)_([0-9A-Fa-f]+)\.mp4$/;
const HMS = /^([01]\d|2[0-3])[0-5]\d[0-5]\d$/;
// Name versions 9 and 10 (14 hex digits): bit 55 − position (reolink_aio's layout, as in cams).
const POSITIONS: [Kind, number][] = [['person', 17], ['vehicle', 19], ['pet', 20], ['motion', 24]];
const DAY = 86_400_000;

export const validId = (id: string): boolean => id.length <= 128 && SD_ID.test(id);

export function decodeKinds(flagsHex: string): Kind[] {
  if (!/^[0-9A-Fa-f]{14}$/.test(flagsHex)) return [];
  const v = BigInt(`0x${flagsHex}`);
  return POSITIONS.filter(([, pos]) => ((v >> BigInt(55 - pos)) & 1n) === 1n).map(([k]) => k);
}

export function parseSdName(nameOrPath: string): SdName | null {
  const id = nameOrPath.slice(nameOrPath.lastIndexOf('/') + 1);
  if (!validId(id)) return null;
  const m = NAME.exec(id);
  if (!m) return null;
  const [, s, dst, ymd, start, end, flags, size] = m;
  const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date || !HMS.test(start) || !HMS.test(end)) return null;
  const bytes = parseInt(size, 16);
  if (!Number.isSafeInteger(bytes)) return null;
  return { id, stream: s === 'M' ? 'main' : 'sub', dst: Boolean(dst), date, start, end, size: bytes, kinds: decodeKinds(flags) };
}

// A recording still being written is listed with end 000000; only one that
// starts in the last minutes before midnight really ends then (cams).
export const stillRecording = (n: SdName): boolean => n.end === '000000' && n.start < '235500';

const wall = (date: string, hms: string) =>
  Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), Number(hms.slice(0, 2)), Number(hms.slice(2, 4)), Number(hms.slice(4, 6)));

// Callers must check stillRecording(n) first: the end time of a clip still
// being written (end 000000) is meaningless.
// The name's DST flag decides the offset, so the night the clocks change is right.
export function recordingTimes(n: SdName, t: TimeInfo): { start: number; end: number } {
  const off = (t.stdOffsetMinutes + (n.dst ? t.dstOffsetMinutes : 0)) * 60_000;
  const start = wall(n.date, n.start) - off;
  const end = wall(n.date, n.end) - off + (n.end < n.start ? DAY : 0);
  return { start, end };
}

// The camera-local date of a moment (one helper with the analytics limits).
export const localDate = (ts: number, t: TimeInfo): string => localDay(ts, t);

export function localDays(from: number, to: number, t: TimeInfo): string[] {
  const last = localDate(to, t);
  const out = [localDate(from, t)];
  while (out[out.length - 1] < last) {
    const d = new Date(`${out[out.length - 1]}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
