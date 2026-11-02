// The post-move sync (issue #311, src/moves/sync.ts): after a move finished
// on the receiving proxy, or a cancel past the switch-over gave the camera
// back to the original proxy, that proxy compares its clips and events with
// the camera's SD card and fetches what is missing. A scripted inventory
// runner here; the real one against cam-sim in test/move-sync-flow.test.ts.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { InventoryBusyError, InventoryStoppingError, type InventoryReport } from '../src/inventory/runner';
import { setLogLevel } from '../src/log';
import { MoveJournal, type MoveRecord } from '../src/moves/journal';
import { MoveSync, SYNC_GIVE_UP_MS, SYNC_RETRY_MS, SYNC_RETRY_CAP_MS, type SyncReadiness } from '../src/moves/sync';

const MOVE = 'mv_0123456789ABCDEFGHJK';
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeAll(() => setLogLevel('silent'));

type Step =
  | { op: 'check'; kind: 'clips' | 'events'; counts?: Record<string, number>; outcome?: InventoryReport['outcome']; error?: string; cancelledBy?: 'request' | 'stop' }
  | { op: 'repair'; kind: 'clips' | 'events'; counts?: Record<string, number>; stopped?: string | null; outcome?: InventoryReport['outcome']; error?: string }
  | 'busy'
  | 'stopping';

// An inventory runner that answers from a script, in order; it records each call.
function fakeRunner(script: Step[]) {
  const calls: string[] = [];
  const who: unknown[] = [];
  let n = 0;
  const next = (what: string): Exclude<Step, 'busy' | 'stopping'> => {
    const s = script.shift();
    if (!s) throw new Error(`no script step for ${what}`);
    if (s === 'busy') throw new InventoryBusyError('clips-1-aaaaaa');
    if (s === 'stopping') throw new InventoryStoppingError();
    return s;
  };
  const report = (s: Exclude<Step, 'busy' | 'stopping'>, cam: string): InventoryReport => ({
    runId: `${s.op === 'repair' ? `${s.kind}repair` : s.kind}-${1000 + ++n}-abcdef`, kind: s.kind, op: s.op, camera: cam, startedAt: 0, tookMs: 1,
    outcome: s.outcome ?? 'ok', ...(s.error ? { error: s.error } : {}), ...('cancelledBy' in s && s.cancelledBy ? { cancelledBy: s.cancelledBy } : {}),
    requestedBy: 'system', window: null, counts: s.counts ?? {}, top: [], items: [], itemsTruncated: false, message: '',
    ...(s.op === 'repair' ? { stopped: s.stopped ?? null } : {}),
  });
  return {
    calls, who,
    left: () => script.length,
    start(kind: string, w: unknown, req: { cam: string; camera?: boolean }) {
      calls.push(`check ${kind}${req.camera ? ' camera' : ''} ${req.cam}`);
      who.push(w);
      const s = next(`check ${kind}`);
      expect(s).toMatchObject({ op: 'check', kind });
      return { runId: 'x', done: Promise.resolve(report(s, req.cam)) };
    },
    async repair(kind: string, w: unknown, runId: string) {
      calls.push(`repair ${kind} ${runId}`);
      who.push(w);
      const s = next(`repair ${kind}`);
      expect(s).toMatchObject({ op: 'repair', kind });
      return { runId: 'y', done: Promise.resolve(report(s, 'cam3')) };
    },
  };
}

type AuditRec = { action: string; outcome: string; message: string; camera?: string; user?: string; details?: Record<string, any> };

function unit(script: Step[], o: { ready?: () => SyncReadiness; now?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-sync-'));
  let now = o.now ?? Date.UTC(2026, 10, 2, 12);
  const journal = new MoveJournal(dir, undefined, { now: () => now });
  const runner = fakeRunner(script);
  const audits: AuditRec[] = [];
  const scheduled: { key: string; at: number }[] = [];
  const sleeps: number[] = [];
  let ready: () => SyncReadiness = o.ready ?? (() => 'ok');
  const make = () =>
    new MoveSync({
      journal, runner, ready: (cam) => (expect(cam).toBe('cam3'), ready()),
      audit: { write: (r) => (audits.push(r as AuditRec), null) },
      now: () => now,
      proxyId: () => 'prx_2123456789ABCDEFGHJK',
      schedule: (key, at) => void scheduled.push({ key, at }),
      sleep: async (ms) => void sleeps.push(ms),
    });
  const sync = make();
  return {
    dir, journal, runner, audits, scheduled, sleeps, sync, make,
    tick: (ms: number) => void (now += ms),
    get now() { return now; },
    setReady: (f: () => SyncReadiness) => void (ready = f),
    syncOf: (role: 'source' | 'target' = 'target') => journal.ended(MOVE, role)?.sync,
    actions: () => audits.filter((a) => a.action === 'move-sync'),
  };
}
type Unit = ReturnType<typeof unit>;

// The receiving proxy's finished move (its tombstone) with the sync asked for.
const finished = (u: Unit) => {
  u.journal.bury({ moveId: MOVE, role: 'target', phase: 'finished' });
  u.sync.finished(MOVE, 'cam3');
};
// The original proxy's cancel after the switch-over (its tombstone names the camera).
const cancelled = (u: Unit) => {
  u.journal.bury({ moveId: MOVE, role: 'source', phase: 'cancelled', camera: 'cam3' });
  u.sync.cancelled(MOVE, 'cam3');
};

const clipsCheck = (missing: number): Step => ({ op: 'check', kind: 'clips', counts: { missingLocally: missing } });
const clipsRepair = (done: number, stopped: string | null = null): Step => ({ op: 'repair', kind: 'clips', counts: { done }, stopped });
const eventsCheck = (missing: number): Step => ({ op: 'check', kind: 'events', counts: { missingEvents: missing } });
const eventsRepair = (done: number): Step => ({ op: 'repair', kind: 'events', counts: { done } });

describe('the post-move sync loop', () => {
  it('checks the clips with the camera, repairs until nothing is missing, then the events once; recorded and audited', async () => {
    const u = unit([clipsCheck(3), clipsRepair(2, 'clip-cap'), clipsCheck(1), clipsRepair(1), clipsCheck(0), eventsCheck(2), eventsRepair(2)]);
    finished(u);
    expect(u.syncOf()).toMatchObject({ state: 'pending', trigger: 'finished', camera: 'cam3', attempts: 0 });
    // Due at once: scheduled for now.
    expect(u.scheduled).toEqual([{ key: `${MOVE}.target`, at: u.now }]);
    await u.sync.process(MOVE, 'target');
    expect(u.runner.calls).toEqual([
      'check clips camera cam3', 'repair clips clips-1001-abcdef', 'check clips camera cam3', 'repair clips clips-1003-abcdef', 'check clips camera cam3',
      'check events cam3', 'repair events events-1006-abcdef',
    ]);
    expect(u.runner.left()).toBe(0);
    // The runs it starts are the system's (the inventory records say so).
    expect(u.runner.who.every((w) => (w as { requestedBy: string; user: string }).requestedBy === 'system' && (w as { user: string }).user === 'move-sync')).toBe(true);
    const s = u.syncOf()!;
    expect(s).toMatchObject({
      state: 'done', trigger: 'finished', camera: 'cam3', attempts: 1, startedAt: u.now, finishedAt: u.now,
      clips: { missingBefore: 3, fetched: 3, missingAfter: 0, rounds: 3, stopped: null },
      events: { missing: 2, added: 2 },
    });
    expect(s.error).toBeUndefined();
    // Two move-sync records: the start and the end.
    const a = u.actions();
    expect(a.map((r) => [r.details!.step, r.outcome])).toEqual([['start', 'success'], ['end', 'success']]);
    expect(a[0]).toMatchObject({ camera: 'cam3', user: 'system', details: { moveId: MOVE, camera: 'cam3', role: 'target', trigger: 'finished' } });
    expect(a[1].details).toMatchObject({ moveId: MOVE, camera: 'cam3', role: 'target', trigger: 'finished', state: 'done', attempts: 1, clips: s.clips, events: s.events, stopped: null });
    expect(a[1].message).toContain('3 missing');
    // Done: processing again does nothing.
    await u.sync.process(MOVE, 'target');
    expect(u.runner.calls).toHaveLength(7);
  });

  it('nothing missing: one check of each kind, no repair', async () => {
    const u = unit([clipsCheck(0), eventsCheck(0)]);
    finished(u);
    await u.sync.process(MOVE, 'target');
    expect(u.runner.calls).toEqual(['check clips camera cam3', 'check events cam3']);
    expect(u.syncOf()).toMatchObject({ state: 'done', clips: { missingBefore: 0, fetched: 0, missingAfter: 0, rounds: 1, stopped: null }, events: { missing: 0, added: 0 } });
  });

  for (const stop of ['retention-full', 'paused', 'failures', 'refused']) {
    it(`a repair that stops (${stop}) ends the clips loop after one more check; the events still run`, async () => {
      const u = unit([clipsCheck(5), clipsRepair(1, stop), clipsCheck(4), eventsCheck(0)]);
      finished(u);
      await u.sync.process(MOVE, 'target');
      expect(u.runner.left()).toBe(0);
      expect(u.syncOf()).toMatchObject({ state: 'done', clips: { missingBefore: 5, fetched: 1, missingAfter: 4, rounds: 2, stopped: stop } });
      expect(u.actions().at(-1)!.details).toMatchObject({ stopped: stop });
    });
  }

  it('a repair that fetches nothing ends the loop (nothing-fetched)', async () => {
    const u = unit([clipsCheck(2), clipsRepair(0), clipsCheck(2), eventsCheck(0)]);
    finished(u);
    await u.sync.process(MOVE, 'target');
    expect(u.syncOf()!.clips).toEqual({ missingBefore: 2, fetched: 0, missingAfter: 2, rounds: 2, stopped: 'nothing-fetched' });
  });

  it('the caps of one repair run (clip-cap, byte-cap) go on to the next round', async () => {
    const u = unit([clipsCheck(120), clipsRepair(50, 'clip-cap'), clipsCheck(70), clipsRepair(10, 'byte-cap'), clipsCheck(60), clipsRepair(60), clipsCheck(0), eventsCheck(0)]);
    finished(u);
    await u.sync.process(MOVE, 'target');
    expect(u.syncOf()!.clips).toEqual({ missingBefore: 120, fetched: 120, missingAfter: 0, rounds: 4, stopped: null });
  });

  it('at most 20 checks (round-cap)', async () => {
    const script: Step[] = [];
    for (let i = 0; i < 19; i++) script.push(clipsCheck(100 - i), clipsRepair(1, 'clip-cap'));
    script.push(clipsCheck(81), eventsCheck(0));
    const u = unit(script);
    finished(u);
    await u.sync.process(MOVE, 'target');
    expect(u.runner.left()).toBe(0);
    expect(u.syncOf()!.clips).toEqual({ missingBefore: 100, fetched: 19, missingAfter: 81, rounds: 20, stopped: 'round-cap' });
  });

  it('a person cancelling one of its runs ends it failed (cancelled), audited', async () => {
    const u = unit([{ op: 'check', kind: 'clips', outcome: 'cancelled', cancelledBy: 'request' }]);
    finished(u);
    await u.sync.process(MOVE, 'target');
    expect(u.syncOf()).toMatchObject({ state: 'failed', error: 'cancelled' });
    expect(u.actions().map((r) => [r.details!.step, r.outcome])).toEqual([['start', 'success'], ['end', 'failure']]);
  });

  it('a camera no longer here (moved on, removed): failed (camera_gone), not retried', async () => {
    const u = unit([], { ready: () => 'gone' });
    finished(u);
    await u.sync.process(MOVE, 'target');
    expect(u.syncOf()).toMatchObject({ state: 'failed', error: 'camera_gone' });
    expect(u.scheduled).toHaveLength(1); // only the first
    expect(u.actions().at(-1)).toMatchObject({ outcome: 'failure', details: { step: 'end', state: 'failed', error: 'camera_gone' } });
  });
});

describe('waiting and retrying', () => {
  it('another inventory running: it waits and tries again, without using up an attempt', async () => {
    const u = unit(['busy', 'busy', clipsCheck(1), 'busy', clipsRepair(1), clipsCheck(0), eventsCheck(0)]);
    finished(u);
    await u.sync.process(MOVE, 'target');
    expect(u.sleeps).toEqual([30_000, 30_000, 30_000]);
    expect(u.syncOf()).toMatchObject({ state: 'done', attempts: 1, clips: { fetched: 1, missingAfter: 0 } });
  });

  it('the camera offline: retried later with a backoff (1 min, doubling, at most 30 min), no audit record per retry; then done', async () => {
    const u = unit([clipsCheck(1), clipsRepair(1), clipsCheck(0), eventsCheck(0)], { ready: () => 'offline' });
    finished(u);
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      await u.sync.process(MOVE, 'target');
      const s = u.syncOf()!;
      expect(s).toMatchObject({ state: 'pending', attempts: i + 1, error: 'camera_offline' });
      delays.push(s.dueAt - u.now);
      expect(u.scheduled.at(-1)).toEqual({ key: `${MOVE}.target`, at: s.dueAt });
      // Not due yet: nothing happens.
      await u.sync.process(MOVE, 'target');
      expect(u.syncOf()!.attempts).toBe(i + 1);
      u.tick(s.dueAt - u.now);
    }
    expect(SYNC_RETRY_MS).toBe(MIN);
    expect(SYNC_RETRY_CAP_MS).toBe(30 * MIN);
    expect(delays).toEqual([1, 2, 4, 8, 16, 30, 30].map((m) => m * MIN));
    // Only the start so far.
    expect(u.actions().map((r) => r.details!.step)).toEqual(['start']);
    u.setReady(() => 'ok');
    await u.sync.process(MOVE, 'target');
    expect(u.syncOf()).toMatchObject({ state: 'done', attempts: 8, clips: { missingBefore: 1, fetched: 1, missingAfter: 0 } });
    expect(u.syncOf()!.error).toBeUndefined();
    expect(u.actions().map((r) => [r.details!.step, r.outcome])).toEqual([['start', 'success'], ['end', 'success']]);
    expect(u.actions()[1].details).toMatchObject({ attempts: 8 });
  });

  it('a check that fails (camera_offline) or a repair stopped by an offline camera: retried, going on from the clips', async () => {
    const u = unit([
      { op: 'check', kind: 'clips', outcome: 'failed', error: 'camera_offline: no answer' },
      clipsCheck(2), clipsRepair(1, 'camera_offline'),
      clipsCheck(1), clipsRepair(1), clipsCheck(0), { op: 'check', kind: 'events', outcome: 'failed', error: 'search failed' },
      eventsCheck(1), eventsRepair(1),
    ]);
    finished(u);
    await u.sync.process(MOVE, 'target');
    expect(u.syncOf()).toMatchObject({ state: 'pending', attempts: 1, error: 'camera_offline: no answer' });
    u.tick(MIN);
    await u.sync.process(MOVE, 'target');
    expect(u.syncOf()).toMatchObject({ state: 'pending', attempts: 2, error: 'camera_offline', clips: { missingBefore: 2, fetched: 1 } });
    u.tick(2 * MIN);
    await u.sync.process(MOVE, 'target');
    // The clips are done; the events check failed: the next try starts at the events.
    expect(u.syncOf()).toMatchObject({ state: 'pending', attempts: 3, step: 'events', error: 'search failed', clips: { missingBefore: 2, fetched: 2, missingAfter: 0, stopped: null } });
    u.tick(4 * MIN);
    await u.sync.process(MOVE, 'target');
    expect(u.runner.left()).toBe(0);
    expect(u.syncOf()).toMatchObject({ state: 'done', attempts: 4, clips: { missingBefore: 2, fetched: 2, missingAfter: 0 }, events: { missing: 1, added: 1 } });
  });

  it('gives up 24 h after it became due: gave-up with the reason and the attempts, audited', async () => {
    const u = unit([], { ready: () => 'offline' });
    finished(u);
    expect(SYNC_GIVE_UP_MS).toBe(24 * HOUR);
    let guard = 0;
    while (u.syncOf()!.state === 'pending' && guard++ < 200) {
      await u.sync.process(MOVE, 'target');
      const s = u.syncOf()!;
      if (s.state === 'pending') u.tick(s.dueAt - u.now);
    }
    const s = u.syncOf()!;
    expect(s).toMatchObject({ state: 'gave-up', error: 'camera_offline', finishedAt: u.now });
    expect(u.now - s.since!).toBeGreaterThanOrEqual(24 * HOUR);
    const give = u.actions().at(-1)!;
    expect(u.actions().map((r) => r.details!.step)).toEqual(['start', 'give-up']);
    expect(give).toMatchObject({ outcome: 'failure', details: { moveId: MOVE, camera: 'cam3', role: 'target', trigger: 'finished', state: 'gave-up', reason: 'camera_offline', attempts: s.attempts } });
    expect(s.attempts).toBeGreaterThan(40);
  });

  it('the proxy stopping: the sync stays pending (resumed at the next start), no end record', async () => {
    const u = unit([clipsCheck(2), 'stopping']);
    finished(u);
    await u.sync.process(MOVE, 'target');
    expect(u.syncOf()).toMatchObject({ state: 'pending', clips: { missingBefore: 2 } });
    expect(u.actions().map((r) => r.details!.step)).toEqual(['start']);
  });

  it('survives a restart: a pending or running sync is taken up again by resume()', async () => {
    const u = unit([clipsCheck(1), clipsRepair(1), clipsCheck(0), eventsCheck(0)], { ready: () => 'offline' });
    finished(u);
    await u.sync.process(MOVE, 'target');
    // A crash while it ran leaves `running` in the tombstone.
    u.journal.setSync(MOVE, 'target', { ...u.syncOf()!, state: 'running' });
    u.setReady(() => 'ok');
    const again = u.make();
    u.scheduled.length = 0;
    again.resume();
    expect(u.syncOf()!.state).toBe('pending');
    expect(u.scheduled).toEqual([{ key: `${MOVE}.target`, at: u.syncOf()!.dueAt }]);
    u.tick(MIN);
    await again.process(MOVE, 'target');
    expect(u.syncOf()).toMatchObject({ state: 'done', attempts: 2, clips: { fetched: 1, missingAfter: 0 } });
    // One start record over both runs.
    expect(u.actions().map((r) => r.details!.step)).toEqual(['start', 'end']);
  });

  it('asked twice for the same move: one sync', () => {
    const u = unit([]);
    finished(u);
    u.sync.finished(MOVE, 'cam3');
    expect(u.scheduled).toHaveLength(1);
  });

  it('lists the syncs it knows (newest first), for the control API', async () => {
    const u = unit([clipsCheck(0), eventsCheck(0)]);
    finished(u);
    await u.sync.process(MOVE, 'target');
    expect(u.sync.list()).toEqual([{ moveId: MOVE, role: 'target', camera: 'cam3', sync: u.syncOf() }]);
  });
});

describe('after a cancel: the original proxy waits for the copy back', () => {
  it('pending, waiting for the return; the return finishing makes it due at once', async () => {
    const u = unit([clipsCheck(1), clipsRepair(1), clipsCheck(0), eventsCheck(0)]);
    cancelled(u);
    const s = u.syncOf('source')!;
    expect(s).toMatchObject({ state: 'pending', trigger: 'cancelled', camera: 'cam3', waitReturn: true });
    expect(s.dueAt - u.now).toBe(30 * MIN);
    await u.sync.process(MOVE, 'source');
    expect(u.runner.calls).toEqual([]);
    // The copy back runs here (a return record of this move): still waiting.
    u.journal.save({ v: 1, id: 'mv_9123456789ABCDEFGHJK', role: 'target', returnOf: MOVE, camera: 'cam3', phase: 'copying', plan: null, peer: { proxyId: 'prx_1', name: '' }, chunks: {}, bytesDone: 0, startedAt: u.now } as MoveRecord);
    u.tick(31 * MIN);
    await u.sync.process(MOVE, 'source');
    expect(u.runner.calls).toEqual([]);
    expect(u.syncOf('source')!.state).toBe('pending');
    // Its finish marks the cancel returned and asks for the sync.
    u.journal.remove('mv_9123456789ABCDEFGHJK');
    u.journal.bury({ moveId: MOVE, role: 'source', phase: 'cancelled', camera: 'cam3', returned: true });
    // The tombstone written again keeps the sync.
    expect(u.syncOf('source')).toMatchObject({ state: 'pending', waitReturn: true });
    u.sync.returned(MOVE);
    expect(u.syncOf('source')).toMatchObject({ state: 'pending', dueAt: u.now });
    expect(u.syncOf('source')!.waitReturn).toBeUndefined();
    await u.sync.process(MOVE, 'source');
    expect(u.syncOf('source')).toMatchObject({ state: 'done', trigger: 'cancelled', clips: { missingBefore: 1, fetched: 1, missingAfter: 0 } });
    expect(u.actions()[0].details).toMatchObject({ role: 'source', trigger: 'cancelled' });
  });

  it('no copy back within 30 minutes: it runs anyway', async () => {
    const u = unit([clipsCheck(0), eventsCheck(0)]);
    cancelled(u);
    u.tick(30 * MIN);
    await u.sync.process(MOVE, 'source');
    expect(u.syncOf('source')).toMatchObject({ state: 'done' });
  });

  it('the camera back here again only when the cancel had switched it over: returned() of another move does nothing', () => {
    const u = unit([]);
    u.sync.returned(MOVE);
    expect(u.syncOf('source')).toBeUndefined();
    expect(u.scheduled).toEqual([]);
  });
});
