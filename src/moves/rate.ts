import { sleep } from '../async';

// The copier's rate (camera-move plan Task 9, S §8.3). Pure: the copier
// recomputes it every minute and at each file.

// cams-admin counts a move's time budget from its approval, the switch-over
// included; the copier starts after it. So the copier aims to be done at 80 %
// of the budget, counted from approval: paceS is the seconds left to that aim
// (0 or less once it has passed: rateFor then goes at the probe until the
// budget itself is over, after which it never goes faster).
export const PACE = 0.8;
export const paceS = (budgetS: number, elapsedS: number): number => budgetS * PACE - elapsedS;

// Bytes per second: the remaining bytes over the remaining budget (at least a
// second: a floor of a minute made every copy paced to its budget end after it,
// task 12), never above the probe (0: not measured, no cap); once the budget is
// over, the last rate or lower, never faster. `lastRate` is the last rate
// before any halving, so pressure that ends doesn't lower the rate for good.
// Halved under pressure (the target's storage paused or its load above the core
// count, or the source answering 503). At least 1 B/s.
export function rateFor(remainingBytes: number, remainingS: number, probeBps: number, pressure: boolean, budgetOver: boolean, lastRate: number): number {
  const probe = probeBps > 0 ? probeBps : Infinity;
  let rate = budgetOver ? Math.min(lastRate > 0 ? lastRate : probe, probe) : Math.min(probe, Math.max(0, remainingBytes) / Math.max(remainingS, 1));
  if (pressure) rate /= 2;
  return Number.isFinite(rate) ? Math.max(1, Math.floor(rate)) : rate;
}

// A sleep that ends early when the signal aborts (a stopped copier never waits out a take).
export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> => sleep(ms, signal, { unref: true });

// A token bucket holding a stream to a rate: one second's worth may go at
// once, the rest waits. Never loops on the clock: each take waits once for
// what it overdraws.
export class TokenBucket {
  private tokens: number | null = null;
  private last = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(o: { now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {}) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? abortableSleep;
  }

  async take(n: number, rate: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(rate) || rate <= 0) return;
    const t = this.now();
    this.tokens = this.tokens === null ? rate : Math.min(rate, this.tokens + ((t - this.last) * rate) / 1000);
    this.last = t;
    this.tokens -= n;
    if (this.tokens < 0) await this.sleep(Math.ceil((-this.tokens * 1000) / rate), signal);
  }
}
