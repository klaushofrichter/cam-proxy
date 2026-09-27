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
