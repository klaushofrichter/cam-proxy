// A clips repair run's caps (#74, #342), one set for the server
// (repair-clips.ts, runner.ts) and the admin UI (web/src/lib/inventory.ts,
// which imports this file: no Node imports here).
export const REPAIR_MAX_CLIPS = 50;
export const REPAIR_MAX_BYTES = 200 * 2 ** 20;
export const REPAIR_GAP_MS = 1000;
export const REPAIR_MAX_FAILURES = 3;
// A repair needs a compare less than an hour old.
export const REPAIR_MAX_AGE_MS = 3_600_000;
// The byte cap as the pages say it ("200 MB").
export const REPAIR_MAX_MB = REPAIR_MAX_BYTES / 2 ** 20;
