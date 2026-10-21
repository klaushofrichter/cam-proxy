import { writable } from 'svelte/store';

// What this admin UI session may do (issue #227), from GET /control/session.
// A session from a cams-admin sign-in link (managed-admin) is no local
// admin: it changes settings or restarts only when the proxy's own
// allow-list unlocks it (ui.config, ui.restart); every other local-admin
// control is off. The page disables what the proxy would refuse.
// `localSettings`: with ui.config, the settings it still never sets
// (addresses, ports, files, trust, users, cams-admin itself; cameras.* = every camera).
export interface Rights { localAdmin: boolean; config: boolean; restart: boolean; localSettings: string[] }
export const ALL_RIGHTS: Rights = { localAdmin: true, config: true, restart: true, localSettings: [] };

// An older proxy answers no rights: everything stays on (it refuses what it
// refuses, and the control shows that).
export function rightsOf(session: unknown): Rights {
  const r = (session as { rights?: Partial<Rights> } | null)?.rights;
  if (!r || typeof r !== 'object') return ALL_RIGHTS;
  const local = r.localAdmin === true;
  const settings = Array.isArray(r.localSettings) ? r.localSettings.filter((x): x is string => typeof x === 'string') : [];
  return { localAdmin: local, config: local || r.config === true, restart: local || r.restart === true, localSettings: local ? [] : settings };
}

export const rights = writable<Rights>(ALL_RIGHTS);

// What a control needs: 'config' (the Settings page's writes), 'restart'
// (the proxy and camera-side restarts), 'local' (everything else only the
// local admin token may do).
export type Need = 'local' | 'config' | 'restart';
export const LOCKED_TEXT = 'Needs the local admin token: you signed in from cams-admin.';

// Why a control is off for this session, or null when it may be used.
export function lockedWhy(r: Rights, need: Need): string | null {
  if (r.localAdmin || (need === 'config' && r.config) || (need === 'restart' && r.restart)) return null;
  return LOCKED_TEXT;
}

// A refusal the proxy still sent (403 local_admin_only), in plain words.
export const REFUSED_TEXT = 'Refused: this needs the local admin token (you signed in from cams-admin). Nothing was changed.';

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
export const SOME_SETTINGS_TEXT = 'Addresses, ports, files, trust and users need the local admin token: you signed in from cams-admin.';
export function settingsNote(r: Rights): string | null {
  return lockedWhy(r, 'config') ?? (!r.localAdmin && r.localSettings.length ? SOME_SETTINGS_TEXT : null);
}
