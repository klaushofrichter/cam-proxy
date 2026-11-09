import { afterAll, describe, expect, it } from 'vitest';
import { loopLag } from './helpers/loop-lag';

// fleet-isolation's "the loop stays responsive" check: a stall of this
// thread's loop (synchronous work) counts; a thread that waits for a core on a
// busy machine (here: a wait that uses no CPU) does not.
describe('the event loop lag check', () => {
  const lag = loopLag();
  afterAll(() => lag.close());
  const ticks = async (n: number) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 15));
  };

  it('a 300 ms stall by synchronous work counts', async () => {
    await ticks(3);
    lag.reset();
    await ticks(5);
    // 300 ms of this thread's CPU (on a busy machine the wall time is longer).
    const cpu = () => {
      const u = process.threadCpuUsage();
      return (u.user + u.system) / 1000;
    };
    const end = cpu() + 300;
    while (cpu() < end) {
      // the stall
    }
    await ticks(5);
    const r = lag.p99();
    expect(r.wall).toBeGreaterThan(250);
    expect(r.cpu).toBeGreaterThan(250);
  });

  it('300 ms without the CPU (the thread descheduled on a busy machine) does not', async () => {
    await ticks(3);
    lag.reset();
    await ticks(5);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    await ticks(5);
    const r = lag.p99();
    expect(r.wall).toBeGreaterThan(250);
    expect(r.cpu).toBeLessThan(50);
  });
});
