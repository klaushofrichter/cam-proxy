// Strict validators for command args (contract commands/<name>.args.schema.json,
// strict variant). Hand-written: no schema library at run time. A test runs
// them against the vendored strict schemas on the fixtures.
import { NEVER_REMOTE_ACTIONS, REMOTE_ACTIONS } from './policy';
import { CAMERA_NAME_PATTERN } from './remote-settable';
import { FILE_KINDS, MOVE_KINDS, type MoveBounds, type MoveCopied, type MovePlan, type MoveRole, type MoveSummary, type Settings, type SettingsMap, type Space, type MoveReason } from '../moves/types';
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
export const validateCameraName = (a: unknown) => v1<CameraNameArgs>(a, ['camera', 'name'], (o) => (typeof o.camera !== 'string' || !CAM.test(o.camera) ? 'camera' : typeof o.name !== 'string' || !CAMERA_NAME_PATTERN.test(o.name) ? 'name' : null));

// ---- Camera moves (contract commands/move.*.args, strict) ----
export interface MoveTargetsArgs { v: 1; requestId: string; targets: { proxyId: string; name: string; site: string | null }[] }
export interface MoveOpenArgs { v: 1; moveId: string; requestId: string; camera: string; tokenHash: string; targetIp: string }
export interface MoveOfferArgs { v: 1; moveId: string; token: string; source: { proxyId: string; name: string; url: string; caFingerprints: string[]; tlsServername: string }; camera: { camsId: string; proxyCameraId: string; name: string; host: string; protocol: 'https' | 'http'; user: string; onvifPort: number; rtspPort: number; baichuanPort: number }; summary: MoveSummary; settings: Settings }
export interface MoveAnswerArgs { v: 1; moveId: string; requestId: string; target: { proxyId: string; name: string }; accept: boolean; reason?: MoveReason; detail?: string; space?: Space; estimateS?: number }
export interface MoveStartArgs { v: 1; moveId: string; plan: MovePlan; settings: Settings; done: string[] }
export interface MoveGoArgs { v: 1; moveId: string; plan: MovePlan; targetPublicKey: string; expectedLeaf: string }
export interface MoveBeginArgs { v: 1; camera: string; target: string; bounds: MoveBounds | null }
// move.summary: what a move of this camera would carry (read only).
export interface MoveSummaryArgs { v: 1; camera: string }
export interface MoveReturnOpenArgs { v: 1; moveId: string; returnOf: string; tokenHash: string; targetIp: string }
export interface MoveReturnStartArgs { v: 1; moveId: string; returnOf: string; token: string; source: MoveOfferArgs['source']; done: string[] }
export interface MoveReleaseArgs { v: 1; moveId: string }
export interface MoveFinishArgs { v: 1; moveId: string; role: MoveRole; abandoned: boolean; return?: boolean }
export interface MoveCancelArgs { v: 1; moveId: string; role: MoveRole; copied?: MoveCopied; expectedLeaf?: string }

const MOVE_ID = /^mv_[0-9A-HJKMNP-TV-Z]{20}$/;
const REQ_ID = /^rq_[0-9A-HJKMNP-TV-Z]{20}$/;
const PRX_ID = /^prx_[0-9A-HJKMNP-TV-Z]{20}$/;
const SITE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const FINGERPRINT = /^SHA256:[0-9A-F]{64}$/;
// An X25519 public key as SPKI DER base64: the 12-byte prefix (MCowBQYDK2VuAyEA) and 32 bytes, 60 characters.
export const X25519_SPKI = /^MCowBQYDK2VuAyEA[A-Za-z0-9+/]{43}=$/;
const CHUNK_ID = /^(stills|clips|events|checks|archive|ptz):[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const TOKEN_HASH = HASH;
// Loose on purpose (the contract's pattern): never IP validation, the move code compares addresses itself.
const TARGET_IP = /^[0-9A-Fa-f:.]{2,45}$/;
const MOVE_TOKEN = /^[\x21-\x7e]{8,256}$/;
const MOVE_REASONS: readonly string[] = ['moves_not_allowed', 'camera_unreachable', 'camera_limit', 'id_taken', 'busy', 'incompatible', 'no_site_ca', 'ca_does_not_cover_camera', 'external_cert', 'other_account', 'target_offline', 'not_routed', 'host_overridden', 'target_failed', 'offer_expired', 'not_registered', 'internal'];
const SPACE_PLANS: readonly string[] = ['all', 'omit', 'fit', 'retention'];
const nat = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const str = (x: unknown, max: number, min = 0): x is string => typeof x === 'string' && x.length >= min && x.length <= max;
const idLike = (x: unknown): x is string => typeof x === 'string' && CAM.test(x);
const natOrNull = (x: unknown) => x === null || nat(x);

// A flat settings map (targetSettings, retentionProposal): up to 64 paths, each a leaf value.
export const settingsMap = (x: unknown): x is SettingsMap | null => {
  if (x === null) return true;
  if (!isObj(x)) return false;
  const e = Object.entries(x);
  return e.length <= 64 && e.every(([p, v]) => PATH_RE.test(p) && leafValue(v));
};
const closed = (x: unknown, keys: string[]): x is Record<string, unknown> => isObj(x) && only(x, keys);
const optional = (o: Record<string, unknown>, k: string, ok: (x: unknown) => boolean) => o[k] === undefined || ok(o[k]);
const bool = (x: unknown) => typeof x === 'boolean';
const oneOf = (...l: string[]) => (x: unknown) => typeof x === 'string' && l.includes(x);

// The camera node of the config: every leaf optional, never null, closed objects.
export function settingsProblem(s: unknown): string | null {
  if (!closed(s, ['name', 'statusPollS', 'ftp', 'stills', 'storage', 'analytics', 'events'])) return 'settings';
  if (!optional(s, 'name', (x) => typeof x === 'string' && CAMERA_NAME_PATTERN.test(x))) return 'settings.name';
  if (!optional(s, 'statusPollS', (x) => Number.isSafeInteger(x) && (x as number) >= 1)) return 'settings.statusPollS';
  if (!optional(s, 'ftp', (x) => closed(x, ['enabled', 'stream']) && optional(x, 'enabled', bool) && optional(x, 'stream', oneOf('main', 'sub')))) return 'settings.ftp';
  if (!optional(s, 'stills', (x) => closed(x, ['enabled', 'stream', 'intervalS']) && optional(x, 'enabled', bool) && optional(x, 'stream', oneOf('sub', 'main')) && optional(x, 'intervalS', (n) => typeof n === 'number' && Number.isFinite(n) && n > 0))) return 'settings.stills';
  if (!optional(s, 'storage', (x) => closed(x, ['sharePercent']) && optional(x, 'sharePercent', (n) => typeof n === 'number' && n >= 0 && n <= 100))) return 'settings.storage';
  if (!optional(s, 'analytics', (x) => closed(x, ['kinds']) && optional(x, 'kinds', (k) => closed(k, ['person', 'vehicle', 'pet']) && optional(k, 'person', bool) && optional(k, 'vehicle', bool) && optional(k, 'pet', bool)))) return 'settings.analytics';
  if (!optional(s, 'events', (x) => closed(x, ['poll']) && optional(x, 'poll', (p) => closed(p, ['enabled']) && optional(p, 'enabled', bool)))) return 'settings.events';
  return null;
}

export function summaryProblem(s: unknown): string | null {
  if (!closed(s, [...FILE_KINDS])) return 'summary';
  for (const k of FILE_KINDS) {
    const x = s[k];
    if (!closed(x, ['files', 'bytes', 'rows', 'oldest', 'newest']) || !nat(x.files) || !nat(x.bytes) || !nat(x.rows) || !natOrNull(x.oldest) || !natOrNull(x.newest)) return `summary.${k}`;
  }
  return null;
}

export const spaceProblem = (s: unknown): string | null => {
  if (!closed(s, ['needed', 'available', 'fits', 'perKind', 'retentionProposal'])) return 'space';
  if (!nat(s.needed) || !nat(s.available) || !bool(s.fits)) return 'space';
  if (!closed(s.perKind, [...FILE_KINDS]) || !Object.values(s.perKind).every(nat)) return 'space.perKind';
  return settingsMap(s.retentionProposal) ? null : 'space.retentionProposal';
};

export const planProblem = (p: unknown): string | null => {
  if (!closed(p, ['transfer', 'kinds', 'space', 'targetSettings', 'budgetS', 'estimateS']) || !bool(p.transfer)) return 'plan';
  if (!Array.isArray(p.kinds) || p.kinds.length > MOVE_KINDS.length || new Set(p.kinds).size !== p.kinds.length || p.kinds.some((k) => !(MOVE_KINDS as readonly unknown[]).includes(k))) return 'plan.kinds';
  if (typeof p.space !== 'string' || !SPACE_PLANS.includes(p.space)) return 'plan.space';
  if (!settingsMap(p.targetSettings)) return 'plan.targetSettings';
  return nat(p.budgetS) && nat(p.estimateS) ? null : 'plan.budget';
};

const moveId = (o: Record<string, unknown>) => (typeof o.moveId === 'string' && MOVE_ID.test(o.moveId) ? null : 'moveId');
const role = (o: Record<string, unknown>) => (o.role === 'source' || o.role === 'target' ? null : 'role');
const port = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 1;

export const validateMoveTargets = (a: unknown) => v1<MoveTargetsArgs>(a, ['requestId', 'targets'], (o) => {
  if (typeof o.requestId !== 'string' || !REQ_ID.test(o.requestId)) return 'requestId';
  if (!Array.isArray(o.targets) || o.targets.length > 64) return 'targets';
  for (const [i, t] of o.targets.entries()) if (!closed(t, ['proxyId', 'name', 'site']) || typeof t.proxyId !== 'string' || !PRX_ID.test(t.proxyId) || !str(t.name, 64, 1) || !(t.site === null || (typeof t.site === 'string' && SITE.test(t.site)))) return `targets[${i}]`;
  return null;
});
export const validateMoveOpen = (a: unknown) => v1<MoveOpenArgs>(a, ['moveId', 'requestId', 'camera', 'tokenHash', 'targetIp'], (o) =>
  moveId(o) ?? (typeof o.requestId !== 'string' || !REQ_ID.test(o.requestId) ? 'requestId' : !idLike(o.camera) ? 'camera' : typeof o.tokenHash !== 'string' || !TOKEN_HASH.test(o.tokenHash) ? 'tokenHash' : typeof o.targetIp !== 'string' || !TARGET_IP.test(o.targetIp) ? 'targetIp' : null));
export const validateMoveReturnOpen = (a: unknown) => v1<MoveReturnOpenArgs>(a, ['moveId', 'returnOf', 'tokenHash', 'targetIp'], (o) =>
  moveId(o) ?? (typeof o.returnOf !== 'string' || !MOVE_ID.test(o.returnOf) ? 'returnOf' : typeof o.tokenHash !== 'string' || !TOKEN_HASH.test(o.tokenHash) ? 'tokenHash' : typeof o.targetIp !== 'string' || !TARGET_IP.test(o.targetIp) ? 'targetIp' : null));
// The move source as the receiving side keeps it (move.offer, move.return.start).
const sourceProblem = (s: unknown): boolean =>
  !closed(s, ['proxyId', 'name', 'url', 'caFingerprints', 'tlsServername']) || typeof s.proxyId !== 'string' || !PRX_ID.test(s.proxyId) || !str(s.name, 64, 1) || !str(s.url, 300) || !/^https?:\/\//.test(s.url)
    || !Array.isArray(s.caFingerprints) || s.caFingerprints.length > 2 || s.caFingerprints.some((f) => typeof f !== 'string' || !FINGERPRINT.test(f)) || !str(s.tlsServername, 253, 1);
export const validateMoveReturnStart = (a: unknown) => v1<MoveReturnStartArgs>(a, ['moveId', 'returnOf', 'token', 'source', 'done'], (o) =>
  moveId(o) ?? (typeof o.returnOf !== 'string' || !MOVE_ID.test(o.returnOf) ? 'returnOf' : typeof o.token !== 'string' || !MOVE_TOKEN.test(o.token) ? 'token' : sourceProblem(o.source) ? 'source'
    : !Array.isArray(o.done) || o.done.length > 512 || o.done.some((c) => typeof c !== 'string' || !CHUNK_ID.test(c)) ? 'done' : null));
export const validateMoveOffer = (a: unknown) => v1<MoveOfferArgs>(a, ['moveId', 'token', 'source', 'camera', 'summary', 'settings'], (o) => {
  const bad = moveId(o);
  if (bad) return bad;
  if (typeof o.token !== 'string' || !MOVE_TOKEN.test(o.token)) return 'token';
  if (sourceProblem(o.source)) return 'source';
  const c = o.camera;
  if (!closed(c, ['camsId', 'proxyCameraId', 'name', 'host', 'protocol', 'user', 'onvifPort', 'rtspPort', 'baichuanPort']) || !idLike(c.camsId) || !idLike(c.proxyCameraId) || typeof c.name !== 'string' || !CAMERA_NAME_PATTERN.test(c.name)
    || !str(c.host, 255, 1) || (c.protocol !== 'https' && c.protocol !== 'http') || !str(c.user, 64) || !port(c.onvifPort) || !port(c.rtspPort) || !port(c.baichuanPort)) return 'camera';
  return summaryProblem(o.summary) ?? settingsProblem(o.settings);
});
// A refusal's detail (contract: a string of 1 to 300 characters, counted in code points).
const detailOk = (x: unknown) => typeof x === 'string' && x.length > 0 && [...x].length <= 300;
export const validateMoveAnswer = (a: unknown) => v1<MoveAnswerArgs>(a, ['moveId', 'requestId', 'target', 'accept', 'reason', 'detail', 'space', 'estimateS'], (o) => {
  const bad = moveId(o);
  if (bad) return bad;
  if (typeof o.requestId !== 'string' || !REQ_ID.test(o.requestId)) return 'requestId';
  const t = o.target;
  if (!closed(t, ['proxyId', 'name']) || typeof t.proxyId !== 'string' || !PRX_ID.test(t.proxyId) || !str(t.name, 64, 1)) return 'target';
  if (!bool(o.accept)) return 'accept';
  if (!optional(o, 'reason', (x) => typeof x === 'string' && MOVE_REASONS.includes(x))) return 'reason';
  if (!optional(o, 'detail', detailOk)) return 'detail';
  if (o.space !== undefined) {
    const p = spaceProblem(o.space);
    if (p) return p;
  }
  return optional(o, 'estimateS', nat) ? null : 'estimateS';
});
export const validateMoveStart = (a: unknown) => v1<MoveStartArgs>(a, ['moveId', 'plan', 'settings', 'done'], (o) =>
  moveId(o) ?? planProblem(o.plan) ?? settingsProblem(o.settings) ?? (!Array.isArray(o.done) || o.done.length > 512 || o.done.some((c) => typeof c !== 'string' || !CHUNK_ID.test(c)) ? 'done' : null));
export const validateMoveGo = (a: unknown) => v1<MoveGoArgs>(a, ['moveId', 'plan', 'targetPublicKey', 'expectedLeaf'], (o) =>
  moveId(o) ?? planProblem(o.plan) ?? (typeof o.targetPublicKey !== 'string' || !X25519_SPKI.test(o.targetPublicKey) ? 'targetPublicKey' : typeof o.expectedLeaf !== 'string' || !FINGERPRINT.test(o.expectedLeaf) ? 'expectedLeaf' : null));
// The pre-approval bounds of move.begin: a closed object or null.
export const boundsProblem = (b: unknown): string | null => {
  if (b === null) return null;
  if (!closed(b, ['transfer', 'kinds', 'space', 'maxBudgetS']) || !bool(b.transfer)) return 'bounds';
  if (!Array.isArray(b.kinds) || b.kinds.length > MOVE_KINDS.length || new Set(b.kinds).size !== b.kinds.length || b.kinds.some((k) => !(MOVE_KINDS as readonly unknown[]).includes(k))) return 'bounds';
  if (typeof b.space !== 'string' || !SPACE_PLANS.includes(b.space)) return 'bounds';
  return Number.isSafeInteger(b.maxBudgetS) && (b.maxBudgetS as number) >= 60 && (b.maxBudgetS as number) <= 604800 ? null : 'bounds';
};
export const validateMoveBegin = (a: unknown) => v1<MoveBeginArgs>(a, ['camera', 'target', 'bounds'], (o) =>
  !idLike(o.camera) ? 'camera' : typeof o.target !== 'string' || !PRX_ID.test(o.target) ? 'target' : o.bounds === undefined ? 'bounds' : boundsProblem(o.bounds));
export const validateMoveSummary = (a: unknown) => v1<MoveSummaryArgs>(a, ['camera'], (o) => (idLike(o.camera) ? null : 'camera'));
export const validateMoveRelease = (a: unknown) => v1<MoveReleaseArgs>(a, ['moveId'], moveId);
export const validateMoveFinish = (a: unknown) => v1<MoveFinishArgs>(a, ['moveId', 'role', 'abandoned', 'return'], (o) => moveId(o) ?? role(o) ?? (bool(o.abandoned) ? (optional(o, 'return', bool) ? null : 'return') : 'abandoned'));
// copied is required only for the target (a source cancel carries expectedLeaf instead, optional).
export const validateMoveCancel = (a: unknown) => v1<MoveCancelArgs>(a, ['moveId', 'role', 'copied', 'expectedLeaf'], (o) =>
  moveId(o) ?? role(o) ?? (o.role === 'target' && o.copied === undefined ? 'copied' : !optional(o, 'copied', oneOf('delete', 'age-out')) ? 'copied' : !optional(o, 'expectedLeaf', (x) => typeof x === 'string' && FINGERPRINT.test(x)) ? 'expectedLeaf' : null));
export const ARGS_VALIDATORS: Record<string, (a: unknown) => ArgsVerdict<unknown>> = {
  'tokens.apply': validateTokensApply,
  'config.get': validateConfigGet,
  'config.set': validateConfigSet,
  'config.unset': validateConfigUnset,
  'config.rollback': validateConfigRollback,
  'camera.action': validateCameraAction,
  'camera.name.set': validateCameraName,
  'proxy.restart': validateProxyRestart,
  'move.targets': validateMoveTargets,
  'move.open': validateMoveOpen,
  'move.return.open': validateMoveReturnOpen,
  'move.return.start': validateMoveReturnStart,
  'move.offer': validateMoveOffer,
  'move.answer': validateMoveAnswer,
  'move.start': validateMoveStart,
  'move.go': validateMoveGo,
  'move.release': validateMoveRelease,
  'move.finish': validateMoveFinish,
  'move.cancel': validateMoveCancel,
  'move.begin': validateMoveBegin,
  'move.summary': validateMoveSummary,
};
