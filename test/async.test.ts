import { afterEach, describe, expect, it, vi } from 'vitest';
import { sleep, TIMED_OUT, within } from '../src/async';
import { abortableSleep } from '../src/moves/rate';

// The shared async helpers: what the loops, the shutdown paths and the move
// copier rely on.
afterEach(() => vi.restoreAllMocks());

// The timers the helper made, to see whether each keeps the process alive.
const timers = () => {
  const made: NodeJS.Timeout[] = [];
  const real = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    const t = real(fn, ms);
    made.push(t);
    return t;
  }) as typeof setTimeout);
  return made;
};

describe('sleep', () => {
  it('waits, ends early on an abort, resolves at once when already aborted', async () => {
    const t0 = Date.now();
    await sleep(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    const ac = new AbortController();
    const p = sleep(10_000, ac.signal);
    ac.abort();
    await p;
    await sleep(10_000, AbortSignal.abort());
  });

  it('keeps the process alive unless unref is asked for', async () => {
    const made = timers();
    await sleep(1);
    await sleep(1, undefined, { unref: true });
    expect(made.map((t) => t.hasRef())).toEqual([true, false]);
  });
});

describe('abortableSleep', () => {
  it('ends early on an abort and never keeps the process alive', async () => {
    const made = timers();
    const ac = new AbortController();
    const p = abortableSleep(10_000, ac.signal);
    ac.abort();
    await p;
    await abortableSleep(1);
    expect(made.every((t) => !t.hasRef())).toBe(true);
    expect(made.length).toBe(2);
  });
});

describe('within', () => {
  it('the value in time, TIMED_OUT after ms, a rejection passed on', async () => {
    expect(await within(Promise.resolve(7), 1000)).toBe(7);
    expect(await within(new Promise(() => undefined), 20)).toBe(TIMED_OUT);
    await expect(within(Promise.reject(new Error('x')), 1000)).rejects.toThrow('x');
  });

  it('keeps the process alive unless unref is asked for', async () => {
    const made = timers();
    await within(Promise.resolve(1), 1000);
    await within(Promise.resolve(1), 1000, { unref: true });
    expect(made.map((t) => t.hasRef())).toEqual([true, false]);
  });
});
