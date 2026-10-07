import type { AuditLog } from '../audit/audit-log';
import { configChanges, overrideState, type Change } from '../config/changes';
import type { Config } from '../config/defaults';
import { translatePath } from '../config/legacy';
import { ConfigError, configRevision, getPath, needsProcessRestart, needsRestart, planOverrides, planUnset, rebuildWith, setPath, writeOverridesFile, type Loaded, type Plan } from '../config/load';
import { CONFIG_SCHEMA } from '../config/schema';
import { configView } from '../config/view';
import type { OverridesBackups, Backup, PathState } from './backups';
import type { CommandBody } from './command-check';
import type { ConfigRollbackArgs, ConfigSetArgs, ConfigUnsetArgs } from './command-args';
import type { Done, Handler } from './commands';
import { CAMERA_NAME_PATTERN, classify, denyReason, NARROW, NARROW_REASON, narrowingOk, SECRET_KEY_PATTERN, settableView } from './remote-settable';

// cams-admin's settings commands (migration spec M §8, plan P3 Task 7):
// config.get, config.set / config.unset (dry run, revision conflict) and
// config.rollback (path-level, from the backup). Only the compiled
// remote-settable leaves (remote-settable.ts), classified on the translated
// paths before anything is planned. From the revision check to the write
// nothing awaits: a local PUT /control/config can't interleave.
export interface ConfigCommandDeps {
  loaded: () => Loaded;
  setLoaded: (l: Loaded) => void; // applies live settings (proxy.ts's)
  running: () => Config; // what the components run with (config.get's values)
  backups: OverridesBackups;
  audit: Pick<AuditLog, 'write'>;
  now?: () => number;
}

type Failure = { path: string; code: string; detail?: string };
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const failed = (code: string, paths: Failure[]): Done => ({ status: 'failed', code, result: { paths } });
const MAX_CAMERAS = 24;
// Settings never hold a secret; a path that looks like one (the contract's
// SECRET_KEY_PATTERN, e.g. a key file's path) is never sent.
const SECRET_PATH = SECRET_KEY_PATTERN;

// A legacy path (camera.*, ftp.user) as the proxy reads it; one it can't
// assign (several cameras) stays as sent and is refused as not a remote setting.
const translate = (l: Loaded, p: string): string => {
  try {
    return translatePath(p, l.order);
  } catch {
    return p;
  }
};

// The contract's path checks 1-3, in its order: unknown_camera, not_remote_settable, held_by_env.
function checkPaths(l: Loaded, paths: string[]): Done | null {
  const fails: Failure[] = [];
  for (const p of paths) {
    const c = classify(p, l.config.cameraOrder);
    if (c === 'unknown_camera') fails.push({ path: p, code: 'unknown_camera' });
    else if (c !== 'remote') {
      const why = denyReason(p);
      fails.push({ path: p, code: 'not_remote_settable', ...(why ? { detail: why } : {}) });
    } else if (l.sources[p] === 'env') fails.push({ path: p, code: 'held_by_env', detail: `set in .env (${l.envNames[p] ?? 'the environment'})`.slice(0, 200) });
  }
  if (!fails.length) return null;
  const order = ['unknown_camera', 'not_remote_settable', 'held_by_env'];
  return failed(order.find((o) => fails.some((f) => f.code === o))!, fails);
}

const currentOf = (l: Loaded, paths: string[]) =>
  Object.fromEntries(paths.map((p) => {
    const v = getPath(l.config, p);
    return [p, { ...(v !== undefined ? { v } : {}), s: l.sources[p] ?? 'default' }];
  }));

const pathOfMessage = (msg: string, paths: string[]): string => {
  const m = /^([A-Za-z0-9.-]+):/.exec(msg);
  return m && paths.includes(m[1]) ? m[1] : m?.[1] ?? '';
};
const invalidValue = (err: ConfigError, paths: string[]): Done => failed('invalid_value', [{ path: pathOfMessage(err.message, paths), code: 'invalid_value', detail: err.message.slice(0, 200) }]);

const changeRecord = (changes: Change[]) => changes.map((c) => ({ key: c.path, from: c.from, to: c.to, ...(c.restart ? { restart: c.restart } : {}) }));

// Writes the planned overrides and applies them; the backup first (so a
// write is never without one), dropped again if the write fails.
function commit(d: ConfigCommandDeps, l: Loaded, next: Loaded, overrides: object, backup: Backup | null): boolean {
  try {
    if (backup) d.backups.save(backup);
  } catch {
    return false;
  }
  try {
    writeOverridesFile(l.files.overrides, overrides);
  } catch {
    if (backup) d.backups.remove(backup.cmdId);
    return false;
  }
  d.setLoaded(next);
  return true;
}

function write(d: ConfigCommandDeps, cmd: CommandBody, args: { dryRun: boolean; baseRevision: string }, paths: string[], plan: (l: Loaded) => Plan): Done {
  const l = d.loaded();
  if (new Set(paths).size !== paths.length) return failed('invalid_value', [{ path: '', code: 'invalid_value', detail: 'a setting is named twice (a legacy path and its new name)' }]);
  const bad = checkPaths(l, paths);
  if (bad) return bad;
  const revision = configRevision(l);
  if (args.baseRevision !== revision) return { status: 'conflict', result: { revision, current: currentOf(l, paths) } };
  let p: Plan;
  try {
    p = plan(l);
  } catch (err) {
    if (err instanceof ConfigError) return invalidValue(err, paths);
    throw err;
  }
  const changes = configChanges(l, p.next);
  const widening = changes.filter((c) => !narrowingOk(c.path, c.from, c.to));
  if (widening.length) return failed('widening_local_only', widening.map((c) => ({ path: c.path, code: 'widening_local_only', detail: NARROW_REASON[NARROW[c.path]] })));
  const unchanged = paths.filter((x) => !changes.some((c) => c.path === x));
  if (args.dryRun) return { status: 'ok', result: { dryRun: true, baseRevision: revision, revision, changes, unchanged } };
  const after = configRevision(p.next);
  const backup: Backup = {
    v: 1, cmdId: cmd.cmdId, command: cmd.command as Backup['command'], actor: cmd.actor, at: (d.now ?? Date.now)(), revisionBefore: revision, revisionAfter: after,
    paths: paths.map((x) => ({ path: x, before: overrideState(l.overrides, x), after: overrideState(p.overrides, x) })),
  };
  if (!commit(d, l, p.next, p.overrides, backup)) return { status: 'failed', code: 'store_error', result: { paths: [] } };
  if (changes.length) {
    d.audit.write({
      action: 'config-change', category: ['configuration'], type: ['change'], outcome: 'success', user: 'cams-admin',
      message: `Settings changed by cams-admin (on behalf of ${cmd.actor}): ${changes.map((c) => c.path).join(', ')}`,
      details: { cmdId: cmd.cmdId, actor: cmd.actor, changes: changeRecord(changes) },
    });
  }
  return { status: 'ok', result: { dryRun: false, baseRevision: revision, revision: after, changes, unchanged }, changed: changes.map((c) => c.path) };
}

// A copy of the overrides with each path back to a state; empty groups dropped.
function withStates(overrides: object, states: { path: string; state: PathState }[]): Obj {
  const out = structuredClone(overrides) as Obj;
  for (const { path, state } of states) setPath(out, path, state.set ? state.value : undefined);
  const prune = (x: Obj) => {
    for (const [k, v] of Object.entries(x)) if (isObj(v)) (prune(v), Object.keys(v).length === 0 && delete x[k]);
  };
  prune(out);
  return out;
}

type Undoer = { by: 'cams-admin'; cmd: CommandBody } | { by: 'local'; who: { user: string; ip?: string; userAgent?: string } };

// config.rollback and the card's Undo (R3-5): each path the command named
// back to its override state before, when it still holds the state the
// command left; no direction check (it restores what a person had set).
function rollback(d: ConfigCommandDeps, of: string, dryRun: boolean, u: Undoer): Done {
  const b = d.backups.get(of);
  if (!b) return { status: 'failed', code: 'no_backup' };
  if (b.rolledBack) return { status: 'failed', code: 'already_rolled_back' };
  const l = d.loaded();
  const paths = b.paths.map((x) => x.path);
  const bad = checkPaths(l, paths);
  if (bad) return bad;
  const revision = configRevision(l);
  const moved = b.paths.filter((x) => !same(overrideState(l.overrides, x.path), x.after)).map((x) => x.path);
  if (moved.length) return { status: 'conflict', result: { revision, current: currentOf(l, moved) } };
  const overrides = withStates(l.overrides, b.paths.map((x) => ({ path: x.path, state: x.before })));
  let next: Loaded;
  try {
    next = rebuildWith(l, overrides);
  } catch (err) {
    if (err instanceof ConfigError) return invalidValue(err, paths);
    throw err;
  }
  const changes = configChanges(l, next);
  const unchanged = paths.filter((x) => !changes.some((c) => c.path === x));
  if (dryRun) return { status: 'ok', result: { dryRun: true, baseRevision: revision, revision, changes, unchanged, of } };
  const at = (d.now ?? Date.now)();
  const after = configRevision({ ...l, overrides } as Loaded);
  const backup: Backup | null = u.by === 'cams-admin'
    ? { v: 1, cmdId: u.cmd.cmdId, command: 'config.rollback', actor: u.cmd.actor, at, revisionBefore: revision, revisionAfter: after, paths: b.paths.map((x) => ({ path: x.path, before: x.after, after: x.before })) }
    : null;
  if (!commit(d, l, next, overrides, backup)) return { status: 'failed', code: 'store_error', result: { paths: [] } };
  try {
    d.backups.markRolledBack(of, u.by === 'cams-admin' ? { at, by: 'cams-admin', cmdId: u.cmd.cmdId } : { at, by: 'local', user: u.who.user });
  } catch {
    // The settings are restored; the mark is cosmetic (a second rollback then conflicts).
  }
  if (changes.length) {
    d.audit.write(u.by === 'cams-admin'
      ? { action: 'config-change', category: ['configuration'], type: ['change'], outcome: 'success', user: 'cams-admin', message: `Settings rolled back by cams-admin (on behalf of ${u.cmd.actor}, ${of}): ${changes.map((c) => c.path).join(', ')}`, details: { cmdId: u.cmd.cmdId, actor: u.cmd.actor, rollbackOf: of, changes: changeRecord(changes) } }
      : { action: 'config-change', category: ['configuration'], type: ['change'], outcome: 'success', user: u.who.user, ...(u.who.ip ? { ip: u.who.ip } : {}), ...(u.who.userAgent ? { userAgent: u.who.userAgent } : {}), message: `cams-admin's change ${of} undone: ${changes.map((c) => c.path).join(', ')}`, details: { undoOf: of, changes: changeRecord(changes) } });
  }
  return { status: 'ok', result: { dryRun: false, baseRevision: revision, revision: configRevision(next), changes, unchanged, of }, changed: changes.map((c) => c.path) };
}

// The config.get result (R3-6): one compact object per path, at most 24 cameras.
export function compactView(l: Loaded, running: Config, marks: ReturnType<OverridesBackups['byPath']>, maxCameras = MAX_CAMERAS): Record<string, unknown> {
  const all = l.config.cameraOrder;
  const cameras = all.slice(0, maxCameras);
  const omitted = all.slice(maxCameras);
  const view = configView(l, running, marks) as Record<string, { value?: unknown; source: string; pending?: boolean; next?: unknown; by?: { cmdId: string; actor: string; at: number } }>;
  const paths: Record<string, unknown> = {};
  for (const [p, e] of Object.entries(view)) {
    const m = /^cameras\.([^.]+)\./.exec(p);
    if ((m && !cameras.includes(m[1])) || SECRET_PATH.test(p)) continue;
    const by = e.by;
    const r = needsProcessRestart(p) ? 'process' : needsRestart(p) ? 'restart' : null;
    paths[p] = { ...(e.value !== undefined ? { v: e.value } : {}), s: e.source, ...(r ? { r } : {}), ...(e.pending ? { p: true, ...(e.next !== undefined ? { n: e.next } : {}) } : {}), ...(by ? { by } : {}) };
  }
  return { revision: configRevision(l), schema: CONFIG_SCHEMA, cameras, omittedCameras: omitted, paths, settable: settableView() };
}

export function configHandlers(d: ConfigCommandDeps): Record<'config.get' | 'config.set' | 'config.unset' | 'config.rollback', Handler> {
  return {
    'config.get': () => {
      try {
        return { status: 'ok', result: compactView(d.loaded(), d.running(), d.backups.byPath()) };
      } catch {
        return { status: 'failed', code: 'store_error' };
      }
    },
    'config.set': (args, cmd) => {
      const a = args as ConfigSetArgs;
      const l = d.loaded();
      const entries = Object.entries(a.set).map(([p, v]) => [translate(l, p), v] as const);
      const paths = entries.map(([p]) => p);
      return write(d, cmd, a, paths, (cur) => {
        // A camera name from cams-admin: the contract's CAMERA_NAME_PATTERN (an invalid_value, as the proxy's own rules).
        for (const [p, v] of entries) if (/^cameras\.[^.]+\.name$/.test(p) && (typeof v !== 'string' || !CAMERA_NAME_PATTERN.test(v))) throw new ConfigError(`${p}: 1 to 64 characters, no control, bidi, separator or zero-width characters`);
        const patch: Obj = {};
        for (const [p, v] of entries) setPath(patch, p, v);
        return planOverrides(cur, patch);
      });
    },
    'config.unset': (args, cmd) => {
      const a = args as ConfigUnsetArgs;
      const l = d.loaded();
      const paths = a.paths.map((p) => translate(l, p));
      return write(d, cmd, a, paths, (cur) => planUnset(cur, paths));
    },
    'config.rollback': (args, cmd) => {
      const a = args as ConfigRollbackArgs;
      return rollback(d, a.cmdId, a.dryRun, { by: 'cams-admin', cmd });
    },
  };
}

// The card's Undo (R3-5): the rollback with the local admin's rights.
export function undoLocal(d: ConfigCommandDeps, cmdId: string, who: { user: string; ip?: string; userAgent?: string }): Done {
  return rollback(d, cmdId, false, { by: 'local', who });
}
