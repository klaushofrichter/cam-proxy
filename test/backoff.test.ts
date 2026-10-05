import { describe, expect, it } from 'vitest';
import { Backoff } from '../src/cameras/backoff';

describe('Backoff (spec §3.3)', () => {
  it('5 s doubling to 5 min', () => {
    const b = new Backoff();
    expect(Array.from({ length: 9 }, () => b.next())).toEqual([5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
  });
  it('reset after 10 min healthy, not before', () => {
    const b = new Backoff();
    b.next();
    b.next();
    b.healthy(0, 599_999);
    expect(b.next()).toBe(20000);
    b.healthy(0, 600_000);
    expect(b.next()).toBe(5000);
  });
});
