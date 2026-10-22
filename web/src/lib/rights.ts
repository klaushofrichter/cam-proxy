import { writable } from 'svelte/store';

// What this admin UI session may do (issue #227), from GET /control/session.
// A session from a cams-admin sign-in link (managed-admin) is no local
// admin: it changes settings or restarts only when the proxy's own
// allow-list unlocks it (ui.config, ui.restart); every other local-admin
// control is off. The page disables what the proxy would refuse.
// `localSettings`: with ui.config, the settings it still never sets
// (addresses, ports, files, trust, users, cams-admin itself, storage limits,
// Google Vision on/off; cameras.* = every camera). `narrow`: the settings it
// changes one way only (retention and size caps up, spending caps down), with
// the value that means no cap.
export interface NarrowRule { dir: 'less' | 'more'; unlimited?: 0 | 'unset' }
export interface Rights { localAdmin: boolean; config: boolean; restart: boolean; move: boolean; localSettings: string[]; narrow: Record<string, NarrowRule> }
export const ALL_RIGHTS: Rights = { localAdmin: true, config: true, restart: true, move: true, localSettings: [], narrow: {} };

const isRule = (x: unknown): x is NarrowRule => {
  const r = x as NarrowRule | null;
  return typeof r === 'object' && r !== null && (r.dir === 'less' || r.dir === 'more') && (r.unlimited === undefined || r.unlimited === 0 || r.unlimited === 'unset');
};

// An older proxy answers no rights: everything stays on (it refuses what it
// refuses, and the control shows that).
export function rightsOf(session: unknown): Rights {
  const r = (session as { rights?: Partial<Rights> & { narrowSettings?: unknown } } | null)?.rights;
  if (!r || typeof r !== 'object') return ALL_RIGHTS;
  const local = r.localAdmin === true;
  const settings = Array.isArray(r.localSettings) ? r.localSettings.filter((x): x is string => typeof x === 'string') : [];
  const n = r.narrowSettings;
  const narrow = local || typeof n !== 'object' || n === null ? {} : Object.fromEntries(Object.entries(n).filter(([, v]) => isRule(v)).map(([k, v]) => [k, { dir: v.dir, ...(v.unlimited !== undefined ? { unlimited: v.unlimited } : {}) }]));
  return { localAdmin: local, config: local || r.config === true, restart: local || r.restart === true, move: local || r.move === true, localSettings: local ? [] : settings, narrow };
}

export const rights = writable<Rights>(ALL_RIGHTS);

// What a control needs: 'config' (the Settings page's writes), 'restart'
// (the proxy and camera-side restarts), 'move' (starting a camera move: the
// move.send allow entry), 'local' (everything else only the
// local admin token may do).
export type Need = 'local' | 'config' | 'restart' | 'move';
export const LOCKED_TEXT = 'Needs the local admin token: you signed in from cams-admin.';

// Why a control is off for this session, or null when it may be used.
export function lockedWhy(r: Rights, need: Need): string | null {
  if (r.localAdmin || (need === 'config' && r.config) || (need === 'restart' && r.restart) || (need === 'move' && r.move)) return null;
  return LOCKED_TEXT;
}

// A refusal the proxy still sent (403 local_admin_only), in plain words.
export const REFUSED_TEXT = 'Refused: this needs the local admin token (you signed in from cams-admin). Nothing was changed.';

// A value against ui.config's direction rules (the proxy's NARROW): why it
// is refused, or null. Like the proxy: no cap (0 or unset, per rule) counts
// as infinitely high; a value that is no number yet is the proxy's to judge.
export const NARROW_TEXT = {
  more: 'From a cams-admin sign-in this may only keep data longer; a lower value needs the local admin token.',
  less: 'From a cams-admin sign-in this may only lower spending; a higher value needs the local admin token.',
} as const;
export function narrowWhy(r: Rights, path: string, from: unknown, to: unknown): string | null {
  const rule = r.localAdmin ? undefined : r.narrow[path];
  if (!rule || (typeof to === 'number' && Number.isNaN(to))) return null;
  const n = (x: unknown) => (x === undefined && rule.unlimited === 'unset' ? Infinity : typeof x !== 'number' ? 0 : rule.unlimited === 0 && x === 0 ? Infinity : x);
  const ok = rule.dir === 'less' ? n(to) <= n(from) : n(to) >= n(from);
  return ok ? null : NARROW_TEXT[rule.dir];
}

// One setting on the Settings page: off when settings are, or when it is
// one ui.config never sets.
export function settingLockedWhy(r: Rights, path: string): string | null {
  const why = lockedWhy(r, 'config');
  if (why || r.localAdmin) return why;
  const q = path.replace(/^cameras\.[^.]+(?=\.)/, 'cameras.*');
  return r.localSettings.some((x) => q === x || q.startsWith(`${x}.`)) ? LOCKED_TEXT : null;
}

// The Settings page's one line: all settings off, or with ui.config only
// the ones it never sets.
export const SOME_SETTINGS_TEXT = 'Addresses, ports, files, trust, users, storage limits and Google Vision on/off need the local admin token, as do shorter retention and higher spending caps: you signed in from cams-admin.';
export function settingsNote(r: Rights): string | null {
  return lockedWhy(r, 'config') ?? (!r.localAdmin && r.localSettings.length ? SOME_SETTINGS_TEXT : null);
}

// Reset to defaults by a cams-admin sign-in keeps the overrides it may not
// change, and those whose reset would go against the direction rules (the
// proxy keeps them too): which of `overrides` stay. `view`: each setting's
// value and what its reset goes back to.
export function resetKeeps(r: Rights, overrides: string[], view: Record<string, { value: unknown; resetTo?: { value?: unknown } }> = {}): string[] {
  return r.localAdmin ? [] : overrides.filter((p) => settingLockedWhy(r, p) !== null || (view[p] !== undefined && narrowWhy(r, p, view[p].value, view[p].resetTo?.value) !== null));
}
