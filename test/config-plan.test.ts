import { beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { applyOverrides, ConfigError, getPath, loadConfig, planOverrides, planUnset } from '../src/config/load';
import { configChanges, overrideState } from '../src/config/changes';
import { DEFAULTS } from '../src/config/defaults';

// Planning overrides without writing (plan P3 Task 4): a dry run and a real
// write compute the same change.
const SECRETS = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'cam-pw' };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-plan-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ camera: { host: '192.0.2.10' } }));
});
const load = () => loadConfig(SECRETS, { cwd: dir });
const overridesText = (l: ReturnType<typeof load>) => {
  try {
    return readFileSync(l.files.overrides, 'utf8');
  } catch {
    return null;
  }
};

describe('planOverrides / planUnset', () => {
  it('planOverrides writes nothing and equals what applyOverrides then writes', () => {
    const l = load();
    const before = overridesText(l);
    const p = planOverrides(l, { sse: { pingS: 7 } });
    expect(overridesText(l)).toBe(before);
    expect(p.paths).toEqual(['sse.pingS']);
    const written = applyOverrides(l, { sse: { pingS: 7 } });
    expect(written.overrides).toEqual(p.overrides);
    expect(getPath(written.config, 'sse.pingS')).toBe(7);
    expect(getPath(p.next.config, 'sse.pingS')).toBe(7);
  });
  it('M4: overrides.json is written through a fresh temp file (a leftover tmp of the same pid is no obstacle), mode 600', () => {
    const l = load();
    mkdirSync(`${l.files.overrides}.tmp-${process.pid}`, { recursive: true });
    const n = applyOverrides(l, { sse: { pingS: 7 } });
    expect(JSON.parse(readFileSync(n.files.overrides, 'utf8'))).toEqual({ sse: { pingS: 7 } });
    expect(statSync(n.files.overrides).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(n.files.overrides)).filter((f) => f.startsWith('overrides.json.tmp') && f !== `overrides.json.tmp-${process.pid}`)).toEqual([]);
  });
  it('a value equal to Reset drops the override in the plan too', () => {
    const l = applyOverrides(load(), { sse: { pingS: 7 } });
    const p = planOverrides(l, { sse: { pingS: DEFAULTS.sse.pingS } });
    expect(getPath(p.overrides, 'sse.pingS')).toBeUndefined();
  });
  it('planOverrides throws ConfigError as applyOverrides does, writing nothing', () => {
    const l = load();
    expect(() => planOverrides(l, { sse: { pingS: -1 } })).toThrow(ConfigError);
    expect(overridesText(l)).toBeNull();
  });
  it('planUnset: several paths at once, nothing written; an unknown path throws', () => {
    const l = applyOverrides(load(), { sse: { pingS: 7, maxClients: 9 } });
    const before = overridesText(l);
    const p = planUnset(l, ['sse.pingS', 'sse.maxClients']);
    expect(p.overrides).toEqual({});
    expect(p.paths).toEqual(['sse.pingS', 'sse.maxClients']);
    expect(overridesText(l)).toBe(before);
    expect(getPath(p.next.config, 'sse.pingS')).toBe(DEFAULTS.sse.pingS);
    expect(() => planUnset(l, ['nosuch'])).toThrow(ConfigError);
    expect(() => planUnset(l, ['cameras.cam1'])).toThrow(ConfigError);
  });
  it('legacy paths are translated before paths are listed', () => {
    const p = planOverrides(load(), { camera: { statusPollS: 30 } });
    expect(p.paths).toEqual(['cameras.cam1.statusPollS']);
  });
});

describe('configChanges / overrideState', () => {
  it('configChanges: from, to, sources and restart flags', () => {
    const l = load();
    const n = planOverrides(l, { sse: { pingS: 7 }, stills: { quality: 6 } }).next;
    expect(configChanges(l, n)).toEqual([
      { path: 'sse.pingS', from: DEFAULTS.sse.pingS, to: 7, sourceFrom: 'default', sourceTo: 'override' },
      { path: 'stills.quality', from: DEFAULTS.stills.quality, to: 6, sourceFrom: 'default', sourceTo: 'override', restart: 'restart' },
    ]);
  });
  it('overrideState: set with its value, or not set', () => {
    expect(overrideState({ sse: { pingS: 7 } }, 'sse.pingS')).toEqual({ set: true, value: 7 });
    expect(overrideState({ sse: { pingS: 7 } }, 'sse.maxClients')).toEqual({ set: false });
    expect(overrideState({}, 'sse.pingS')).toEqual({ set: false });
  });
});
