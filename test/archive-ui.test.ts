// The admin UI's Archive card and Clear the Archive (spec 2026-10-05-archive-design §6).
import { describe, expect, it } from 'vitest';
import { archiveRows, clearMatches, clearMessage, type UiArchive } from '../web/src/lib/archive';

const NOW = new Date(2026, 9, 5, 18, 0).getTime();
const GB = 1024 ** 3;
const base: UiArchive = {
  enabled: true, count: 12, bytes: 1.25 * GB, forever: 1, oldestCreatedAt: new Date(2026, 8, 1, 9, 5).getTime(), newestCreatedAt: NOW - 3_600_000,
  disk: { free: 180 * GB, size: 228.6 * GB }, percentOfDisk: 0.5, warnPercent: 50, warning: false, minFreeBytes: 2 * GB,
  nextCleanupAt: new Date(2026, 9, 6, 3, 30).getTime(), expiringAtNextCleanup: 1, lastCleanup: { at: NOW - 14.5 * 3_600_000, removed: 2, bytes: 3e8 }, labels: [],
};
const row = (rows: ReturnType<typeof archiveRows>, key: string) => rows.find((r) => r.key === key);

describe('the Archive card', () => {
  it('count, size, share of the disk, free disk, oldest and newest, next and last cleanup', () => {
    const rows = archiveRows(base, NOW);
    expect(rows.map((r) => [r.label, r.text])).toEqual([
      ['Clips', '12 (1 kept forever)'],
      ['Size', '1.3 GB'],
      ['Of the disk', '0.5 %'],
      ['Disk free', '180.0 GB of 228.6 GB'],
      ['Oldest', '2026-09-01 09:05'],
      ['Newest', '1 h ago'],
      ['Next cleanup', 'in 10 h · 1 clip expires'],
      ['Last cleanup', '15 h ago · 2 removed'],
    ]);
    expect(rows.every((r) => !r.bad)).toBe(true);
  });

  it('the WARNING over archive.warnPercent (no limit)', () => {
    const r = row(archiveRows({ ...base, percentOfDisk: 52.3, warning: true }, NOW), 'percent')!;
    expect(r).toMatchObject({ text: '52.3 % — WARNING: over 50 %', bad: true });
    expect(r.title).toMatch(/archive\.warnPercent/);
  });

  it('empty, nothing expiring, never cleaned, off', () => {
    const rows = archiveRows({ ...base, count: 0, bytes: 0, forever: 0, oldestCreatedAt: null, newestCreatedAt: null, expiringAtNextCleanup: 0, lastCleanup: null, nextCleanupAt: NOW }, NOW);
    expect(row(rows, 'count')?.text).toBe('0');
    expect(row(rows, 'oldest')?.text).toBe('—');
    expect(row(rows, 'next')?.text).toBe('now · nothing expires');
    expect(row(rows, 'last')?.text).toBe('— (not since the start)');
    expect(row(archiveRows({ ...base, enabled: false }, NOW), 'count')?.text).toBe('12 (1 kept forever) · new clips off');
  });
});

describe('Clear the Archive', () => {
  it('the button confirms only with the exact count typed', () => {
    expect(clearMatches('12', 12)).toBe(true);
    expect(clearMatches(' 12 ', 12)).toBe(true);
    expect(clearMatches('11', 12)).toBe(false);
    expect(clearMatches('012', 12)).toBe(false);
    expect(clearMatches('', 0)).toBe(false);
    expect(clearMatches('12 clips', 12)).toBe(false);
  });
  it('says what goes', () => {
    expect(clearMessage({ count: 12, bytes: 1.25 * GB })).toBe('Delete all 12 clips in the Archive (1.3 GB), with their thumbnails and metadata? This cannot be undone. Type 12 to confirm.');
    expect(clearMessage({ count: 1, bytes: 5e6 })).toBe('Delete all 1 clip in the Archive (0.0 GB), with their thumbnails and metadata? This cannot be undone. Type 1 to confirm.');
  });
});
