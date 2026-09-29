import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';
import { DEFAULTS, type Config, type Secrets } from './defaults';
import { checkPartial, leafPaths, SettingError } from './schema';
import { loadSecrets } from './secrets';

export class ConfigError extends Error {}
export type Source = 'default' | 'file' | 'override';

export interface Loaded {
  config: Config;
  secrets: Secrets;
  sources: Record<string, Source>;
  files: { config?: string; overrides: string };
  env: NodeJS.ProcessEnv;
  fileSettings: object;
  overrides: object;
}

// Settings that only take effect after a restart (spec §14).
const RESTART = ['server.port', 'server.dataDir', 'camera.', 'go2rtc.', 'events.onvif.', 'stills.enabled', 'stills.stream', 'stills.intervalS', 'stills.size', 'stills.quality', 'previews.tileSize', 'previews.grid', 'previews.quality', 'ftp.enabled', 'ftp.port', 'ftp.passive', 'ftp.tls', 'ftp.user', 'ftp.publicHost', 'ftp.certFile', 'ftp.keyFile', 'composition.font', 'server.trustProxy'];
export function needsRestart(path: string): boolean {
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

function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), obj);
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

function build(env: NodeJS.ProcessEnv, configFile: string | undefined, fileSettings: Obj, overrides: Obj, baseDir: string): Loaded {
  // A copy: the result is changed below (dataDir), DEFAULTS never is.
  let merged = merge(structuredClone(DEFAULTS) as unknown as Obj, structuredClone(fileSettings));
  // storage.maxBytes replaces the default maxPercent budget.
  if (get(fileSettings, 'storage.maxBytes') !== undefined || get(overrides, 'storage.maxBytes') !== undefined) {
    merged = merge(merged, { storage: { ...(merged.storage as Obj), maxPercent: undefined } });
    delete (merged.storage as Obj).maxPercent;
  }
  // go2rtc.url replaces the default binary.
  if (get(fileSettings, 'go2rtc.url') !== undefined || get(overrides, 'go2rtc.url') !== undefined) {
    delete (merged.go2rtc as Obj).binary;
  }
  const config = merge(merged, structuredClone(overrides)) as unknown as Config;
  const dataDir = isAbsolute(config.server.dataDir) ? config.server.dataDir : resolve(baseDir, config.server.dataDir);
  config.server.dataDir = dataDir;
  crossCheck(config);
  const sources: Record<string, Source> = {};
  for (const p of leafPaths()) {
    sources[p] = get(overrides, p) !== undefined ? 'override' : get(fileSettings, p) !== undefined ? 'file' : 'default';
  }
  const secrets = asConfigError(() => loadSecrets(env, config.ftp.enabled));
  return { config, secrets, sources, files: { config: configFile, overrides: join(dataDir, 'overrides.json') }, env, fileSettings, overrides };
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
  const fileDataDir = (get(fileSettings, 'server.dataDir') as string | undefined) ?? DEFAULTS.server.dataDir;
  const overridesFile = join(isAbsolute(fileDataDir) ? fileDataDir : resolve(baseDir, fileDataDir), 'overrides.json');
  const overrides = existsSync(overridesFile) ? readJson(overridesFile) : {};
  asConfigError(() => checkPartial(overrides));
  if (get(overrides, 'server.dataDir') !== undefined) throw new ConfigError('server.dataDir: can only be set in config.json');
  return build(env, file, fileSettings as Obj, overrides as Obj, baseDir);
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
  if (get(patch, 'server.dataDir') !== undefined) throw new ConfigError('server.dataDir: can only be set in config.json');
  const overrides = merge(loaded.overrides as Obj, patch as Obj);
  const baseDir = loaded.files.config ? dirname(loaded.files.config) : process.cwd();
  const next = build(loaded.env, loaded.files.config, loaded.fileSettings as Obj, overrides, baseDir);
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
  const next = build(loaded.env, loaded.files.config, loaded.fileSettings as Obj, overrides, baseDir);
  writeOverrides(loaded.files.overrides, overrides);
  return next;
}
