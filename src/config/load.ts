import { createHash, randomBytes } from 'crypto';
import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { cameraDefaults, DEFAULTS, type Config, type Secrets } from './defaults';
import { checkPartial, leafAt, leafPaths, SETTINGS, SettingError } from './schema';
import { cameraConfig } from './cameras';
import { derivedPassive, ftpOn, MAX_FTP_CAMERAS, PASSIVE_MAX, PORTS_PER_CAMERA } from './profile';
import { normalizeFile, normalizeOverrides, translatePath } from './legacy';
import { ipv4Int } from '../util/cidr';
import { loadSecrets } from './secrets';
import { EnvSettingError, readEnvLayer, type EnvLayer } from './env';
import { adminUrlProblem } from '../fleet/protocol';
import { jcs } from '../fleet/jcs';
import { validateAllowList } from '../fleet/policy';

export { ConfigError } from './load-error';
import { ConfigError } from './load-error';
export type Source = 'default' | 'file' | 'override' | 'env';

export interface Loaded {
  config: Config;
  secrets: Secrets;
  sources: Record<string, Source>;
  files: { config?: string; overrides: string };
  env: NodeJS.ProcessEnv;
  fileSettings: object;
  overrides: object;
  // Settings set in a lower layer that a higher one replaces, with why (the
  // Settings page and GET /control/profile show it): profile.storageGB or
  // storage.maxBytes (budgetLayers).
  ignored: Record<string, string>;
  // Settings set from the environment (spec 2026-10-04-pi-config-design):
  // the variable that set each path, and the .env file if one is configured.
  envLayer: EnvLayer;
  envNames: Record<string, string>;
  envFile?: { path: string; read: boolean };
  // The cameras in config order, and whether config.json had a legacy `camera` (spec 2026-10-05-multi-camera-host-design §4.2).
  order: string[]; // config.json's camera ids
  addedCameras: string[]; // cameras added in overrides.json (Ruling P2-5), sorted; config order is order + these
  legacyCamera: boolean;
  // camsAdmin.allowCommands / commandsPaused from config.json (Ruling R2-1).
  commandPolicyBase: CommandPolicyBase;
  // CAMPROXY_TOKENS may be unset (the start then needs a live managed client token).
  tokensOptional: boolean;
}

// Every setting path of this configuration: the cameras' paths under their ids.
export const settingPaths = (c: Config): string[] => leafPaths(SETTINGS, '', c.cameraOrder);

// Settings that only take effect after a restart (spec §14).
const RESTART = ['server.port', 'server.dataDir', 'cameras.', 'go2rtc.', 'events.onvif.', 'stills.enabled', 'stills.stream', 'stills.intervalS', 'stills.size', 'stills.quality', 'previews.tileSize', 'previews.grid', 'previews.quality', 'ftp.enabled', 'ftp.port', 'ftp.passive', 'ftp.tls', 'ftp.publicHost', 'ftp.certFile', 'ftp.keyFile', 'composition.font', 'server.trustProxy'];
// Read once when the process starts: the in-process restart leaves them
// pending until a new process.
const PROCESS = ['server.port', 'server.dataDir', 'server.trustProxy', 'composition.font', 'server.tls.port', 'tls.site', 'tls.cameraCerts', 'tls.cameraSubnet', 'tls.proxyAddresses'];
export function needsProcessRestart(path: string): boolean {
  return PROCESS.includes(path);
}
// Live although under a restart prefix: the PoE switch is read on every use,
// the Baichuan port at the next connection, analytics kinds on every event.
const LIVE = [/^poeSwitch\./, /^cameras\.[^.]+\.poeSwitch\./, /^cameras\.[^.]+\.baichuanPort$/, /^cameras\.[^.]+\.analytics\./];
export function needsRestart(path: string): boolean {
  if (LIVE.some((re) => re.test(path))) return false;
  return RESTART.some((r) => (r.endsWith('.') ? path.startsWith(r) : path === r));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function merge(base: Obj, over: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isObj(v) && isObj(base[k]) ? merge(base[k] as Obj, v) : v;
  }
  return out;
}

// The value at a dotted settings path ('ftp.port'), or undefined.
export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), obj);
}

// Sets (or, for undefined, deletes) the value at a dotted settings path.
export function setPath(o: Record<string, unknown>, path: string, v: unknown): void {
  const keys = path.split('.');
  let x = o;
  for (const k of keys.slice(0, -1)) x = (x[k] ??= {}) as Record<string, unknown>;
  if (v === undefined) delete x[keys[keys.length - 1]];
  else x[keys[keys.length - 1]] = v;
}

function readJson(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`${basename(file)}: cannot read the file`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfigError(`${basename(file)}: not valid JSON`);
  }
}

function asConfigError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof SettingError) throw new ConfigError(e.message);
    throw e;
  }
}

function crossCheck(c: Config): void {
  const [cols, rows] = c.previews.grid.split('x').map(Number);
  for (const id of c.cameraOrder) {
    const iv = cameraConfig(c, id)!.stills.intervalS;
    if (cols * rows < 60 / iv) throw new ConfigError(`previews.grid: ${c.previews.grid} holds fewer than the ${60 / iv} tiles of a minute${c.cameraOrder.length > 1 ? ` (camera ${id})` : ''}`);
  }
  // Shares of the storage budget (spec §8.1): together at most 100 %.
  const shared = c.cameraOrder.flatMap((id) => (c.cameras[id].storage?.sharePercent !== undefined ? [[id, c.cameras[id].storage.sharePercent!] as const] : []));
  const sum = shared.reduce((n, [, p]) => n + p, 0);
  if (sum > 100) throw new ConfigError(`cameras: storage.sharePercent adds up to ${sum} % (${shared.map(([id, p]) => `${id} ${p}`).join(', ')}); at most 100`);
  const unshared = c.cameraOrder.filter((id) => c.cameras[id].storage?.sharePercent === undefined);
  if (shared.length && sum === 100 && unshared.length) throw new ConfigError(`cameras: storage.sharePercent adds up to 100 % (${shared.map(([id, p]) => `${id} ${p}`).join(', ')}); ${unshared.join(', ')} ${unshared.length === 1 ? 'has' : 'have'} no share and would get nothing: give it one, or lower the others`);
  const [a, b] = c.ftp.passive.split('-').map(Number);
  if (a > 65535 || b > 65535 || a > b || b - a + 1 > PASSIVE_MAX) throw new ConfigError(`ftp.passive: must be A-B with A <= B, at most ${PASSIVE_MAX} ports`);
  // One FTP server for every camera (spec 2026-10-05-multi-camera-host-design §7):
  // a user each, and at least 10 passive ports per camera (one camera keeps today's rules).
  const ftpCams = c.cameraOrder.filter((id) => cameraConfig(c, id)!.ftp.enabled);
  const seen = new Map<string, string>();
  for (const id of ftpCams) {
    const user = cameraConfig(c, id)!.ftp.user;
    if (seen.has(user)) throw new ConfigError(`cameras: ${seen.get(user)} and ${id} both use the FTP user ${user}`);
    seen.set(user, id);
  }
  if (ftpCams.length > 1 && b - a + 1 < 10 * ftpCams.length) throw new ConfigError(`ftp.passive: ${b - a + 1} ports for ${ftpCams.length} cameras with FTP; at least 10 per camera`);
  // The profile (cams-admin spec 2026-10-25-proxy-profile-design §1): with
  // FTP on, at most 64 cameras (640 ports). A range smaller than the profile
  // needs is a warning (profileWarnings), never a load error.
  checkProfileCameras(c);
  if (c.storage.maxPercent !== undefined && c.storage.maxBytes !== undefined) {
    throw new ConfigError('storage.maxBytes: set either storage.maxPercent or storage.maxBytes, not both');
  }
  if (!c.go2rtc.binary && !c.go2rtc.url) throw new ConfigError('go2rtc.binary: set go2rtc.binary or go2rtc.url');
  // The site CA (spec 2026-10-05-multi-camera-host-design §10.1.1, Ruling P5-2):
  // the addresses its name constraints permit.
  if (c.tls.site) {
    if (!c.tls.cameraSubnet) throw new ConfigError('tls.cameraSubnet: required with tls.site');
    if (!c.tls.proxyAddresses) throw new ConfigError('tls.proxyAddresses: required with tls.site');
  }
  if (c.tls.cameraSubnet) checkSubnet('tls.cameraSubnet', c.tls.cameraSubnet);
  // Camera FTP logins from this network instead of each camera's own address.
  if (c.ftp.sourceSubnet) checkSubnet('ftp.sourceSubnet', c.ftp.sourceSubnet);
  for (const a of c.tls.proxyAddresses?.split(',') ?? []) {
    if (ipv4Int(a) === null) throw new ConfigError(`tls.proxyAddresses: ${a} is not an IPv4 address`);
  }
  if (c.server.tls.port !== undefined && !c.tls.site) throw new ConfigError('server.tls.port: needs tls.site (the proxy certificate comes from the site CA)');
  if (c.server.tls.port !== undefined && c.server.tls.port === c.server.port) throw new ConfigError('server.tls.port: must differ from server.port');
  // cams-admin (spec 2026-10-06-cams-admin-phase1-design §8.9, §9.2).
  // The key file is never one of the P2 files: enrollment overwrites it and
  // unenroll deletes it (deleting policy.json would lift a local pause).
  // Case-insensitively: macOS file systems are (a dev run).
  if (['admin/tokens.json', 'admin/commands.json', 'admin/policy.json', 'admin/replay.json'].includes(c.camsAdmin.keyFile.toLowerCase())) throw new ConfigError(`camsAdmin.keyFile: ${c.camsAdmin.keyFile} is the proxy's own file; use admin/key.json`);
  if (c.camsAdmin.url !== undefined) {
    const p = /^https?:\/\//.test(c.camsAdmin.url) ? adminUrlProblem(c.camsAdmin.url) : 'must be https://';
    if (p) throw new ConfigError(`camsAdmin.url: ${p}`);
  }
}

// Where profile.storageGB and storage.maxBytes are set, and which one is
// ignored: both in config.json or both in overrides.json is an error naming
// the file; in different files the override wins.
function budgetLayers(fileSettings: Obj, overrides: Obj): { maxBytes: boolean; ignored: Record<string, string> } {
  const layer = (p: string) => (getPath(overrides, p) !== undefined ? 'overrides.json' : getPath(fileSettings, p) !== undefined ? 'config.json' : undefined);
  const gb = layer('profile.storageGB');
  const bytes = layer('storage.maxBytes');
  for (const [f, o] of [['config.json', fileSettings], ['overrides.json', overrides]] as const) {
    if (getPath(o, 'profile.storageGB') !== undefined && getPath(o, 'storage.maxBytes') !== undefined) throw new ConfigError(`profile.storageGB: ${f} sets both profile.storageGB and storage.maxBytes; keep one in ${f} (profile.storageGB is the budget, storage.maxBytes the older way to set it)`);
  }
  if (!gb || !bytes) return { maxBytes: !!bytes, ignored: {} };
  // Different files: the one in overrides.json wins.
  return gb === 'overrides.json'
    ? { maxBytes: false, ignored: { 'storage.maxBytes': 'ignored: profile.storageGB (overrides.json) is the storage budget' } }
    : { maxBytes: true, ignored: { 'profile.storageGB': 'ignored: storage.maxBytes (overrides.json) is the storage budget' } };
}

function checkProfileCameras(c: Config): void {
  const n = c.profile.cameras;
  if (n !== undefined && n > MAX_FTP_CAMERAS && ftpOn(c)) throw new ConfigError(`profile.cameras: ${n} cameras need ${PORTS_PER_CAMERA * n} FTP passive ports (${PORTS_PER_CAMERA} per camera); ftp.passive holds at most ${PASSIVE_MAX}`);
}

// camsAdmin.allowCommands and camsAdmin.commandsPaused (migration P2,
// Ruling R2-1): the command policy's deploy-time base, read from config.json
// only and taken out before the checks (not settings). overrides.json (the
// file a remote config.set writes) can never hold them; data/admin/policy.json
// (the Status card and the CLI) changes them at run time.
const POLICY_KEYS = ['allowCommands', 'commandsPaused'] as const;
export interface CommandPolicyBase { allow: string[]; paused: boolean }
function takeCommandPolicy(o: unknown, where: 'config.json' | 'overrides.json' | 'patch'): CommandPolicyBase {
  const base: CommandPolicyBase = { allow: [], paused: false };
  const ca = isObj(o) && isObj(o.camsAdmin) ? (o.camsAdmin as Obj) : undefined;
  if (!ca) return base;
  for (const k of POLICY_KEYS) {
    if (!Object.hasOwn(ca, k)) continue;
    if (where === 'patch') throw new ConfigError(`not_a_setting: camsAdmin.${k} is not a setting (the Status card or admin-commands changes it)`);
    if (where === 'overrides.json') throw new ConfigError(`camsAdmin.${k}: only in config.json or data/admin/policy.json`);
  }
  if (Object.hasOwn(ca, 'allowCommands')) base.allow = validateAllowList(ca.allowCommands, 'camsAdmin.allowCommands', true);
  if (Object.hasOwn(ca, 'commandsPaused')) {
    if (typeof ca.commandsPaused !== 'boolean') throw new ConfigError('camsAdmin.commandsPaused: must be true or false');
    base.paused = ca.commandsPaused;
  }
  for (const k of POLICY_KEYS) delete ca[k];
  if (!Object.keys(ca).length) delete (o as Obj).camsAdmin;
  return base;
}

// The overrides' revision, reported to cams-admin (migration P2): sha256 of
// their canonical JSON ({} when there are none).
export const configRevision = (l: Loaded): string => `sha256:${createHash('sha256').update(jcs(l.overrides)).digest('hex')}`;


// An IPv4 network a.b.c.d/n, /16 or narrower.
function checkSubnet(key: string, v: string): void {
  const [ip, bits] = v.split('/');
  const n = ipv4Int(ip);
  const prefix = Number(bits);
  if (n === null || prefix > 32 || (prefix < 32 && (n & (2 ** (32 - prefix) - 1)) !== 0)) throw new ConfigError(`${key}: ${v} is not an IPv4 network`);
  if (prefix < 16) throw new ConfigError(`${key}: ${v} is wider than /16`);
}

type Norm = { order: string[]; legacy: boolean; policy: CommandPolicyBase; tokensOptional: boolean };
// The camera ids overrides.json adds to config.json's, sorted.
const addedIds = (overrides: Obj, fileIds: string[]): string[] => Object.keys(isObj(overrides.cameras) ? (overrides.cameras as Obj) : {}).filter((id) => !fileIds.includes(id)).sort();
const normOf = (l: Loaded): Norm => ({ order: l.order, legacy: l.legacyCamera, policy: l.commandPolicyBase, tokensOptional: l.tokensOptional });

// passwordFromMove: see loadSecrets (validation only, never the configuration in effect).
type BuildOptions = { passwordFromMove?: readonly string[] };
function build(env: NodeJS.ProcessEnv, configFile: string | undefined, fileSettings: Obj, overrides: Obj, baseDir: string, layer: EnvLayer, norm: Norm, bo: BuildOptions = {}): Loaded {
  // A copy: the result is changed below (dataDir), DEFAULTS never is.
  let merged = merge(structuredClone(DEFAULTS) as unknown as Obj, structuredClone(fileSettings));
  // Cameras added in overrides.json follow config.json's, sorted by id (Ruling P2-5).
  const added = addedIds(overrides, norm.order);
  const order = [...norm.order, ...added];
  // Each camera: its defaults, then its config.json node (spec 2026-10-05-multi-camera-host-design §4.1).
  merged.cameras = Object.fromEntries(order.map((id) => [id, merge(cameraDefaults(id) as unknown as Obj, structuredClone(((fileSettings.cameras as Obj | undefined)?.[id] ?? {}) as Obj))]));
  // The size budget (cams-admin spec 2026-10-25-proxy-profile-design §0, ruling
  // 2026-10-25): profile.storageGB and storage.maxBytes in one file is an
  // error; in two, the higher layer (overrides.json) wins and the other is ignored.
  const budget = budgetLayers(fileSettings, overrides);
  // storage.maxBytes replaces the default maxPercent budget.
  if (budget.maxBytes) {
    merged = merge(merged, { storage: { ...(merged.storage as Obj), maxPercent: undefined } });
    delete (merged.storage as Obj).maxPercent;
  }
  // go2rtc.url replaces the default binary.
  if (getPath(fileSettings, 'go2rtc.url') !== undefined || getPath(overrides, 'go2rtc.url') !== undefined) {
    delete (merged.go2rtc as Obj).binary;
  }
  const config = merge(merged, structuredClone(overrides)) as unknown as Config;
  config.cameraOrder = order;
  for (const p of Object.keys(budget.ignored)) setPath(config as unknown as Obj, p, undefined);
  // ftp.passive unset (neither file nor override) and FTP on (any camera, as
  // crossCheck counts them): 30000 up, 10 ports per camera for
  // max(profile.cameras, cameras held) (src/config/profile.ts). FTP off: the plain default.
  if (ftpOn(config) && getPath(fileSettings, 'ftp.passive') === undefined && getPath(overrides, 'ftp.passive') === undefined) {
    checkProfileCameras(config);
    config.ftp.passive = derivedPassive(config);
  }
  // The environment last: it wins over the overrides and the file. CAMERA_HOST
  // means the one camera's address (spec §4.2).
  const envNames: Record<string, string> = {};
  if (layer.cameraHost) {
    if (norm.order.length !== 1) throw new ConfigError(`${layer.cameraHost.name}: set cameras[].host instead (several cameras)`);
    const id = norm.order[0];
    config.cameras[id].host = layer.cameraHost.value;
    envNames[`cameras.${id}.host`] = layer.cameraHost.name;
  }
  if (layer.piAddress) {
    config.ftp.publicHost = layer.piAddress.value;
    config.server.publicUrl = `http://${layer.piAddress.value}:${config.server.port}`;
    envNames['ftp.publicHost'] = layer.piAddress.name;
    envNames['server.publicUrl'] = layer.piAddress.name;
  }
  const dataDir = isAbsolute(config.server.dataDir) ? config.server.dataDir : resolve(baseDir, config.server.dataDir);
  config.server.dataDir = dataDir;
  crossCheck(config);
  const sources: Record<string, Source> = {};
  for (const p of settingPaths(config)) {
    sources[p] = envNames[p] ? 'env' : getPath(overrides, p) !== undefined ? 'override' : getPath(fileSettings, p) !== undefined ? 'file' : 'default';
  }
  const secrets = asConfigError(() => loadSecrets(env, config.cameraOrder.some((id) => cameraConfig(config, id)!.ftp.enabled), config.cameraOrder, { tokensOptional: norm.tokensOptional, dataDir, moved: config.cameraOrder.filter((id) => !!config.cameras[id]?.moved), ...(bo.passwordFromMove ? { passwordFromMove: bo.passwordFromMove } : {}) }));
  return { config, secrets, sources, ignored: budget.ignored, files: { config: configFile, overrides: join(dataDir, 'overrides.json') }, env, fileSettings, overrides, envLayer: layer, envNames, ...(layer.file ? { envFile: layer.file } : {}), order: norm.order, addedCameras: added, legacyCamera: norm.legacy, commandPolicyBase: norm.policy, tokensOptional: norm.tokensOptional };
}

// Defaults, then config.json (CAMPROXY_CONFIG or ./config.json), then
// <dataDir>/overrides.json; secrets from the environment.
export function loadConfig(env: NodeJS.ProcessEnv, opts: { cwd?: string; tokensOptional?: boolean } = {}): Loaded {
  const cwd = opts.cwd ?? process.cwd();
  const file = env.CAMPROXY_CONFIG ? resolve(cwd, env.CAMPROXY_CONFIG) : existsSync(join(cwd, 'config.json')) ? join(cwd, 'config.json') : undefined;
  // A legacy `camera` is read as a list of one (spec §4.2); nothing is rewritten.
  const norm = normalizeFile(file ? readJson(file) : {});
  const fileSettings = norm.settings;
  const policyBase = takeCommandPolicy(fileSettings, 'config.json');
  asConfigError(() => checkPartial(fileSettings));
  const baseDir = file ? dirname(file) : cwd;
  // Overrides live in the data folder, which the file (not an override) sets.
  const fileDataDir = (getPath(fileSettings, 'server.dataDir') as string | undefined) ?? DEFAULTS.server.dataDir;
  const overridesFile = join(isAbsolute(fileDataDir) ? fileDataDir : resolve(baseDir, fileDataDir), 'overrides.json');
  const overrides = normalizeOverrides(existsSync(overridesFile) ? readJson(overridesFile) : {}, norm.order);
  takeCommandPolicy(overrides, 'overrides.json');
  asConfigError(() => checkPartial(overrides));
  if (getPath(overrides, 'server.dataDir') !== undefined) throw new ConfigError('server.dataDir: can only be set in config.json');
  let layer: EnvLayer;
  try {
    layer = readEnvLayer(env);
  } catch (e) {
    if (e instanceof EnvSettingError) throw new ConfigError(e.message);
    throw e;
  }
  return build(env, file, fileSettings as Obj, overrides as Obj, baseDir, layer, { order: norm.order, legacy: norm.legacy, policy: policyBase, tokensOptional: !!opts.tokensOptional });
}

// overrides.json, atomically (mode 600).
export function writeOverridesFile(file: string, overrides: object): void {
  writeOverrides(file, overrides as Obj);
}
function writeOverrides(file: string, overrides: Obj): void {
  // Atomic and durable (review M4: P3 makes this write remote): a fresh temp
  // file (wx, mode 600), fsync, rename, fsync of the folder. A torn write
  // would keep the proxy from starting.
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${JSON.stringify(overrides, null, 2)}\n`);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  try {
    const d = openSync(dir, 'r');
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
  } catch {
    // Not every platform syncs a folder; the rename is done.
  }
}

// The leaf paths an object sets ('sse.pingS'), e.g. a PUT body.
export const leafPathsOf = (o: object): string[] => setPaths(o as Obj);
function setPaths(o: Obj, prefix = ''): string[] {
  return Object.entries(o).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    return isObj(v) ? setPaths(v, p) : [p];
  });
}

// A copy of the overrides without one path; groups left empty are dropped.
function dropPath(overrides: Obj, path: string): Obj {
  const out = structuredClone(overrides);
  const keys = path.split('.');
  let o: Obj = out;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(o[k])) return out;
    o = o[k] as Obj;
  }
  delete o[keys[keys.length - 1]];
  return pruneEmpty(out);
}

// Drops the groups left empty, in place (how the overrides tree is kept tidy:
// configRevision hashes it).
export function pruneEmpty(x: Obj): Obj {
  for (const [k, v] of Object.entries(x)) if (isObj(v)) (pruneEmpty(v), Object.keys(v).length === 0 && delete x[k]);
  return x;
}

// A copy of the overrides without one camera's node; `cameras` dropped when it is left empty.
export function withoutCamera(overrides: object, id: string): Obj {
  const out = structuredClone(overrides) as Obj;
  const cams = { ...(out.cameras as Obj) };
  delete cams[id];
  if (Object.keys(cams).length) out.cameras = cams;
  else delete out.cameras;
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// A change to overrides.json computed but not written (plan P3 Task 4): the
// configuration it makes, the overrides to write, and the (translated) leaf
// paths the request names. A dry run and a real write use the same plan.
export interface Plan { next: Loaded; overrides: Record<string, unknown>; paths: string[] }

const baseDirOf = (l: Loaded) => (l.files.config ? dirname(l.files.config) : process.cwd());

// What applyOverrides does, without writing: throws ConfigError as it does.
// A value equal to what Reset would restore (config.json's, else the
// default) is not stored: it removes the override instead (Klaus
// 2026-10-05, overrides that only repeated the default).
// `o.passwordFromMove`: camera ids whose password a camera move brings later
// (the target's offer check, its secrets step): their missing password is no
// error. Such a plan is a check only: its `next` is never put in effect.
export function planOverrides(loaded: Loaded, given: object, o: BuildOptions = {}): Plan {
  // Legacy camera.* and ftp.user paths on one camera (Ruling P1-8).
  const patch = normalizeOverrides(given, loaded.order, loaded.addedCameras);
  takeCommandPolicy(patch, 'patch');
  asConfigError(() => checkPartial(patch));
  if (getPath(patch, 'server.dataDir') !== undefined) throw new ConfigError('server.dataDir: can only be set in config.json');
  // An override of a setting the environment sets would never apply.
  for (const [p, name] of Object.entries(loaded.envNames)) {
    if (getPath(patch, p) !== undefined) throw new ConfigError(`${p}: set in .env (${name})`);
  }
  let overrides = merge(loaded.overrides as Obj, patch as Obj);
  const next = rebuildWith(loaded, overrides, o);
  // The checks ran on the whole result above; a path is dropped only when the
  // configuration without it is valid and holds the same value.
  const paths = setPaths(patch as Obj);
  for (const p of paths) {
    const without = dropPath(overrides, p);
    try {
      if (same(getPath(rebuildWith(loaded, without, o).config, p), getPath(next.config, p))) overrides = without;
    } catch {
      // Not valid without it: the override stays.
    }
  }
  const result = overrides === next.overrides ? next : rebuildWith(loaded, overrides, o);
  return { next: result, overrides, paths };
}

// Several overrides removed at once, not written: leaf paths only (a whole
// camera is removeOverride's). A path with no override is left as it is.
export function planUnset(loaded: Loaded, paths: string[]): Plan {
  const all = settingPaths(loaded.config);
  const leaves = paths.map((x) => translatePath(x, loaded.order));
  let overrides = loaded.overrides as Obj;
  for (const p of leaves) {
    if (!all.includes(p)) throw new ConfigError(`${p}: unknown setting`);
    if (getPath(overrides, p) !== undefined) overrides = dropPath(overrides, p);
  }
  return { next: rebuildWith(loaded, overrides), overrides, paths: leaves };
}

// The configuration with these overrides (validated), not written.
export function rebuildWith(loaded: Loaded, overrides: object, o: BuildOptions = {}): Loaded {
  return build(loaded.env, loaded.files.config, loaded.fileSettings as Obj, overrides as Obj, baseDirOf(loaded), loaded.envLayer, normOf(loaded), o);
}

// The configuration rebuilt without these environment variables (a camera's
// own password line removed from the env file: the store's password applies
// at once). The process environment is untouched.
export function withoutEnv(l: Loaded, names: string[]): Loaded {
  const env = { ...l.env };
  for (const n of names) delete env[n];
  return build(env, l.files.config, l.fileSettings as Obj, l.overrides as Obj, baseDirOf(l), l.envLayer, normOf(l));
}

// Adds overrides (validated like the file); nothing is written if the result
// is invalid (see planOverrides).
export function applyOverrides(loaded: Loaded, given: object): Loaded {
  const p = planOverrides(loaded, given);
  writeOverrides(loaded.files.overrides, p.overrides);
  return p.next;
}

// PUT /control/profile (cams-admin spec 2026-10-25-proxy-profile-design §0):
// the given profile fields as overrides; null removes a field's override
// (back to config.json's value or none), an absent field stays; storageGB
// replaces an override of storage.maxBytes. The result
// must have profile.cameras (a set profile has its camera count). Validated
// like any override; nothing is written if it does not load.
export const PROFILE_FIELDS = ['name', 'cameras', 'storageGB', 'firewall'] as const;
export function planProfile(loaded: Loaded, body: unknown): Plan {
  if (!isObj(body)) throw new ConfigError('the profile must be an object');
  for (const k of Object.keys(body)) if (!(PROFILE_FIELDS as readonly string[]).includes(k)) throw new ConfigError(`${k}: not a profile field (${PROFILE_FIELDS.join(', ')})`);
  const cleared = PROFILE_FIELDS.filter((k) => body[k] === null).map((k) => `profile.${k}`);
  // A storage budget set here replaces storage.maxBytes set here (one file may not hold both).
  if (body.storageGB !== null && body.storageGB !== undefined && getPath(loaded.overrides, 'storage.maxBytes') !== undefined) cleared.push('storage.maxBytes');
  const set = Object.fromEntries(PROFILE_FIELDS.filter((k) => body[k] !== null && body[k] !== undefined).map((k) => [k, body[k]]));
  const unset = planUnset(loaded, cleared);
  const plan = Object.keys(set).length ? planOverrides(unset.next, { profile: set }) : unset;
  if (plan.next.config.profile.cameras === undefined) throw new ConfigError('cameras: required (the profile is set with its camera count)');
  return { next: plan.next, overrides: plan.overrides, paths: [...cleared, ...Object.keys(set).map((k) => `profile.${k}`)] };
}
export function applyProfile(loaded: Loaded, body: unknown): Loaded {
  const p = planProfile(loaded, body);
  writeOverrides(loaded.files.overrides, p.overrides);
  return p.next;
}

// The configuration without one override, not written: what Reset goes back
// to (the Settings page shows it on the button).
export function withoutOverride(loaded: Loaded, path: string): Loaded {
  path = translatePath(path, loaded.order);
  if (!settingPaths(loaded.config).includes(path)) throw new ConfigError(`${path}: unknown setting`);
  if (getPath(loaded.overrides, path) === undefined) return loaded;
  return rebuildWith(loaded, dropPath(loaded.overrides as Obj, path));
}

// What an override's Reset goes back to (GET /control/config shows it):
// the value and where it comes from; `same` when that is the value the
// override holds (Reset would change nothing; the Settings page shows no
// Reset then); `means` for a value that leaves the setting unset, none or
// off: what that state does (the schema's `unset` text). A reset the checks
// would refuse (a combination only the override makes valid) answers the
// file's value or the default all the same.
export interface ResetTarget { value?: unknown; source: 'file' | 'default' | 'env'; same?: true; means?: string }
export function resetTarget(loaded: Loaded, path: string): ResetTarget {
  const p = translatePath(path, loaded.order);
  let value: unknown;
  let source: ResetTarget['source'];
  try {
    const after = withoutOverride(loaded, p);
    source = after.sources[p] === 'override' ? 'default' : (after.sources[p] as ResetTarget['source']);
    value = getPath(after.config, p);
  } catch {
    const file = getPath(loaded.fileSettings, p);
    source = file !== undefined ? 'file' : 'default';
    value = file !== undefined ? file : getPath(DEFAULTS, p);
  }
  const unset = leafAt(p)?.unset;
  return {
    ...(value !== undefined ? { value } : {}),
    source,
    ...(same(value, getPath(loaded.config, p)) ? { same: true as const } : unset && same(value, unset.value) ? { means: unset.text } : {}),
  };
}

export function removeOverride(loaded: Loaded, path: string): Loaded {
  // A whole camera: only one added here (Ruling P2-5); its files stay (Ruling P2-6).
  const m = /^cameras\.([^.]+)$/.exec(path);
  if (m) {
    if (!loaded.addedCameras.includes(m[1])) {
      if (loaded.order.includes(m[1])) throw new ConfigError(`cameras.${m[1]}: defined in config.json; remove it there`);
      throw new ConfigError(`cameras.${m[1]}: unknown camera`);
    }
    const overrides = withoutCamera(loaded.overrides, m[1]);
    const next = rebuildWith(loaded, overrides);
    writeOverrides(loaded.files.overrides, overrides);
    return next;
  }
  const next = withoutOverride(loaded, path);
  if (next !== loaded) writeOverrides(loaded.files.overrides, next.overrides as Obj);
  return next;
}

// Every override removed at once (the Settings page's "Reset to defaults"):
// back to config.json and the built-in defaults; the environment still wins.
// Cameras added here stay, whole: the reset is of settings, not of the camera list.
// `keep`: overrides that stay too (a cams-admin sign-in's reset keeps the
// settings only the local admin changes, issue #227).
export function removeAllOverrides(loaded: Loaded, keep?: (path: string) => boolean): Loaded {
  const p = planRemoveAll(loaded, keep);
  writeOverrides(loaded.files.overrides, p.overrides);
  return p.next;
}
// What removeAllOverrides does, without writing (a ui.config reset checks
// the result first, src/api/ui-config.ts).
export function planRemoveAll(loaded: Loaded, keep?: (path: string) => boolean): Plan {
  const cams = (loaded.overrides as Obj).cameras as Obj | undefined;
  const kept: Obj = loaded.addedCameras.length ? { cameras: Object.fromEntries(loaded.addedCameras.map((id) => [id, structuredClone(cams![id])])) } : {};
  const paths = setPaths(loaded.overrides as Obj);
  // A camera's `moved` always stays (camera moves, final review 1): it is no
  // setting but the state of a move; dropping it would start the camera here
  // while it runs on the target. Only the move itself clears it.
  for (const p of paths) if ((keep?.(p) ?? false) || /^cameras\.[^.]+\.moved$/.test(p)) setPath(kept, p, structuredClone(getPath(loaded.overrides, p)));
  return { next: rebuildWith(loaded, kept), overrides: kept, paths };
}

// The startup line `config_env`: the settings taken from the environment,
// with their values (addresses only, never a secret), and whether a .env
// file was read.
export function envSummary(loaded: Loaded): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of Object.keys(loaded.envNames)) out[p] = getPath(loaded.config, p);
  out.envFile = loaded.envFile?.read === true;
  return out;
}
