import { describe, expect, it } from 'vitest';
import { parseSetting } from '../web/src/lib/settings';

// The Settings page turns its text fields into the setting's type (#85: an
// optional number without a value, camera.poeSwitch.port, was saved as text).
describe('Settings page: parseSetting', () => {
  it('uses the setting type, also when there is no value yet', () => {
    expect(parseSetting('integer', undefined, '8')).toBe(8);
    expect(parseSetting('integer', 3, '12')).toBe(12);
    expect(parseSetting('boolean', undefined, 'true')).toBe(true);
    expect(parseSetting('boolean', true, 'false')).toBe(false);
    expect(parseSetting('string', undefined, '192.168.1.217')).toBe('192.168.1.217');
    expect(parseSetting('string', 'none', 'sscpoe-web')).toBe('sscpoe-web');
  });

  it('falls back to the current value type without one (an older proxy)', () => {
    expect(parseSetting(undefined, 5, '6')).toBe(6);
    expect(parseSetting(undefined, false, 'true')).toBe(true);
    expect(parseSetting(undefined, undefined, '7')).toBe('7');
  });
});
