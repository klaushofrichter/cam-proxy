import { leafAt, CAMERA_ID } from '../config/schema';

// What cams-admin may set on this proxy (M §8.2, M5; plan R3-1, R3-2).
// Exact leaves: a new setting is denied until someone classifies it here, and
// a remote one must also be in the contract's remote-settable.json (the upper
// bound; a test). Deny wins. Compiled in: no setting, file or command widens it.
export const REMOTE: readonly string[] = [
  'stills.stream', 'stills.intervalS', 'stills.size', 'stills.quality', 'stills.maxGB',
  'previews.tileSize', 'previews.grid', 'previews.quality', 'previews.maxGB',
  'events.onvif.subscribeMin', 'events.onvif.pullTimeoutS', 'events.poll.intervalS', 'events.poll.afterOnvifDownS', 'events.maxOpenMin',
  'retention.stillsDays', 'retention.previewsDays', 'retention.clipsDays', 'retention.eventsDays', 'retention.auditDays', 'retention.streamLogDays', 'retention.intervalMin',
  'composition.concurrent', 'sse.maxClients', 'sse.queuePerClient', 'sse.pingS', 'recordings.cacheMB',
  'ftp.stream', 'ftp.maxGB',
  'analytics.googleVision.enabled', 'analytics.googleVision.monthlyLimit', 'analytics.googleVision.dailyCap', 'analytics.googleVision.checksPerDay', 'analytics.googleVision.perCameraDailyCap',
  'cameras.*.statusPollS', 'cameras.*.stills.stream', 'cameras.*.stills.intervalS',
  'cameras.*.ftp.stream',
];
// Local only (coordinator rulings 2026-10-07: storage; I4, contract LOCAL_ONLY:
// capture and feature on/off switches, health thresholds): a person at the
// proxy decides them.
// Denied like the trust paths; a refusal names the reason.
const LOCAL_ONLY: Readonly<Record<string, string>> = {
  storage: 'local only: a storage budget lowered remotely would make the proxy delete stills and clips',
  'cameras.*.storage': 'local only: a storage share lowered remotely would make the proxy delete stills and clips',
  'stills.enabled': 'local only: turns capture on or off',
  'cameras.*.stills.enabled': 'local only: turns capture on or off',
  'ftp.enabled': 'local only: turns clip intake on or off',
  'cameras.*.ftp.enabled': 'local only: turns clip intake on or off',
  'archive.enabled': 'local only: turns the Archive on or off',
  'time.zone': "local only: the cameras' time zone, where the proxy stands",
  'events.poll.enabled': 'local only: turns event polling on or off',
  'cameras.*.events.poll.enabled': 'local only: turns event polling on or off',
  ...Object.fromEntries(['person', 'vehicle', 'pet'].flatMap((k) => [[`analytics.kinds.${k}`, 'local only: turns analysis on or off'], [`cameras.*.analytics.kinds.${k}`, 'local only: turns analysis on or off']])),
  // Vision management (cams-admin design 2026-11-05): the bound of cams-admin's
  // Google Vision changes (CEILINGS); googleVision.enabled is remote within it.
  'analytics.googleVision.remoteMaxMonthly': 'local only: the most monthly Google Vision calls cams-admin may allow; set at the proxy',
  'health.diskPercent': 'local only: a health threshold decides what the proxy reports as a problem',
  'health.tempC': 'local only: a health threshold decides what the proxy reports as a problem',
  'host.stats': 'local only: turns reading the host figures on or off',
  'ftp.stalledHours': 'local only: a health threshold decides what the proxy reports as a problem',
  'archive.warnPercent': 'local only: a health threshold decides what the proxy reports as a problem',
  // The proxy profile (cams-admin spec 2026-10-25-proxy-profile-design §0).
  profile: 'local only: the proxy profile holds the camera limit and the storage budget; it is set at the proxy',
};
// Addresses, ports, files, trust, users and cams-admin itself: never remote,
// and never through a cams-admin sign-in's ui.config either (issue #227,
// src/api/auth.ts): a changed address would send the camera's or the
// switch's password elsewhere.
export const NEVER_FROM_CAMS_ADMIN: readonly string[] = [
  'server', 'go2rtc', 'ftp.port', 'ftp.passive', 'ftp.tls', 'ftp.publicHost', 'ftp.sourceSubnet', 'ftp.certFile', 'ftp.keyFile', 'tls', 'composition.font', 'ntp.server', 'poeSwitch', 'camsAdmin',
  'cameras.*.id', 'cameras.*.host', 'cameras.*.protocol', 'cameras.*.tlsName', 'cameras.*.user', 'cameras.*.onvifPort', 'cameras.*.rtspPort', 'cameras.*.baichuanPort', 'cameras.*.poeSwitch', 'cameras.*.ftp.user', 'cameras.*.webUiUrl',
  // Camera moves: hiding a camera and the camera limit are local (src/moves;
  // moves is only the old name of profile.cameras now, src/config/legacy.ts).
  'cameras.*.moved', 'moves',
  // The camera holds its name; cameras.*.name is only the initial name (set
  // at the proxy). A rename from cams-admin is camera.name.set (contract 3dffb81).
  'cameras.*.name',
];
export const DENIED: readonly string[] = [...new Set([
  ...NEVER_FROM_CAMS_ADMIN, 'storage',
  ...Object.keys(LOCAL_ONLY),
])];
// R3-2: toward less spending, or toward keeping data longer (retention
// periods, size caps). storage.* is denied outright (local only).
// Vision management (cams-admin design 2026-11-05): `ceiling` (lower always,
// raise up to the local ceiling) and `ceilingGated` (off always, on only while
// the ceiling is above 0), each bounded by its CEILINGS path.
export type NarrowKind = 'less' | 'more' | 'ceiling' | 'ceilingGated';
export const NARROW: Readonly<Record<string, NarrowKind>> = {
  'analytics.googleVision.enabled': 'ceilingGated', 'analytics.googleVision.monthlyLimit': 'ceiling', 'analytics.googleVision.dailyCap': 'less',
  'analytics.googleVision.checksPerDay': 'less', 'analytics.googleVision.perCameraDailyCap': 'less',
  'retention.stillsDays': 'more', 'retention.previewsDays': 'more', 'retention.clipsDays': 'more', 'retention.eventsDays': 'more', 'retention.auditDays': 'more', 'retention.streamLogDays': 'more',
  'stills.maxGB': 'more', 'previews.maxGB': 'more', 'ftp.maxGB': 'more',
};
// The local-only ceiling of each ceiling path (the contract's `ceilings`).
export const CEILINGS: Readonly<Record<string, string>> = {
  'analytics.googleVision.enabled': 'analytics.googleVision.remoteMaxMonthly',
  'analytics.googleVision.monthlyLimit': 'analytics.googleVision.remoteMaxMonthly',
};
// Caps where 0 means "no cap" (schema docs): 0 counts as infinitely high.
const ZERO_IS_UNLIMITED = new Set(['analytics.googleVision.dailyCap', 'analytics.googleVision.perCameraDailyCap']);
// Size caps where unset means "no cap": unset counts as infinitely high.
const UNSET_IS_UNLIMITED = new Set(['stills.maxGB', 'previews.maxGB', 'ftp.maxGB']);
// The contract's CAMERA_NAME_PATTERN (security review M3): a camera name from
// cams-admin (camera.name.set, config.set of cameras.*.name).
// 1-64 code points, none a control (Cc), format (Cf: bidi marks incl. U+061C,
// zero-width, soft hyphen, U+180E, tag characters), surrogate (Cs: a lone
// one), private-use (Co), line/paragraph separator or unassigned (Cn)
// character (security review M3; the contract follows).
export const CAMERA_NAME_PATTERN = /^(?:(?![\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}])\P{Cn}){1,64}$/u;
// The contract's SECRET_KEY_PATTERN: never a remote path; dropped from answers.
export const SECRET_KEY_PATTERN = /pem|key|password|passwd|secret|token|cookie/i;
export const NARROW_REASON = { less: 'a remote change may only lower spending', more: 'a remote change may only keep data longer' } as const;
const CAMERA_ID_RE = new RegExp(CAMERA_ID);
const under = (p: string, x: string) => p === x || p.startsWith(`${x}.`);

// Why a denied path is local only (a refusal's detail), or undefined.
export function denyReason(path: string): string | undefined {
  const pat = patternOf(path);
  const hit = Object.keys(LOCAL_ONLY).filter((k) => under(pat, k)).sort((a, b) => b.length - a.length)[0];
  return hit ? LOCAL_ONLY[hit] : undefined;
}

export type PathClass = 'remote' | 'denied' | 'unknown_camera' | 'not_a_setting';

export function patternOf(path: string): string {
  const m = /^cameras\.([^.]+)\.(.+)$/.exec(path);
  return m ? `cameras.*.${m[2]}` : path;
}

export function classify(path: string, cameraIds: readonly string[]): PathClass {
  const m = /^cameras\.([^.]+)(\..+)?$/.exec(path);
  if (m && !m[2]) return 'not_a_setting';
  if (m && (!CAMERA_ID_RE.test(m[1]) || !cameraIds.includes(m[1]))) return 'unknown_camera';
  if (!leafAt(path)) return 'not_a_setting';
  const pat = patternOf(path);
  if (DENIED.some((d) => under(pat, d))) return 'denied';
  return REMOTE.includes(pat) ? 'remote' : 'denied';
}

// `ceiling`: the current value of the path's CEILINGS path (a ceiling kind only; 0 when not given).
export function narrowingOk(path: string, from: unknown, to: unknown, ceiling = 0): boolean {
  const dir = NARROW[path];
  if (!dir) return true;
  if (dir === 'ceilingGated') return to !== true || from === true || ceiling > 0;
  if (dir === 'ceiling') return typeof to === 'number' && (to <= (typeof from === 'number' ? from : 0) || to <= ceiling);
  if (typeof from === 'boolean' || typeof to === 'boolean') return dir === 'less' ? to === false || from === to : to === true || from === to;
  const n = (x: unknown) => (x === undefined && UNSET_IS_UNLIMITED.has(path) ? Infinity : typeof x !== 'number' ? 0 : ZERO_IS_UNLIMITED.has(path) && x === 0 ? Infinity : x);
  return dir === 'less' ? n(to) <= n(from) : n(to) >= n(from);
}

// A ceiling path's ceiling in a config (0 when unset or not a number).
export const ceilingOf = (config: object, path: string): number => {
  const c = CEILINGS[path];
  const v = c ? c.split('.').reduce<unknown>((o, k) => (typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[k] : undefined), config) : undefined;
  return typeof v === 'number' ? v : 0;
};
// Why a ceiling path's change is refused (the contract's `detail`, naming the ceiling).
export function ceilingDetail(path: string, ceiling: number): string {
  return NARROW[path] === 'ceilingGated' && ceiling <= 0
    ? `cams-admin may not switch it on: no ceiling at the proxy (${CEILINGS[path]} is 0)`
    : `cams-admin may allow up to ${ceiling} calls a month (${CEILINGS[path]})`;
}
export type DirectionFailure = { path: string; code: 'widening_local_only' | 'above_local_ceiling'; detail: string };
// The direction checks of a change list, in the contract's order: every
// less/more path against its direction (widening_local_only), then the
// ceiling paths against the ceiling in `config` (above_local_ceiling).
// `reasons`: the widening detail per direction. Null: nothing refused.
export function directionFailures(changes: readonly { path: string; from?: unknown; to?: unknown }[], config: object, reasons: Record<'less' | 'more', string> = NARROW_REASON): { code: DirectionFailure['code']; paths: DirectionFailure[] } | null {
  const isCeiling = (p: string) => NARROW[p] === 'ceiling' || NARROW[p] === 'ceilingGated';
  const widening = changes.filter((c) => !isCeiling(c.path) && !narrowingOk(c.path, c.from, c.to));
  if (widening.length) return { code: 'widening_local_only', paths: widening.map((c) => ({ path: c.path, code: 'widening_local_only', detail: reasons[NARROW[c.path] as 'less' | 'more'] })) };
  const above = changes.filter((c) => isCeiling(c.path) && !narrowingOk(c.path, c.from, c.to, ceilingOf(config, c.path)));
  if (above.length) return { code: 'above_local_ceiling', paths: above.map((c) => ({ path: c.path, code: 'above_local_ceiling', detail: ceilingDetail(c.path, ceilingOf(config, c.path)) })) };
  return null;
}

// NARROW for a page that checks a value before it sends it (issue #227:
// GET /control/session's narrowSettings): the direction, and which value
// counts as no cap at all (0, or unset); a ceiling kind names its ceiling path.
export function narrowRules(): Record<string, { dir: NarrowKind; unlimited?: 0 | 'unset'; ceiling?: string }> {
  return Object.fromEntries(Object.entries(NARROW).map(([p, dir]) => [p, { dir, ...(ZERO_IS_UNLIMITED.has(p) ? { unlimited: 0 as const } : UNSET_IS_UNLIMITED.has(p) ? { unlimited: 'unset' as const } : {}), ...(CEILINGS[p] ? { ceiling: CEILINGS[p] } : {}) }]));
}

export function settableView(): Record<string, { type: string; min?: number; max?: number; oneOf?: number[]; enum?: string[]; pattern?: string; optional?: boolean; dir?: NarrowKind }> {
  return Object.fromEntries(REMOTE.map((pat) => {
    const leaf = leafAt(pat.replace('cameras.*.', 'cameras.x.'))!;
    const { doc: _doc, unset: _unset, ...bounds } = leaf as Record<string, unknown>;
    return [pat, { ...(bounds as { type: string }), ...(NARROW[pat] ? { dir: NARROW[pat] } : {}) }];
  }));
}
