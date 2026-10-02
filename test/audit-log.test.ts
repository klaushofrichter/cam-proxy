import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLog, AuditQueryError, cut, redact } from '../src/audit/audit-log';
import { logger } from '../src/log';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
function make(now: { t: number }, over: Partial<ConstructorParameters<typeof AuditLog>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-'));
  dirs.push(dir);
  return { dir, log: new AuditLog({ dir, version: '2026.10.01.1', camera: () => 'cam1', now: () => now.t, host: 'testhost', ...over }) };
}
const base = { category: ['authentication'], type: ['start'], outcome: 'success' as const };
const T = Date.UTC(2026, 9, 1, 23, 59, 0);

describe('AuditLog.write', () => {
  it('writes one ECS line to the UTC day file, with the common fields', () => {
    const now = { t: T };
    const { dir, log } = make(now);
    log.write({ ...base, action: 'login', message: 'Admin signed in', user: 'admin', ip: '10.0.0.5', details: { auth: { method: 'token-form' } } });
    const lines = readFileSync(join(dir, '2026-10-01.jsonl'), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      '@timestamp': '2026-10-01T23:59:00.000Z', ecs: { version: '8.11.0' },
      event: { kind: 'event', category: ['authentication'], type: ['start'], action: 'login', outcome: 'success', dataset: 'cam-proxy.audit' },
      service: { name: 'cam-proxy', version: '2026.10.01.1' }, host: { name: 'testhost' }, labels: { camera: 'cam1' },
      user: { name: 'admin' }, source: { ip: '10.0.0.5' }, message: 'Admin signed in', cam_proxy: { auth: { method: 'token-form' } },
    });
  });

  it('starts a new file at UTC midnight', () => {
    const now = { t: T };
    const { dir, log } = make(now);
    log.write({ ...base, action: 'a', message: 'one' });
    now.t = T + 120_000;
    log.write({ ...base, action: 'b', message: 'two' });
    expect(readdirSync(dir).sort()).toEqual(['2026-10-01.jsonl', '2026-10-02.jsonl']);
  });

  it('copies each record to the logger and never throws on a failed write', () => {
    const info = vi.spyOn(logger, 'info');
    const error = vi.spyOn(logger, 'error');
    const now = { t: T };
    const { dir, log } = make(now);
    log.write({ ...base, action: 'login', message: 'm' });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ audit: true, ecs: expect.objectContaining({ message: 'm' }) }), 'audit');
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'not a folder'); // the folder is now a file: appends fail
    expect(log.write({ ...base, action: 'login', message: 'x' })).toBeNull();
    expect(error).toHaveBeenCalled();
    rmSync(dir, { force: true });
  });

  it('redacts values of secret-looking keys anywhere in the details', () => {
    const now = { t: T };
    const { dir, log } = make(now);
    log.write({ ...base, action: 'config-change', message: 'm', details: { changes: [{ key: 'server.adminToken', from: 'aaa', to: 'bbb' }], apiKey: 'k', nested: { password: 'p', fine: 1 } } });
    const text = readFileSync(join(dir, '2026-10-01.jsonl'), 'utf8');
    for (const s of ['"aaa"', '"bbb"', '"k"', '"p"']) expect(text).not.toContain(s);
    expect(redact({ token: 'x', list: [{ secretThing: 'y' }], n: 2 })).toEqual({ token: '[redacted]', list: [{ secretThing: '[redacted]' }], n: 2 });
    expect(redact({ auth: { tokenKind: 'client', reason: 'admin-only' } })).toEqual({ auth: { tokenKind: 'client', reason: 'admin-only' } });
  });

  // Issue #70: `secret` names an environment variable; any other value is redacted.
  it('keeps a secret field that names a known secret variable, redacts any other', () => {
    expect(redact({ secret: 'CAMPROXY_GOOGLE_VISION_KEY', masked: 'AIza…wXyZ', replaced: 'env' })).toEqual({ secret: 'CAMPROXY_GOOGLE_VISION_KEY', masked: 'AIza…wXyZ', replaced: 'env' });
    expect(redact({ secret: 'AIzaSyManualKey0000000wXyZ' })).toEqual({ secret: '[redacted]' });
    expect(redact({ secret: 'CAMPROXY_X with more' })).toEqual({ secret: '[redacted]' });
    expect(redact({ secret: 'CAMPROXY_ADMIN_TOKEN_VALUE' })).toEqual({ secret: '[redacted]' }); // only known names
    expect(redact({ secret: { name: 'CAMPROXY_X' } })).toEqual({ secret: '[redacted]' });
  });

  it('redacts a config change by its key name', () => {
    expect(redact({ changes: [{ key: 'camera.password', from: 'a', to: 'b' }, { key: 'retention.auditDays', from: 90, to: 30 }] })).toEqual({
      changes: [{ key: 'camera.password', from: '[redacted]', to: '[redacted]' }, { key: 'retention.auditDays', from: 90, to: 30 }],
    });
  });

  it('does not glue a record onto a partial last line left by a crash', () => {
    const now = { t: T };
    const { dir, log } = make(now);
    log.write({ ...base, action: 'a', message: 'first' });
    appendFileSync(join(dir, '2026-10-01.jsonl'), '{"broken');
    const again = new AuditLog({ dir, version: 'v', camera: () => 'cam1', now: () => now.t, host: 'h' });
    again.write({ ...base, action: 'a', message: 'after' });
    expect(again.list({}).records.map((r) => [r.message, r.cam_proxy!.cursor])).toEqual([['after', '2026-10-01:3'], ['first', '2026-10-01:1']]);
  });

  it('cuts a long user agent to 512 characters, never inside a surrogate pair', () => {
    const now = { t: T };
    const { log } = make(now);
    expect(log.write({ ...base, action: 'login', message: 'm', userAgent: 'a'.repeat(600) })!.user_agent).toEqual({ original: 'a'.repeat(512) });
    const ua = (log.write({ ...base, action: 'login', message: 'm', userAgent: 'a'.repeat(511) + '😀😀' })!.user_agent as { original: string }).original;
    expect(ua).toBe('a'.repeat(511));
    expect(ua).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('cut() keeps whole characters', () => {
    expect(cut('abc', 5)).toBe('abc');
    expect(cut('abcdef', 3)).toBe('abc');
    expect(cut('ab😀', 3)).toBe('ab');
    expect(cut('ab😀', 4)).toBe('ab😀');
  });

  it('lets the caller add ECS fields but not override the core ones', () => {
    const now = { t: T };
    const { log } = make(now);
    const r = log.write({ ...base, action: 'real', message: 'm', ecs: { event: { action: 'x' }, service: { name: 'evil' }, url: { path: '/a' } } })!;
    expect(r.event.action).toBe('real');
    expect(r.service).toEqual({ name: 'cam-proxy', version: '2026.10.01.1' });
    expect(r.url).toEqual({ path: '/a' });
  });

  it('copies the audit-throttled record to the logger too', () => {
    const info = vi.spyOn(logger, 'info');
    const now = { t: T };
    const { log } = make(now, { maxFileBytes: 10 });
    log.write({ ...base, action: 'login', message: 'fill' });
    log.write({ ...base, action: 'auth-refused', outcome: 'failure', message: 'r' });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ audit: true, ecs: expect.objectContaining({ event: expect.objectContaining({ action: 'audit-throttled' }) }) }), 'audit');
  });

  // Review focus 3.
  it('drops auth-refused past the size limit with one audit-throttled record; other actions still write', () => {
    const now = { t: T };
    const { dir, log } = make(now, { maxFileBytes: 2000 });
    for (let i = 0; i < 40; i++) log.write({ ...base, action: 'auth-refused', outcome: 'failure', message: `refused ${i}` });
    log.write({ ...base, action: 'login', message: 'still here' });
    const recs = readFileSync(join(dir, '2026-10-01.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(recs.filter((r) => r.event.action === 'audit-throttled')).toHaveLength(1);
    expect(recs.at(-1).message).toBe('still here');
    expect(recs.filter((r) => r.event.action === 'auth-refused').length).toBeLessThan(40);
  });
});

describe('AuditLog.list', () => {
  function seed() {
    const now = { t: Date.UTC(2026, 8, 29, 12) };
    const { log } = make(now);
    // 3 records on each of 3 days
    for (let d = 0; d < 3; d++) for (let i = 0; i < 3; i++) {
      now.t = Date.UTC(2026, 8, 29 + d, 12, i);
      log.write({ ...base, action: i === 2 ? 'logout' : 'login', outcome: i === 1 ? 'failure' : 'success', message: `d${d}i${i}` });
    }
    return log;
  }

  it('answers the newest first without a cursor', () => {
    const r = seed().list({ limit: 4 });
    expect(r.records.map((x) => x.message)).toEqual(['d2i2', 'd2i1', 'd2i0', 'd1i2']);
    expect(r.hasMore).toBe(true);
    expect(r.records[0].cam_proxy!.cursor).toBe('2026-10-01:3');
  });

  // Review focus 2.
  it('pages across file boundaries both ways, never repeating or skipping', () => {
    const log = seed();
    const seen: string[] = [];
    let page = log.list({ limit: 2 });
    for (;;) {
      seen.push(...page.records.map((x) => x.message));
      if (!page.hasMore) break;
      page = log.list({ limit: 2, before: page.next! });
    }
    expect(seen).toEqual(['d2i2', 'd2i1', 'd2i0', 'd1i2', 'd1i1', 'd1i0', 'd0i2', 'd0i1', 'd0i0']);
    const up: string[] = [];
    let after = log.list({ limit: 2, after: '' });
    for (;;) {
      up.push(...after.records.map((x) => x.message));
      if (!after.hasMore) break;
      after = log.list({ limit: 2, after: after.next! });
    }
    expect(up).toEqual([...seen].reverse());
    // A poller at the end keeps its cursor.
    expect(log.list({ after: after.next! })).toEqual({ records: [], next: after.next, hasMore: false });
  });

  it('filters by action, outcome and time', () => {
    const log = seed();
    expect(log.list({ actions: ['logout'] }).records.map((x) => x.message)).toEqual(['d2i2', 'd1i2', 'd0i2']);
    expect(log.list({ outcome: 'failure' }).records.map((x) => x.message)).toEqual(['d2i1', 'd1i1', 'd0i1']);
    expect(log.list({ from: Date.UTC(2026, 8, 30), to: Date.UTC(2026, 8, 30, 23) }).records.map((x) => x.message)).toEqual(['d1i2', 'd1i1', 'd1i0']);
  });

  it('refuses a bad cursor, a bad range and a bad limit', () => {
    const log = seed();
    expect(() => log.list({ before: 'nope' })).toThrow(AuditQueryError);
    expect(() => log.list({ before: '2026-10-01:1', after: '2026-10-01:1' })).toThrow(AuditQueryError);
    expect(() => log.list({ from: 10, to: 5 })).toThrow(AuditQueryError);
    expect(() => log.list({ limit: 0 })).toThrow(AuditQueryError);
    expect(() => log.list({ limit: 501 })).toThrow(AuditQueryError);
  });

  it('says hasMore only when a record is left past the limit, at the exact boundary too', () => {
    const log = seed(); // 9 records
    expect(log.list({ limit: 9 })).toMatchObject({ hasMore: false });
    expect(log.list({ limit: 8 })).toMatchObject({ hasMore: true });
    expect(log.list({ limit: 9, after: '' })).toMatchObject({ hasMore: false });
    expect(log.list({ limit: 8, after: '' })).toMatchObject({ hasMore: true });
    const first = log.list({ limit: 4 });
    expect(log.list({ limit: 5, before: first.next! })).toMatchObject({ hasMore: false });
    expect(log.list({ limit: 4, before: first.next! })).toMatchObject({ hasMore: true });
  });

  it('skips a corrupt line but keeps the line numbers', () => {
    const now = { t: T };
    const { dir, log } = make(now);
    log.write({ ...base, action: 'a', message: 'first' });
    writeFileSync(join(dir, '2026-10-01.jsonl'), readFileSync(join(dir, '2026-10-01.jsonl'), 'utf8') + '{broken\n');
    log.write({ ...base, action: 'a', message: 'third' });
    expect(log.list({}).records.map((r) => [r.message, r.cam_proxy!.cursor])).toEqual([['third', '2026-10-01:3'], ['first', '2026-10-01:1']]);
  });
});

describe('AuditLog files', () => {
  it('finds a record, deletes whole days before a date, measures the folder', () => {
    const now = { t: Date.UTC(2026, 8, 1, 1) };
    const { dir, log } = make(now);
    for (const d of [1, 2, 3]) { now.t = Date.UTC(2026, 8, d, 1); log.write({ ...base, action: 'storage-daily', message: `s${d}`, details: { day: `2026-09-0${d}` } }); }
    expect(log.find((r) => r.cam_proxy?.day === '2026-09-02', 31)?.message).toBe('s2');
    expect(log.usage()).toMatchObject({ files: 3, oldest: Date.UTC(2026, 8, 1), newest: Date.UTC(2026, 8, 3) });
    expect(log.deleteBefore('2026-09-03', true)).toBe(2);
    expect(readdirSync(dir)).toHaveLength(3);
    expect(log.deleteBefore('2026-09-03')).toBe(2);
    expect(readdirSync(dir)).toEqual(['2026-09-03.jsonl']);
  });

  // #78: growth per calendar day of the last 7 whole days; today's file is
  // left out by its date, not by its position (a quiet today has no file).
  it('measures growth per calendar day, leaving out only today', () => {
    const now = { t: Date.UTC(2026, 8, 10, 12) };
    const { dir, log } = make(now);
    // Whole days 09-07 and 09-09 (09-08 had no records), nothing yet today.
    writeFileSync(join(dir, '2026-09-07.jsonl'), 'x'.repeat(299) + '\n');
    writeFileSync(join(dir, '2026-09-09.jsonl'), 'x'.repeat(299) + '\n');
    expect(log.usage().growthPerDay).toBe(200); // 600 bytes over 3 calendar days
    writeFileSync(join(dir, '2026-09-10.jsonl'), 'x'.repeat(9999) + '\n');
    expect(log.usage().growthPerDay).toBe(200); // today's partial day doesn't count
    // At most the last 7 whole days.
    writeFileSync(join(dir, '2026-09-01.jsonl'), 'x'.repeat(699) + '\n');
    expect(log.usage().growthPerDay).toBe(600 / 7);
    // Only today: no whole day yet.
    rmSync(join(dir, '2026-09-01.jsonl'));
    rmSync(join(dir, '2026-09-07.jsonl'));
    rmSync(join(dir, '2026-09-09.jsonl'));
    expect(log.usage().growthPerDay).toBe(0);
  });

  it('refuses a malformed day in deleteBefore', () => {
    const now = { t: Date.UTC(2026, 8, 1, 1) };
    const { dir, log } = make(now);
    log.write({ ...base, action: 'a', message: 'm' });
    expect(log.deleteBefore('z')).toBe(0);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it('find limits by calendar days, not file count', () => {
    const now = { t: Date.UTC(2026, 8, 1, 1) };
    const { log } = make(now);
    for (const d of [1, 10]) { now.t = Date.UTC(2026, 8, d, 1); log.write({ ...base, action: 'a', message: `s${d}` }); }
    expect(log.find((r) => r.message === 's1', 2)).toBeUndefined();
    expect(log.find((r) => r.message === 's1', 10)?.message).toBe('s1');
    expect(log.find((r) => r.message === 's10', 0)?.message).toBe('s10');
  });
});

describe('AuditLog.list day skipping', () => {
  it('does not read the day files that from/to exclude', () => {
    const now = { t: Date.UTC(2026, 8, 29, 12) };
    const { log } = make(now);
    for (const d of [29, 30, 31]) {
      now.t = d === 31 ? Date.UTC(2026, 9, 1, 12) : Date.UTC(2026, 8, d, 12);
      log.write({ ...base, action: 'login', message: `day ${d}` });
    }
    const spy = vi.spyOn(log as unknown as { lines: (d: string) => string[] }, 'lines');
    const r = log.list({ from: Date.UTC(2026, 8, 30), to: Date.UTC(2026, 8, 30, 23, 59, 59, 999) });
    expect(r.records.map((x) => x.message)).toEqual(['day 30']);
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['2026-09-30']);
  });
});
