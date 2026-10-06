import { describe, expect, it } from 'vitest';
import { canEnroll, stateClass, stateText } from '../web/src/lib/cams-admin';

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
