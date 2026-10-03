import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuditLog } from '../src/audit/audit-log';
import { InventoryBusyError, InventoryRunner, InventoryStoppingError, MAX_ITEMS, RepairRefusedError, RUN_ID, type Check, type CheckResult, type InventoryKind, type Repair, type RepairResult } from '../src/inventory/runner';

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
  return { dir, audit, runner, advance: (ms: number) => void (clock += ms) };
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

// PR 2 (#106): options, repairs apart from checks, one lock, cached summaries.
describe('InventoryRunner: options and repairs', () => {
  const repaired = (n: number): RepairResult => ({ counts: { requested: n, done: n, failed: 0, skipped: 0, bytes: n * 10 }, top: [], items: [{ id: 'a', result: 'ok' }], message: `${n} fetched`, stopped: null });
  // A clips kind whose check echoes its options and whose repair needs a camera compare.
  const clipsKind = (repair: Repair = async () => repaired(2)): InventoryKind => ({
    label: 'Clips',
    camera: true,
    run: async (ctx) => ({ ...result(1), counts: { missingSeconds: 1, camera: ctx.options?.camera ? 1 : 0 } }),
    repair: { run: repair, ready: (r) => (r.options?.camera ? null : 'compare with the camera first') },
  });
  const repairRecords = (a: AuditLog) => a.list({ actions: ['inventory-repair'] }).records;

  it('passes the camera option to the check, and keeps it in the report and the record', async () => {
    const { runner, audit } = setup({ clips: clipsKind() });
    const r = await runner.start('clips', who, { camera: true }).done;
    expect(r).toMatchObject({ op: 'check', options: { camera: true }, counts: { camera: 1 } });
    expect(records(audit)[0].cam_proxy).toMatchObject({ kind: 'clips', options: { camera: true } });
    const plain = await runner.start('clips', who).done;
    expect(plain).not.toHaveProperty('options');
    expect(plain.counts.camera).toBe(0);
  });

  it('runs a repair from a recent check report: saved apart, audited as inventory-repair', async () => {
    let seen: string | undefined;
    let own: string | undefined;
    const { runner, audit, dir } = setup({ clips: clipsKind(async (ctx) => ((seen = ctx.source.runId), (own = ctx.runId), repaired(2))) });
    const check = await runner.start('clips', who, { camera: true }).done;
    const { runId, done } = await runner.repair('clips', who, check.runId);
    expect(runId).toMatch(/^clipsrepair-\d+-[0-9a-f]{6}$/);
    expect(runner.running()).toMatchObject({ runId, kind: 'clips', op: 'repair' });
    const r = await done;
    expect(seen).toBe(check.runId);
    expect(own).toBe(runId); // the repair knows its own run id (#75 marks its rows with it)
    expect(r).toMatchObject({ runId, kind: 'clips', op: 'repair', outcome: 'ok', source: check.runId, stopped: null, window: check.window, counts: { done: 2, bytes: 20 }, message: 'Clips repair: 2 fetched' });
    expect(readdirSync(join(dir, 'inventory', 'clipsrepair'))).toEqual([`${runId}.json`]);
    expect(await runner.get(runId)).toEqual(r);
    expect((await runner.list()).clips.map((x) => x.runId)).toEqual([check.runId]);
    expect((await runner.listRepairs()).clips.map((x) => x.runId)).toEqual([runId]);
    expect(records(audit)).toHaveLength(1); // the check's
    const rec = repairRecords(audit);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({
      event: { action: 'inventory-repair', category: ['host'], type: ['change'], outcome: 'success' },
      user: { name: 'admin' }, message: 'Clips repair: 2 fetched',
      cam_proxy: { runId, kind: 'clips', source: check.runId, outcome: 'ok', stopped: null, counts: { requested: 2, done: 2 }, failures: [] },
    });
  });

  it('refuses a repair from a missing, foreign, unfinished, stale or unsuitable report', async () => {
    const { runner, advance } = setup({ clips: clipsKind(), stills: stillsKind(async () => result(1)) });
    const refused = async (id: string) => {
      try {
        await runner.repair('clips', who, id);
      } catch (e) {
        expect(e).toBeInstanceOf(RepairRefusedError);
        return (e as RepairRefusedError).code;
      }
      return 'started';
    };
    expect(await refused('clips-1-abcdef')).toBe('not_found');
    expect(await refused('../../catalog')).toBe('not_found');
    const stills = await runner.start('stills', who).done;
    expect(await refused(stills.runId)).toBe('not_found'); // another kind's report
    const local = await runner.start('clips', who).done;
    expect(await refused(local.runId)).toBe('not_repairable'); // no camera compare
    const compared = await runner.start('clips', who, { camera: true }).done;
    advance(3_600_000);
    expect(await refused(compared.runId)).toBe('report_stale');
    runner.checks.clips = { ...clipsKind(), run: async () => { throw new Error('boom'); } };
    const failed = await runner.start('clips', who, { camera: true }).done;
    expect(await refused(failed.runId)).toBe('not_repairable');
    expect(runner.running()).toBeNull();
    await expect(runner.repair('stills', who, stills.runId)).rejects.toThrow('no repair of kind stills');
  });

  it('a repair and a check share the one lock', async () => {
    let release: () => void = () => undefined;
    const { runner } = setup({ clips: clipsKind(() => new Promise((r) => (release = () => r(repaired(1))))) });
    const check = await runner.start('clips', who, { camera: true }).done;
    const rep = await runner.repair('clips', who, check.runId);
    expect(() => runner.start('clips', who)).toThrow(InventoryBusyError);
    await expect(runner.repair('clips', who, check.runId)).rejects.toBeInstanceOf(InventoryBusyError);
    release();
    expect((await rep.done).outcome).toBe('ok');
  });

  it('a cancelled repair keeps its partial counts and says who cancelled', async () => {
    const { runner, audit } = setup({ clips: clipsKind((ctx) => new Promise((r) => ctx.signal.addEventListener('abort', () => r({ ...repaired(1), stopped: 'paused' })))) });
    const check = await runner.start('clips', who, { camera: true }).done;
    const rep = await runner.repair('clips', who, check.runId);
    expect(runner.cancel()).toBe(rep.runId);
    const r = await rep.done;
    expect(r).toMatchObject({ outcome: 'cancelled', cancelledBy: 'request', counts: { done: 1 }, message: 'Clips repair cancelled (partial): 1 fetched' });
    expect(repairRecords(audit)[0]).toMatchObject({ event: { outcome: 'unknown' }, cam_proxy: { cancelledBy: 'request' } });
  });

  it('list() reads the saved reports once, and again after the next save', async () => {
    const { runner, dir } = setup({ stills: stillsKind(async () => result(1)) });
    const a = await runner.start('stills', who).done;
    expect((await runner.list()).stills.map((x) => x.runId)).toEqual([a.runId]);
    // A file that appears behind the runner's back is not seen until the next save.
    const other = { ...a, runId: 'stills-1-abcdef', startedAt: 1 };
    writeFileSync(join(dir, 'inventory', 'stills', 'stills-1-abcdef.json'), JSON.stringify(other));
    expect((await runner.list()).stills).toHaveLength(1);
    const b = await runner.start('stills', who).done;
    expect((await runner.list()).stills.map((x) => x.runId)).toEqual([b.runId, a.runId, 'stills-1-abcdef']);
  });
});

describe('InventoryRunner: cache, restart, stop (review fixes)', () => {
  const repaired = (n: number): RepairResult => ({ counts: { requested: n, done: n, failed: 0, skipped: 0, bytes: n }, top: [], items: [], message: `${n} fetched`, stopped: null });
  const clips = (repair: Repair): InventoryKind => ({
    label: 'Clips', camera: true,
    run: async () => result(1),
    repair: { run: repair, ready: () => null },
  });

  it('a save that lands while list() reads does not leave a stale list cached', async () => {
    const { runner } = setup({ stills: stillsKind(async () => result(1)) });
    const a = await runner.start('stills', who).done;
    (runner as unknown as { summaries: Map<string, unknown> }).summaries.clear();
    const priv = runner as unknown as { read: (f: string, id: string) => Promise<unknown> };
    const real = priv.read.bind(runner);
    let gate: () => void = () => undefined;
    const held = new Promise<void>((r) => (gate = r));
    let first = true;
    priv.read = async (f, id) => {
      if (first) {
        first = false;
        await held;
      }
      return real(f, id);
    };
    const inflight = runner.list();
    await new Promise((r) => setTimeout(r, 20));
    const b = await runner.start('stills', who).done;
    gate();
    await inflight;
    expect((await runner.list()).stills.map((x) => x.runId)).toEqual([b.runId, a.runId]);
  });

  it('list() and listRepairs() return copies', async () => {
    const { runner } = setup({ clips: clips(async () => repaired(1)) });
    const c = await runner.start('clips', who).done;
    const rep = await runner.repair('clips', who, c.runId);
    await rep.done;
    (await runner.list()).clips.pop();
    (await runner.listRepairs()).clips.pop();
    expect((await runner.list()).clips).toHaveLength(1);
    expect((await runner.listRepairs()).clips).toHaveLength(1);
  });

  it('drops the camera option for a kind without a compare', async () => {
    const { runner } = setup({ stills: stillsKind(async () => result(1)) });
    const r = await runner.start('stills', who, { camera: true }).done;
    expect(r).not.toHaveProperty('options');
  });

  it('a fresh runner on the same folder lists and reads the earlier runs', async () => {
    const { runner, dir, audit } = setup({ clips: clips(async () => repaired(1)) });
    const c = await runner.start('clips', who).done;
    const rep = await (await runner.repair('clips', who, c.runId)).done;
    const again = new InventoryRunner({ dir: join(dir, 'inventory'), audit, camera: () => 'cam1', checks: { clips: clips(async () => repaired(1)) } });
    expect((await again.list()).clips.map((x) => x.runId)).toEqual([c.runId]);
    expect((await again.listRepairs()).clips.map((x) => x.runId)).toEqual([rep.runId]);
    expect(await again.get(rep.runId)).toEqual(rep);
  });

  it('a repair that throws a non-Error releases the lock and audits a failure', async () => {
    const { runner, audit } = setup({ clips: clips(async () => { throw 'boom'; }) });
    const c = await runner.start('clips', who).done;
    const r = await (await runner.repair('clips', who, c.runId)).done;
    expect(r).toMatchObject({ outcome: 'failed', error: 'boom', message: 'Clips repair failed: boom' });
    expect(runner.running()).toBeNull();
    expect(audit.list({ actions: ['inventory-repair'] }).records[0]).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'boom' } });
    expect(() => runner.start('clips', who)).not.toThrow();
  });

  it('stop() during a repair cancels it, and a later repair is refused as stopping', async () => {
    const { runner, audit } = setup({ clips: clips((ctx) => new Promise((r) => ctx.signal.addEventListener('abort', () => r({ ...repaired(1), stopped: 'paused' })))) });
    const c = await runner.start('clips', who).done;
    const rep = await runner.repair('clips', who, c.runId);
    await runner.stop();
    expect(await rep.done).toMatchObject({ outcome: 'cancelled', cancelledBy: 'stop', stopped: 'paused' });
    expect(audit.list({ actions: ['inventory-repair'] }).records[0]).toMatchObject({ cam_proxy: { cancelledBy: 'stop' } });
    await expect(runner.repair('clips', who, c.runId)).rejects.toBeInstanceOf(InventoryStoppingError);
  });
});
