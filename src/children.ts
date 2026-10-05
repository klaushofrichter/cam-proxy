import type { ChildProcess } from 'child_process';

// The proxy's long-lived children (go2rtc, ffmpeg). When the process exits
// any way it can see (a normal end, an uncaught error, process.exit), they go
// with it: an orphaned go2rtc would keep its ports, and a proxy started right
// after could not bind them (live test 2026-10-05). A SIGKILL of node itself
// can't be seen; in a container the stop takes every process with it.
const live = new Set<ChildProcess>();
let hooked = false;

export function trackChild(p: ChildProcess): void {
  live.add(p);
  p.once('exit', () => live.delete(p));
  if (!hooked) {
    hooked = true;
    process.once('exit', killChildren);
  }
}

export function killChildren(): void {
  for (const p of live) {
    try {
      p.kill('SIGKILL');
    } catch {
      // gone
    }
  }
  live.clear();
}

export const liveChildren = (): number => live.size;
