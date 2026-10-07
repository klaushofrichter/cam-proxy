import { describe, expect, it } from 'vitest';
import { canEnroll, commandsBanner, stateClass, stateText, tokenStateText, widenErrorText } from '../web/src/lib/cams-admin';
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
