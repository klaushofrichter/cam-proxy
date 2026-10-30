import { describe, it, expect, beforeEach } from 'vitest';
import { MoveLease } from '../src/ptz/lease';

interface Timer { ms: number; fn: () => void; cancelled: boolean; fired: boolean }

let timers: Timer[];
let log: string[];
let stopFails: number;
let lease: MoveLease;

const schedule = (ms: number, fn: () => void) => {
  const t: Timer = { ms, fn, cancelled: false, fired: false };
  timers.push(t);
  return () => void (t.cancelled = true);
};
// Runs every armed, uncancelled timer of at most `ms`.
const fire = (ms: number) => {
  for (const t of [...timers]) if (!t.cancelled && !t.fired && t.ms <= ms) (t.fired = true), t.fn();
};
const idle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const cmd = (name: string, fail = false) => async () => {
  log.push(name);
  if (fail) throw new Error(`${name} failed`);
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

beforeEach(() => {
  timers = [];
  log = [];
  stopFails = 0;
  lease = new MoveLease({
    stop: async () => {
      log.push('Stop');
      if (stopFails > 0) {
        stopFails--;
        throw new Error('stop failed');
      }
    },
    schedule,
    retryMs: 250,
  });
});

describe('MoveLease', () => {
  it('stops after the duration', async () => {
    await lease.move(cmd('Left'), 400);
    expect(lease.active()).toBe(true);
    expect(timers.map((t) => t.ms)).toEqual([400]);
    fire(400);
    await idle();
    expect(log).toEqual(['Left', 'Stop']);
    expect(lease.active()).toBe(false);
  });

  it('a second move replaces the first: one Stop, after the second duration', async () => {
    await lease.move(cmd('Left'), 400);
    await lease.move(cmd('Right'), 600);
    expect(timers[0].cancelled).toBe(true);
    fire(400);
    await idle();
    expect(log).toEqual(['Left', 'Right']);
    fire(600);
    await idle();
    expect(log).toEqual(['Left', 'Right', 'Stop']);
  });

  it('stop() stops at once and cancels the timer', async () => {
    await lease.move(cmd('Left'), 400);
    await lease.stop();
    expect(log).toEqual(['Left', 'Stop']);
    expect(lease.active()).toBe(false);
    fire(2000);
    await idle();
    expect(log).toEqual(['Left', 'Stop']);
  });

  it('stop() without a move still sends Stop', async () => {
    await lease.stop();
    expect(log).toEqual(['Stop']);
  });

  it('stop() queued behind a slow move still runs after it', async () => {
    const slow = deferred();
    void lease.move(() => (log.push('Left'), slow.promise), 400);
    const s = lease.stop();
    await idle();
    expect(log).toEqual(['Left']);
    slow.resolve();
    await s;
    expect(log).toEqual(['Left', 'Stop']);
  });

  it('then(cmd) during a move: Stop, then cmd, and no later Stop', async () => {
    await lease.move(cmd('Left'), 400);
    await lease.then(cmd('ToPos'));
    fire(2000);
    await idle();
    expect(log).toEqual(['Left', 'Stop', 'ToPos']);
  });

  it('then(cmd) without a move: just cmd', async () => {
    await lease.then(cmd('ToPos'));
    expect(log).toEqual(['ToPos']);
  });

  it('a failed start rejects and sends one Stop', async () => {
    await expect(lease.move(cmd('Left', true), 400)).rejects.toThrow('Left failed');
    await idle();
    expect(log).toEqual(['Left', 'Stop']);
    expect(lease.active()).toBe(false);
    fire(2000);
    await idle();
    expect(log).toEqual(['Left', 'Stop']);
  });

  it('one failing command does not break the chain', async () => {
    await expect(lease.then(cmd('ToPos', true))).rejects.toThrow();
    await lease.then(cmd('ToPos'));
    expect(log).toEqual(['ToPos', 'ToPos']);
  });

  it('a failed timer Stop is retried once', async () => {
    stopFails = 5;
    await lease.move(cmd('Left'), 400);
    fire(400);
    await idle();
    expect(log).toEqual(['Left', 'Stop']);
    expect(timers.map((t) => t.ms)).toEqual([400, 250]);
    fire(250);
    await idle();
    expect(log).toEqual(['Left', 'Stop', 'Stop']);
    fire(2000);
    await idle();
    expect(log).toEqual(['Left', 'Stop', 'Stop']);
  });

  it('no retry Stop once a new move has started', async () => {
    stopFails = 1;
    await lease.move(cmd('Left'), 400);
    fire(400);
    await idle();
    await lease.move(cmd('Right'), 400);
    timers.find((t) => t.ms === 250)!.fn();
    await idle();
    expect(log).toEqual(['Left', 'Stop', 'Right']);
  });

  it('never more than 2000 ms between the last move and its Stop', async () => {
    await lease.move(cmd('Left'), 2000);
    await lease.move(cmd('Left'), 60_000);
    expect(timers.map((t) => t.ms)).toEqual([2000, 2000]);
  });

  it('the default scheduler stops by itself', async () => {
    const l: string[] = [];
    const real = new MoveLease({ stop: async () => void l.push('Stop') });
    await real.move(async () => void l.push('Left'), 100);
    await new Promise((r) => setTimeout(r, 200));
    expect(l).toEqual(['Left', 'Stop']);
  });
});
