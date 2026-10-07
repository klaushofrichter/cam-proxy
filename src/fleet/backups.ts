import { readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { PrivateFileInvalid, PrivateFileUnsafe, readPrivateJson, writePrivateJson } from './private-file';

// Overrides backups (migration spec M §8.5, plan P3 R3-5): before each
// cams-admin settings write, the override state of every path it names, in
// data/admin/overrides.bak-<cmdId>.json (mode 600, folder 700, atomic; the
// newest 20 kept). config.rollback and the card's Undo restore those paths
// only. Never printed, logged or served whole.
export interface PathState { set: boolean; value?: unknown }
export interface Backup {
  v: 1; cmdId: string; command: 'config.set' | 'config.unset' | 'config.rollback'; actor: string; at: number;
  revisionBefore: string; revisionAfter: string;
  paths: { path: string; before: PathState; after: PathState }[];
  rolledBack?: { at: number; by: 'cams-admin' | 'local'; cmdId?: string; user?: string };
}

const CMD_ID = /^cmd_[0-9A-HJKMNP-TV-Z]{20}$/;
const FILE = /^overrides\.bak-(cmd_[0-9A-HJKMNP-TV-Z]{20})\.json$/;
const KEEP = 20;
// A hard cap: the newest backup per path is kept beyond KEEP (review I1), and
// paths are bounded (the remote-settable leaves), so this is never reached in use.
const HARD_CAP = 500;
const isState = (x: unknown): x is PathState => typeof x === 'object' && x !== null && typeof (x as PathState).set === 'boolean';
const valid = (b: unknown, cmdId: string): b is Backup => {
  const x = b as Backup;
  return typeof x === 'object' && x !== null && x.v === 1 && x.cmdId === cmdId && typeof x.at === 'number' && typeof x.actor === 'string' && ['config.set', 'config.unset', 'config.rollback'].includes(x.command)
    && Array.isArray(x.paths) && x.paths.every((p) => typeof p?.path === 'string' && isState(p.before) && isState(p.after));
};

export class OverridesBackups {
  private warned = new Set<string>();
  constructor(
    private readonly dir: string, // <dataDir>/admin
    private readonly now: () => number = Date.now,
    private readonly log: { warn(o: object, m: string): void } = { warn() {} },
  ) {}

  private file(cmdId: string): string {
    if (!CMD_ID.test(cmdId)) throw new Error('not a command id');
    return join(this.dir, `overrides.bak-${cmdId}.json`);
  }

  save(b: Backup): void {
    writePrivateJson(this.file(b.cmdId), b);
    this.prune();
  }

  // The newest 20, and beyond them every not-undone backup that is still the
  // newest one naming one of its paths (review I1): a flood of other remote
  // changes never takes away the Undo or the marker of an earlier change.
  private prune(): void {
    const all = this.list();
    const newest = new Set<string>();
    const seen = new Set<string>();
    for (const b of all) {
      if (b.rolledBack) continue;
      for (const p of b.paths) {
        if (seen.has(p.path)) continue;
        seen.add(p.path);
        newest.add(b.cmdId);
      }
    }
    const keep = all.filter((b, i) => i < KEEP || newest.has(b.cmdId)).slice(0, HARD_CAP);
    const kept = new Set(keep.map((b) => b.cmdId));
    for (const old of all) if (!kept.has(old.cmdId)) rmSync(this.file(old.cmdId), { force: true });
  }

  // A backup whose write did not happen after all.
  remove(cmdId: string): void {
    rmSync(this.file(cmdId), { force: true });
  }

  // null: missing, unsafe or invalid (logged once per file).
  get(cmdId: string): Backup | null {
    const f = this.file(cmdId);
    try {
      const b = readPrivateJson(f);
      if (valid(b, cmdId)) return b;
      throw new PrivateFileInvalid(`${f} is not a backup`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (!(e instanceof PrivateFileUnsafe || e instanceof PrivateFileInvalid)) throw e;
      if (!this.warned.has(f)) {
        this.warned.add(f);
        this.log.warn({ file: f, reason: e.message }, 'admin_backup_unusable');
      }
      return null;
    }
  }

  // Newest first, valid ones only.
  list(): Backup[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names.flatMap((n) => {
      const m = FILE.exec(n);
      const b = m ? this.get(m[1]) : null;
      return b ? [b] : [];
    }).sort((a, b) => b.at - a.at || (a.cmdId < b.cmdId ? 1 : -1));
  }

  markRolledBack(cmdId: string, r: NonNullable<Backup['rolledBack']>): void {
    const f = this.file(cmdId);
    const b = this.get(cmdId);
    if (!b) throw new Error('no backup');
    writePrivateJson(f, { ...b, rolledBack: r });
  }

  // Per path: the newest not-rolled-back backup whose `after` set it (the
  // "set by cams-admin" marker, R3-14). A rolled-back one is skipped (the
  // path went back to what the one before it set); a rollback marks nothing
  // (it restored a value someone else had set); an unset marks nothing.
  byPath(): Map<string, { cmdId: string; actor: string; at: number; value: unknown }> {
    const out = new Map<string, { cmdId: string; actor: string; at: number; value: unknown }>();
    const seen = new Set<string>();
    for (const b of this.list()) {
      if (b.rolledBack) continue;
      for (const p of b.paths) {
        if (seen.has(p.path)) continue;
        seen.add(p.path);
        if (b.command !== 'config.rollback' && p.after.set) out.set(p.path, { cmdId: b.cmdId, actor: b.actor, at: b.at, value: p.after.value });
      }
    }
    return out;
  }
}
