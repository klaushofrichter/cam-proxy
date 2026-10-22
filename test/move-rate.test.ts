// The copier's rate (camera-move plan Task 9, S §8.3): remaining bytes over the
// remaining budget, never above the probe, never faster once the budget is
// over, halved under pressure; and the token bucket that holds a stream to it.
import { describe, expect, it } from 'vitest';
import { PACE, paceS, rateFor, TokenBucket } from '../src/moves/rate';

const MB = 1024 * 1024;

describe('rateFor', () => {
  it('rate stays under probe and fits the budget', () => {
    // 1000 MB in 100 s would need 10 MB/s: the probe (5 MB/s) caps it.
    expect(rateFor(1000 * MB, 100, 5 * MB, false, false, 0)).toBe(5 * MB);
    // 100 MB in 1000 s: 100 kB/s fills the budget, below the probe.
    expect(rateFor(100 * MB, 1000, 5 * MB, false, false, 0)).toBe(Math.floor((100 * MB) / 1000));
    // The last minute: what is left over the seconds left (the probe still caps it); less than a second counts as one.
    expect(rateFor(10 * MB, 10, 5 * MB, false, false, 0)).toBe(MB);
    expect(rateFor(MB, 0.2, 5 * MB, false, false, 0)).toBe(MB);
    // No probe measured (0): only the budget limits it.
    expect(rateFor(100 * MB, 1000, 0, false, false, 0)).toBe(Math.floor((100 * MB) / 1000));
  });

  it('a copy paced to its budget ends within it (the last minute is not slowed down)', () => {
    // Recomputed at every file (S §8.3): 100 files of 1 MB in a 600 s budget, the probe far above.
    let t = 0;
    let remaining = 100 * MB;
    while (remaining > 0) {
      const rate = rateFor(remaining, 600 - t, 50 * MB, false, t >= 600, 0);
      t += MB / rate;
      remaining -= MB;
    }
    expect(t).toBeLessThanOrEqual(600.5);
  });

  it('paces to 80 % of the budget, counted from approval (the switch-over included)', () => {
    expect(PACE).toBe(0.8);
    // 300 s budget: the aim is 240 s after approval.
    expect(paceS(300, 0)).toBe(240);
    expect(paceS(300, 60)).toBe(180);
    // Past the aim but inside the budget: no time left to aim at (rateFor then goes at the probe).
    expect(paceS(300, 260)).toBe(-20);
    // A copy paced this way, recomputed at every file, ends near the aim and inside the budget.
    let t = 60;
    let remaining = 100 * MB;
    while (remaining > 0) {
      const rate = rateFor(remaining, paceS(300, t), 50 * MB, false, t >= 300, 0);
      t += MB / rate;
      remaining -= MB;
    }
    expect(t).toBeLessThanOrEqual(241);
    expect(t).toBeGreaterThanOrEqual(235);
  });

  it('rate never rises after the budget is over', () => {
    // Remaining time 0 or less: the last rate, never above the probe.
    expect(rateFor(1000 * MB, 0, 5 * MB, false, true, MB)).toBe(MB);
    expect(rateFor(1000 * MB, -500, 5 * MB, false, true, MB)).toBe(MB);
    expect(rateFor(1000 * MB, -500, 5 * MB, false, true, 9 * MB)).toBe(5 * MB);
    // Without a last rate it is the probe.
    expect(rateFor(1000 * MB, -500, 5 * MB, false, true, 0)).toBe(5 * MB);
  });

  it('pressure halves the rate', () => {
    expect(rateFor(1000 * MB, 100, 4 * MB, true, false, 0)).toBe(2 * MB);
    expect(rateFor(1000 * MB, 0, 4 * MB, true, true, 2 * MB)).toBe(MB);
  });

  it('is at least one byte per second', () => {
    expect(rateFor(0, 1000, 5 * MB, true, false, 0)).toBe(1);
  });
});

describe('TokenBucket', () => {
  it('holds a stream to the rate', async () => {
    let now = 0;
    const slept: number[] = [];
    const b = new TokenBucket({ now: () => now, sleep: async (ms) => void (slept.push(ms), (now += ms)) });
    // 1000 B/s: 3000 bytes take about 3 s (one second's burst allowed).
    for (let i = 0; i < 30; i++) await b.take(100, 1000);
    expect(now).toBeGreaterThanOrEqual(2000);
    expect(now).toBeLessThanOrEqual(3000);
    expect(slept.length).toBeGreaterThan(0);
  });

  it('does not wait below the rate', async () => {
    let now = 0;
    const b = new TokenBucket({ now: () => now, sleep: async (ms) => void (now += ms) });
    await b.take(500, 1000);
    expect(now).toBe(0);
  });
});
