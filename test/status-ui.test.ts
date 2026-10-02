import { describe, expect, it } from 'vitest';
import { daysUntilFullText } from '../web/src/lib/format';

describe('Status page: days until full (#78)', () => {
  it('rounds, says "more than a year" past 365 days, and — when not filling', () => {
    expect(daysUntilFullText(null)).toBe('—');
    expect(daysUntilFullText(214.4)).toBe('214');
    expect(daysUntilFullText(365)).toBe('365');
    expect(daysUntilFullText(365.6)).toBe('more than a year');
    expect(daysUntilFullText(893_477)).toBe('more than a year');
  });
});
