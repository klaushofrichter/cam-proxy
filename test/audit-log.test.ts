import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLog, AuditQueryError, redact } from '../src/audit/audit-log';
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

  it('redacts a config change by its key name', () => {
    expect(redact({ changes: [{ key: 'camera.password', from: 'a', to: 'b' }, { key: 'retention.auditDays', from: 90, to: 30 }] })).toEqual({
      changes: [{ key: 'camera.password', from: '[redacted]', to: '[redacted]' }, { key: 'retention.auditDays', from: 90, to: 30 }],
    });
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
});
