import { describe, expect, it } from 'vitest';
import { buildHealth } from '../src/health/summary';
import type { MoveSyncRecord } from '../src/moves/sync-types';
import type { MoveSyncView } from '../src/moves/sync';
import { H, NOW, input } from './helpers/health-input';
import { strict, why } from './helpers/contract';

// The post-move check (#311) in the health summary (Klaus, 2026-11-02: "If
// there are issues in the after-move we should show them"): one "Move check"
// item. Running or waiting: a warning; something still missing, failed or
// gave up: a problem for 7 days after it ended; done with nothing missing:
// shown for 24 h, no problem. No sync in its window: no item.
const view = (sync: Partial<MoveSyncRecord>, camera = 'cam1', moveId = 'mv_1'): MoveSyncView => ({
  moveId, role: 'target', camera,
  sync: { state: 'done', trigger: 'finished', camera, requestedAt: NOW - 2 * H, dueAt: NOW - 2 * H, attempts: 1, ...sync },
});
const done = (missingAfter: number, over: Partial<MoveSyncRecord> = {}) => ({
  state: 'done' as const, startedAt: NOW - H, finishedAt: NOW - 30 * 60_000,
  clips: { missingBefore: 5, fetched: 5 - missingAfter, missingAfter, rounds: 2, stopped: missingAfter ? 'retention-full' : null },
  events: { missing: 2, added: 2 }, ...over,
});
const health = (moveSyncs: MoveSyncView[]) => buildHealth(input({ moveSyncs }));
const item = (h: ReturnType<typeof buildHealth>) => h.items.find((i) => i.id === 'moveSync');

describe('the moveSync item', () => {
  it('no syncs: no item', () => {
    expect(item(health([]))).toBeUndefined();
    expect(item(buildHealth(input({})))).toBeUndefined();
  });
  it('done, nothing missing: what it fetched, no problem, right after the last inventory', () => {
    const h = health([view(done(0))]);
    expect(item(h)).toEqual({ id: 'moveSync', label: 'Move check', value: 'done', text: 'cam1: done, 5 clips and 2 events fetched', problem: false });
    expect(h.ok).toBe(true);
    const ids = h.items.map((i) => i.id);
    expect(ids.indexOf('moveSync')).toBe(ids.indexOf('inventory') + 1);
  });
  it('done with nothing to fetch says so', () => {
    expect(item(health([view(done(0, { clips: { missingBefore: 0, fetched: 0, missingAfter: 0, rounds: 1, stopped: null }, events: { missing: 0, added: 0 } }))]))?.text).toBe('cam1: done, nothing was missing');
  });
  it('done, nothing missing, more than 24 h ago: no item', () => {
    expect(item(health([view(done(0, { finishedAt: NOW - 25 * H }))]))).toBeUndefined();
  });
  it('clips still missing: a problem with the count and why it stopped', () => {
    const h = health([view(done(3))]);
    expect(item(h)).toEqual({ id: 'moveSync', label: 'Move check', value: 'missing', text: 'cam1: 3 clips still missing (retention-full)', problem: true });
    expect([h.ok, h.problemCount]).toEqual([false, 1]);
  });
  it('events still missing count too', () => {
    expect(item(health([view(done(1, { events: { missing: 4, added: 1 } }))]))?.text).toBe('cam1: 1 clip and 3 events still missing (retention-full)');
    expect(item(health([view(done(0, { events: { missing: 2, added: 0 } }))]))).toMatchObject({ value: 'missing', text: 'cam1: 2 events still missing', problem: true });
  });
  it('a problem stays 7 days after it ended, then the item goes', () => {
    expect(item(health([view(done(3, { finishedAt: NOW - 6 * 24 * H }))]))?.problem).toBe(true);
    expect(item(health([view(done(3, { finishedAt: NOW - 8 * 24 * H }))]))).toBeUndefined();
  });
  it('gave up and failed: problems with the reason', () => {
    expect(item(health([view({ state: 'gave-up', finishedAt: NOW - H, error: 'camera offline' })]))).toEqual({ id: 'moveSync', label: 'Move check', value: 'gave-up', text: 'cam1: gave up after 24 h (camera offline)', problem: true });
    expect(item(health([view({ state: 'failed', finishedAt: NOW - H, error: 'the camera is gone from this proxy' })]))).toMatchObject({ value: 'failed', text: 'cam1: failed (the camera is gone from this proxy)', problem: true });
  });
  it('running and waiting: a warning, not a problem', () => {
    const r = health([view({ state: 'running', startedAt: NOW - 60_000 })]);
    expect(item(r)).toEqual({ id: 'moveSync', label: 'Move check', value: 'running', text: 'cam1: checking the SD card', problem: false, warning: true });
    expect([r.ok, r.problemCount]).toEqual([true, 0]);
    expect(item(health([view({ state: 'pending', error: 'camera offline' })]))).toMatchObject({ value: 'pending', text: 'cam1: waiting (camera offline)', problem: false, warning: true });
    expect(item(health([view({ state: 'pending', waitReturn: true })]))?.text).toBe('cam1: waiting for the copy back');
    expect(item(health([view({ state: 'pending' })]))?.text).toBe('cam1: waiting');
  });
  it('only the newest sync of a camera counts (the list is newest first)', () => {
    expect(item(health([view(done(0), 'cam1', 'mv_2'), view(done(3), 'cam1', 'mv_1')]))).toMatchObject({ value: 'done', problem: false });
  });
  it('several cameras: a problem wins over a warning over fine, and the count is said', () => {
    expect(item(health([view(done(0), 'cam1'), view(done(3), 'cam4')]))).toMatchObject({ value: 'missing', text: 'cam4: 3 clips still missing (retention-full)', problem: true });
    expect(item(health([view(done(2), 'cam1'), view(done(3), 'cam4')]))).toMatchObject({ text: '2 cameras with a move problem', problem: true });
    expect(item(health([view(done(0), 'cam1'), view({ state: 'running' }, 'cam4')]))).toMatchObject({ value: 'running', text: 'cam4: checking the SD card', warning: true });
    expect(item(health([view(done(0), 'cam1'), view(done(0), 'cam4')]))?.text).toBe('2 cameras done, nothing missing');
  });
  it('the text stays within the contract\'s 200 characters', () => {
    expect(item(health([view({ state: 'failed', finishedAt: NOW, error: 'x'.repeat(400) })]))!.text.length).toBeLessThanOrEqual(200);
  });
  it('passes the cams-admin contract (strict health summary)', () => {
    const v = strict('health-summary');
    for (const h of [health([view(done(3))]), health([view({ state: 'running' })])]) expect(v(h), why(v)).toBe(true);
  });
});
