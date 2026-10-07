import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as load from '../src/config/load';
import { applyOverrides, configRevision, getPath, loadConfig, type Loaded } from '../src/config/load';
import { DEFAULTS } from '../src/config/defaults';
import { CONFIG_SCHEMA, leafPaths, SETTINGS } from '../src/config/schema';
import { OverridesBackups } from '../src/fleet/backups';
import { compactView, configHandlers, undoLocal, type ConfigCommandDeps } from '../src/fleet/config-commands';
import type { CommandBody } from '../src/fleet/command-check';
import type { Done, Handler } from '../src/fleet/commands';
import { DENIED } from '../src/fleet/remote-settable';
import type { AuditInput } from '../src/audit/audit-log';
import { jcs } from '../src/fleet/jcs';

// config.get / config.set / config.unset / config.rollback (plan P3 Task 7;
// Review Focus 1-4): a real loadConfig in a temp folder, cams-admin's commands
// through the handlers, a local edit through the same Loaded holder.
const SECRETS = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'cam-pw' };
const CMD = (n: number) => `cmd_${String(n).padStart(20, '0')}`;
const ACTOR = 'admin@example.org';

let dir: string;
let holder: { loaded: Loaded };
let setLoaded: ReturnType<typeof vi.fn<(l: Loaded) => void>>;
let audit: { records: AuditInput[]; write: (i: AuditInput) => null };
let backups: OverridesBackups;
let h: Record<string, Handler>;
let deps: ConfigCommandDeps;
let overridesFile: string;

function setup(config: object) {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-cfgcmd-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  holder = { loaded: loadConfig(SECRETS, { cwd: dir }) };
  overridesFile = holder.loaded.files.overrides;
  setLoaded = vi.fn<(l: Loaded) => void>((l) => void (holder.loaded = l));
  audit = { records: [], write: (i) => (audit.records.push(i), null) };
  backups = new OverridesBackups(join(holder.loaded.config.server.dataDir, 'admin'));
  deps = { loaded: () => holder.loaded, setLoaded, running: () => holder.loaded.config, backups, audit, now: () => 1_791_000_000_000 };
  h = configHandlers(deps);
}
const TWO = { cameras: [{ id: 'cam1', host: '192.0.2.11' }, { id: 'cam2', host: '192.0.2.12' }] };
beforeEach(() => setup(TWO));
afterEachRestore();
function afterEachRestore() {
  beforeEach(() => vi.restoreAllMocks());
}

const rev = () => configRevision(holder.loaded);
const run = async (name: string, args: object, n = 1) => (await h[name](args, { cmdId: CMD(n), actor: ACTOR, command: name } as CommandBody)) as Done;
const localEdit = (patch: object) => void (holder.loaded = applyOverrides(holder.loaded, patch));
const fileText = () => {
  try {
    return readFileSync(overridesFile, 'utf8');
  } catch {
    return null;
  }
};

describe('config.get (R3-6)', () => {
  it('compact paths with sources, settable bounds, the revision; no secret anywhere', async () => {
    const r = await run('config.get', { v: 1 });
    expect(r.status).toBe('ok');
    expect(r.result).toMatchObject({ revision: rev(), schema: CONFIG_SCHEMA, cameras: ['cam1', 'cam2'], omittedCameras: [] });
    const paths = r.result!.paths as Record<string, Record<string, unknown>>;
    expect(paths['sse.pingS']).toEqual({ v: DEFAULTS.sse.pingS, s: 'default' });
    expect(paths['stills.quality']).toEqual({ v: DEFAULTS.stills.quality, s: 'default', r: 'restart' });
    expect(paths['cameras.cam1.host']).toEqual({ v: '192.0.2.11', s: 'file', r: 'restart' });
    expect((r.result!.settable as Record<string, unknown>)['cameras.*.name']).toBeDefined();
    expect(JSON.stringify(r.result)).not.toMatch(/password|CAMPROXY_|token|cam-pw/i);
  });
  it('an override cams-admin set is marked `by`; pending restart values are p/n', async () => {
    await run('config.set', { v: 1, dryRun: false, baseRevision: rev(), set: { 'sse.pingS': 7, 'stills.quality': 6 } }, 2);
    const r = await run('config.get', { v: 1 }, 3);
    const paths = r.result!.paths as Record<string, Record<string, unknown>>;
    expect(paths['sse.pingS']).toEqual({ v: 7, s: 'override', by: { cmdId: CMD(2), actor: ACTOR, at: 1_791_000_000_000 } });
    // running: () => the new config here; a running config with the old value shows p/n.
    const old = loadConfig(SECRETS, { cwd: mkdtempSync(join(tmpdir(), 'x-')) }).config;
    const v = compactView(holder.loaded, { ...holder.loaded.config, stills: old.stills }, backups.byPath());
    expect((v.paths as Record<string, unknown>)['stills.quality']).toMatchObject({ v: DEFAULTS.stills.quality, s: 'override', r: 'restart', p: true, n: 6 });
    // A local edit of the same path: no longer cams-admin's value, no marker.
    localEdit({ sse: { pingS: 9 } });
    expect(((await run('config.get', { v: 1 }, 4)).result!.paths as Record<string, Record<string, unknown>>)['sse.pingS']).toEqual({ v: 9, s: 'override' });
  });
  it('a 24-camera proxy stays under 64 KiB; the 25th camera is omitted, not cut', async () => {
    setup({ cameras: Array.from({ length: 25 }, (_, i) => ({ id: `camera-${String(i + 1).padStart(2, '0')}`, host: `192.0.2.${i + 1}` })) });
    const r = await run('config.get', { v: 1 });
    expect(r.result!.omittedCameras).toEqual(['camera-25']);
    expect((r.result!.cameras as string[]).length).toBe(24);
    expect(Object.keys(r.result!.paths as object).some((p) => p.startsWith('cameras.camera-25.'))).toBe(false);
    expect(Object.keys(r.result!.paths as object).filter((p) => p.startsWith('cameras.camera-24.')).length).toBe(leafPaths(SETTINGS, '', ['x']).filter((p) => p.startsWith('cameras.x.')).length);
    expect(Buffer.byteLength(jcs(r.result))).toBeLessThanOrEqual(65536);
  });
});

describe('config.set', () => {
  it('dry run: the diff, nothing written, no config-change record, revision unchanged', async () => {
    const before = fileText();
    const base = rev();
    const r = await run('config.set', { v: 1, dryRun: true, baseRevision: base, set: { 'sse.pingS': 7, 'stills.quality': 6 } });
    expect(r).toMatchObject({ status: 'ok', result: { dryRun: true, baseRevision: base, revision: base, unchanged: [], changes: [
      { path: 'sse.pingS', from: DEFAULTS.sse.pingS, to: 7, sourceFrom: 'default', sourceTo: 'override' },
      { path: 'stills.quality', from: DEFAULTS.stills.quality, to: 6, sourceFrom: 'default', sourceTo: 'override', restart: 'restart' }] } });
    expect(fileText()).toBe(before);
    expect(setLoaded).not.toHaveBeenCalled();
    expect(audit.records.filter((x) => x.action === 'config-change')).toHaveLength(0);
    expect(backups.list()).toHaveLength(0);
  });
  it('apply: written, applied live, backup saved, config-change by cams-admin with cmdId and actor', async () => {
    const base = rev();
    const r = await run('config.set', { v: 1, dryRun: false, baseRevision: base, set: { 'sse.pingS': 7 } }, 2);
    expect(r).toMatchObject({ status: 'ok', result: { dryRun: false, baseRevision: base }, changed: ['sse.pingS'] });
    expect(r.result!.revision).not.toBe(base);
    expect(r.result!.revision).toBe(rev());
    expect(setLoaded).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fileText()!)).toEqual({ sse: { pingS: 7 } });
    expect(backups.get(CMD(2))).toMatchObject({ command: 'config.set', actor: ACTOR, revisionBefore: base, revisionAfter: rev(), paths: [{ path: 'sse.pingS', before: { set: false }, after: { set: true, value: 7 } }] });
    expect(audit.records.find((x) => x.action === 'config-change')).toMatchObject({ user: 'cams-admin', details: { cmdId: CMD(2), actor: ACTOR, changes: [{ key: 'sse.pingS', from: DEFAULTS.sse.pingS, to: 7 }] } });
  });
  it('a value equal to Reset drops the override (sourceTo default); the same value again is unchanged', async () => {
    localEdit({ sse: { pingS: 9 } });
    const r = await run('config.set', { v: 1, dryRun: false, baseRevision: rev(), set: { 'sse.pingS': DEFAULTS.sse.pingS } });
    expect(r.result!.changes).toEqual([{ path: 'sse.pingS', from: 9, to: DEFAULTS.sse.pingS, sourceFrom: 'override', sourceTo: 'default' }]);
    const again = await run('config.set', { v: 1, dryRun: true, baseRevision: rev(), set: { 'sse.pingS': DEFAULTS.sse.pingS } }, 2);
    expect(again.result).toMatchObject({ changes: [], unchanged: ['sse.pingS'] });
  });
  it('Review Focus 1: trust paths fail before planning, the file stays byte-identical', async () => {
    localEdit({ sse: { pingS: 9 } });
    const before = fileText();
    const spy = vi.spyOn(load, 'writeOverridesFile');
    const plan = vi.spyOn(load, 'planOverrides');
    const cases: [Record<string, unknown>, string][] = [
      [{ 'cameras.cam1.host': '192.0.2.9' }, 'not_remote_settable'], [{ 'camsAdmin.url': 'https://evil.example' }, 'not_remote_settable'],
      [{ 'cameras.evil.name': 'x' }, 'unknown_camera'], [{ 'cameras.evil.host': '192.0.2.9' }, 'unknown_camera'],
      [{ 'cameras.cam1': 'x' }, 'not_remote_settable'], [{ cameras: 'x' }, 'not_remote_settable'],
      [{ 'ntp.server': '192.0.2.1' }, 'not_remote_settable'], [{ 'ftp.publicHost': '192.0.2.1' }, 'not_remote_settable'],
      [{ 'cameras.cam1.id': 'cam9' }, 'not_remote_settable'], [{ 'cameras.cam1.user': 'root' }, 'not_remote_settable'],
      [{ 'sse.pingS': 7, 'tls.site': 'x' }, 'not_remote_settable'], // one bad path fails the whole command
      [{ 'camera.host': '192.0.2.9' }, 'not_remote_settable'], // legacy, several cameras: not translatable, never a camera
      [{ 'ftp.user': 'x' }, 'not_remote_settable'],
    ];
    for (const [set, code] of cases) {
      const r = await run('config.set', { v: 1, dryRun: false, baseRevision: rev(), set });
      expect(r, JSON.stringify(set)).toMatchObject({ status: 'failed', code, result: { paths: expect.arrayContaining([expect.objectContaining({ code })]) } });
    }
    for (const d of DENIED.filter((x) => !x.startsWith('cameras.*.'))) {
      const leaf = leafPaths(SETTINGS, '', ['cam1']).find((p) => p === d || p.startsWith(`${d}.`))!;
      expect((await run('config.set', { v: 1, dryRun: true, baseRevision: rev(), set: { [leaf]: 1 } })).code, leaf).toBe('not_remote_settable');
    }
    expect(spy).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(fileText()).toBe(before);
    expect(setLoaded).not.toHaveBeenCalled();
    // The spies see the handler's calls (a good path plans and writes).
    await run('config.set', { v: 1, dryRun: false, baseRevision: rev(), set: { 'sse.pingS': 8 } });
    expect(plan).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('Review Focus 1: a legacy path on a one-camera proxy is translated first, then refused', async () => {
    setup({ camera: { host: '192.0.2.10' } });
    const spy = vi.spyOn(load, 'writeOverridesFile');
    expect(await run('config.set', { v: 1, dryRun: false, baseRevision: rev(), set: { 'camera.host': '192.0.2.9' } })).toMatchObject({ status: 'failed', code: 'not_remote_settable', result: { paths: [{ path: 'cameras.cam1.host', code: 'not_remote_settable' }] } });
    expect(await run('config.set', { v: 1, dryRun: false, baseRevision: rev(), set: { 'camera.poeSwitch.host': '192.0.2.9' } })).toMatchObject({ code: 'not_remote_settable' });
    expect(spy).not.toHaveBeenCalled();
    const ok = await run('config.set', { v: 1, dryRun: true, baseRevision: rev(), set: { 'camera.statusPollS': 45 } });
    expect(ok.result!.changes).toEqual([expect.objectContaining({ path: 'cameras.cam1.statusPollS', to: 45 })]);
  });
  it('local-only paths name the reason (I4, storage)', async () => {
    const r = await run('config.set', { v: 1, dryRun: true, baseRevision: rev(), set: { 'stills.enabled': false } });
    expect(r).toMatchObject({ status: 'failed', code: 'not_remote_settable', result: { paths: [{ path: 'stills.enabled', code: 'not_remote_settable', detail: expect.stringMatching(/^local only: /) }] } });
  });
  it('held_by_env, even on a dry run (a remote-settable path the env layer holds)', async () => {
    const l = holder.loaded;
    holder.loaded = { ...l, sources: { ...l.sources, 'sse.pingS': 'env' }, envNames: { ...l.envNames, 'sse.pingS': 'CAMPROXY_SSE_PING' } };
    for (const dryRun of [true, false]) expect(await run('config.set', { v: 1, dryRun, baseRevision: rev(), set: { 'sse.pingS': 7 } })).toMatchObject({ status: 'failed', code: 'held_by_env', result: { paths: [{ path: 'sse.pingS', code: 'held_by_env' }] } });
    expect(await run('config.unset', { v: 1, dryRun: true, baseRevision: rev(), paths: ['sse.pingS'] })).toMatchObject({ code: 'held_by_env' });
  });
  it('the contract order: unknown_camera before not_remote_settable before held_by_env before conflict', async () => {
    expect((await run('config.set', { v: 1, dryRun: true, baseRevision: `sha256:${'0'.repeat(64)}`, set: { 'tls.site': 'x', 'cameras.evil.name': 'x' } })).code).toBe('unknown_camera');
    expect((await run('config.set', { v: 1, dryRun: true, baseRevision: `sha256:${'0'.repeat(64)}`, set: { 'tls.site': 'x' } })).code).toBe('not_remote_settable');
    expect((await run('config.set', { v: 1, dryRun: true, baseRevision: `sha256:${'0'.repeat(64)}`, set: { 'sse.pingS': 3 } })).status).toBe('conflict');
  });
  it('Review Focus 2: a local edit between dry run and apply → conflict with the current values; nothing written', async () => {
    const base = rev();
    expect((await run('config.set', { v: 1, dryRun: true, baseRevision: base, set: { 'sse.pingS': 7 } })).status).toBe('ok');
    localEdit({ sse: { pingS: 9 } });
    const before = fileText();
    const r = await run('config.set', { v: 1, dryRun: false, baseRevision: base, set: { 'sse.pingS': 7 } }, 2);
    expect(r).toMatchObject({ status: 'conflict', result: { revision: rev(), current: { 'sse.pingS': { v: 9, s: 'override' } } } });
    expect(getPath(holder.loaded.config, 'sse.pingS')).toBe(9);
    expect(fileText()).toBe(before);
    expect(setLoaded).not.toHaveBeenCalled();
    expect(backups.list()).toHaveLength(0);
    expect((await run('config.set', { v: 1, dryRun: true, baseRevision: base, set: { 'sse.pingS': 7 } }, 3)).status).toBe('conflict');
  });
  it('R3-2: lowering a retention period or size cap, or raising a Vision limit, fails widening_local_only with the reason; storage fails not_remote_settable; nothing written', async () => {
    localEdit({ ftp: { maxGB: 50 } });
    const before = fileText();
    const cases: [Record<string, unknown>, string, string | undefined][] = [
      [{ 'retention.clipsDays': 1 }, 'widening_local_only', 'a remote change may only keep data longer'],
      [{ 'retention.stillsDays': 1 }, 'widening_local_only', 'a remote change may only keep data longer'],
      [{ 'retention.auditDays': 1 }, 'widening_local_only', 'a remote change may only keep data longer'],
      [{ 'ftp.maxGB': 1 }, 'widening_local_only', 'a remote change may only keep data longer'],
      [{ 'stills.maxGB': 1 }, 'widening_local_only', 'a remote change may only keep data longer'], // unset = no cap
      [{ 'analytics.googleVision.monthlyLimit': 99999 }, 'widening_local_only', 'a remote change may only lower spending'],
      [{ 'storage.maxPercent': 10 }, 'not_remote_settable', undefined], [{ 'storage.maxBytes': 1 }, 'not_remote_settable', undefined],
      [{ 'storage.keepHours.clips': 0 }, 'not_remote_settable', undefined], [{ 'cameras.cam1.storage.sharePercent': 1 }, 'not_remote_settable', undefined],
    ];
    for (const [set, code, detail] of cases) {
      const r = await run('config.set', { v: 1, dryRun: false, baseRevision: rev(), set });
      expect(r, JSON.stringify(set)).toMatchObject({ status: 'failed', code, result: { paths: [expect.objectContaining({ code, ...(detail ? { detail } : {}) })] } });
    }
    expect(fileText()).toBe(before);
    expect((await run('config.set', { v: 1, dryRun: true, baseRevision: rev(), set: { 'retention.clipsDays': 365 } })).status).toBe('ok');
    // config.unset of a size cap set locally (back to "no cap") is allowed;
    expect((await run('config.unset', { v: 1, dryRun: true, baseRevision: rev(), paths: ['ftp.maxGB'] })).status).toBe('ok');
    // of a retention period above the default it is refused.
    localEdit({ retention: { clipsDays: 30 } });
    expect(await run('config.unset', { v: 1, dryRun: true, baseRevision: rev(), paths: ['retention.clipsDays'] })).toMatchObject({ status: 'failed', code: 'widening_local_only' });
  });
  it("invalid_value: the proxy's own rules (previews.grid too small for stills.intervalS), the message as detail", async () => {
    const r = await run('config.set', { v: 1, dryRun: true, baseRevision: rev(), set: { 'previews.grid': '2x2' } });
    expect(r).toMatchObject({ status: 'failed', code: 'invalid_value', result: { paths: [{ path: 'previews.grid', code: 'invalid_value', detail: expect.stringMatching(/^previews\.grid: /) }] } });
    expect((await run('config.set', { v: 1, dryRun: true, baseRevision: rev(), set: { 'sse.pingS': 100000 } })).code).toBe('invalid_value');
    expect((await run('config.set', { v: 1, dryRun: true, baseRevision: rev(), set: { 'sse.pingS': 'x' } })).code).toBe('invalid_value');
  });
  it('a store error (overrides.json not writable) fails store_error and leaves the running config unchanged', async () => {
    const adminDir = join(holder.loaded.config.server.dataDir);
    load.writeOverridesFile(overridesFile, {});
    chmodSync(adminDir, 0o500);
    try {
      const r = await run('config.set', { v: 1, dryRun: false, baseRevision: rev(), set: { 'sse.pingS': 7 } });
      expect(r).toMatchObject({ status: 'failed', code: 'store_error' });
    } finally {
      chmodSync(adminDir, 0o700);
    }
    expect(setLoaded).not.toHaveBeenCalled();
    expect(getPath(holder.loaded.config, 'sse.pingS')).toBe(DEFAULTS.sse.pingS);
  });
});

describe('config.unset', () => {
  it('back to file/default, same checks, backup saved', async () => {
    localEdit({ sse: { pingS: 9, maxClients: 7 } });
    const dry = await run('config.unset', { v: 1, dryRun: true, baseRevision: rev(), paths: ['sse.pingS', 'stills.quality'] });
    expect(dry).toMatchObject({ status: 'ok', result: { dryRun: true, changes: [{ path: 'sse.pingS', from: 9, to: DEFAULTS.sse.pingS, sourceFrom: 'override', sourceTo: 'default' }], unchanged: ['stills.quality'] } });
    const r = await run('config.unset', { v: 1, dryRun: false, baseRevision: rev(), paths: ['sse.pingS'] }, 2);
    expect(r.status).toBe('ok');
    expect(JSON.parse(fileText()!)).toEqual({ sse: { maxClients: 7 } });
    expect(backups.get(CMD(2))).toMatchObject({ command: 'config.unset', paths: [{ path: 'sse.pingS', before: { set: true, value: 9 }, after: { set: false } }] });
    expect(await run('config.unset', { v: 1, dryRun: false, baseRevision: rev(), paths: ['cameras.cam1.host'] }, 3)).toMatchObject({ code: 'not_remote_settable' });
    expect(await run('config.unset', { v: 1, dryRun: false, baseRevision: rev(), paths: ['cameras.evil.name'] }, 4)).toMatchObject({ code: 'unknown_camera' });
  });
});

describe('config.rollback (R3-5)', () => {
  it("Review Focus 3: rollback restores only the command's paths; an unrelated local edit stays; the same path edited since → conflict", async () => {
    await run('config.set', { v: 1, dryRun: false, baseRevision: rev(), set: { 'sse.pingS': 7, 'sse.maxClients': 49 } }, 2);
    localEdit({ stills: { quality: 4 } }); // unrelated
    const rb = await run('config.rollback', { v: 1, dryRun: false, cmdId: CMD(2) }, 3);
    expect(rb).toMatchObject({ status: 'ok', result: { of: CMD(2), dryRun: false, changes: expect.arrayContaining([expect.objectContaining({ path: 'sse.pingS', to: DEFAULTS.sse.pingS }), expect.objectContaining({ path: 'sse.maxClients', to: DEFAULTS.sse.maxClients })]) } });
    expect(getPath(holder.loaded.config, 'stills.quality')).toBe(4);
    expect(JSON.parse(fileText()!)).toEqual({ stills: { quality: 4 } });
    expect(backups.get(CMD(2))!.rolledBack).toMatchObject({ by: 'cams-admin', cmdId: CMD(3) });
    expect(audit.records.filter((x) => x.action === 'config-change').at(-1)).toMatchObject({ user: 'cams-admin', details: { cmdId: CMD(3), rollbackOf: CMD(2) } });
    expect(await run('config.rollback', { v: 1, dryRun: false, cmdId: CMD(2) }, 4)).toMatchObject({ status: 'failed', code: 'already_rolled_back' });
    // the conflict case: set, then a local edit of the same path, then rollback
    await run('config.set', { v: 1, dryRun: false, baseRevision: rev(), set: { 'sse.pingS': 11, 'sse.maxClients': 40 } }, 5);
    localEdit({ sse: { pingS: 12 } });
    const before = fileText();
    expect(await run('config.rollback', { v: 1, dryRun: false, cmdId: CMD(5) }, 6)).toMatchObject({ status: 'conflict', result: { revision: rev(), current: { 'sse.pingS': { v: 12, s: 'override' } } } });
    const c = await run('config.rollback', { v: 1, dryRun: false, cmdId: CMD(5) }, 7);
    expect(Object.keys(c.result!.current as object)).toEqual(['sse.pingS']); // only the changed path
    expect(fileText()).toBe(before);
  });
  it('no_backup for an unknown cmdId; a dry run writes nothing; a rollback of a rollback restores again; no direction check', async () => {
    expect(await run('config.rollback', { v: 1, dryRun: false, cmdId: CMD(99) })).toMatchObject({ status: 'failed', code: 'no_backup' });
    localEdit({ retention: { clipsDays: 3 } });
    await run('config.set', { v: 1, dryRun: false, baseRevision: rev(), set: { 'retention.clipsDays': 30 } }, 2);
    const before = fileText();
    const dry = await run('config.rollback', { v: 1, dryRun: true, cmdId: CMD(2) }, 3);
    expect(dry).toMatchObject({ status: 'ok', result: { dryRun: true, of: CMD(2), changes: [expect.objectContaining({ path: 'retention.clipsDays', from: 30, to: 3 })] } });
    expect(fileText()).toBe(before);
    expect(backups.get(CMD(2))!.rolledBack).toBeUndefined();
    // the rollback lowers a retention period: allowed (it restores the local value)
    expect((await run('config.rollback', { v: 1, dryRun: false, cmdId: CMD(2) }, 4)).status).toBe('ok');
    expect(getPath(holder.loaded.config, 'retention.clipsDays')).toBe(3);
    expect((await run('config.rollback', { v: 1, dryRun: false, cmdId: CMD(4) }, 5)).status).toBe('ok');
    expect(getPath(holder.loaded.config, 'retention.clipsDays')).toBe(30);
  });
  it('rollback re-checks the classification (a backup naming a denied path is refused not_remote_settable)', async () => {
    backups.save({ v: 1, cmdId: CMD(8), command: 'config.set', actor: ACTOR, at: 1, revisionBefore: rev(), revisionAfter: rev(), paths: [{ path: 'cameras.cam1.host', before: { set: true, value: '192.0.2.66' }, after: { set: false } }] });
    const before = fileText();
    expect(await run('config.rollback', { v: 1, dryRun: false, cmdId: CMD(8) })).toMatchObject({ status: 'failed', code: 'not_remote_settable' });
    expect(fileText()).toBe(before);
  });
  it("undoLocal: the card's Undo with the local admin's name; no backup of its own", async () => {
    await run('config.set', { v: 1, dryRun: false, baseRevision: rev(), set: { 'sse.pingS': 7 } }, 2);
    const r = undoLocal(deps, CMD(2), { user: 'admin', ip: '127.0.0.1' });
    expect(r).toMatchObject({ status: 'ok', result: { of: CMD(2) } });
    expect(getPath(holder.loaded.config, 'sse.pingS')).toBe(DEFAULTS.sse.pingS);
    expect(backups.list()).toHaveLength(1);
    expect(backups.get(CMD(2))!.rolledBack).toMatchObject({ by: 'local', user: 'admin' });
    expect(audit.records.at(-1)).toMatchObject({ action: 'config-change', user: 'admin', ip: '127.0.0.1', details: { undoOf: CMD(2) } });
    expect(undoLocal(deps, CMD(2), { user: 'admin' })).toMatchObject({ status: 'failed', code: 'already_rolled_back' });
  });
});
