import { getPath, needsProcessRestart, needsRestart, settingPaths, type Loaded, type Source } from './load';

// One changed leaf setting between two configurations: the Settings page's
// `config-change` record and cams-admin's config.set/unset/rollback diff (plan
// P3 Task 4). `restart`: the change waits for a restart, or for a new process.
export interface Change { path: string; from?: unknown; to?: unknown; sourceFrom: Source; sourceTo: Source; restart?: 'restart' | 'process' }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function configChanges(before: Loaded, after: Loaded): Change[] {
  const paths = [...new Set([...settingPaths(before.config), ...settingPaths(after.config)])].sort();
  const out: Change[] = [];
  for (const p of paths) {
    const from = getPath(before.config, p);
    const to = getPath(after.config, p);
    if (same(from, to)) continue;
    out.push({
      path: p,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      sourceFrom: before.sources[p] ?? 'default',
      sourceTo: after.sources[p] ?? 'default',
      ...(needsProcessRestart(p) ? { restart: 'process' as const } : needsRestart(p) ? { restart: 'restart' as const } : {}),
    });
  }
  return out;
}

// Whether overrides.json sets a leaf path, and to what.
export function overrideState(overrides: object, path: string): { set: boolean; value?: unknown } {
  const v = getPath(overrides, path);
  return v === undefined ? { set: false } : { set: true, value: v };
}
