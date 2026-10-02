import { describe, expect, it } from 'vitest';
import { cameraStateText, isNewStart, RESTART_GIVE_UP_MS } from '../web/src/lib/maintenance';

describe('Maintenance page helpers (#71, #83)', () => {
  it('tells a new proxy start by its version or start time', () => {
    const before = { version: 'v1', startedAt: 1000 };
    expect(isNewStart(before, { version: 'v1', startedAt: 1000 })).toBe(false);
    expect(isNewStart(before, { version: 'v1', startedAt: 2000 })).toBe(true);
    expect(isNewStart(before, { version: 'v2', startedAt: 1000 })).toBe(true);
    // An older proxy without startedAt: the version decides.
    expect(isNewStart({ version: 'v1' }, { version: 'v1' })).toBe(false);
    expect(isNewStart(null, { version: 'v1', startedAt: 5 })).toBe(true);
    expect(RESTART_GIVE_UP_MS).toBe(120_000);
  });

  it('shows the camera as rebooting while a reboot is under way', () => {
    const at = new Date(2026, 9, 1, 14, 7).getTime();
    expect(cameraStateText({ online: false, reboot: { phase: 'rebooting', requestedAt: at } })).toBe('rebooting (requested 14:07)');
    expect(cameraStateText({ online: true, reboot: { phase: 'rebooting', requestedAt: at } })).toBe('rebooting (requested 14:07)');
    expect(cameraStateText({ online: true, reboot: { phase: 'back', requestedAt: at } })).toBe('online');
    expect(cameraStateText({ online: false, reboot: null })).toBe('offline');
    expect(cameraStateText({ online: true })).toBe('online');
  });
});
