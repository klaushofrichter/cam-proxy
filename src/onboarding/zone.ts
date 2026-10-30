// The zone a camera should run in, as the camera's own GetTime/SetTime terms
// (spec 2026-10-30-camera-onboarding-design §4.7): the standard offset and a
// DST rule "the nth weekday of a month at a local time" (src/camera/time.ts).
// A zone whose changes that rule can't express (none, or more than two a
// year, a shift that is no whole hour) is unsupported.
import type { Config } from '../config/defaults';
import { dstBounds, type DstRule } from '../camera/time';

export interface ZoneRule { stdOffsetMinutes: number; dst: (DstRule & { offsetHours: number }) | null }

const HOUR = 3600_000;
const MIN = 60_000;

// Whether the runtime knows this IANA zone.
export function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// The zone's UTC offset in minutes at an instant.
function offsetAt(fmt: Intl.DateTimeFormat, t: number): number {
  const name = fmt.formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name);
  if (!m || !m[1]) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

// The local wall time of `t` at offset `off` as a DST rule's part.
function rulePart(t: number, off: number): { mon: number; week: number; weekday: number; hour: number; min: number } {
  const d = new Date(t + off * MIN);
  const day = d.getUTCDate();
  const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return { mon: d.getUTCMonth() + 1, week: day > days - 7 ? 5 : Math.ceil(day / 7), weekday: d.getUTCDay(), hour: d.getUTCHours(), min: d.getUTCMinutes() };
}

export function zoneRule(zone: string, year: number): ZoneRule | 'unsupported' {
  if (!knownZone(zone)) return 'unsupported';
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
  const from = Date.UTC(year, 0, 1);
  const to = Date.UTC(year + 1, 0, 1);
  // The year's changes, hour by hour, then to the minute.
  const changes: { at: number; before: number; after: number }[] = [];
  let prev = offsetAt(fmt, from);
  for (let t = from + HOUR; t <= to; t += HOUR) {
    const cur = offsetAt(fmt, t);
    if (cur === prev) continue;
    let lo = t - HOUR;
    let hi = t;
    while (hi - lo > MIN) {
      const mid = lo + Math.floor((hi - lo) / 2 / MIN) * MIN;
      if (offsetAt(fmt, mid) === prev) lo = mid;
      else hi = mid;
    }
    changes.push({ at: hi, before: prev, after: cur });
    prev = cur;
  }
  if (changes.length === 0) return { stdOffsetMinutes: prev, dst: null };
  if (changes.length !== 2) return 'unsupported';
  const std = Math.min(changes[0].before, changes[0].after);
  const dstOff = Math.max(changes[0].before, changes[0].after);
  const shift = dstOff - std;
  if (shift <= 0 || shift % 60 !== 0) return 'unsupported';
  const start = changes.find((c) => c.after === dstOff && c.before === std);
  const end = changes.find((c) => c.after === std && c.before === dstOff);
  if (!start || !end) return 'unsupported';
  // The wall time just before each change: the start in standard time, the end in DST.
  const s = rulePart(start.at, std);
  const e = rulePart(end.at, dstOff);
  const dst = { startMon: s.mon, startWeek: s.week, startWeekday: s.weekday, startHour: s.hour, startMin: s.min, endMon: e.mon, endWeek: e.week, endWeekday: e.weekday, endHour: e.hour, endMin: e.min, offsetHours: shift / 60 };
  const [bs, be] = dstBounds(year, dst, std, shift);
  if (bs !== start.at || be !== end.at) return 'unsupported';
  return { stdOffsetMinutes: std, dst };
}

const isUtc = (z: string) => /^(UTC|Etc\/UTC|Etc\/GMT|GMT|Etc\/Universal|Universal|Etc\/Zulu|Zulu)$/i.test(z);

// The proxy's zone: time.zone, else the host's when it is known (TZ set, or
// a zone other than UTC: a container without a zone reports UTC), else null.
export function proxyZone(c: Config, env: NodeJS.ProcessEnv = process.env, hostZone: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone): string | null {
  if (c.time?.zone) return c.time.zone;
  const tz = env.TZ?.replace(/^:/, '');
  if (tz && knownZone(tz)) return tz;
  if (tz) return null;
  const h = hostZone();
  return h && !isUtc(h) && knownZone(h) ? h : null;
}
