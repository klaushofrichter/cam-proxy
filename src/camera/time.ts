// The camera's time zone, from GetTime (moved from cams server/recordings/clipNames.ts).
export interface TimeInfo {
  stdOffsetMinutes: number; // e.g. -360 for UTC-6
  dstOffsetMinutes: number; // added when a clip's name carries the DST flag
}

export function timeInfoFromGetTime(value: unknown): TimeInfo {
  const v = (value ?? {}) as { Time?: { timeZone?: number }; Dst?: { enable?: number; offset?: number } };
  const west = Number(v.Time?.timeZone ?? 0);
  const dstOn = Number(v.Dst?.enable ?? 0) === 1;
  return {
    stdOffsetMinutes: west === 0 ? 0 : -west / 60,
    dstOffsetMinutes: dstOn ? Number(v.Dst?.offset ?? 1) * 60 : 0,
  };
}
