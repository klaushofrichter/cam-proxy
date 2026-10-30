import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ALLOW_ENTRIES, CommandPolicy, DEFAULT_ON, DISRUPTIVE_ENTRIES, ENTRY_TEXT, IMPLEMENTED, NEVER_REMOTE_ACTIONS, UI_ENTRIES, validateAllowList, WideningRefused } from '../src/fleet/policy';
import { readEnvLayer } from '../src/config/env';
import { privateFileHooks, writePrivateJson } from '../src/fleet/private-file';
import { settingPaths } from '../src/config/load';
import { DEFAULTS } from '../src/config/defaults';
import { classify, DENIED } from '../src/fleet/remote-settable';

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
    const ids = ['cam1'];
    for (const p of ['camsAdmin.url', 'camsAdmin.keyFile', 'server.port', 'tls.site', 'go2rtc.url', 'ftp.port', 'ftp.certFile', 'ntp.server', 'poeSwitch.host', 'composition.font', 'cameras.cam1.host', 'cameras.cam1.user', 'cameras.cam1.tlsName', 'cameras.cam1.poeSwitch.port']) expect(classify(p, ids), p).toBe('denied');
    for (const p of ['stills.intervalS', 'retention.stillsDays', 'cameras.cam1.name']) expect(classify(p, ids), p).toBe('remote');
    // Every real setting under a denied prefix is denied (no prefix typo hides one).
    for (const p of settingPaths(DEFAULTS)) if (DENIED.some((x) => p === x || p.startsWith(`${x}.`))) expect(classify(p, ids), p).toBe('denied');
  });
});

describe('entry texts', () => {
  it('every allow entry has a sentence for the card; entries not in this version say so', () => {
    for (const e of ALLOW_ENTRIES) {
      expect(ENTRY_TEXT[e], e).toMatch(/\w{3,}/);
      // The ui.* entries (#227) are no command: they unlock the admin UI for a cams-admin sign-in.
      if (!IMPLEMENTED.has(e) && !(UI_ENTRIES as readonly string[]).includes(e)) expect(ENTRY_TEXT[e], e).toMatch(/not in this version/);
    }
  });
});

describe('CommandPolicy', () => {
  it('defaults: enabled, not paused, only the default-on read allowed; no file written by reading', () => {
    const d = dir();
    expect(make(d).effective()).toEqual({ enabled: true, paused: false, pauseReason: null, allow: ['camera.onboarding.get'], unconfirmed: [], envName: null });
    expect(() => statSync(join(d, 'admin'))).toThrow();
  });
  it('policy.json wins over config.json for allow; paused if either says so', () => {
    const d = dir();
    const p = make(d, { allow: ['tokens.apply'], paused: true });
    expect(p.effective()).toMatchObject({ allow: ['tokens.apply', 'camera.onboarding.get'], paused: true });
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
  it("another user's policy.json is not used: paused, with the reason", () => {
    const d = dir();
    const p = make(d);
    p.setAllow(['tokens.apply'], 'local');
    privateFileHooks.fstat = () => ({ mode: 0o100644, uid: (process.getuid?.() ?? 0) + 1 });
    try {
      expect(p.effective()).toMatchObject({ paused: true, allow: [], pauseReason: expect.stringMatching(/policy\.json.*another user/) });
    } finally {
      delete privateFileHooks.fstat;
    }
    expect(p.effective()).toMatchObject({ paused: false, allow: ['tokens.apply'] });
  });
  it('our policy.json with 660 (the cluster volume under fsGroup): tightened to 600 and used', () => {
    const d = dir();
    const p = make(d);
    p.setAllow(['tokens.apply'], 'local');
    chmodSync(join(d, 'admin', 'policy.json'), 0o660);
    expect(p.effective()).toMatchObject({ paused: false, allow: ['tokens.apply'] });
    expect(statSync(join(d, 'admin', 'policy.json')).mode & 0o777).toBe(0o600);
  });
  it('I3: entries a P2 version stored for commands it did not run need fresh local consent; tokens.apply stays', () => {
    const d = dir();
    writePrivateJson(join(d, 'admin', 'policy.json'), { v: 1, allow: ['tokens.apply', 'config.set', 'camera.action:camera-reboot'], changedAt: 1, changedBy: 'local' });
    const p = make(d);
    expect(p.effective()).toMatchObject({ allow: ['tokens.apply', 'camera.onboarding.get'], unconfirmed: ['config.set', 'camera.action:camera-reboot'] });
    // config.json's base the same way (a P2 deployment may list them).
    expect(make(dir(), { allow: ['tokens.apply.admin', 'proxy.restart'], paused: false }).effective()).toMatchObject({ allow: ['tokens.apply.admin', 'camera.onboarding.get'], unconfirmed: ['proxy.restart'] });
    // A managed admin can't confirm (that widens); the local admin can.
    expect(() => p.setAllow(['tokens.apply', 'config.set'], 'managed')).toThrow(WideningRefused);
    p.setAllow(['tokens.apply', 'config.set'], 'local');
    // Not listed: the default-on read is switched off.
    expect(p.effective()).toMatchObject({ allow: ['tokens.apply', 'config.set'], unconfirmed: [] });
    expect(make(d).effective()).toMatchObject({ allow: ['tokens.apply', 'config.set'], unconfirmed: [] });
    // A pause keeps the consent.
    p.pause('x', 'managed');
    expect(p.effective()).toMatchObject({ allow: ['tokens.apply', 'config.set'], paused: true });
  });
  it('M5: a stored camera.action:camera-ftp-off (allowed before) is dropped, never makes the file unusable', () => {
    const d = dir();
    writePrivateJson(join(d, 'admin', 'policy.json'), { v: 1, allow: ['tokens.apply', 'camera.action:camera-ftp-off'], changedAt: 1, changedBy: 'local' });
    expect(make(d).effective()).toMatchObject({ paused: false, allow: ['tokens.apply', 'camera.onboarding.get'], unconfirmed: [] });
    expect(validateAllowList(['tokens.apply', 'camera.action:camera-ftp-off'], 'x', true)).toEqual(['tokens.apply']);
    expect(() => validateAllowList(['camera.action:camera-ftp-off'], 'x')).toThrow();
  });
});


describe('the onboarding entries (spec 2026-10-30-camera-onboarding-design §4.6)', () => {
  it('camera.onboarding.get is allowed by default and can be switched off locally; managed rights only narrow', () => {
    const d = dir();
    const p = make(d);
    expect(DEFAULT_ON).toEqual(['camera.onboarding.get']);
    expect(p.effective().allow).toContain('camera.onboarding.get');
    expect(IMPLEMENTED.has('camera.onboarding.get')).toBe(true);
    expect(ENTRY_TEXT['camera.onboarding.get']).toBe("cams-admin may read each camera's onboarding status (no secrets)");
    p.setAllow([], 'managed');
    expect(p.effective().allow).not.toContain('camera.onboarding.get');
    expect((JSON.parse(readFileSync(join(d, 'admin', 'policy.json'), 'utf8')) as { off: string[] }).off).toEqual(['camera.onboarding.get']);
    expect(() => p.setAllow(['camera.onboarding.get'], 'managed')).toThrow(WideningRefused);
    p.setAllow(['camera.onboarding.get', 'config.get'], 'local');
    expect(p.effective().allow).toEqual(expect.arrayContaining(['camera.onboarding.get', 'config.get']));
    const f = JSON.parse(readFileSync(join(d, 'admin', 'policy.json'), 'utf8')) as { allow: string[]; off: string[] };
    expect([f.allow, f.off]).toEqual([['config.get'], []]);
  });

  it('camera.action:camera-time-set is disruptive, off by default', () => {
    expect(ALLOW_ENTRIES).toContain('camera.action:camera-time-set');
    expect(DISRUPTIVE_ENTRIES.has('camera.action:camera-time-set')).toBe(true);
    expect(make(dir()).effective().allow).not.toContain('camera.action:camera-time-set');
    expect(ENTRY_TEXT['camera.action:camera-time-set']).toBe("DISRUPTIVE: cams-admin may run camera-time-set on a camera: rewrites the camera's time zone and DST rule");
  });
});
