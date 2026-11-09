import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

type Lock = { packages?: Record<string, { version?: string; resolved?: string }> };
const read = (file: string): Lock | null => {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Lock) : null;
  } catch {
    return null;
  }
};

// The installed packages (node_modules/.package-lock.json, written by npm)
// that differ from package-lock.json: a checkout whose lock moved on without
// an `npm ci`. cam-sim, a release tarball, is the one that matters: an old one
// answers commands it did not know yet with rspCode -9 (2026-11-09: e2e:multi
// "Set camera time" failed locally with "can't set its time zone" on a
// cam-sim from 10-20 while the lock pinned 11-03, and passed in CI).
export function staleDeps(root: string): string[] {
  const locked = read(join(root, 'package-lock.json'))?.packages;
  const installed = read(join(root, 'node_modules', '.package-lock.json'))?.packages;
  if (!locked || !installed) return [];
  return Object.keys(installed)
    .filter((k) => k in locked && (installed[k].resolved ?? installed[k].version) !== (locked[k].resolved ?? locked[k].version))
    .map((k) => `${k.replace(/^.*node_modules\//, '')}: installed ${installed[k].resolved ?? installed[k].version}, locked ${locked[k].resolved ?? locked[k].version}`);
}
