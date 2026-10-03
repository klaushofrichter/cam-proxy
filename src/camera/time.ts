// The camera's time zone, from GetTime (moved from cams server/recordings/clipNames.ts).
export interface TimeInfo {
  stdOffsetMinutes: number; // e.g. -360 for UTC-6
  dstOffsetMinutes: number; // added when a clip's name carries the DST flag
  dstRule?: DstRule; // when DST applies (FTP upload names carry no DST flag)
}

// The camera's DST rule (GetTime Dst): the nth weekday (week 5 = the last) of
// a month, at a local time; the start in standard time, the end in DST.
export interface DstRule {
  startMon: number;
  startWeek: number;
  startWeekday: number;
  startHour: number;
  startMin: number;
  endMon: number;
  endWeek: number;
  endWeekday: number;
  endHour: number;
  endMin: number;
}

// The day of the nth weekday of a month (week 5, or past the month's end: the last).
function nthWeekday(year: number, mon: number, week: number, weekday: number): number {
  const first = new Date(Date.UTC(year, mon - 1, 1)).getUTCDay();
  let day = 1 + ((weekday - first + 7) % 7) + (Math.max(1, week) - 1) * 7;
  const days = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  while (day > days) day -= 7;
  return day;
}

// The UTC instants DST starts and ends in a year (std and dst in minutes).
export function dstBounds(year: number, r: DstRule, std: number, dst: number): [number, number] {
  const start = Date.UTC(year, r.startMon - 1, nthWeekday(year, r.startMon, r.startWeek, r.startWeekday), r.startHour, r.startMin) - std * 60_000;
  const end = Date.UTC(year, r.endMon - 1, nthWeekday(year, r.endMon, r.endWeek, r.endWeekday), r.endHour, r.endMin) - (std + dst) * 60_000;
  return [start, end];
}

// Whether a UTC instant is in DST, given the year's bounds; start > end:
// DST spans New Year (southern hemisphere).
export const inDst = (u: number, start: number, end: number): boolean => (start < end ? u >= start && u < end : u >= start || u < end);

export function timeInfoFromGetTime(value: unknown): TimeInfo {
  const v = (value ?? {}) as { Time?: { timeZone?: number }; Dst?: Partial<Record<keyof DstRule | 'enable' | 'offset', number>> };
  const west = Number(v.Time?.timeZone ?? 0);
  const dstOn = Number(v.Dst?.enable ?? 0) === 1;
  const info: TimeInfo = {
    stdOffsetMinutes: west === 0 ? 0 : -west / 60,
    dstOffsetMinutes: dstOn ? Number(v.Dst?.offset ?? 1) * 60 : 0,
  };
  const d = v.Dst ?? {};
  const keys: (keyof DstRule)[] = ['startMon', 'startWeek', 'startWeekday', 'startHour', 'startMin', 'endMon', 'endWeek', 'endWeekday', 'endHour', 'endMin'];
  if (dstOn && keys.every((k) => Number.isInteger(Number(d[k] ?? (k.endsWith('Min') ? 0 : NaN))))) {
    info.dstRule = Object.fromEntries(keys.map((k) => [k, Number(d[k] ?? 0)])) as unknown as DstRule;
  }
  return info;
}
