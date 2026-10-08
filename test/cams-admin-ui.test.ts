import { describe, expect, it } from 'vitest';
import { actorLabel, allowedText, byText, unconfirmedText, canEnroll, changeLines, commandsBanner, commandsStateText, entryGroups, lastCommandText, sinceOf, stateClass, stateText, summaryWarnings, tokensCountText, tokenStateText, undoErrorText, widenErrorText } from '../web/src/lib/cams-admin';
// Shaped like web/src/lib/api's ApiError (that module needs a browser's types).
const apiError = (status: number, body: unknown) => Object.assign(new Error(`HTTP ${status}`), { status, body });

// The Status page's cams-admin card (spec 2026-10-06-cams-admin-phase1-design §9.2).
describe('the cams-admin card', () => {
  it('says each state in words', () => {
    expect(stateText('off')).toBe('not enrolled');
    expect(stateText('not-enrolled')).toBe('not enrolled');
    expect(stateText('disabled')).toBe('off (camsAdmin.enabled is false)');
    expect(stateText('connecting')).toBe('connecting');
    expect(stateText('connected')).toBe('connected');
    expect(stateText('backoff')).toBe('disconnected, retrying');
    expect(stateText('rejected')).toBe('rejected by cams-admin: re-enroll');
    expect(stateText('incompatible')).toBe('incompatible: update the proxy or cams-admin');
    expect(stateText('key-unsafe')).toBe('key file unsafe: not used');
    expect(stateText('key-invalid')).toBe('key file unreadable: enroll again');
  });
  it('red for what needs a person, green when connected', () => {
    expect(stateClass('connected')).toBe('ok');
    for (const s of ['rejected', 'incompatible', 'key-unsafe', 'key-invalid', 'backoff'] as const) expect(stateClass(s), s).toBe('bad');
    for (const s of ['off', 'not-enrolled', 'disabled', 'connecting'] as const) expect(stateClass(s), s).toBe('');
  });
  it('the enroll form while there is nothing working to keep', () => {
    for (const s of ['off', 'not-enrolled', 'rejected', 'key-unsafe', 'key-invalid', 'incompatible'] as const) expect(canEnroll(s), s).toBe(true);
    for (const s of ['connected', 'connecting', 'backoff', 'disabled'] as const) expect(canEnroll(s), s).toBe(false);
  });
});

// Commands and managed tokens on the card (migration P2).
describe('commands and managed tokens on the card', () => {
  const base = { enabled: true, envName: null, paused: false, pauseReason: null, allow: [] };
  it('the banner: the env switch first (cams-admin cannot change it), then a pause with its reason', () => {
    expect(commandsBanner(base)).toBeNull();
    expect(commandsBanner({ ...base, enabled: false, envName: 'CAMPROXY_ADMIN_COMMANDS', paused: true, pauseReason: 'x' })).toBe("Off: CAMPROXY_ADMIN_COMMANDS is set to off in the environment. cams-admin can't change this.");
    expect(commandsBanner({ ...base, paused: true, pauseReason: 'maintenance' })).toBe('Paused: maintenance');
    expect(commandsBanner({ ...base, paused: true, pauseReason: null })).toBe('Paused');
  });
  it('a token state in words', () => {
    const now = 1_000_000;
    const t = { id: 'tok_1', kind: 'client', label: 'x', retireAt: null, blocked: false, live: true, hashPrefix: 'sha256:abcdabcd' };
    expect(tokenStateText(t, now)).toBe('live');
    expect(tokenStateText({ ...t, blocked: true }, now)).toBe('blocked');
    expect(tokenStateText({ ...t, live: false, retireAt: now - 1 }, now)).toBe('retired');
    expect(tokenStateText({ ...t, retireAt: now + 120_000 }, now)).toBe('retires in 2 min');
  });
  it('a refused widening says how to do it', () => {
    expect(widenErrorText(apiError(403, { error: 'local_admin_only' }), 'x')).toBe("Adding a command needs the proxy's own admin token: sign in with it (not through cams).");
    expect(widenErrorText(apiError(400, { error: 'invalid', detail: 'bad' }), 'Not saved')).toBe('bad');
    expect(widenErrorText(new Error('x'), 'Not saved')).toBe('Not saved');
  });
});

// Remote configuration on the card (migration P3): the entries in groups,
// the disruptive ones under a warning and unticked by default; cams-admin's
// changes with Undo; the Settings marker.
describe('P3 on the card', () => {
  const known = ['tokens.apply', 'config.get', 'config.set', 'camera.action:camera-test', 'camera.action:camera-reboot', 'proxy.restart'].map((entry) => ({ entry, text: `${entry} text` }));
  const groups = { tokens: ['tokens.apply'], read: ['config.get'], settings: ['config.set'], camera: ['camera.action:camera-test'], disruptive: ['camera.action:camera-reboot', 'proxy.restart'] };
  it('groups in order; the disruptive group carries its warning; nothing is allowed by default', () => {
    const g = entryGroups({ known, groups, allow: [] });
    expect(g.map((x) => x.title)).toEqual(['Managed tokens', 'Read settings', 'Change settings', 'Camera actions', 'Disruptive — off by default']);
    const d = g.at(-1)!;
    expect(d.warning).toMatch(/interrupt/);
    expect(d.entries.map((e) => e.entry)).toEqual(['camera.action:camera-reboot', 'proxy.restart']);
    expect(g.flatMap((x) => x.entries).every((e) => !e.allowed)).toBe(true);
    expect(entryGroups({ known, groups, allow: ['proxy.restart'] }).at(-1)!.entries.find((e) => e.entry === 'proxy.restart')!.allowed).toBe(true);
  });
  it('I3: an entry allowed before this version shows as needing a fresh confirmation, unticked', () => {
    const g = entryGroups({ known, groups, allow: [], unconfirmed: ['proxy.restart'] });
    const e = g.at(-1)!.entries.find((x) => x.entry === 'proxy.restart')!;
    expect(e).toMatchObject({ allowed: false, unconfirmed: true });
    expect(unconfirmedText).toBe('allowed before this version: tick and Save to confirm');
  });
  it('an older proxy without groups: one list', () => {
    const g = entryGroups({ known, allow: [] });
    expect(g).toHaveLength(1);
    expect(g[0].entries).toHaveLength(known.length);
  });
  it('a change in words; who set a setting; why an Undo was refused', () => {
    expect(changeLines({ cmdId: 'cmd_1', command: 'config.set', actor: 'a@example.org', at: 1, paths: [{ path: 'sse.pingS', from: 15, to: 7 }, { path: 'stills.maxGB', to: 50 }, { path: 'ftp.maxGB', from: 9 }], rolledBack: null })).toEqual(['sse.pingS: 15 s → 7 s', 'stills.maxGB: default → 50 GB', 'ftp.maxGB: 9 GB → default']);
    expect(byText({ cmdId: 'cmd_1', actor: 'admin@example.org', at: 1 })).toBe('set by cams-admin (on behalf of admin@example.org)');
    const err = (status: number, body: unknown) => Object.assign(new Error('x'), { status, body });
    expect(undoErrorText(err(409, { error: 'conflict', paths: ['sse.pingS'] }))).toBe('Not undone: sse.pingS changed here since. Reset it on the Settings page instead.');
    expect(undoErrorText(err(409, { error: 'already_rolled_back' }))).toBe('Already undone.');
    expect(undoErrorText(err(403, { error: 'local_admin_only' }))).toBe("Undo needs the proxy's own admin token: sign in with it (not through cams).");
    expect(undoErrorText(new Error('x'))).toBe('Not undone');
  });
});

// #203: the Status page's short cams-admin card and the cams-admin page.
describe('the cams-admin summary', () => {
  const NOW = Date.UTC(2026, 9, 8, 12, 0);
  const view = { state: 'connected' as const, url: 'https://cams-admin.example.org/', account: 'home', proxyId: 'prx_01J9ABCDEFGHJKMNPQ9F5X', fingerprint: 'SHA256:AB', enrolledAt: NOW - 86400_000, connectedSince: NOW - 3600_000, lastHeartbeatAt: NOW - 5000, lastAckAt: null, lastError: null, lastErrorAt: null, retryInMs: null, truncated: false };
  const cmds = { enabled: true, envName: null, paused: false, pauseReason: null, allow: ['tokens.apply', 'config.get'], unconfirmed: ['config.set', 'tokens.apply'], recent: [{ cmdId: 'c2', command: 'tokens.apply', actor: 'cms_79S6GNGR8RP1QG00ZJZS', at: NOW - 120_000, status: 'ok' as const }, { cmdId: 'c1', command: 'config.set', actor: 'a@b.c', at: NOW - 7200_000, status: 'conflict' as const, code: 'changed' }] };
  const token = (id: string, over: Partial<{ blocked: boolean; live: boolean; retireAt: number | null }> = {}) => ({ id, kind: 'client', label: 'cams', retireAt: null, blocked: false, live: true, hashPrefix: 'sha256:0123456', ...over });

  it('since when: connected since, else the last error or the enrollment', () => {
    expect(sinceOf(view)).toBe(NOW - 3600_000);
    expect(sinceOf({ ...view, state: 'backoff', lastErrorAt: NOW - 60_000 })).toBe(NOW - 60_000);
    expect(sinceOf({ ...view, state: 'connecting', lastErrorAt: null })).toBe(NOW - 86400_000);
    expect(sinceOf({ ...view, state: 'off', enrolledAt: null, lastErrorAt: null })).toBeNull();
  });
  it('commands: on, paused (with the reason) or off in the environment', () => {
    expect(commandsStateText(cmds)).toBe('on');
    expect(commandsStateText({ ...cmds, paused: true, pauseReason: 'maintenance' })).toBe('paused: maintenance');
    expect(commandsStateText({ ...cmds, paused: true })).toBe('paused');
    expect(commandsStateText({ ...cmds, enabled: false, envName: 'CAMPROXY_ADMIN_COMMANDS' })).toBe('off (CAMPROXY_ADMIN_COMMANDS)');
  });
  it('how many are allowed, and how many need re-confirming', () => {
    expect(allowedText(cmds)).toBe('2 allowed, 1 needs re-confirming');
    expect(allowedText({ ...cmds, unconfirmed: [] })).toBe('2 allowed');
    expect(allowedText({ ...cmds, allow: [], unconfirmed: ['a', 'b'] })).toBe('none allowed, 2 need re-confirming');
  });
  it('managed tokens: live and blocked', () => {
    expect(tokensCountText({ revision: 1, problem: null, items: [] }, NOW)).toBe('none');
    expect(tokensCountText({ revision: 1, problem: null, items: [token('a'), token('b'), token('c', { blocked: true })] }, NOW)).toBe('2 live, 1 blocked');
    expect(tokensCountText({ revision: 1, problem: null, items: [token('a'), token('b', { live: false })] }, NOW)).toBe('1 live, 1 retired');
  });
  it('the last command: when, what, how it ended', () => {
    expect(lastCommandText(cmds.recent, NOW)).toBe('2 min ago · tokens.apply · ok');
    expect(lastCommandText(cmds.recent.slice(1), NOW)).toBe('2 h ago · config.set · conflict (changed)');
    expect(lastCommandText([], NOW)).toBe('none yet');
  });
  it('warnings: an error while not connected, the tokens problem, commands to re-confirm', () => {
    expect(summaryWarnings(view, cmds, { problem: null })).toEqual(['1 command needs re-confirming on the cams-admin page']);
    expect(summaryWarnings({ ...view, state: 'backoff', lastError: 'ECONNREFUSED' }, { ...cmds, unconfirmed: [] }, { problem: 'tokens.json unreadable' })).toEqual(['Last error: ECONNREFUSED', 'tokens.json unreadable']);
    expect(summaryWarnings({ ...view, lastError: 'old' }, null, null)).toEqual([]);
  });
  it('an actor: an email as it is, an id shortened, the full value kept', () => {
    expect(actorLabel('a@b.c')).toEqual({ text: 'a@b.c', full: 'a@b.c' });
    expect(actorLabel('cms_79S6GNGR8RP1QG00ZJZS')).toEqual({ text: 'cms_79S6…ZJZS', full: 'cms_79S6GNGR8RP1QG00ZJZS' });
    expect(actorLabel('system')).toEqual({ text: 'system', full: 'system' });
  });
});
