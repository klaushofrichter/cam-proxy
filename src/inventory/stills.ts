import { join } from 'path';
import { setImmediate as yieldToLoop } from 'timers/promises';
import type { AuditLog } from '../audit/audit-log';
import type { Catalog } from '../catalog/db';
import { addressChanges, cameraOutages, CAUSE_ACTIONS, offlineSpans, OUTAGE_MS, proxyStarts, recordOf, storagePauses, type GapCause } from './gap-causes';
import { records } from './audit-records';
import { minuteOf, readPackFooter } from '../stills/store';
import { MAX_ITEMS, MAX_TOP, type Check, type CheckResult } from './runner';
import { DAY, dayStart, HOUR, MINUTE, utcDayParts, utcHhmm } from '../time-units';
import { listDir } from '../fs-util';

// The stills inventory (#72, spec 2026-10-02-inventory-design §3): what the
// store should hold for the retention window, and what it holds. Local only.
// The folders are read day by day with async reads, so the server stays
// responsive; the signal is checked between days.
// A gap is explained by what overlaps it: a proxy start inside it (a clean
// one from its previous stop, a crash from the gap's start, to STARTUP_MS
// after the start: a stall that a restart fixed stays unexplained), and a camera reboot or
// power-cycle (from the request, or the PoE cut, to the camera's answer plus
// STARTUP_MS; without an end record, OUTAGE_MS after the start), and a
// storage pause (disk full: `storage-paused` to `storage-resumed`, or to the
// next proxy start, whose process checks the disk again; #106), the camera
// offline (the status checks' offline to online, plus STARTUP_MS) and a
// camera address change (to STARTUP_MS after it). The sources: gap-causes.ts,
// shared with the client API's outages list.

// The signal is checked every this many minutes; up to FOOTER_READS footers are read at a time.
const CHUNK_MINUTES = 120;
const FOOTER_READS = 6;
// The audit actions the check reads, in one pass.
const AUDIT_ACTIONS = ['storage-daily', ...CAUSE_ACTIONS];
// Stills resume within this time after a proxy start (go2rtc, then the grabber).
export const STARTUP_MS = 120_000;
export { OUTAGE_MS, records, type GapCause };
const OFF_NOTE = 'Stills are off: the window ends after the newest pack';
const CLOCK_NOTE = "Seconds covered by local clips compare the clips' times (the camera's clock) with the stills' (the proxy's clock), not aligned: a few seconds' skew";

// 59 s, 1 min, 10 min 5 s, 1 h 30 min (the same words as the admin UI's list).
export function duration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  const m = Math.floor((s % 3600) / 60);
  return `${Math.floor(s / 3600)} h${m ? ` ${m} min` : ''}`;
}

// enabled: stills.enabled (false: the window ends after the newest pack, #106).
export interface StillsSettings { cam: string; intervalS: number; stillsDays: number; previewsDays: number; keepHours: number; enabled?: boolean }
export interface StillsInventoryDeps {
  dataDir: string;
  settings: (cam: string) => StillsSettings; // read when a run starts, for the run's camera
  audit: Pick<AuditLog, 'list'>;
  catalog: Catalog;
}
export interface Gap { from: number; to: number; seconds: number; explained: GapCause | null; explainedSeconds: number }
interface FileProblem { type: 'unreadable-pack' | 'pack-without-sprite' | 'sprite-without-pack'; minute: number }
type WindowReason = 'retention' | 'budget' | 'store-younger' | 'empty';

const names = async (dir: string) => new Set(await listDir(dir));

// fn over items, at most `limit` at a time; the results in the items' order.
async function mapPool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// The minute an HHMM file name stands for in a day, or null.
const minuteOfName = (dayStartTs: number, n: string, ext: RegExp): number | null => {
  const m = /^(\d{2})(\d{2})\.(\w+)$/.exec(n);
  return m && ext.test(m[3]) ? dayStartTs + Number(m[1]) * HOUR + Number(m[2]) * MINUTE : null;
};

// The clips overlapping [from, to), merged, by start (clip times: the camera's clock).
function clipSpans(c: Catalog, cam: string, from: number, to: number): { s: number; e: number }[] {
  const rows = c.db
    .prepare('SELECT start_ts AS s, end_ts AS e FROM clips WHERE cam = ? AND end_ts IS NOT NULL AND start_ts < ? AND end_ts > ? ORDER BY start_ts')
    .all(cam, to, from) as unknown as { s: number; e: number }[];
  const out: { s: number; e: number }[] = [];
  for (const r of rows) {
    const last = out.at(-1);
    if (last && r.s <= last.e) last.e = Math.max(last.e, r.e);
    else out.push({ s: r.s, e: r.e });
  }
  return out;
}

// Runs of missing slots, across minute and day borders.
class Gaps {
  private open: { from: number; to: number } | null = null;
  constructor(private readonly onClose: (from: number, to: number) => void) {}
  missing(ts: number, ms: number): void {
    if (this.open && this.open.to === ts) this.open.to = ts + ms;
    else {
      this.close();
      this.open = { from: ts, to: ts + ms };
    }
  }
  close(): void {
    const g = this.open;
    this.open = null;
    if (g) this.onClose(g.from, g.to);
  }
}

export function stillsCheck(d: StillsInventoryDeps): Check {
  return async (ctx): Promise<CheckResult> => {
    const s = d.settings(ctx.cam);
    const now = ctx.now;
    const retentionFrom = dayStart(now - s.stillsDays * DAY);
    // Exclusive: the current minute is in memory, and the one before is written only when the next frame comes.
    let to = minuteOf(now) - MINUTE;
    const protectedFrom = now - s.keepHours * HOUR;
    const stillsDir = join(d.dataDir, 'stills', s.cam);
    const previewsDir = join(d.dataDir, 'previews', s.cam);
    const counts = {
      stillsDays: s.stillsDays, minutes: 0, packs: 0, expectedSeconds: 0, presentSeconds: 0, missingSeconds: 0, missingPct: 0,
      gaps: 0, explainedSeconds: 0, unexplainedSeconds: 0, restorableSeconds: 0,
      unreadablePacks: 0, packsWithoutSprite: 0, spritesWithoutPack: 0, previewsPruned: 0, prunedDuringRun: 0,
    };

    // The day folders of the retention window: one readdir each, kept for the walk.
    const days: { start: number; packs: Set<string>; previews: Set<string> }[] = [];
    for (let t = retentionFrom; t < to; t += DAY) {
      const p = utcDayParts(t);
      days.push({ start: t, packs: await names(join(stillsDir, ...p)), previews: await names(join(previewsDir, ...p)) });
    }

    // The oldest pack before `to` decides where the window starts.
    const oldestIn = (pick: (day: (typeof days)[number]) => Set<string>, ext: RegExp): number | null => {
      for (const day of days) {
        const ms = [...pick(day)].map((n) => minuteOfName(day.start, n, ext)).filter((m): m is number => m !== null);
        if (ms.length) {
          const m = Math.min(...ms);
          return m < to ? m : null;
        }
      }
      return null;
    };
    // Stills turned off (#106): nothing is written after the newest pack, so
    // the window ends there instead of counting the rest as one long gap.
    const off = s.enabled === false;
    if (off) {
      let newest: number | null = null;
      for (const day of days) for (const n of day.packs) {
        const m = minuteOfName(day.start, n, /^pack$/);
        if (m !== null && m < to && (newest === null || m > newest)) newest = m;
      }
      if (newest !== null) to = newest + MINUTE;
    }
    const oldest = oldestIn((x) => x.packs, /^pack$/);
    // Previews may be pruned before stills (their own retention, cap or keepHours):
    // a pack without a sprite before the later of their retention cutoff and the
    // oldest preview is counted as pruned, not flagged.
    const oldestPreview = oldestIn((x) => x.previews, /^(json|jpg)$/);
    const previewsFrom = Math.max(dayStart(now - s.previewsDays * DAY), oldestPreview ?? to);
    if (oldest === null) return { window: { from: null, to, reason: 'empty', retentionFrom, protectedFrom, notes: [] }, counts, top: [], items: [], message: 'no stills stored' };
    // One pass over the audit log for every action the check needs.
    // Records of another camera don't explain this camera's gaps (spec 2026-10-05-multi-camera-host-design §5.2).
    const audit = (await records(d.audit, AUDIT_ACTIONS, retentionFrom - OUTAGE_MS, now)).filter(recordOf(ctx.cam));
    let from: number;
    let reason: WindowReason;
    if (oldest - retentionFrom < HOUR) {
      from = retentionFrom;
      reason = 'retention';
    } else {
      from = oldest;
      const o = oldest;
      const olderSeen = audit.filter((r) => r.event.action === 'storage-daily' && Date.parse(r['@timestamp']) >= retentionFrom).some((r) => {
        const v = (r.cam_proxy as { kinds?: { stills?: { oldest?: unknown } } } | undefined)?.kinds?.stills?.oldest;
        return typeof v === 'number' && v < o - HOUR;
      });
      reason = olderSeen ? 'budget' : 'store-younger';
    }

    // Proxy starts in the window: the last one inside a gap explains it, a
    // clean one from its previous stop on (ruling: a stall before the stop is
    // not the restart's), a crash (no stop time) from the gap's start.
    const starts = proxyStarts(audit).filter((x) => x.t >= from && x.t <= to);
    // The camera's own outages count until STARTUP_MS after they end (stills resume then).
    const outages = [
      ...cameraOutages(audit).map((o) => ({ ...o, b: o.b + STARTUP_MS })),
      ...storagePauses(audit).map((o) => ({ ...o, b: o.b ?? now })),
      ...addressChanges(audit).map((o) => ({ ...o, b: o.a + STARTUP_MS })),
      ...offlineSpans(d.catalog, ctx.cam, from, to).map((o) => ({ ...o, b: (o.b ?? now) + STARTUP_MS })),
    ];
    const top: Gap[] = [];
    const gaps = new Gaps((gFrom, gTo) => {
      // Each cause's share of [gFrom, gTo); the union counts once, the largest share names the gap (a proxy start on a tie).
      const parts: { a: number; b: number; cause: GapCause }[] = [];
      const st = starts.filter((x) => x.t >= gFrom && x.t < gTo).at(-1);
      if (st) {
        const a = st.crash || st.stop === null ? gFrom : Math.max(gFrom, st.stop);
        const b = Math.min(gTo, st.t + STARTUP_MS);
        if (b > a) parts.push({ a, b, cause: st.crash ? 'crash' : 'stop' });
      }
      for (const o of outages) if (o.a < gTo && o.b > gFrom) parts.push({ a: Math.max(gFrom, o.a), b: Math.min(gTo, o.b), cause: o.cause });
      let explained: GapCause | null = null;
      let best = 0;
      for (const p of parts) if (p.b - p.a > best) [best, explained] = [p.b - p.a, p.cause];
      let covered = 0;
      let end = gFrom;
      for (const p of [...parts].sort((x, y) => x.a - y.a)) {
        if (p.b <= end) continue;
        covered += p.b - Math.max(p.a, end);
        end = p.b;
      }
      const explainedSeconds = Math.round(covered / 1000);
      counts.gaps++;
      counts.explainedSeconds += explainedSeconds;
      top.push({ from: gFrom, to: gTo, seconds: (gTo - gFrom) / 1000, explained, explainedSeconds });
      top.sort((a, b) => b.seconds - a.seconds || a.from - b.from);
      if (top.length > MAX_TOP) top.pop();
    });
    const items: FileProblem[] = [];
    const problem = (type: FileProblem['type'], minute: number) => {
      if (type === 'unreadable-pack') counts.unreadablePacks++;
      else if (type === 'pack-without-sprite') counts.packsWithoutSprite++;
      else counts.spritesWithoutPack++;
      if (items.length <= MAX_ITEMS) items.push({ type, minute }); // one more than kept: the runner flags the cut
    };

    const walk = days.filter((x) => x.start + DAY > from);
    ctx.progress({ phase: 'stills', done: 0, total: walk.length });
    let cancelled = false;
    for (const [i, day] of walk.entries()) {
      const parts = utcDayParts(day.start);
      const spans = clipSpans(d.catalog, s.cam, day.start, day.start + DAY);
      let k = 0;
      const minutes: number[] = [];
      for (let m = Math.max(from, day.start); m < Math.min(to, day.start + DAY); m += MINUTE) minutes.push(m);
      for (let c = 0; c < minutes.length; c += CHUNK_MINUTES) {
        if (ctx.signal.aborted) {
          cancelled = true;
          break;
        }
        const chunk = minutes.slice(c, c + CHUNK_MINUTES);
        // undefined: no pack; 'pruned': listed, but deleted (retention) before its footer was read.
        const footers = await mapPool(chunk, FOOTER_READS, async (m) => {
          const name = `${utcHhmm(m)}.pack`;
          if (!day.packs.has(name)) return undefined;
          const f = await readPackFooter(join(stillsDir, ...parts, name));
          return f === undefined ? ('pruned' as const) : f;
        });
        for (const [x, m] of chunk.entries()) {
          counts.minutes++;
          const name = utcHhmm(m);
          const json = day.previews.has(`${name}.json`);
          const jpg = day.previews.has(`${name}.jpg`);
          let slots: [number, number][] | null = null;
          let step = s.intervalS; // a minute without a readable pack: the current interval
          const f = footers[x];
          if (f === 'pruned') counts.prunedDuringRun++; // its seconds count as missing; not a file problem
          else if (f !== undefined) {
            counts.packs++;
            if (f) [slots, step] = [f.slots, f.intervalS];
            else problem('unreadable-pack', m);
            if (!json || !jpg) {
              if (m >= previewsFrom) problem('pack-without-sprite', m);
              else counts.previewsPruned++;
            }
          } else if (json || jpg) problem('sprite-without-pack', m);
          for (let j = 0; j < Math.round(60 / step); j++) {
            const ts = m + j * step * 1000;
            counts.expectedSeconds += step;
            if (slots?.[j]?.[1]) {
              gaps.close();
              continue;
            }
            counts.missingSeconds += step;
            gaps.missing(ts, step * 1000);
            while (k < spans.length && spans[k].e <= ts) k++;
            if (k < spans.length && spans[k].s <= ts) counts.restorableSeconds += step;
          }
        }
      }
      if (cancelled) break;
      ctx.progress({ phase: 'stills', done: i + 1, total: walk.length, note: parts.join('-') });
      await yieldToLoop();
    }
    gaps.close();

    counts.presentSeconds = counts.expectedSeconds - counts.missingSeconds;
    counts.unexplainedSeconds = counts.missingSeconds - counts.explainedSeconds;
    counts.missingPct = counts.expectedSeconds ? Math.round((counts.missingSeconds / counts.expectedSeconds) * 10_000) / 100 : 0;
    const problems = counts.unreadablePacks + counts.packsWithoutSprite + counts.spritesWithoutPack;
    const message =
      `${duration(counts.missingSeconds)} of ${duration(counts.expectedSeconds)} missing (${counts.missingPct}%) since ${new Date(from).toISOString().slice(0, 16).replace('T', ' ')} UTC, ` +
      `${counts.gaps} gaps${top[0] ? ` (longest ${duration(top[0].seconds)})` : ''}, ${duration(counts.explainedSeconds)} explained by proxy stops, camera reboots, the camera offline or storage pauses, ` +
      `${duration(counts.restorableSeconds)} covered by local clips (camera clock, not restored), ${problems} file problems`;
    return { window: { from, to, reason, retentionFrom, protectedFrom, notes: [...(off ? [OFF_NOTE] : []), ...(counts.restorableSeconds > 0 ? [CLOCK_NOTE] : [])] }, counts, top, items, message };
  };
}
