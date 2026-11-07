import { spawn } from 'child_process';
import { trackChild } from '../../children';
import type { LocateResult, SwitchDetail } from './driver';

// Finding a camera's switch port (spec 2026-11-07-poe-switches-design,
// "Finding a camera"). The switch has no MAC table (GPS-208, firmware 6.1.x),
// but its port detail has the current rates: a ping burst to the camera
// raises that port's tx clearly above every other port (measured 2026-11-05:
// 10–30×). Only tx counts: a camera's own stream keeps its port's rx high.

export const LOCATE_RATIO = 5; // the top port's tx at least 5× the next linked port's
// The top port's tx must rise at least this much over its own baseline, and
// the next port's tx counts as at least this much in the ratio (rates of 0).
// A guess: the rates' unit isn't documented; the measured ratios were 10–30×.
export const LOCATE_FLOOR = 1;

// The port whose tx rose clearly during the burst. `portIndex`: UI port
// (1-based) → the switch's internal index. Ports past `ports` (the uplinks)
// and ports without a link never count.
export function pickPort(ports: number, base: SwitchDetail, burst: SwitchDetail, portIndex: (port: number) => number): LocateResult {
  const seen: Array<{ port: number; index: number; tx: number; rise: number }> = [];
  for (let port = 1; port <= ports; port++) {
    const index = portIndex(port);
    if (index < 0 || index >= burst.poe.length) continue;
    if (burst.link[index] === false) continue;
    const tx = burst.tx[index] ?? 0;
    seen.push({ port, index, tx, rise: tx - (base.tx[index] ?? 0) });
  }
  seen.sort((a, b) => b.tx - a.tx);
  const [top, next] = seen;
  if (!top || top.rise < LOCATE_FLOOR) return { found: false, reason: 'no_traffic' };
  const ratio = Math.round((top.tx / Math.max(next?.tx ?? 0, LOCATE_FLOOR)) * 10) / 10;
  if (ratio < LOCATE_RATIO) return { found: false, reason: 'ambiguous', ratio };
  return { found: true, port: top.port, poe: burst.poe[top.index], watts: burst.watts[top.index] ?? 0, link: burst.link[top.index] ?? null, ratio };
}

// Runs a command to its end: its exit code and stdout.
export type Runner = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;

const BURST_LIMIT_MS = 10_000; // ping -w 5 ends by itself; a hung one is killed

const spawnRunner: Runner = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    trackChild(p);
    let stdout = '';
    const kill = setTimeout(() => p.kill('SIGKILL'), BURST_LIMIT_MS);
    kill.unref();
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => (stdout += d));
    p.once('error', (err) => {
      clearTimeout(kill);
      reject(err);
    });
    p.once('close', (code) => {
      clearTimeout(kill);
      resolve({ code, stdout });
    });
  });

// A ~5 s ping burst to `host` (measured unprivileged with BusyBox ping in the
// proxy's alpine container). answered: the summary line
// "N packets transmitted, M packets received" has M > 0. A failed spawn or an
// output without that line: not answered.
export function pingBurst(host: string, run: Runner = spawnRunner): { done: Promise<{ answered: boolean }> } {
  if (!host || host.startsWith('-')) return { done: Promise.resolve({ answered: false }) };
  const done = run('ping', ['-q', '-s', '1400', '-i', '0.01', '-w', '5', host]).then(
    ({ stdout }) => {
      const m = /(\d+) packets transmitted, (\d+) (?:packets )?received/.exec(stdout);
      return { answered: !!m && Number(m[2]) > 0 };
    },
    () => ({ answered: false }),
  );
  return { done };
}
