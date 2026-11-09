// How long this thread's event loop was held between two ticks of a 10 ms
// probe, as wall time and as this thread's CPU time. A stall of the loop by
// the proxy (synchronous work) is CPU time on this thread and shows in both;
// a busy machine (other test files, CI) only stretches the wall time: the
// thread waits for a core without running. So checks use the CPU time.
// Not seen by it: a synchronous call that blocks without using the CPU (a
// sync read of a slow disk); none of the checked paths makes one.
const TICK_MS = 10;

export interface LoopLag {
  reset(): void;
  // p99 in ms since the last reset: the loop held, by wall time and by this thread's CPU time.
  p99(): { wall: number; cpu: number };
  // The longest hold since the last reset (ms), likewise.
  max(): { wall: number; cpu: number };
  close(): void;
}

const cpuMs = () => {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
};
const p99 = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.99) - 1)];
};

export function loopLag(): LoopLag {
  let wall: number[] = [];
  let cpu: number[] = [];
  let lastWall = performance.now();
  let lastCpu = cpuMs();
  let timer: NodeJS.Timeout | undefined;
  const sample = () => {
    const w = performance.now();
    const c = cpuMs();
    wall.push(Math.max(0, w - lastWall - TICK_MS));
    cpu.push(c - lastCpu);
    lastWall = w;
    lastCpu = c;
  };
  const tick = () => {
    sample();
    timer = setTimeout(tick, TICK_MS);
    timer.unref();
  };
  timer = setTimeout(tick, TICK_MS);
  timer.unref();
  return {
    reset() {
      wall = [];
      cpu = [];
    },
    p99: () => ({ wall: p99(wall), cpu: p99(cpu) }),
    max: () => ({ wall: Math.max(0, ...wall), cpu: Math.max(0, ...cpu) }),
    // Also counts the hold up to now (a step that just ended).
    close() {
      clearTimeout(timer);
      sample();
    },
  };
}
