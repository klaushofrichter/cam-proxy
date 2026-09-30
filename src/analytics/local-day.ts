import type { TimeInfo } from '../camera/time';
import { dstBounds } from '../clips/indexer';

// The camera-local date of a moment: the limits count per camera day and
// calendar month (the container runs in UTC). Without the camera's time
// info, the UTC date.
export function localDay(ts: number, t: TimeInfo | undefined): string {
  let offset = 0;
  if (t) {
    offset = t.stdOffsetMinutes;
    if (t.dstRule && t.dstOffsetMinutes) {
      const year = new Date(ts + offset * 60_000).getUTCFullYear();
      const [start, end] = dstBounds(year, t.dstRule, t.stdOffsetMinutes, t.dstOffsetMinutes);
      if (ts >= start && ts < end) offset += t.dstOffsetMinutes;
    }
  }
  return new Date(ts + offset * 60_000).toISOString().slice(0, 10);
}
