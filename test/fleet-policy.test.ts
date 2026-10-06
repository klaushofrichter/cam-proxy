import { mkdtempSync, statSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ALLOW_ENTRIES, CommandPolicy, DENIED_PATH_PREFIXES, isDeniedPath, NEVER_REMOTE_ACTIONS, validateAllowList, WideningRefused } from '../src/fleet/policy';
import { readEnvLayer } from '../src/config/env';
import { settingPaths } from '../src/config/load';
import { DEFAULTS } from '../src/config/defaults';

const dir = () => mkdtempSync(join(tmpdir(), 'policy-'));
const quiet = { info() {}, warn() {}, debug() {} };
const make = (d: string, base = { allow: [] as string[], paused: false }, env: NodeJS.ProcessEnv = {}) =>
  new CommandPolicy({ base: () => base, file: join(d, 'admin', 'policy.json'), env: () => readEnvLayer(env), log: quiet });

describe('the closed lists', () => {
  it('allow entries: known names only; never-remote actions and unknown names are refused', () => {
    expect(validateAllowList(['tokens.apply', 'camera.action:camera-reboot'], 'x')).toEqual(['tokens.apply', 'camera.action:camera-reboot']);
    for (const bad of [['frobnicate'], ['camera.action:find-camera'], ['camera.action:camera-trust-clear'], 'tokens.apply', [1], Array(33).fill('tokens.apply')]) expect(() => validateAllowList(bad, 'x'), JSON.stringify(bad)).toThrow();
    for (const a of NEVER_REMOTE_ACTIONS) expect(ALLOW_ENTRIES).not.toContain(`camera.action:${a}`);
  });
  it('the deny list covers camsAdmin.*, every address, port, file path and trust setting (M5)', () => {
    for (const p of ['camsAdmin.url', 'camsAdmin.keyFile', 'server.port', 'tls.site', 'go2rtc.url', 'ftp.port', 'ftp.certFile', 'ntp.server', 'poeSwitch.host', 'composition.font', 'cameras.cam1.host', 'cameras.cam1.user', 'cameras.cam1.tlsName', 'cameras.cam1.poeSwitch.port']) expect(isDeniedPath(p), p).toBe(true);
    for (const p of ['stills.intervalS', 'retention.days', 'cameras.cam1.name']) expect(isDeniedPath(p), p).toBe(false);
    // Every real setting under a denied prefix is denied (no prefix typo hides one).
    for (const p of settingPaths(DEFAULTS)) if (DENIED_PATH_PREFIXES.some((x) => p === x || p.startsWith(`${x}.`))) expect(isDeniedPath(p), p).toBe(true);
  });
});

describe('CommandPolicy', () => {
  it('defaults: enabled, not paused, nothing allowed; no file written by reading', () => {
    const d = dir();
    expect(make(d).effective()).toEqual({ enabled: true, paused: false, pauseReason: null, allow: [], envName: null });
    expect(() => statSync(join(d, 'admin'))).toThrow();
  });
  it('policy.json wins over config.json for allow; paused if either says so', () => {
    const d = dir();
    const p = make(d, { allow: ['tokens.apply'], paused: true });
    expect(p.effective()).toMatchObject({ allow: ['tokens.apply'], paused: true });
    p.setAllow(['tokens.apply', 'tokens.apply.admin'], 'local');
    expect(p.effective().allow).toEqual(['tokens.apply', 'tokens.apply.admin']);
    expect(statSync(join(d, 'admin', 'policy.json')).mode & 0o777).toBe(0o600);
  });
  it('managed rights only narrow (R2-3)', () => {
    const p = make(dir());
    p.setAllow(['tokens.apply', 'tokens.apply.admin'], 'local');
    expect(() => p.setAllow(['tokens.apply', 'tokens.apply.admin', 'config.get'], 'managed')).toThrow(WideningRefused);
    p.setAllow(['tokens.apply'], 'managed');
    p.pause('incident', 'managed');
    expect(p.effective()).toMatchObject({ paused: true, pauseReason: 'incident', allow: ['tokens.apply'] });
    expect(() => p.resume('managed' as 'local')).toThrow(WideningRefused);
  });
  it('the env kill switch fails closed and beats every file (R2-5)', () => {
    for (const [env, enabled] of [[{}, true], [{ CAMPROXY_ADMIN_COMMANDS: 'on' }, true], [{ CAMPROXY_ADMIN_COMMANDS: 'off' }, false], [{ CAMPROXY_ADMIN_COMMANDS: 'OFF ' }, false], [{ CAMPROXY_ADMIN_COMMANDS: 'yes' }, false], [{ CAMPROXY_ADMIN_COMMANDS: '' }, false]] as const) {
      expect(make(dir(), { allow: ['tokens.apply'], paused: false }, env as NodeJS.ProcessEnv).effective().enabled, JSON.stringify(env)).toBe(enabled);
    }
    const d = dir();
    const envFile = join(d, '.env');
    writeFileSync(envFile, 'CAMPROXY_ADMIN_COMMANDS=off\n', { mode: 0o600 });
    expect(make(d, { allow: [], paused: false }, { CAMPROXY_ENV_FILE: envFile, CAMPROXY_ADMIN_COMMANDS: 'on' }).effective().enabled).toBe(false);
  });
  it('a policy.json readable by others is not used: paused, with the reason', () => {
    const d = dir();
    const p = make(d);
    p.setAllow(['tokens.apply'], 'local');
    chmodSync(join(d, 'admin', 'policy.json'), 0o644);
    expect(p.effective()).toMatchObject({ paused: true, allow: [], pauseReason: expect.stringMatching(/policy\.json.*others/) });
  });
});
