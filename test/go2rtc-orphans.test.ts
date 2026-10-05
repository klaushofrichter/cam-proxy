import { spawn, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { reapOrphanGo2rtc } from '../src/stills/orphans';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitGone = async (pid: number) => {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
};

// Review 2026-10-05: after a SIGKILL of node, its go2rtc lived on with the
// ports, and every later start was go2rtc_not_ready. A start reaps go2rtc
// that is provably ours and orphaned, and never one of a running proxy.
describe('orphaned go2rtc', () => {
  it('kills an orphaned go2rtc of a camproxy temp dir and sweeps the dir; leaves a running one', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'camproxy-test-bin-'));
    const fake = join(bin, 'go2rtc');
    writeFileSync(fake, `#!${process.execPath}\nsetTimeout(() => undefined, 60000);\n`);
    chmodSync(fake, 0o755);
    const orphanDir = mkdtempSync(join(tmpdir(), 'camproxy-go2rtc-'));
    writeFileSync(join(orphanDir, 'go2rtc.json'), '{}');
    const liveDir = mkdtempSync(join(tmpdir(), 'camproxy-go2rtc-'));
    writeFileSync(join(liveDir, 'go2rtc.json'), '{}');
    const staleDir = mkdtempSync(join(tmpdir(), 'camproxy-go2rtc-'));
    const freshDir = mkdtempSync(join(tmpdir(), 'camproxy-go2rtc-')); // another proxy may be about to use it
    // Left over from earlier runs: older than a minute.
    const old = new Date(Date.now() - 3600_000);
    for (const d of [orphanDir, staleDir]) utimesSync(d, old, old);
    // The orphan: started by a shell that exits at once (its parent is gone).
    const r = spawnSync('sh', ['-c', '"$0" -c "$1" >/dev/null 2>&1 & echo $!', fake, join(orphanDir, 'go2rtc.json')], { encoding: 'utf8' });
    const orphan = Number(r.stdout.trim());
    // A running proxy's go2rtc: its parent (this node) is alive.
    const running = spawn(fake, ['-c', join(liveDir, 'go2rtc.json')], { stdio: 'ignore' });
    try {
      await new Promise((x) => setTimeout(x, 300));
      // Another test's proxy start may reap it first (tests run side by side): either way it goes.
      await reapOrphanGo2rtc();
      expect(await waitGone(orphan)).toBe(true);
      expect(alive(running.pid!)).toBe(true);
      expect(existsSync(orphanDir)).toBe(false);
      expect(existsSync(staleDir)).toBe(false);
      expect(existsSync(liveDir)).toBe(true);
      expect(existsSync(freshDir)).toBe(true);
    } finally {
      running.kill('SIGKILL');
      if (alive(orphan)) process.kill(orphan, 'SIGKILL');
    }
  });
});
