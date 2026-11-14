import { describe, expect, it } from 'vitest';
import { inCidr, ipv4Int, plainIp } from '../src/util/cidr';

describe('plainIp', () => {
  it('drops only the IPv4-mapped prefix', () => {
    expect(plainIp('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(plainIp('10.0.0.1')).toBe('10.0.0.1');
    expect(plainIp('::1')).toBe('::1');
    expect(plainIp(undefined)).toBe('');
  });

  it('in any case, and folds an address for comparing (the move token guard)', () => {
    expect(plainIp('::FFFF:10.0.0.1')).toBe('10.0.0.1');
    expect(plainIp(' FE80::1 ')).toBe('fe80::1');
  });
});

describe('ipv4Int', () => {
  it('reads dotted decimal addresses', () => {
    expect(ipv4Int('0.0.0.0')).toBe(0);
    expect(ipv4Int('10.42.0.89')).toBe(((10 * 256 + 42) * 256 + 0) * 256 + 89);
    expect(ipv4Int('255.255.255.255')).toBe(2 ** 32 - 1);
  });

  it.each(['', ' 1.2.3.4', '1.2.3.4 ', '0x1.0.0.0', '1e2.0.0.0', '010.0.0.1', '1.2.3', '1.2.3.4.5', '256.0.0.1', '-1.0.0.0', '1..2.3', '+1.2.3.4', '1.2.3.4/32'])('refuses %j', (v) => {
    expect(ipv4Int(v)).toBeNull();
  });
});

describe('inCidr', () => {
  it('needs a whole prefix from 0 to 32', () => {
    expect(inCidr('10.42.0.89', '10.42.0.0/16')).toBe(true);
    expect(inCidr('10.42.0.89', '0.0.0.0/0')).toBe(true);
    for (const c of ['10.42.0.0', '10.42.0.0/', '10.42.0.0/16.5', '10.42.0.0/ 16', '10.42.0.0/0x10', '10.42.0.0/33', '10.42.0.0/-1', '10.42.0.0/16/1']) expect(inCidr('10.42.0.89', c)).toBe(false);
  });
});
