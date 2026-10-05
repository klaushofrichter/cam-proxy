import { dstBounds, inDst, type TimeInfo } from '../camera/time';

// The camera-local date of a moment: the limits count per camera day and
// calendar month (the container runs in UTC). Without the camera's time
// info, the UTC date.
export function localDay(ts: number, t: TimeInfo | undefined): string {
  return new Date(ts + localOffsetMinutes(ts, t) * 60_000).toISOString().slice(0, 10);
}

// The camera's offset from UTC at a moment, in minutes (its standard
// offset, plus its DST offset while its DST rule applies); 0 without the
// camera's time info.
export function localOffsetMinutes(ts: number, t: TimeInfo | undefined): number {
  if (!t) return 0;
  let offset = t.stdOffsetMinutes;
  if (t.dstRule && t.dstOffsetMinutes) {
    const year = new Date(ts + offset * 60_000).getUTCFullYear();
    const [start, end] = dstBounds(year, t.dstRule, t.stdOffsetMinutes, t.dstOffsetMinutes);
    if (inDst(ts, start, end)) offset += t.dstOffsetMinutes;
  }
  return offset;
}
