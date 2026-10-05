import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';
import { logger } from '../log';
import { trackedPids } from '../children';

// go2rtc that an earlier cam-proxy process left behind (a SIGKILL of node:
// review 2026-10-05) keeps its ports, and every later start would be
// go2rtc_not_ready. A start reaps those that are provably ours: a go2rtc
// whose config is in a camproxy-go2rtc-* temp folder, and whose parent is
// gone (pid 1, or a reaper that isn't node). A go2rtc of a running proxy
// (its parent is that node) is never touched. Then the stale temp folders
// (older than a minute, used by no process) are removed.
const PREFIX = 'camproxy-go2rtc-';
const STALE_MS = 60_000;

export interface Proc { pid: number; ppid: number; args: string[] }

function processes(): Proc[] {
  if (existsSync('/proc/self/stat')) {
    const out: Proc[] = [];
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        const args = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean);
        out.push({ pid: Number(d), ppid, args });
      } catch {
        // gone meanwhile
      }
    }
    return out;
  }
  const text = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' });
  return text.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), args: m[3].split(/\s+/) }] : [];
  });
}

// The camproxy config file a go2rtc runs (its -c argument), if any.
function configOf(p: Proc): string | undefined {
  if (!p.args.some((a) => basename(a) === 'go2rtc')) return undefined;
  const i = p.args.indexOf('-c');
  const file = i >= 0 ? p.args[i + 1] : undefined;
  return file && basename(dirname(file)).startsWith(PREFIX) ? file : undefined;
}

let reaps = 0;
// How often this process reaped (once, at its start; tests).
export const reapCount = (): number => reaps;

// Seams for tests: this process's pid, the process list, our tracked
// children, the kill, and whether to sweep temp folders.
export interface ReapOptions { pid?: number; processes?: () => Proc[]; tracked?: () => Set<number>; kill?: (pid: number) => void; sweep?: boolean; now?: number }

export async function reapOrphanGo2rtc(o: ReapOptions = {}): Promise<{ killed: number[]; removed: string[] }> {
  reaps++;
  const killed: number[] = [];
  const removed: string[] = [];
  const self = o.pid ?? process.pid;
  const now = o.now ?? Date.now();
  // pid 1 is a container's process: in its pid namespace every process with
  // ppid 1 is our own child, and no earlier proxy's go2rtc can be left over.
  if (self === 1) return { killed, removed };
  const tracked = (o.tracked ?? trackedPids)();
  const kill = o.kill ?? ((pid: number) => process.kill(pid, 'SIGKILL'));
  let procs: Proc[];
  try {
    procs = (o.processes ?? processes)();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'go2rtc_orphans_unreadable');
    return { killed, removed };
  }
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const isNode = (p: Proc | undefined) => !!p && basename(p.args[0] ?? '').startsWith('node');
  const inUse = new Set<string>();
  for (const p of procs) {
    const file = configOf(p);
    if (!file || p.pid === self) continue;
    const parent = byPid.get(p.ppid);
    // Ours and running (our child, or tracked) first; then: its parent is gone (pid 1, or a reaper that isn't node).
    const orphan = p.ppid !== self && !tracked.has(p.pid) && (p.ppid === 1 || !isNode(parent));
    if (!orphan) {
      inUse.add(dirname(file));
      continue;
    }
    try {
      kill(p.pid);
      killed.push(p.pid);
      logger.warn({ pid: p.pid, config: file }, 'go2rtc_orphan_killed');
    } catch {
      inUse.add(dirname(file)); // not ours to kill after all
    }
  }
  // Give the killed ones a moment to let go of their ports.
  if (o.sweep === false) return { killed, removed };
  for (let i = 0; i < 20 && killed.some((pid) => alive(pid)); i++) await new Promise((r) => setTimeout(r, 50));
  for (const name of safeDir(tmpdir())) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = join(tmpdir(), name);
    if (inUse.has(dir)) continue;
    try {
      if (now - statSync(dir).mtimeMs < STALE_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // gone, or not ours
    }
  }
  return { killed, removed };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
