// The camera's time zone and DST rule (spec 2026-10-30-camera-onboarding-design
// §4.7): GetTime, then one whole-object SetTime with the zone, the DST rule
// and the clock (the proxy's now, as wall time in that zone: the camera reads
// the clock in the zone it is given), then GetTime again to compare. Measured
// on the E1 (cam-sim v2026.10.30.3): timeZone in seconds WEST of UTC,
// -46800..43200; an out-of-range value answers rspCode -4.
import { CameraError, type ReolinkClient } from './client';
import type { ZoneRule } from '../onboarding/zone';

export type TimeOutcome = 'set' | 'already' | 'unsupported' | 'failed';
type TimeObject = Record<string, unknown>;
interface GetTime { Time?: TimeObject; Dst?: TimeObject }

const RULE_KEYS = ['startMon', 'startWeek', 'startWeekday', 'startHour', 'startMin', 'endMon', 'endWeek', 'endWeekday', 'endHour', 'endMin'] as const;

// Whether the camera's answer holds the zone and rule.
function holds(v: GetTime, rule: ZoneRule): boolean {
  if (Number(v.Time?.timeZone) !== -rule.stdOffsetMinutes * 60) return false;
  const d = v.Dst ?? {};
  if (rule.dst === null) return Number(d.enable ?? 0) === 0;
  if (Number(d.enable) !== 1 || Number(d.offset) !== rule.dst.offsetHours) return false;
  return RULE_KEYS.every((k) => Number(d[k]) === rule.dst![k]);
}

// The wall time of `now` in `zone`, and whether DST is in effect there.
function wallIn(zone: string, now: number, rule: ZoneRule): Record<string, number> {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' })
      .formatToParts(new Date(now))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  );
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offsetMin = Math.round((wall - Math.floor(now / 1000) * 1000) / 60_000);
  return { year: parts.year, mon: parts.month, day: parts.day, hour: parts.hour, min: parts.minute, sec: parts.second, isDst: offsetMin !== rule.stdOffsetMinutes ? 1 : 0 };
}

const summary = (v: GetTime | undefined) => (v ? { timeZone: v.Time?.timeZone ?? null, dst: v.Dst ? Object.fromEntries(['enable', 'offset', ...RULE_KEYS].map((k) => [k, v.Dst![k] ?? null])) : null } : undefined);

export async function setCameraZone(client: Pick<ReolinkClient, 'command' | 'logout'>, rule: ZoneRule, zone: string, now: () => number = Date.now): Promise<{ outcome: TimeOutcome; before?: unknown; after?: unknown; detail?: string }> {
  let before: GetTime | undefined;
  try {
    before = await client.command<GetTime>('GetTime');
    if (holds(before, rule)) return { outcome: 'already', before: summary(before), after: summary(before) };
    const Time = { ...(before.Time ?? {}), ...wallIn(zone, now(), rule), timeZone: -rule.stdOffsetMinutes * 60 };
    const Dst = rule.dst === null
      ? { ...(before.Dst ?? {}), enable: 0 }
      : { ...(before.Dst ?? {}), enable: 1, offset: rule.dst.offsetHours, ...Object.fromEntries(RULE_KEYS.map((k) => [k, rule.dst![k]])), startSec: 0, endSec: 0 };
    await client.command('SetTime', { Time, Dst });
    const after = await client.command<GetTime>('GetTime');
    return holds(after, rule) ? { outcome: 'set', before: summary(before), after: summary(after) } : { outcome: 'failed', before: summary(before), after: summary(after), detail: 'the camera did not keep the zone or the DST rule' };
  } catch (err) {
    const rsp = err instanceof CameraError ? err.rspCode : undefined;
    if (rsp === -9) return { outcome: 'unsupported', before: summary(before), detail: 'the camera does not take SetTime (rspCode -9)' };
    if (err instanceof CameraError && err.code !== 'camera_error') throw err;
    return { outcome: 'failed', before: summary(before), detail: (err as Error).message };
  } finally {
    await client.logout();
  }
}
