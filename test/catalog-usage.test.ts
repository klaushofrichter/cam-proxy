import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import { MIGRATIONS } from '../src/catalog/migrations';
import { addUsage, adoptLegacyUsage, releaseUsage, usageBetween, usageByCamera } from '../src/catalog/analyses';
import { keyId } from '../src/analytics/key-id';

const fresh = () => openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-usage-')), 'catalog.sqlite'));

// A catalog as release 8 left it, with one month of usage (spec §5.1).
function version8(rows: [string, string, number][]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'camproxy-usage8-')), 'catalog.sqlite');
  const raw = new DatabaseSync(path);
  raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
  MIGRATIONS.slice(0, 8).forEach((sql, i) => {
    raw.exec(sql);
    raw.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
  });
  for (const [p, d, n] of rows) raw.prepare('INSERT INTO analytics_usage (provider, day, calls) VALUES (?, ?, ?)').run(p, d, n);
  raw.close();
  return path;
}

describe('analytics_usage per key and camera (spec §5.1)', () => {
  it('keyId: the first 12 hex digits of SHA-256, never the key', () => {
    expect(keyId('abc')).toBe('ba7816bf8f01');
    expect(keyId('abc')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('counts per provider, key and camera; sums over keys and cameras by default', () => {
    const c = fresh();
    const a = { provider: 'google-vision', keyId: keyId('k1'), cam: 'cam3' };
    const b = { provider: 'google-vision', keyId: keyId('k1'), cam: 'cam4' };
    addUsage(c, a, '2026-10-05');
    addUsage(c, a, '2026-10-05');
    addUsage(c, b, '2026-10-05');
    expect(usageBetween(c, 'google-vision', '2026-10-01', '2026-10-31')).toBe(3);
    expect(usageBetween(c, 'google-vision', '2026-10-01', '2026-10-31', { cam: 'cam4' })).toBe(1);
    expect(usageBetween(c, 'google-vision', '2026-10-01', '2026-10-31', { keyIds: [keyId('k2')] })).toBe(0);
    expect(usageByCamera(c, 'google-vision', '2026-10-05', '2026-10-05')).toEqual({ cam3: 2, cam4: 1 });
    releaseUsage(c, a, '2026-10-05');
    expect(usageBetween(c, 'google-vision', '2026-10-05', '2026-10-05', { cam: 'cam3' })).toBe(1);
    releaseUsage(c, a, '2026-10-05');
    releaseUsage(c, a, '2026-10-05'); // never below 0
    expect(usageBetween(c, 'google-vision', '2026-10-05', '2026-10-05', { cam: 'cam3' })).toBe(0);
  });

  it('migration 9 keeps the Pi month: legacy rows get key "" and the one camera', () => {
    const c = openCatalog(version8([['google-vision', '2026-10-04', 14], ['google-vision:check', '2026-10-04', 2]]));
    expect(c.schemaVersion()).toBe(9);
    expect(usageBetween(c, 'google-vision', '2026-10-01', '2026-10-31')).toBe(14);
    expect(adoptLegacyUsage(c, ['cam1'])).toBe(2);
    expect(usageByCamera(c, 'google-vision', '2026-10-04', '2026-10-04')).toEqual({ cam1: 14 });
    expect(usageBetween(c, 'google-vision', '2026-10-04', '2026-10-04', { keyIds: [''] })).toBe(14);
    expect(adoptLegacyUsage(c, ['cam1'])).toBe(0); // once only
    expect(c.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'stream_log_cam_ts'").get()).toBeDefined();
  });

  it('with several cameras the legacy rows go to "unknown"', () => {
    const c = openCatalog(version8([['google-vision', '2026-10-04', 5]]));
    adoptLegacyUsage(c, ['cam3', 'cam4']);
    expect(usageByCamera(c, 'google-vision', '2026-10-04', '2026-10-04')).toEqual({ unknown: 5 });
  });
});
