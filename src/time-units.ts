// Time units and the UTC day/minute naming the data folders use.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const pad2 = (n: number) => String(n).padStart(2, '0');

// The start of the UTC day of `ts`.
export const dayStart = (ts: number) => Math.floor(ts / DAY) * DAY;

// The UTC day folder parts of `ts`: [YYYY, MM, DD].
export const utcDayParts = (ts: number): [string, string, string] => {
  const d = new Date(ts);
  return [String(d.getUTCFullYear()), pad2(d.getUTCMonth() + 1), pad2(d.getUTCDate())];
};

// The UTC HHMM of `ts` (a minute's file name).
export const utcHhmm = (ts: number): string => {
  const d = new Date(ts);
  return `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
};

// A YYYY-MM-DD date `n` days later (earlier for a negative n).
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}
