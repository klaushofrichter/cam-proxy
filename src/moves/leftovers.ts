// What the proxy a camera left can't remove itself (spec
// 2026-10-30-ptz-capabilities-design §7, plan D Task 7): an entry in
// config.json (never written here), the camera's password in the process
// environment (compose's environment or env_file) or a _FILE secret. Kept in
// data/admin/move-leftovers.json at a move's finish and re-checked on every
// read, so a fixed item drops out. Never a value: names only.
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Loaded } from '../config/load';
import { EnvFileError, removeEnvKey } from '../config/env-file';
import { cameraPasswordEnv } from '../config/password-env';
import { writePrivateJson } from '../fleet/private-file';

export interface MoveLeftover { camera: string; moveId: string; items: string[] }
export const LEFTOVERS_MAX = 16;
export type EnvCleanup = { outcome: 'removed'; key: string; backup: string } | { outcome: 'not_in_file' | 'not_managed'; key: string } | { outcome: 'failed'; key: string; code: string };

// The camera's password line removed from the env file this proxy manages
// (CAMPROXY_ENV_FILE, read at start); not_managed without one.
export function removePasswordLine(loaded: Loaded, cam: string, now = new Date()): EnvCleanup {
  const key = cameraPasswordEnv(cam);
  const file = loaded.envFile;
  if (!file?.read) return { outcome: 'not_managed', key };
  try {
    const r = removeEnvKey(file.path, key, now);
    return r ? { outcome: 'removed', key, backup: r.backup } : { outcome: 'not_in_file', key };
  } catch (err) {
    return { outcome: 'failed', key, code: err instanceof EnvFileError ? err.code : 'write_failed' };
  }
}

// What is left of a camera that moved away, as seen now.
export function leftoverItems(loaded: Loaded, cam: string, moveId: string): string[] {
  const name = cameraPasswordEnv(cam);
  const items: string[] = [];
  if (loaded.order.includes(cam) && loaded.config.cameras[cam]?.moved === moveId) items.push('config.json entry');
  if ((loaded.env[name] ?? '').trim() !== '') items.push(`env ${name}`);
  if (loaded.env[`${name}_FILE`] !== undefined) items.push(`env ${name}_FILE`);
  return items;
}

const entryOk = (e: unknown): e is MoveLeftover => {
  const o = e as MoveLeftover;
  return !!o && typeof o.camera === 'string' && typeof o.moveId === 'string' && Array.isArray(o.items) && o.items.every((i) => typeof i === 'string');
};

export class MoveLeftovers {
  private readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, 'admin', 'move-leftovers.json');
  }

  private read(): MoveLeftover[] {
    try {
      const v = JSON.parse(readFileSync(this.path, 'utf8')) as { entries?: unknown };
      return Array.isArray(v.entries) ? v.entries.filter(entryOk) : [];
    } catch {
      return [];
    }
  }

  // Replaces an entry of that camera; the newest LEFTOVERS_MAX stay.
  add(entry: MoveLeftover): void {
    const next = [...this.read().filter((e) => e.camera !== entry.camera), { camera: entry.camera, moveId: entry.moveId, items: [...entry.items] }].slice(-LEFTOVERS_MAX);
    writePrivateJson(this.path, { v: 1, entries: next });
  }

  // Each entry's items as they are now; entries with none left, and cameras running here again, dropped.
  current(loaded: Loaded): MoveLeftover[] {
    return this.read()
      .filter((e) => !(loaded.config.cameras[e.camera] && loaded.config.cameras[e.camera].moved === undefined))
      .map((e) => ({ ...e, items: leftoverItems(loaded, e.camera, e.moveId).filter((i) => e.items.includes(i)) }))
      .filter((e) => e.items.length > 0);
  }
}
