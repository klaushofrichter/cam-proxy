import { describe, expect, it } from 'vitest';
import { diskText, healthHeadline, itemOf, loadText, memoryText, piCardTitle, problemOf, uptimeText, type UiHealth } from '../web/src/lib/health';

// Spec 2026-10-03-health-summary-design A3: the Status page's Health and Pi cards.
const GB = 1024 ** 3;
const health = (problems: string[] = []): UiHealth => ({
  ok: problems.length === 0,
  problemCount: problems.length,
  platform: { pi: true, model: 'Raspberry Pi 4 Model B Rev 1.5', hostStats: true },
  thresholds: { diskPercent: 90, tempC: 75, ftpStalledHours: 6 },
  items: ['camera', 'disk', 'cpuTemp', 'version'].map((id) => ({ id, label: id, value: null, text: '', problem: problems.includes(id) })),
  disk: null,
  host: null,
});

describe('the Health card', () => {
  it('headline: All OK, 1 problem, N problems', () => {
    expect(healthHeadline(health())).toBe('All OK');
    expect(healthHeadline(health(['disk']))).toBe('1 problem');
    expect(healthHeadline(health(['disk', 'camera', 'cpuTemp']))).toBe('3 problems');
  });
  it('problemOf: the item\'s flag; false without the item or without a summary', () => {
    expect(problemOf(health(['disk']), 'disk')).toBe(true);
    expect(problemOf(health(['disk']), 'camera')).toBe(false);
    expect(problemOf(health(), 'underVoltage')).toBe(false);
    expect(problemOf(undefined, 'disk')).toBe(false);
    expect(itemOf(health(), 'version')?.id).toBe('version');
    expect(itemOf(undefined, 'version')).toBeUndefined();
  });
});

describe('the Pi card', () => {
  it('titled Pi on a Raspberry Pi, Host when host.stats forces the figures on elsewhere', () => {
    expect(piCardTitle({ pi: true, model: 'x', hostStats: true })).toBe('Pi');
    expect(piCardTitle({ pi: false, model: null, hostStats: true })).toBe('Host');
  });
  it('uptime in days and hours, hours and minutes, or minutes', () => {
    expect(uptimeText(412233)).toBe('4 d 18 h');
    expect(uptimeText(3 * 3600 + 5 * 60 + 9)).toBe('3 h 5 min');
    expect(uptimeText(42 * 60 + 30)).toBe('42 min');
    expect(uptimeText(null)).toBe('—');
  });
  it('memory, load and disk', () => {
    expect(memoryText({ totalBytes: 4025016320, availableBytes: 3435134976, usedPercent: 14.7 })).toBe('14.7 % of 3.7 GB');
    expect(memoryText(null)).toBe('—');
    expect(loadText({ m1: 0.42, m5: 0.38, m15: 0.3 })).toBe('0.42 · 0.38 · 0.30');
    expect(loadText(null)).toBe('—');
    expect(diskText({ sizeBytes: 228.6 * GB, freeBytes: 191 * GB, usedBytes: 26 * GB, usedPercent: 11.4 })).toBe('11.4 % used, 191.0 GB free');
    expect(diskText(null)).toBe('—');
  });
});
