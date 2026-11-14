import { describe, expect, it } from 'vitest';
import { plainIp } from '../src/util/cidr';

describe('plainIp', () => {
  it('drops only the IPv4-mapped prefix', () => {
    expect(plainIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(plainIp('10.0.0.1')).toBe('10.0.0.1');
    expect(plainIp('::1')).toBe('::1');
    expect(plainIp(undefined)).toBe('');
  });
});
