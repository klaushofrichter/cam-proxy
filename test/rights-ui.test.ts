import { get } from 'svelte/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, errorText, refreshRights } from '../web/src/lib/api';
import { powerCycleFailText } from '../web/src/lib/maintenance';
import { ALL_RIGHTS, LOCKED_TEXT, lockedWhy, REFUSED_TEXT, resetKeeps, rights, rightsOf, settingLockedWhy, settingsNote, SOME_SETTINGS_TEXT } from '../web/src/lib/rights';
import { restartToApply } from '../web/src/lib/camera-settings';

// Issue #227: a session from a cams-admin sign-in link (managed-admin) sees
// the local-admin controls off, with one line why; a refusal the proxy
// still sends is shown in words at the control, never silently.
describe('the session rights (GET /control/session)', () => {
  it('the local admin: everything', () => {
    expect(rightsOf({ loggedIn: true, origin: 'local', rights: { localAdmin: true, config: true, restart: true } })).toEqual(ALL_RIGHTS);
  });
  it('a cams-admin sign-in: what the allow-list unlocks, nothing else', () => {
    expect(rightsOf({ loggedIn: true, origin: 'managed', rights: { localAdmin: false, config: false, restart: false } })).toEqual({ localAdmin: false, config: false, restart: false, localSettings: [] });
    expect(rightsOf({ loggedIn: true, origin: 'managed', rights: { localAdmin: false, config: true, restart: false, localSettings: ['server', 'cameras.*.host', 7] } })).toEqual({ localAdmin: false, config: true, restart: false, localSettings: ['server', 'cameras.*.host'] });
    // Anything but true is false.
    expect(rightsOf({ rights: { localAdmin: 'yes', config: 1 } })).toEqual({ localAdmin: false, config: false, restart: false, localSettings: [] });
  });
  it('an older proxy (no rights in the answer) or no answer: everything stays on; the proxy decides', () => {
    expect(rightsOf({ loggedIn: true })).toEqual(ALL_RIGHTS);
    expect(rightsOf(null)).toEqual(ALL_RIGHTS);
  });
});

describe('which controls are off, and why', () => {
  const managed = { localAdmin: false, config: false, restart: false, localSettings: [] as string[] };
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
  const unlocked = { localAdmin: false, config: true, restart: false, localSettings: ['server', 'poeSwitch', 'cameras.*.host'] };
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
    const r = { localAdmin: false, config: true, restart: false, localSettings: ['ntp.server', 'cameras.*.host'] };
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
    await vi.waitFor(() => expect(get(rights)).toEqual({ localAdmin: false, config: false, restart: false, localSettings: [] }));
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(['/control/config', '/control/session']);
  });
  it('refreshRights keeps the last rights when the session can\'t be read or is gone', async () => {
    rights.set({ localAdmin: false, config: true, restart: false, localSettings: [] });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await refreshRights();
    expect(get(rights).config).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => answer(200, managed)));
    await refreshRights();
    expect(get(rights).config).toBe(false);
  });
});
