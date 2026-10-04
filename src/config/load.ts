import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { DEFAULTS, type Config, type Secrets } from './defaults';
import { checkPartial, leafPaths, SettingError } from './schema';
import { loadSecrets } from './secrets';
import { EnvSettingError, readEnvLayer, type EnvLayer } from './env';

export class ConfigError extends Error {}
export type Source = 'default' | 'file' | 'override' | 'env';

export interface Loaded {
  config: Config;
  secrets: Secrets;
  sources: Record<string, Source>;
  files: { config?: string; overrides: string };
  env: NodeJS.ProcessEnv;
  fileSettings: object;
  overrides: object;
  // Settings set from the environment (spec 2026-10-04-pi-config-design):
  // the variable that set each path, and the .env file if one is configured.
  envLayer: EnvLayer;
  envNames: Record<string, string>;
  envFile?: { path: string; read: boolean };
}

// Settings that only take effect after a restart (spec §14).
const RESTART = ['server.port', 'server.dataDir', 'camera.', 'go2rtc.', 'events.onvif.', 'stills.enabled', 'stills.stream', 'stills.intervalS', 'stills.size', 'stills.quality', 'previews.tileSize', 'previews.grid', 'previews.quality', 'ftp.enabled', 'ftp.port', 'ftp.passive', 'ftp.tls', 'ftp.user', 'ftp.publicHost', 'ftp.certFile', 'ftp.keyFile', 'composition.font', 'server.trustProxy'];
// Read once when the process starts: the in-process restart leaves them
// pending until a new process.
const PROCESS = ['server.port', 'server.dataDir', 'server.trustProxy', 'composition.font'];
export function needsProcessRestart(path: string): boolean {
  return PROCESS.includes(path);
}
// Live although under a restart prefix: the PoE switch is read on every use;
// the Baichuan port at the next connection.
const LIVE = ['camera.poeSwitch.', 'camera.baichuanPort'];
export function needsRestart(path: string): boolean {
  if (LIVE.some((l) => (l.endsWith('.') ? path.startsWith(l) : path === l))) return false;
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
  if (!c.camera.host) throw new ConfigError('camera.host: required');
  const [cols, rows] = c.previews.grid.split('x').map(Number);
  if (cols * rows < 60 / c.stills.intervalS) throw new ConfigError(`previews.grid: ${c.previews.grid} holds fewer than the ${60 / c.stills.intervalS} tiles of a minute`);
  const [a, b] = c.ftp.passive.split('-').map(Number);
  if (a > 65535 || b > 65535 || a > b || b - a > 100) throw new ConfigError('ftp.passive: must be A-B with A <= B, at most 100 ports');
  if (c.storage.maxPercent !== undefined && c.storage.maxBytes !== undefined) {
    throw new ConfigError('storage.maxBytes: set either storage.maxPercent or storage.maxBytes, not both');
  }
  if (!c.go2rtc.binary && !c.go2rtc.url) throw new ConfigError('go2rtc.binary: set go2rtc.binary or go2rtc.url');
}

function build(env: NodeJS.ProcessEnv, configFile: string | undefined, fileSettings: Obj, overrides: Obj, baseDir: string, layer: EnvLayer): Loaded {
  // A copy: the result is changed below (dataDir), DEFAULTS never is.
  let merged = merge(structuredClone(DEFAULTS) as unknown as Obj, structuredClone(fileSettings));
  // storage.maxBytes replaces the default maxPercent budget.
  if (getPath(fileSettings, 'storage.maxBytes') !== undefined || getPath(overrides, 'storage.maxBytes') !== undefined) {
    merged = merge(merged, { storage: { ...(merged.storage as Obj), maxPercent: undefined } });
    delete (merged.storage as Obj).maxPercent;
  }
  // go2rtc.url replaces the default binary.
  if (getPath(fileSettings, 'go2rtc.url') !== undefined || getPath(overrides, 'go2rtc.url') !== undefined) {
    delete (merged.go2rtc as Obj).binary;
  }
  const config = merge(merged, structuredClone(overrides)) as unknown as Config;
  // The environment last: it wins over the overrides and the file.
  const envNames: Record<string, string> = {};
  if (layer.cameraHost) {
    config.camera.host = layer.cameraHost.value;
    envNames['camera.host'] = layer.cameraHost.name;
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
  for (const p of leafPaths()) {
    sources[p] = envNames[p] ? 'env' : getPath(overrides, p) !== undefined ? 'override' : getPath(fileSettings, p) !== undefined ? 'file' : 'default';
  }
  const secrets = asConfigError(() => loadSecrets(env, config.ftp.enabled));
  return { config, secrets, sources, files: { config: configFile, overrides: join(dataDir, 'overrides.json') }, env, fileSettings, overrides, envLayer: layer, envNames, ...(layer.file ? { envFile: layer.file } : {}) };
}

// Defaults, then config.json (CAMPROXY_CONFIG or ./config.json), then
// <dataDir>/overrides.json; secrets from the environment.
export function loadConfig(env: NodeJS.ProcessEnv, opts: { cwd?: string } = {}): Loaded {
  const cwd = opts.cwd ?? process.cwd();
  const file = env.CAMPROXY_CONFIG ? resolve(cwd, env.CAMPROXY_CONFIG) : existsSync(join(cwd, 'config.json')) ? join(cwd, 'config.json') : undefined;
  const fileSettings = file ? readJson(file) : {};
  asConfigError(() => checkPartial(fileSettings));
  const baseDir = file ? dirname(file) : cwd;
  // Overrides live in the data folder, which the file (not an override) sets.
  const fileDataDir = (getPath(fileSettings, 'server.dataDir') as string | undefined) ?? DEFAULTS.server.dataDir;
  const overridesFile = join(isAbsolute(fileDataDir) ? fileDataDir : resolve(baseDir, fileDataDir), 'overrides.json');
  const overrides = existsSync(overridesFile) ? readJson(overridesFile) : {};
  asConfigError(() => checkPartial(overrides));
  if (getPath(overrides, 'server.dataDir') !== undefined) throw new ConfigError('server.dataDir: can only be set in config.json');
  let layer: EnvLayer;
  try {
    layer = readEnvLayer(env);
  } catch (e) {
    if (e instanceof EnvSettingError) throw new ConfigError(e.message);
    throw e;
  }
  return build(env, file, fileSettings as Obj, overrides as Obj, baseDir, layer);
}

function writeOverrides(file: string, overrides: Obj): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(overrides, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// Adds overrides (validated like the file); nothing is written if the result
// is invalid.
export function applyOverrides(loaded: Loaded, patch: object): Loaded {
  asConfigError(() => checkPartial(patch));
  if (getPath(patch, 'server.dataDir') !== undefined) throw new ConfigError('server.dataDir: can only be set in config.json');
  // An override of a setting the environment sets would never apply.
  for (const [p, name] of Object.entries(loaded.envNames)) {
    if (getPath(patch, p) !== undefined) throw new ConfigError(`${p}: set in .env (${name})`);
  }
  const overrides = merge(loaded.overrides as Obj, patch as Obj);
  const baseDir = loaded.files.config ? dirname(loaded.files.config) : process.cwd();
  const next = build(loaded.env, loaded.files.config, loaded.fileSettings as Obj, overrides, baseDir, loaded.envLayer);
  writeOverrides(loaded.files.overrides, overrides);
  return next;
}

export function removeOverride(loaded: Loaded, path: string): Loaded {
  if (!leafPaths().includes(path)) throw new ConfigError(`${path}: unknown setting`);
  const overrides = structuredClone(loaded.overrides) as Obj;
  const keys = path.split('.');
  let o: Obj = overrides;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(o[k])) return loaded;
    o = o[k] as Obj;
  }
  delete o[keys[keys.length - 1]];
  // Drop groups left empty.
  const prune = (x: Obj) => {
    for (const [k, v] of Object.entries(x)) if (isObj(v)) (prune(v), Object.keys(v).length === 0 && delete x[k]);
  };
  prune(overrides);
  const baseDir = loaded.files.config ? dirname(loaded.files.config) : process.cwd();
  const next = build(loaded.env, loaded.files.config, loaded.fileSettings as Obj, overrides, baseDir, loaded.envLayer);
  writeOverrides(loaded.files.overrides, overrides);
  return next;
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
