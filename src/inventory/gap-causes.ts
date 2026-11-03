import type { AuditLog, AuditRecord } from '../audit/audit-log';
import type { Catalog } from '../catalog/db';
import { REBOOT_WAIT_MS } from '../camera/reboot';
import { DAY } from '../time-units';
import { records } from './audit-records';

// What can explain a stretch without stills (#72, #106, cams' blank
// thumbnails 2026-11-03): one set of sources for the stills inventory's gaps
// and the client API's outages list. Each comes from what the proxy already
// keeps: the audit log (proxy starts and stops, camera reboots and
// power-cycles, storage pauses, address changes) and the stream log (the
// camera going offline and online again, `camera-status`). Nothing is guessed:
// a stretch none of these overlaps stays unexplained.

export type GapCause = 'stop' | 'crash' | 'reboot' | 'powercycle' | 'paused' | 'offline' | 'address';
// The audit actions the causes read.
export const CAUSE_ACTIONS = ['proxy-start', 'camera-reboot', 'camera-powercycle', 'storage-paused', 'storage-resumed', 'camera-host-change'];
// A camera reboot or power-cycle without an end record: the proxy's own watch
// gives up after this long (REBOOT_WAIT_MS) and writes `not-back`.
export const OUTAGE_MS = REBOOT_WAIT_MS;

// A cause's span: `b` null while it lasts (an open storage pause, a camera still offline).
export interface CauseSpan { a: number; b: number | null; cause: GapCause }

// Records of another camera explain nothing here (spec 2026-10-05-multi-camera-host-design §5.2).
export const recordOf = (cam: string) => (r: AuditRecord): boolean => {
  const c = (r.labels as { camera?: string } | undefined)?.camera;
  return c === undefined || c === cam;
};

// The proxy starts: `stop` the previous clean stop, null after a crash (unknown).
export interface ProxyStart { t: number; crash: boolean; stop: number | null }
export function proxyStarts(recs: AuditRecord[]): ProxyStart[] {
  return recs
    .filter((r) => r.event.action === 'proxy-start')
    .map((r) => {
      const det = (r.cam_proxy ?? {}) as { uncleanStop?: unknown; previousStop?: unknown };
      const stop = typeof det.previousStop === 'string' ? Date.parse(det.previousStop) : NaN;
      return { t: Date.parse(r['@timestamp']), crash: det.uncleanStop === true, stop: Number.isFinite(stop) ? stop : null };
    });
}

// The camera's reboots and power-cycles from the proxy: a start record that
// reached the camera (a reboot: not a failure; a power-cycle: a success, or a
// failure that may have cut the PoE; from the cut) up to its end record (back,
// not-back, or the proxy stopping); without one, OUTAGE_MS.
export function cameraOutages(recs: AuditRecord[]): { a: number; b: number; cause: GapCause }[] {
  const out: { a: number; b: number; cause: GapCause }[] = [];
  const open = new Map<string, { a: number; cause: GapCause }>();
  const close = (action: string, at: number) => {
    const o = open.get(action);
    if (!o) return;
    open.delete(action);
    out.push({ a: o.a, b: Math.min(at, o.a + OUTAGE_MS), cause: o.cause });
  };
  for (const r of recs) {
    const action = r.event.action;
    if (action !== 'camera-reboot' && action !== 'camera-powercycle') continue;
    const t = Date.parse(r['@timestamp']);
    const det = (r.cam_proxy ?? {}) as { phase?: unknown; offAt?: unknown; poeOff?: unknown };
    if (det.phase === 'requested') {
      const cycle = action === 'camera-powercycle';
      const reached = cycle ? r.event.outcome === 'success' || det.poeOff === true : r.event.outcome !== 'failure';
      if (!reached) continue;
      close(action, t);
      open.set(action, { a: typeof det.offAt === 'number' ? det.offAt : t, cause: cycle ? 'powercycle' : 'reboot' });
    } else if (det.phase === 'back' || det.phase === 'not-back' || det.phase === 'stop') close(action, t);
  }
  for (const [action, o] of open) close(action, o.a + OUTAGE_MS);
  return out;
}

// The storage pauses (disk full): from a `storage-paused` record to the next
// `storage-resumed` or `proxy-start` (a new process starts unpaused and
// writes a new record if the disk is still full); an open one: b null.
export function storagePauses(recs: AuditRecord[]): CauseSpan[] {
  const out: CauseSpan[] = [];
  let open: number | null = null;
  for (const r of recs) {
    const action = r.event.action;
    const t = Date.parse(r['@timestamp']);
    if (action === 'storage-paused') open ??= t;
    else if ((action === 'storage-resumed' || action === 'proxy-start') && open !== null) {
      out.push({ a: open, b: t, cause: 'paused' });
      open = null;
    }
  }
  if (open !== null) out.push({ a: open, b: null, cause: 'paused' });
  return out;
}

// The camera's address changed (camera-host-change, changed): the camera's
// side restarts there; a moment, not a span.
export function addressChanges(recs: AuditRecord[]): CauseSpan[] {
  return recs
    .filter((r) => r.event.action === 'camera-host-change' && r.event.outcome === 'success' && (r.cam_proxy as { outcome?: unknown } | undefined)?.outcome === 'changed')
    .map((r) => {
      const t = Date.parse(r['@timestamp']);
      return { a: t, b: t, cause: 'address' as const };
    });
}

// The camera offline, as the proxy's status checks saw it (two failed checks
// in a row; the stream log's camera-status rows without `stream`, which are
// the stream's own up and down): from the row that said offline to the next
// that said online. The state before `from` comes from the last row before it.
export function offlineSpans(catalog: Catalog, cam: string, from: number, to: number): CauseSpan[] {
  type Row = { ts: number; online: number | null };
  const base = "SELECT ts, json_extract(data, '$.online') AS online FROM stream_log WHERE cam = ? AND type = 'camera-status' AND json_extract(data, '$.stream') IS NULL";
  const before = catalog.db.prepare(`${base} AND ts < ? ORDER BY id DESC LIMIT 1`).get(cam, from) as Row | undefined;
  const rows = catalog.db.prepare(`${base} AND ts >= ? AND ts <= ? ORDER BY id`).all(cam, from, to) as unknown as Row[];
  const out: CauseSpan[] = [];
  let open: number | null = before && before.online === 0 ? before.ts : null;
  for (const r of rows) {
    if (r.online === 0) open ??= r.ts;
    else if (r.online === 1 && open !== null) {
      out.push({ a: open, b: r.ts, cause: 'offline' });
      open = null;
    }
  }
  if (open !== null) {
    // Still offline at `to`: the next row after it ends the span, if there is one.
    const next = catalog.db.prepare(`${base} AND ts > ? AND json_extract(data, '$.online') = 1 ORDER BY id LIMIT 1`).get(cam, to) as Row | undefined;
    out.push({ a: open, b: next ? next.ts : null, cause: 'offline' });
  }
  return out;
}

// The client API's outages for a camera (GET /api/cameras/:cam/outages): what
// happened in [from, to], each as {cause, from, to} (unix ms; `to` null while
// it lasts; from = to for a moment: an address change, a crashed proxy's start).
// A proxy start explains from its previous clean stop; after a crash only the
// start is known. Read: the audit a day either side (a stop long before, a
// start long after `to`), the stream log for the window.
export interface Outage { cause: GapCause; from: number; to: number | null }
export async function outagesFor(d: { audit: Pick<AuditLog, 'list'>; catalog: Catalog; cam: string; now: number }, from: number, to: number): Promise<Outage[]> {
  const recs = (await records(d.audit, CAUSE_ACTIONS, from - DAY, Math.min(d.now, to + DAY))).filter(recordOf(d.cam));
  const spans: CauseSpan[] = [
    ...proxyStarts(recs).map((s) => ({ a: s.crash || s.stop === null ? s.t : s.stop, b: s.t, cause: (s.crash ? 'crash' : 'stop') as GapCause })),
    ...cameraOutages(recs),
    ...storagePauses(recs),
    ...addressChanges(recs),
    ...offlineSpans(d.catalog, d.cam, from, to),
  ];
  return spans
    .filter((s) => s.a <= to && (s.b === null || s.b >= from))
    .sort((x, y) => x.a - y.a || (x.b ?? Infinity) - (y.b ?? Infinity))
    .map((s) => ({ cause: s.cause, from: s.a, to: s.b }));
}
