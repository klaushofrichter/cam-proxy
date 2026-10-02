import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLog } from '../src/audit/audit-log';
import { InventoryBusyError, InventoryRunner, InventoryStoppingError, MAX_ITEMS, RUN_ID, type Check, type CheckResult, type InventoryKind } from '../src/inventory/runner';

const T0 = Date.UTC(2026, 9, 2, 12, 0);
const result = (n: number, items = 0): CheckResult => ({
  window: { from: T0 - 60_000, to: T0, reason: 'retention' },
  counts: { missingSeconds: n },
  top: Array.from({ length: 12 }, (_, i) => ({ i })),
  items: Array.from({ length: items }, (_, i) => ({ i })),
  message: `${n} s missing`,
});

// A check that reports progress, then waits until released (5 s missing) or
// cancelled (2 s missing: the partial counts).
function gated() {
  let release: () => void = () => undefined;
  const check: Check = (ctx) =>
    new Promise((resolve) => {
      ctx.progress({ phase: 'stills', done: 1, total: 8, note: '2026-09-25' });
      release = () => resolve(result(5));
      ctx.signal.addEventListener('abort', () => resolve(result(2)));
    });
  return { check, release: () => release() };
}

// The check table's entry for a kind: its label and its check.
const stillsKind = (run: Check): InventoryKind => ({ label: 'Stills', run });

// Every runner clock read moves 1 s on: a run takes 1000 ms, and runs get distinct start times.
function setup(checks: Record<string, InventoryKind>) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-inv-'));
  let clock = T0;
  const audit = new AuditLog({ dir: join(dir, 'audit'), version: 't', camera: () => 'cam1', now: () => clock });
  const runner = new InventoryRunner({ dir: join(dir, 'inventory'), audit, camera: () => 'cam1', checks, now: () => (clock += 1000) });
  return { dir, audit, runner };
}
const who = { requestedBy: 'token' as const, ip: '10.0.0.5', userAgent: 'vitest' };
const records = (a: AuditLog) => a.list({ actions: ['inventory'] }).records;

describe('InventoryRunner', () => {
  it('runs a check, saves the report and writes one inventory record', async () => {
    const { runner, audit, dir } = setup({ stills: stillsKind(async () => result(7)) });
    const { runId, done } = runner.start('stills', who);
    expect(runId).toMatch(RUN_ID);
    expect(runId.startsWith('stills-')).toBe(true);
    const r = await done;
    expect(r).toMatchObject({ runId, kind: 'stills', camera: 'cam1', outcome: 'ok', requestedBy: 'token', tookMs: 1000, counts: { missingSeconds: 7 }, message: 'Stills inventory: 7 s missing', itemsTruncated: false });
    expect(r.top).toHaveLength(10);
    expect(JSON.parse(readFileSync(join(dir, 'inventory', 'stills', `${runId}.json`), 'utf8'))).toEqual(r);
    const recs = records(audit);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      event: { action: 'inventory', category: ['host'], type: ['info'], outcome: 'success' },
      user: { name: 'admin' }, source: { ip: '10.0.0.5' }, message: 'Stills inventory: 7 s missing',
      cam_proxy: { runId, kind: 'stills', outcome: 'ok', requestedBy: 'token', counts: { missingSeconds: 7 }, tookMs: 1000 },
    });
    expect((recs[0].cam_proxy as { top: unknown[] }).top).toHaveLength(10);
    expect(runner.running()).toBeNull();
  });

  it('one run at a time: a second start is refused with the running id; progress shows', async () => {
    const g = gated();
    const { runner } = setup({ stills: stillsKind(g.check) });
    const a = runner.start('stills', who);
    let busy: unknown;
    try {
      runner.start('stills', who);
    } catch (e) {
      busy = e;
    }
    expect(busy).toBeInstanceOf(InventoryBusyError);
    expect((busy as InventoryBusyError).runId).toBe(a.runId);
    expect(runner.running()).toMatchObject({ runId: a.runId, kind: 'stills', outcome: 'running', progress: { phase: 'stills', done: 1, total: 8, note: '2026-09-25' } });
    expect(await runner.get(a.runId)).toMatchObject({ outcome: 'running' });
    g.release();
    expect((await a.done).outcome).toBe('ok');
    const b = runner.start('stills', who); // the lock is free again
    expect(b.runId).not.toBe(a.runId);
    runner.cancel();
    await b.done;
  });

  it('cancel keeps the partial counts; the record is unknown and says who cancelled', async () => {
    const g = gated();
    const { runner, audit } = setup({ stills: stillsKind(g.check) });
    const { runId, done } = runner.start('stills', who);
    expect(runner.cancel()).toBe(runId);
    const r = await done;
    expect(r).toMatchObject({ outcome: 'cancelled', cancelledBy: 'request', counts: { missingSeconds: 2 }, message: 'Stills inventory cancelled (partial): 2 s missing' });
    expect(r).not.toHaveProperty('error');
    expect(records(audit)[0]).toMatchObject({ event: { outcome: 'unknown' }, cam_proxy: { outcome: 'cancelled', cancelledBy: 'request' } });
    expect(runner.cancel()).toBeNull();
  });

  it('a check that throws ends failed, is audited and frees the lock', async () => {
    const { runner, audit } = setup({ stills: stillsKind(async () => { throw new Error('disk gone'); }) });
    const r = await runner.start('stills', who).done;
    expect(r).toMatchObject({ outcome: 'failed', error: 'disk gone', counts: {}, window: null, top: [], items: [], message: 'Stills inventory failed: disk gone' });
    expect(records(audit)[0]).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'disk gone' } });
    expect(runner.running()).toBeNull();
  });

  it('keeps the last 10 runs per kind; the list is newest first, without top and items', async () => {
    const { runner, dir } = setup({ stills: stillsKind(async () => result(1)) });
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const s = runner.start('stills', who);
      ids.push(s.runId);
      await s.done;
    }
    expect(readdirSync(join(dir, 'inventory', 'stills')).sort()).toEqual(ids.slice(2).map((id) => `${id}.json`).sort());
    const list = await runner.list();
    expect(list.stills.map((x) => x.runId)).toEqual(ids.slice(2).reverse());
    expect(list.stills[0]).toEqual({ runId: ids[11], kind: 'stills', startedAt: expect.any(Number), tookMs: 1000, outcome: 'ok', counts: { missingSeconds: 1 }, message: 'Stills inventory: 1 s missing' });
    expect(await runner.get(ids[0])).toBeUndefined();
    expect((await runner.get(ids[11]))!).toMatchObject({ runId: ids[11], outcome: 'ok' });
    expect(await runner.get('../../catalog.sqlite')).toBeUndefined();
  });

  it('caps the items at 500 and says so', async () => {
    const { runner } = setup({ stills: stillsKind(async () => result(1, MAX_ITEMS + 1)) });
    const r = await runner.start('stills', who).done;
    expect(r.items).toHaveLength(MAX_ITEMS);
    expect(r.itemsTruncated).toBe(true);
  });

  it('stop() cancels a running check as "stop" and waits for its record', async () => {
    const g = gated();
    const { runner, audit } = setup({ stills: stillsKind(g.check) });
    runner.start('stills', who);
    await runner.stop();
    expect(records(audit)[0].cam_proxy).toMatchObject({ outcome: 'cancelled', cancelledBy: 'stop' });
    expect(runner.running()).toBeNull();
    await runner.stop(); // nothing runs: returns at once
  });

  it('refuses to start once stop() was called', async () => {
    const { runner } = setup({ stills: stillsKind(async () => result(1)) });
    await runner.stop();
    expect(() => runner.start('stills', who)).toThrow(InventoryStoppingError);
    expect(runner.running()).toBeNull();
  });

  it('takes the label of each kind from the check table', async () => {
    const { runner } = setup({ stills: stillsKind(async () => result(1)), clips: { label: 'Clips', run: async () => result(2) } });
    expect(runner.kinds()).toEqual(['stills', 'clips']);
    expect((await runner.start('clips', who).done).message).toBe('Clips inventory: 2 s missing');
  });

  it('knows only the kinds it has a check for', () => {
    const { runner } = setup({ stills: stillsKind(async () => result(0)) });
    expect(runner.kinds()).toEqual(['stills']);
    expect(() => runner.start('clips', who)).toThrow('no inventory of kind clips');
  });

  it.each([['null', null, 'null'], ['an object', {}, '[object Object]'], ['a string', 'x', 'x']])('a check that throws %s ends failed and frees the lock', async (_n, thrown, text) => {
    const { runner, audit } = setup({ stills: stillsKind(async () => { throw thrown; }) });
    const r = await runner.start('stills', who).done;
    expect(r).toMatchObject({ outcome: 'failed', error: text, message: `Stills inventory failed: ${text}` });
    expect(records(audit)[0]).toMatchObject({ event: { outcome: 'failure' } });
    expect(runner.running()).toBeNull();
    expect(() => runner.start('stills', who)).not.toThrow();
  });

  it('a save failure still frees the lock and writes the audit record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-inv-'));
    writeFileSync(join(dir, 'blocker'), 'x'); // a file where the directory should be
    const audit = new AuditLog({ dir: join(dir, 'audit'), version: 't', camera: () => 'cam1', now: () => T0 });
    const runner = new InventoryRunner({ dir: join(dir, 'blocker', 'inventory'), audit, camera: () => 'cam1', checks: { stills: stillsKind(async () => result(3)) } });
    const r = await runner.start('stills', who).done;
    expect(r.outcome).toBe('ok');
    expect(records(audit)).toHaveLength(1);
    expect(runner.running()).toBeNull();
  });

  it('inherited names are not kinds', () => {
    const { runner } = setup({ stills: stillsKind(async () => result(0)) });
    expect(() => runner.start('constructor', who)).toThrow('no inventory of kind constructor');
  });

  it('a check that finished before the cancel is ok, not cancelled', async () => {
    const { runner } = setup({ stills: stillsKind(async () => result(4)) });
    const { done } = runner.start('stills', who);
    await Promise.resolve();
    await Promise.resolve();
    runner.cancel();
    expect((await done).outcome).toBe('ok');
  });
});
