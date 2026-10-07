import { getPath, needsRestart, resetTarget, settingPaths, type Loaded } from './load';
import { leafAt } from './schema';
import type { Config } from './defaults';

// The effective configuration for the UI: value (what runs), source, restart
// flag, the next value for restart settings changed but not yet applied, and
// the type (integer, boolean or string), for settings without a value.
// `legacy`: a config.json value read from a legacy `camera` object (spec
// 2026-10-05-multi-camera-host-design §4.2: "config.json (legacy camera)").
// `by` (plan P3 R3-14): the override holds the value a cams-admin command set
// (marks: OverridesBackups.byPath()).
export type ChangeMarks = Map<string, { cmdId: string; actor: string; at: number; value: unknown }>;
export function configView(loaded: Loaded, running: Config, marks?: ChangeMarks) {
  return Object.fromEntries(
    settingPaths(running).map((p) => {
      const restart = needsRestart(p);
      const value = getPath(running, p);
      const next = getPath(loaded.config, p);
      const pending = restart && JSON.stringify(value) !== JSON.stringify(next);
      // `env`: the variable that sets it (read-only on the Settings page).
      // `resetTo` (an override): what Reset goes back to, the file's value or the
      // default; `same` when that changes nothing, `means` for an unset state.
      const mark = marks?.get(p);
      const by = mark && loaded.sources[p] === 'override' && JSON.stringify(getPath(loaded.overrides, p)) === JSON.stringify(mark.value) ? { cmdId: mark.cmdId, actor: mark.actor, at: mark.at } : null;
      return [p, { value, source: loaded.sources[p], ...(loaded.envNames[p] ? { env: loaded.envNames[p] } : {}), restart, ...(restart ? { restartScope: /^cameras\.[^.]+\./.test(p) ? 'camera' : 'host' } : {}), pending, ...(pending ? { next } : {}), type: leafAt(p)?.type, ...(loaded.sources[p] === 'override' ? { resetTo: resetTarget(loaded, p) } : {}), ...(loaded.legacyCamera && loaded.sources[p] === 'file' && (p.startsWith('cameras.') || p.startsWith('poeSwitch.')) ? { legacy: true } : {}), ...(by ? { by } : {}) }];
    }),
  );
}

