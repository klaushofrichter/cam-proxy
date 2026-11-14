import { describe, expect, it } from 'vitest';
import { addDays, utcDay } from '../src/time-units';

describe('time-units', () => {
  it('utcDay is the UTC calendar day of a timestamp', () => {
    expect(utcDay(Date.UTC(2026, 10, 14, 0, 0, 0))).toBe('2026-11-14');
    expect(utcDay(Date.UTC(2026, 10, 14, 23, 59, 59, 999))).toBe('2026-11-14');
    expect(utcDay(Date.UTC(2026, 0, 1) - 1)).toBe('2025-12-31');
  });
  it('addDays still crosses months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
