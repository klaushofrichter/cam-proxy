// The Archive's input rules (spec 2026-10-05-archive-design §2.4, docs/archive.md).
import { describe, expect, it } from 'vitest';
import { checkLabels, checkName, checkRetention, contentDisposition, defaultName, onBehalfOf, RuleError, safeFileName } from '../src/archive/rules';
import type { TimeInfo } from '../src/camera/time';

const CHICAGO: TimeInfo = { stdOffsetMinutes: -360, dstOffsetMinutes: 60, dstRule: { startMon: 3, startWeek: 2, startWeekday: 0, startHour: 2, startMin: 0, endMon: 11, endWeek: 1, endWeekday: 0, endHour: 2, endMin: 0 } };

describe('names', () => {
  it('trims, allows any printable text up to 120 characters', () => {
    expect(checkName('  Fox at the door  ')).toBe('Fox at the door');
    expect(checkName('Füchse 🦊 / Garten')).toBe('Füchse 🦊 / Garten');
    expect(checkName('x'.repeat(120))).toHaveLength(120);
  });
  it.each([[''], ['   '], ['x'.repeat(121)], ['a\nb'], ['a\u0000b'], ['tab\there'], [42], [null]])('refuses %j', (v) => {
    expect(() => checkName(v)).toThrow(RuleError);
  });
});

describe('labels', () => {
  it('letters and digits, case-insensitive set, first spelling wins, predefined spelling', () => {
    expect(checkLabels(['pet', 'Garden', 'garden', '4k', 'sd', 'PERSON', 'vehicle'])).toEqual(['Pet', 'Garden', '4K', 'SD', 'Person', 'Vehicle']);
    expect(checkLabels([])).toEqual([]);
  });
  it.each([['not a list'], [['two words']], [['dash-ed']], [['']], [['x'.repeat(25)]], [[1]], [Array.from({ length: 17 }, (_, i) => `L${i}`)]])('refuses %j', (v) => {
    expect(() => checkLabels(v)).toThrow(RuleError);
  });
  it('16 distinct labels are fine; duplicates do not count', () => {
    expect(checkLabels(Array.from({ length: 16 }, (_, i) => `L${i}`))).toHaveLength(16);
    expect(checkLabels([...Array.from({ length: 16 }, (_, i) => `L${i}`), 'l0'])).toHaveLength(16);
  });
});

describe('retention', () => {
  it('whole days 1 to 36500, or null for forever', () => {
    expect(checkRetention(1)).toBe(1);
    expect(checkRetention(36500)).toBe(36500);
    expect(checkRetention(null)).toBeNull();
  });
  it.each([[0], [36501], [1.5], ['365'], [-1]])('refuses %j', (v) => {
    expect(() => checkRetention(v)).toThrow(RuleError);
  });
});

describe('the default name', () => {
  it("is the recording's start in camera time, then the camera's name", () => {
    // 2026-10-05 19:03:22 UTC is 14:03:22 CDT (DST).
    expect(defaultName(Date.UTC(2026, 9, 5, 19, 3, 22, 500), 'Den', CHICAGO)).toBe('2026-10-05 14:03:22 Den');
    // In January, CST (UTC-6).
    expect(defaultName(Date.UTC(2026, 0, 15, 5, 30), 'Den', CHICAGO)).toBe('2026-01-14 23:30:00 Den');
    // Without time info: UTC.
    expect(defaultName(Date.UTC(2026, 0, 15, 5, 30), 'Den', undefined)).toBe('2026-01-15 05:30:00 Den');
  });
  it('stays within 120 characters with a long camera name', () => {
    expect(defaultName(0, 'C'.repeat(200), undefined).length).toBeLessThanOrEqual(120);
  });
});

describe('file names for downloads', () => {
  it('replaces what file systems refuse; keeps the rest', () => {
    expect(safeFileName('2026-10-05 14:03:22 Den')).toBe('2026-10-05 14-03-22 Den');
    expect(safeFileName('a/b\\c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i');
    expect(safeFileName('Füchse 🦊')).toBe('Füchse 🦊');
    expect(safeFileName('..')).toBe('clip');
    expect(safeFileName('  . hidden .  ')).toBe('hidden');
    expect(safeFileName('x'.repeat(300)).length).toBe(100);
  });
  it('Content-Disposition with an ASCII fallback and the UTF-8 name', () => {
    expect(contentDisposition('Fox 🦊.mp4')).toBe(`attachment; filename="Fox _.mp4"; filename*=UTF-8''Fox%20%F0%9F%A6%8A.mp4`);
  });
});

describe('X-On-Behalf-Of', () => {
  it('an email-like printable value, else nothing', () => {
    expect(onBehalfOf('klaus@example.com')).toBe('klaus@example.com');
    expect(onBehalfOf(undefined)).toBeUndefined();
    expect(onBehalfOf('two words')).toBeUndefined();
    expect(onBehalfOf('x'.repeat(255))).toBeUndefined();
    expect(onBehalfOf('ä@example.com')).toBeUndefined();
  });
});
