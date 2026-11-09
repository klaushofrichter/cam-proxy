import { writable } from 'svelte/store';

// What this admin UI session may do (issue #227), from GET /control/session.
// A session from a cams-admin sign-in link (managed-admin) is no local
// admin: it changes settings or restarts only when the proxy's own
// allow-list unlocks it (ui.config, ui.restart); every other local-admin
// control is off. The page disables what the proxy would refuse.
// `localSettings`: with ui.config, the settings it still never sets
// (addresses, ports, files, trust, users, cams-admin itself, storage limits,
// the Google Vision ceiling; cameras.* = every camera). `narrow`: the settings it
// changes one way only (retention and size caps up, spending caps down), with
// the value that means no cap; and those bounded by a ceiling set at the proxy
// (`ceiling`: the Google Vision monthly limit; `ceilingGated`: Google Vision on).
// `interval`: a capture interval (only shorter, cams-admin #20); `inherits`:
// the setting an unset camera value takes effect as. Keys are patterns (cameras.*.).
export interface NarrowRule { dir: 'less' | 'more' | 'ceiling' | 'ceilingGated'; unlimited?: 0 | 'unset'; ceiling?: string; interval?: true; inherits?: string }
export interface Rights { localAdmin: boolean; config: boolean; restart: boolean; move: boolean; localSettings: string[]; narrow: Record<string, NarrowRule> }
export const ALL_RIGHTS: Rights = { localAdmin: true, config: true, restart: true, move: true, localSettings: [], narrow: {} };

const isRule = (x: unknown): x is NarrowRule => {
  const r = x as NarrowRule | null;
  return typeof r === 'object' && r !== null && (r.dir === 'less' || r.dir === 'more' || r.dir === 'ceiling' || r.dir === 'ceilingGated') && (r.unlimited === undefined || r.unlimited === 0 || r.unlimited === 'unset') && (r.ceiling === undefined || typeof r.ceiling === 'string') && (r.interval === undefined || r.interval === true) && (r.inherits === undefined || typeof r.inherits === 'string');
};

// An older proxy answers no rights: everything stays on (it refuses what it
// refuses, and the control shows that).
export function rightsOf(session: unknown): Rights {
  const r = (session as { rights?: Partial<Rights> & { narrowSettings?: unknown } } | null)?.rights;
  if (!r || typeof r !== 'object') return ALL_RIGHTS;
  const local = r.localAdmin === true;
  const settings = Array.isArray(r.localSettings) ? r.localSettings.filter((x): x is string => typeof x === 'string') : [];
  const n = r.narrowSettings;
  const narrow = local || typeof n !== 'object' || n === null ? {} : Object.fromEntries(Object.entries(n).filter(([, v]) => isRule(v)).map(([k, v]) => [k, { dir: v.dir, ...(v.unlimited !== undefined ? { unlimited: v.unlimited } : {}), ...(v.ceiling !== undefined ? { ceiling: v.ceiling } : {}), ...(v.interval ? { interval: true as const } : {}), ...(v.inherits !== undefined ? { inherits: v.inherits } : {}) }]));
  return { localAdmin: local, config: local || r.config === true, restart: local || r.restart === true, move: r.move === true, localSettings: local ? [] : settings, narrow };
}

export const rights = writable<Rights>(ALL_RIGHTS);

// What a control needs: 'config' (the Settings page's writes), 'restart'
// (the proxy and camera-side restarts), 'move' (starting a camera move: the
// move.send allow entry), 'local' (everything else only the
// local admin token may do).
export type Need = 'local' | 'config' | 'restart' | 'move';
export const MOVE_TEXT = "Moving a camera isn't allowed on this proxy: allow move.send on its Cams-Admin page.";
export const LOCKED_TEXT = 'Needs the local admin token: you signed in from cams-admin.';

// Why a control is off for this session, or null when it may be used.
export function lockedWhy(r: Rights, need: Need): string | null {
  if (need === 'move') return r.move ? null : MOVE_TEXT;
  if (r.localAdmin || (need === 'config' && r.config) || (need === 'restart' && r.restart)) return null;
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
  interval: 'From a cams-admin sign-in this interval may only get shorter; a longer one needs the local admin token.',
} as const;
const patternOf = (path: string) => path.replace(/^cameras\.[^.]+(?=\.)/, 'cameras.*');
// The rule of a setting (by its pattern), or undefined.
export const narrowRule = (r: Rights, path: string): NarrowRule | undefined => (r.localAdmin ? undefined : r.narrow[patternOf(path)]);
// The Google Vision ceiling set at the proxy (Vision management, 2026-11-05).
export const CEILING_TEXT = (n: number) => `From a cams-admin sign-in this may go up to ${n.toLocaleString('en-US')} calls a month (the ceiling set at the proxy); more needs the local admin token.`;
export const NO_CEILING_TEXT = "From a cams-admin sign-in Google Vision can't be switched on: the proxy has no ceiling for cams-admin (0).";
// `ceiling`: the current value of the rule's ceiling setting (a ceiling rule;
// unknown: the proxy judges). `inherited`: the value of the rule's `inherits`
// setting, what an unset value takes effect as (unknown: the proxy judges).
export function narrowWhy(r: Rights, path: string, from: unknown, to: unknown, ceiling?: number, inherited?: unknown): string | null {
  const rule = narrowRule(r, path);
  if (!rule || (typeof to === 'number' && Number.isNaN(to))) return null;
  if (rule.inherits) {
    if ((from === undefined || to === undefined) && typeof inherited !== 'number') return null;
    from = from ?? inherited;
    to = to ?? inherited;
  }
  if (rule.dir === 'ceilingGated') return ceiling === undefined || to !== true || from === true || ceiling > 0 ? null : NO_CEILING_TEXT;
  if (rule.dir === 'ceiling') return ceiling === undefined || typeof to !== 'number' || to <= (typeof from === 'number' ? from : 0) || to <= ceiling ? null : CEILING_TEXT(ceiling);
  const n = (x: unknown) => (x === undefined && rule.unlimited === 'unset' ? Infinity : typeof x !== 'number' ? 0 : rule.unlimited === 0 && x === 0 ? Infinity : x);
  const ok = rule.dir === 'less' ? n(to) <= n(from) : n(to) >= n(from);
  return ok ? null : rule.interval ? NARROW_TEXT.interval : NARROW_TEXT[rule.dir];
}

// One setting on the Settings page: off when settings are, or when it is
// one ui.config never sets.
export function settingLockedWhy(r: Rights, path: string): string | null {
  const why = lockedWhy(r, 'config');
  if (why || r.localAdmin) return why;
  const q = patternOf(path);
  return r.localSettings.some((x) => q === x || q.startsWith(`${x}.`)) ? LOCKED_TEXT : null;
}

// The Settings page's one line: all settings off, or with ui.config only
// the ones it never sets.
export const SOME_SETTINGS_TEXT = "Addresses, ports, files, trust, users, storage limits and Google Vision's ceiling for cams-admin need the local admin token, as do shorter retention, higher spending caps, longer capture intervals and Google Vision beyond that ceiling: you signed in from cams-admin.";
export function settingsNote(r: Rights): string | null {
  return lockedWhy(r, 'config') ?? (!r.localAdmin && r.localSettings.length ? SOME_SETTINGS_TEXT : null);
}

// Reset to defaults by a cams-admin sign-in keeps the overrides it may not
// change, and those whose reset would go against the direction rules (the
// proxy keeps them too): which of `overrides` stay. `view`: each setting's
// value and what its reset goes back to.
export function resetKeeps(r: Rights, overrides: string[], view: Record<string, ViewSetting & { resetTo?: { value?: unknown } }> = {}): string[] {
  return r.localAdmin ? [] : overrides.filter((p) => settingLockedWhy(r, p) !== null || (view[p] !== undefined && narrowWhy(r, p, savedValue(view[p]), view[p].resetTo?.value, undefined, inheritedValue(r, p, view)) !== null));
}
// A setting of the Settings page's view. The proxy judges a change against
// the saved value: a setting waiting for a restart is `next`, not `value`.
export type ViewSetting = { value: unknown; pending?: boolean; next?: unknown };
export const savedValue = (s: ViewSetting): unknown => (s.pending ? s.next : s.value);
// What an unset value of `path` takes effect as on the Settings page (the
// saved value of its rule's `inherits` setting in `view`), or undefined.
export function inheritedValue(r: Rights, path: string, view: Record<string, ViewSetting>): unknown {
  const inh = narrowRule(r, path)?.inherits;
  return inh && view[inh] ? savedValue(view[inh]) : undefined;
}
