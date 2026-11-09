import { basename, dirname } from 'path';
import { parentGone, processes, type Proc } from '../../src/stills/orphans';

// #119: the media children that tests start, by program and temp folder:
// cam-sim's MediaMTX (camsim-rtsp-*) and cam-proxy's go2rtc (camproxy-go2rtc-*).
// One whose parent is gone was left by an aborted or crashed run (a killed
// worker, a timeout, Ctrl-C); one of a live node is a running test's.
const KINDS = [
  { program: 'mediamtx', folder: 'camsim-rtsp-' },
  { program: 'go2rtc', folder: 'camproxy-go2rtc-' },
];

const ours = (p: Proc) => KINDS.some((k) => p.args.some((a) => basename(a) === k.program) && p.args.some((a) => basename(dirname(a)).startsWith(k.folder)));

export function strayPids(procs: Proc[], self: number): number[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  return procs.filter((p) => p.pid !== self && ours(p) && parentGone(p, byPid.get(p.ppid))).map((p) => p.pid);
}

// Kills the strays (SIGKILL); never throws: a test run goes on without it.
export function reapStrays(): number[] {
  try {
    const pids = strayPids(processes(), process.pid);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone meanwhile
      }
    }
    return pids;
  } catch {
    return [];
  }
}
