import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, errorText, refreshRights } from '../web/src/lib/api';
import { powerCycleFailText } from '../web/src/lib/maintenance';
import { ALL_RIGHTS, LOCKED_TEXT, lockedWhy, NARROW_TEXT, narrowWhy, REFUSED_TEXT, resetKeeps, rights, rightsOf, settingLockedWhy, settingsNote, SOME_SETTINGS_TEXT } from '../web/src/lib/rights';
import { restartToApply } from '../web/src/lib/camera-settings';

// Issue #227: a session from a cams-admin sign-in link (managed-admin) sees
// the local-admin controls off, with one line why; a refusal the proxy
// still sends is shown in words at the control, never silently.
describe('the session rights (GET /control/session)', () => {
  it('the local admin: everything', () => {
    expect(rightsOf({ loggedIn: true, origin: 'local', rights: { localAdmin: true, config: true, restart: true } })).toEqual(ALL_RIGHTS);
  });
  it('a cams-admin sign-in: what the allow-list unlocks, nothing else', () => {
    expect(rightsOf({ loggedIn: true, origin: 'managed', rights: { localAdmin: false, config: false, restart: false } })).toEqual({ localAdmin: false, config: false, restart: false, move: false, localSettings: [], narrow: {} });
    expect(rightsOf({ loggedIn: true, origin: 'managed', rights: { localAdmin: false, config: true, restart: false, move: false, localSettings: ['server', 'cameras.*.host', 7] } })).toEqual({ localAdmin: false, config: true, restart: false, move: false, localSettings: ['server', 'cameras.*.host'], narrow: {} });
    // Anything but true is false.
    expect(rightsOf({ rights: { localAdmin: 'yes', config: 1 } })).toEqual({ localAdmin: false, config: false, restart: false, move: false, localSettings: [], narrow: {} });
  });
  it('the move right: the local admin, or a sign-in the move.send entry unlocks', () => {
    expect(rightsOf({ rights: { localAdmin: false, config: false, restart: false, move: true } }).move).toBe(true);
    expect(rightsOf({ rights: { localAdmin: false, move: 'yes' } }).move).toBe(false);
    expect(lockedWhy(rightsOf({ rights: { localAdmin: false, move: true } }), 'move')).toBeNull();
    expect(lockedWhy(rightsOf({ rights: { localAdmin: false } }), 'move')).toBe(LOCKED_TEXT);
  });
  it('an older proxy (no rights in the answer) or no answer: everything stays on; the proxy decides', () => {
    expect(rightsOf({ loggedIn: true })).toEqual(ALL_RIGHTS);
    expect(rightsOf(null)).toEqual(ALL_RIGHTS);
  });
});

describe('which controls are off, and why', () => {
  const managed = { localAdmin: false, config: false, restart: false, move: false, localSettings: [] as string[], narrow: {} };
  it('nothing is off for the local admin', () => {
    for (const need of ['local', 'config', 'restart'] as const) expect(lockedWhy(ALL_RIGHTS, need)).toBeNull();
  });
  it('a cams-admin sign-in: every local-admin control off, in one plain sentence', () => {
    for (const need of ['local', 'config', 'restart'] as const) expect(lockedWhy(managed, need)).toBe(LOCKED_TEXT);
    expect(LOCKED_TEXT).toBe('Needs the local admin token: you signed in from cams-admin.');
  });
  it('ui.config and ui.restart turn their own controls on, nothing else', () => {
    expect(lockedWhy({ ...managed, config: true }, 'config')).toBeNull();
    expect(lockedWhy({ ...managed, config: true }, 'restart')).toBe(LOCKED_TEXT);
    expect(lockedWhy({ ...managed, config: true }, 'local')).toBe(LOCKED_TEXT);
    expect(lockedWhy({ ...managed, restart: true }, 'restart')).toBeNull();
    expect(lockedWhy({ ...managed, restart: true, config: true }, 'local')).toBe(LOCKED_TEXT);
  });
});

describe('one setting on the Settings page', () => {
  const unlocked = { localAdmin: false, config: true, restart: false, move: false, localSettings: ['server', 'poeSwitch', 'cameras.*.host'], narrow: {} };
  it('with ui.config: on, except what it never sets', () => {
    expect(settingLockedWhy(unlocked, 'sse.pingS')).toBeNull();
    expect(settingLockedWhy(unlocked, 'cameras.cam1.statusPollS')).toBeNull();
    for (const p of ['server.port', 'poeSwitch.host', 'cameras.cam1.host', 'cameras.front-door.host']) expect(settingLockedWhy(unlocked, p), p).toBe(LOCKED_TEXT);
    // A prefix is no match: serverX is not server.
    expect(settingLockedWhy({ ...unlocked, localSettings: ['server'] }, 'serverX.y')).toBeNull();
  });
  it('without ui.config: every setting off; the local admin: none', () => {
    expect(settingLockedWhy({ ...unlocked, config: false }, 'sse.pingS')).toBe(LOCKED_TEXT);
    expect(settingLockedWhy(ALL_RIGHTS, 'server.port')).toBeNull();
  });
  it("the page's one line says which", () => {
    expect(settingsNote({ ...unlocked, config: false })).toBe(LOCKED_TEXT);
    expect(settingsNote(unlocked)).toBe(SOME_SETTINGS_TEXT);
    expect(settingsNote(ALL_RIGHTS)).toBeNull();
  });
});

describe('a refusal shown in words', () => {
  it('403 local_admin_only says what it needs; other errors keep their detail', () => {
    expect(errorText(403, { error: 'local_admin_only' })).toBe(REFUSED_TEXT);
    expect(new ApiError(403, { error: 'local_admin_only' }).message).toBe(REFUSED_TEXT);
    expect(REFUSED_TEXT).toMatch(/local admin token.*cams-admin.*Nothing was changed/);
    expect(errorText(400, { error: 'invalid', detail: 'sse.pingS: too small' })).toBe('sse.pingS: too small');
    expect(errorText(500, null)).toBe('HTTP 500');
  });
  it('Restart to apply and the power-cycle show it too', async () => {
    expect(await restartToApply(async () => { throw new ApiError(403, { error: 'local_admin_only' }); })).toBe(`Restart failed: ${REFUSED_TEXT}`);
    expect(powerCycleFailText({ error: 'local_admin_only' }, 8)).toBe(`Camera power-cycle: ${REFUSED_TEXT}`);
  });
});

describe('Reset to defaults for a cams-admin sign-in', () => {
  it('names the overrides that stay (the ones ui.config never changes)', () => {
    const r = { localAdmin: false, config: true, restart: false, move: false, localSettings: ['ntp.server', 'cameras.*.host'], narrow: {} };
    expect(resetKeeps(r, ['sse.pingS', 'ntp.server', 'cameras.cam1.host'])).toEqual(['ntp.server', 'cameras.cam1.host']);
    expect(resetKeeps(ALL_RIGHTS, ['ntp.server'])).toEqual([]);
  });
});

// The controls follow a pause or an unticked entry without a reload.
describe('the rights follow the proxy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    rights.set(ALL_RIGHTS);
  });
  const answer = (status: number, body: unknown) => ({ status, ok: status < 400, text: async () => JSON.stringify(body), json: async () => body });
  const managed = { loggedIn: true, origin: 'managed', rights: { localAdmin: false, config: false, restart: false } };
  it('a 403 local_admin_only reads the session again', async () => {
    const fetch = vi.fn(async (url: string) => (url === '/control/session' ? answer(200, managed) : answer(403, { error: 'local_admin_only' })));
    vi.stubGlobal('fetch', fetch);
    await expect(api('PUT', '/control/config', {})).rejects.toThrow(REFUSED_TEXT);
    await vi.waitFor(() => expect(get(rights)).toEqual({ localAdmin: false, config: false, restart: false, move: false, localSettings: [], narrow: {} }));
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(['/control/config', '/control/session']);
  });
  it('refreshRights keeps the last rights when the session can\'t be read or is gone', async () => {
    rights.set({ localAdmin: false, config: true, restart: false, move: false, localSettings: [], narrow: {} });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await refreshRights();
    expect(get(rights).config).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => answer(200, managed)));
    await refreshRights();
    expect(get(rights).config).toBe(false);
  });
});

// Klaus (2026-10-21, #227 follow-up): with ui.config, retention and size caps
// only go up, Google Vision's spending caps only down (the proxy's
// narrowSettings); storage limits and Google Vision on/off stay locked.
describe('the direction rules of a cams-admin sign-in', () => {
  const narrow = { 'retention.clipsDays': { dir: 'more' as const }, 'stills.maxGB': { dir: 'more' as const, unlimited: 'unset' as const }, 'analytics.googleVision.monthlyLimit': { dir: 'less' as const }, 'analytics.googleVision.dailyCap': { dir: 'less' as const, unlimited: 0 as const } };
  const r = { localAdmin: false, config: true, restart: false, move: false, localSettings: ['storage', 'cameras.*.storage', 'analytics.googleVision.enabled'], narrow };
  it('rightsOf reads narrowSettings, dropping what is not a rule', () => {
    expect(rightsOf({ rights: { localAdmin: false, config: true, restart: false, move: false, localSettings: [], narrowSettings: { ...narrow, x: { dir: 'up' }, y: 3 } } }).narrow).toEqual(narrow);
    expect(rightsOf({ rights: { localAdmin: true, config: true, restart: true, narrowSettings: narrow } }).narrow).toEqual({});
  });
  it('a value the other way says why; the right way, another setting or the local admin: nothing', () => {
    expect(narrowWhy(r, 'retention.clipsDays', 30, 20)).toBe(NARROW_TEXT.more);
    expect(narrowWhy(r, 'retention.clipsDays', 30, 40)).toBeNull();
    expect(narrowWhy(r, 'analytics.googleVision.monthlyLimit', 100, 200)).toBe(NARROW_TEXT.less);
    expect(narrowWhy(r, 'analytics.googleVision.monthlyLimit', 100, 50)).toBeNull();
    // 0 = no daily cap; an unset size cap = none.
    expect(narrowWhy(r, 'analytics.googleVision.dailyCap', 10, 0)).toBe(NARROW_TEXT.less);
    expect(narrowWhy(r, 'stills.maxGB', 20, undefined)).toBeNull();
    expect(narrowWhy(r, 'stills.maxGB', undefined, 20)).toBe(NARROW_TEXT.more);
    // Not a number yet: the proxy says what is wrong.
    expect(narrowWhy(r, 'retention.clipsDays', 30, Number.NaN)).toBeNull();
    expect(narrowWhy(r, 'sse.pingS', 30, 1)).toBeNull();
    expect(narrowWhy(ALL_RIGHTS, 'retention.clipsDays', 30, 1)).toBeNull();
    expect(NARROW_TEXT.more).toMatch(/cams-admin sign-in.*longer/);
    expect(NARROW_TEXT.less).toMatch(/cams-admin sign-in.*spending/);
  });
  it('storage and Google Vision on/off are locked rows', () => {
    for (const p of ['storage.maxPercent', 'storage.keepHours.clips', 'cameras.cam1.storage.sharePercent', 'analytics.googleVision.enabled']) expect(settingLockedWhy(r, p), p).toBe(LOCKED_TEXT);
    expect(settingLockedWhy(r, 'analytics.googleVision.monthlyLimit')).toBeNull();
    expect(settingsNote(r)).toBe(SOME_SETTINGS_TEXT);
    expect(SOME_SETTINGS_TEXT).toMatch(/storage limits.*Google Vision/);
  });
  it('Reset to defaults keeps an override whose reset would go the other way', () => {
    const view = { 'retention.clipsDays': { value: 60, resetTo: { value: 7, source: 'default' as const } }, 'retention.eventsDays': { value: 5, resetTo: { value: 30, source: 'default' as const } }, 'analytics.googleVision.monthlyLimit': { value: 100, resetTo: { value: 0, source: 'default' as const } }, 'storage.maxPercent': { value: 50, resetTo: { value: 85, source: 'default' as const } }, 'sse.pingS': { value: 9, resetTo: { value: 15, source: 'default' as const } } };
    expect(resetKeeps(r, Object.keys(view), view)).toEqual(['retention.clipsDays', 'storage.maxPercent']);
    expect(resetKeeps(ALL_RIGHTS, Object.keys(view), view)).toEqual([]);
  });
  it('a refusal with a reason says it', () => {
    expect(errorText(403, { error: 'local_admin_only', detail: 'retention.clipsDays: a cams-admin sign-in may only keep data longer' })).toBe('Refused: retention.clipsDays: a cams-admin sign-in may only keep data longer. Nothing was changed.');
  });
});
