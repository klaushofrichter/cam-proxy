import { mkdtempSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { switchPasswordStore } from '../src/config/switch-passwords';

const tmp = () => mkdtempSync(join(tmpdir(), 'swpw-'));

describe('switch password store', () => {
  it('stores, reads and deletes in a 600 file', () => {
    const d = tmp();
    const s = switchPasswordStore(d);
    expect(s.get('sw_a')).toBeUndefined();
    s.set('sw_a', 'pw-one');
    s.set('sw_b', 'pw-two');
    expect(s.get('sw_a')).toBe('pw-one');
    expect(statSync(join(d, 'admin', 'switch-passwords.json')).mode & 0o777).toBe(0o600);
    s.delete('sw_a');
    expect(s.get('sw_a')).toBeUndefined();
    expect(s.get('sw_b')).toBe('pw-two');
    expect(s.get('__proto__')).toBeUndefined();
  });
});
