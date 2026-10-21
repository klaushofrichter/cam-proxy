import { configChanges } from '../config/changes';
import { planOverrides, planRemoveAll, withoutOverride, type Loaded } from '../config/load';
import { NARROW, narrowingOk } from '../fleet/remote-settable';
import { isLocalSetting } from './auth';

// Issue #227 follow-up (Klaus, 2026-10-21): a cams-admin sign-in's ui.config
// follows cams-admin's own direction rules (NARROW, src/fleet/remote-settable.ts):
// retention and size caps only up (keep data longer), Google Vision's
// spending caps only down. A change the other way is the local admin's.
export const UI_NARROW_REASON = { less: 'a cams-admin sign-in may only lower spending', more: 'a cams-admin sign-in may only keep data longer' } as const;

// The leaf settings a change moves against NARROW's direction.
export function againstDirection(before: Loaded, after: Loaded): string[] {
  return configChanges(before, after).filter((c) => !narrowingOk(c.path, c.from, c.to)).map((c) => c.path);
}

// PUT /control/config (the patch) or DELETE /control/config/<path> (the
// decoded path) under ui.config: why it is refused, or null. An invalid
// request is null here: the route answers it (400).
export function uiConfigAgainst(loaded: Loaded, req: { method: 'PUT'; body: unknown } | { method: 'DELETE'; path: string }): string | null {
  let after: Loaded;
  try {
    after = req.method === 'PUT' ? planOverrides(loaded, (req.body ?? {}) as object).next : withoutOverride(loaded, req.path);
  } catch {
    return null;
  }
  const bad = againstDirection(loaded, after);
  return bad.length ? bad.map((p) => `${p}: ${UI_NARROW_REASON[NARROW[p]]}`).join('; ') : null;
}

// Reset to defaults under ui.config: the overrides that stay. The settings
// ui.config never changes (isLocalSetting), and those whose reset would go
// against the direction rules (a reset to a shorter retention, a higher cap).
export function uiConfigResetKeep(loaded: Loaded): (path: string) => boolean {
  let bad = new Set<string>();
  try {
    bad = new Set(againstDirection(loaded, planRemoveAll(loaded, isLocalSetting).next));
  } catch {
    // Invalid without them: the reset itself answers 400.
  }
  return (p) => isLocalSetting(p) || bad.has(p);
}
