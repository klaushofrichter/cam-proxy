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

// The temp folder of one of ours, after its prefix ('' for none), if it is ours.
const folderOf = (p: Proc) => {
  for (const k of KINDS) {
    if (!p.args.some((a) => basename(a) === k.program)) continue;
    const dir = p.args.map((a) => basename(dirname(a))).find((d) => d.startsWith(k.folder));
    if (dir) return dir.slice(k.folder.length);
  }
  return undefined;
};

// A test that orphans one on purpose (test/go2rtc-orphans.test.ts) names its
// folder with its own pid (`camproxy-go2rtc-run<pid>-…`, runFolderPrefix): no
// sweep of another run, started side by side, touches it while that test's
// process lives.
export const runFolderPrefix = (folder: string, pid = process.pid) => `${folder}run${pid}-`;
const RUN_MARK = /^run(\d+)-/;

export function strayPids(procs: Proc[], self: number): number[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  return procs.filter((p) => {
    if (p.pid === self) return false;
    const dir = folderOf(p);
    if (dir === undefined || !parentGone(p, byPid.get(p.ppid))) return false;
    const owner = RUN_MARK.exec(dir);
    return !(owner && byPid.has(Number(owner[1])));
  }).map((p) => p.pid);
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
