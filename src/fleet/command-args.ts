// Strict validators for command args (contract commands/<name>.args.schema.json,
// strict variant). Hand-written: no schema library at run time. A test runs
// them against the vendored strict schemas on the fixtures.
import { NEVER_REMOTE_ACTIONS, REMOTE_ACTIONS } from './policy';
import type { ManagedToken, TokensApplyArgs } from './token-store';

export type ArgsVerdict<T> = { ok: true; args: T } | { ok: false; code: 'unsupported_version' | 'invalid_args'; detail: string };
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const TOK_ID = /^tok_[0-9A-HJKMNP-TV-Z]{20}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const LABEL = /^[^\u0000-\u001f\u007f]{1,64}$/u;

export function validateTokensApply(a: unknown): ArgsVerdict<TokensApplyArgs> {
  if (!isObj(a)) return { ok: false, code: 'invalid_args', detail: 'args: not an object' };
  if (a.v !== 1) return Number.isInteger(a.v) ? { ok: false, code: 'unsupported_version', detail: `args.v ${String(a.v)}` } : { ok: false, code: 'invalid_args', detail: 'args.v' };
  if (!only(a, ['v', 'revision', 'tokens'])) return { ok: false, code: 'invalid_args', detail: 'args: unknown field' };
  if (!Number.isSafeInteger(a.revision) || (a.revision as number) < 1) return { ok: false, code: 'invalid_args', detail: 'revision' };
  if (!Array.isArray(a.tokens) || a.tokens.length > 64) return { ok: false, code: 'invalid_args', detail: 'tokens' };
  const ids = new Set<string>();
  const hashes = new Set<string>();
  const out: ManagedToken[] = [];
  for (const [i, t] of a.tokens.entries()) {
    const bad = (f: string): ArgsVerdict<TokensApplyArgs> => ({ ok: false, code: 'invalid_args', detail: `tokens[${i}].${f}` });
    if (!isObj(t) || !only(t, ['id', 'kind', 'hash', 'label', 'retireAt'])) return bad('*');
    if (typeof t.id !== 'string' || !TOK_ID.test(t.id) || ids.has(t.id)) return bad('id');
    if (t.kind !== 'client' && t.kind !== 'admin') return bad('kind');
    if (typeof t.hash !== 'string' || !HASH.test(t.hash) || hashes.has(t.hash)) return bad('hash');
    if (typeof t.label !== 'string' || !LABEL.test(t.label)) return bad('label');
    if (t.retireAt !== null && !(Number.isSafeInteger(t.retireAt) && (t.retireAt as number) >= 0)) return bad('retireAt');
    ids.add(t.id);
    hashes.add(t.hash);
    out.push({ id: t.id, kind: t.kind, hash: t.hash, label: t.label, retireAt: t.retireAt as number | null });
  }
  return { ok: true, args: { v: 1, revision: a.revision as number, tokens: out } };
}


// P3 (contract "Args v1"): closed objects, args.v 1.
export interface ConfigSetArgs { v: 1; dryRun: boolean; baseRevision: string; set: Record<string, boolean | number | string> }
export interface ConfigUnsetArgs { v: 1; dryRun: boolean; baseRevision: string; paths: string[] }
export interface ConfigRollbackArgs { v: 1; dryRun: boolean; cmdId: string }
export interface CameraActionArgs { v: 1; camera: string | null; action: string; input?: { kind: string; camera?: boolean } }
export interface CameraNameArgs { v: 1; camera: string; name: string }

// A settings path as GET /control/config names it: dotted, no `_` (so never __proto__).
export const PATH_RE = /^[a-z][A-Za-z0-9]{0,31}(\.[a-z0-9][A-Za-z0-9-]{0,31}){0,5}$/;
const REV = /^sha256:[0-9a-f]{64}$/;
const CMD_ID = /^cmd_[0-9A-HJKMNP-TV-Z]{20}$/;
const CAM = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/u;
const leafValue = (x: unknown) => typeof x === 'boolean' || Number.isSafeInteger(x) || (typeof x === 'string' && x.length <= 512);
const v1 = <T>(a: unknown, keys: string[], rest: (o: Record<string, unknown>) => string | null): ArgsVerdict<T> => {
  if (!isObj(a)) return { ok: false, code: 'invalid_args', detail: 'args: not an object' };
  if (a.v !== 1) return Number.isInteger(a.v) ? { ok: false, code: 'unsupported_version', detail: `args.v ${String(a.v)}` } : { ok: false, code: 'invalid_args', detail: 'args.v' };
  if (!only(a, ['v', ...keys])) return { ok: false, code: 'invalid_args', detail: 'args: unknown field' };
  const bad = rest(a);
  return bad ? { ok: false, code: 'invalid_args', detail: bad } : { ok: true, args: a as T };
};
export const validateConfigGet = (a: unknown) => v1<{ v: 1 }>(a, [], () => null);
export const validateProxyRestart = validateConfigGet;
export const validateConfigSet = (a: unknown) => v1<ConfigSetArgs>(a, ['dryRun', 'baseRevision', 'set'], (o) => {
  if (typeof o.dryRun !== 'boolean') return 'dryRun';
  if (typeof o.baseRevision !== 'string' || !REV.test(o.baseRevision)) return 'baseRevision';
  if (!isObj(o.set)) return 'set';
  const e = Object.entries(o.set);
  if (e.length < 1 || e.length > 64) return 'set: 1 to 64 entries';
  for (const [p, x] of e) if (!PATH_RE.test(p) || !leafValue(x)) return `set.${p.slice(0, 64)}`;
  return null;
});
export const validateConfigUnset = (a: unknown) => v1<ConfigUnsetArgs>(a, ['dryRun', 'baseRevision', 'paths'], (o) => {
  if (typeof o.dryRun !== 'boolean') return 'dryRun';
  if (typeof o.baseRevision !== 'string' || !REV.test(o.baseRevision)) return 'baseRevision';
  if (!Array.isArray(o.paths) || o.paths.length < 1 || o.paths.length > 64) return 'paths: 1 to 64';
  if (o.paths.some((p) => typeof p !== 'string' || !PATH_RE.test(p)) || new Set(o.paths).size !== o.paths.length) return 'paths';
  return null;
});
export const validateConfigRollback = (a: unknown) => v1<ConfigRollbackArgs>(a, ['dryRun', 'cmdId'], (o) => (typeof o.dryRun !== 'boolean' ? 'dryRun' : typeof o.cmdId !== 'string' || !CMD_ID.test(o.cmdId) ? 'cmdId' : null));
export const validateCameraAction = (a: unknown) => v1<CameraActionArgs>(a, ['camera', 'action', 'input'], (o) => {
  if (typeof o.action !== 'string' || !([...REMOTE_ACTIONS, ...NEVER_REMOTE_ACTIONS] as string[]).includes(o.action)) return 'action';
  if (o.action === 'retention-run' ? o.camera !== null : typeof o.camera !== 'string' || !CAM.test(o.camera)) return 'camera';
  if (o.input !== undefined) {
    if (o.action !== 'inventory' || !isObj(o.input) || !only(o.input, ['kind', 'camera'])) return 'input';
    if (typeof o.input.kind !== 'string' || o.input.kind.length < 1 || o.input.kind.length > 32) return 'input.kind';
    if (o.input.camera !== undefined && typeof o.input.camera !== 'boolean') return 'input.camera';
  }
  return null;
});
export const validateCameraName = (a: unknown) => v1<CameraNameArgs>(a, ['camera', 'name'], (o) => (typeof o.camera !== 'string' || !CAM.test(o.camera) ? 'camera' : typeof o.name !== 'string' || !NAME.test(o.name) ? 'name' : null));

export const ARGS_VALIDATORS: Record<string, (a: unknown) => ArgsVerdict<unknown>> = {
  'tokens.apply': validateTokensApply,
  'config.get': validateConfigGet,
  'config.set': validateConfigSet,
  'config.unset': validateConfigUnset,
  'config.rollback': validateConfigRollback,
  'camera.action': validateCameraAction,
  'camera.name.set': validateCameraName,
  'proxy.restart': validateProxyRestart,
};
