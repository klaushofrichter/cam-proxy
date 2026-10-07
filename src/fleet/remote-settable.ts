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
  'analytics.googleVision.monthlyLimit', 'analytics.googleVision.dailyCap', 'analytics.googleVision.checksPerDay', 'analytics.googleVision.perCameraDailyCap',
  'cameras.*.name', 'cameras.*.statusPollS', 'cameras.*.stills.stream', 'cameras.*.stills.intervalS',
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
  'events.poll.enabled': 'local only: turns event polling on or off',
  'cameras.*.events.poll.enabled': 'local only: turns event polling on or off',
  ...Object.fromEntries(['person', 'vehicle', 'pet'].flatMap((k) => [[`analytics.kinds.${k}`, 'local only: turns analysis on or off'], [`cameras.*.analytics.kinds.${k}`, 'local only: turns analysis on or off']])),
  'analytics.googleVision.enabled': 'local only: turns analysis on or off',
  'health.diskPercent': 'local only: a health threshold decides what the proxy reports as a problem',
  'health.tempC': 'local only: a health threshold decides what the proxy reports as a problem',
  'host.stats': 'local only: turns reading the host figures on or off',
  'ftp.stalledHours': 'local only: a health threshold decides what the proxy reports as a problem',
  'archive.warnPercent': 'local only: a health threshold decides what the proxy reports as a problem',
};
export const DENIED: readonly string[] = [...new Set([
  'server', 'go2rtc', 'storage', 'ftp.port', 'ftp.passive', 'ftp.tls', 'ftp.publicHost', 'ftp.certFile', 'ftp.keyFile', 'tls', 'composition.font', 'ntp.server', 'poeSwitch', 'camsAdmin',
  'cameras.*.id', 'cameras.*.host', 'cameras.*.protocol', 'cameras.*.tlsName', 'cameras.*.user', 'cameras.*.onvifPort', 'cameras.*.rtspPort', 'cameras.*.baichuanPort', 'cameras.*.poeSwitch', 'cameras.*.ftp.user', 'cameras.*.webUiUrl',
  ...Object.keys(LOCAL_ONLY),
])];
// R3-2: toward less spending, or toward keeping data longer (retention
// periods, size caps). storage.* is denied outright (local only).
export const NARROW: Readonly<Record<string, 'less' | 'more'>> = {
  'analytics.googleVision.monthlyLimit': 'less', 'analytics.googleVision.dailyCap': 'less',
  'analytics.googleVision.checksPerDay': 'less', 'analytics.googleVision.perCameraDailyCap': 'less',
  'retention.stillsDays': 'more', 'retention.previewsDays': 'more', 'retention.clipsDays': 'more', 'retention.eventsDays': 'more', 'retention.auditDays': 'more', 'retention.streamLogDays': 'more',
  'stills.maxGB': 'more', 'previews.maxGB': 'more', 'ftp.maxGB': 'more',
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

export function narrowingOk(path: string, from: unknown, to: unknown): boolean {
  const dir = NARROW[path];
  if (!dir) return true;
  if (typeof from === 'boolean' || typeof to === 'boolean') return dir === 'less' ? to === false || from === to : to === true || from === to;
  const n = (x: unknown) => (x === undefined && UNSET_IS_UNLIMITED.has(path) ? Infinity : typeof x !== 'number' ? 0 : ZERO_IS_UNLIMITED.has(path) && x === 0 ? Infinity : x);
  return dir === 'less' ? n(to) <= n(from) : n(to) >= n(from);
}

export function settableView(): Record<string, { type: string; min?: number; max?: number; oneOf?: number[]; enum?: string[]; pattern?: string; optional?: boolean; dir?: 'less' | 'more' }> {
  return Object.fromEntries(REMOTE.map((pat) => {
    const leaf = leafAt(pat.replace('cameras.*.', 'cameras.x.'))!;
    const { doc: _doc, unset: _unset, ...bounds } = leaf as Record<string, unknown>;
    return [pat, { ...(bounds as { type: string }), ...(NARROW[pat] ? { dir: NARROW[pat] } : {}) }];
  }));
}
