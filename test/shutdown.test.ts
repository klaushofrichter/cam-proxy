import { spawn, spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { shutdownHandler } from '../src/shutdown';
import { killChildren, liveChildren, trackChild } from '../src/children';

describe('shutdown on a signal (cli)', () => {
  it('stops, then exits 0', async () => {
    const exits: number[] = [];
    const on = shutdownHandler({ stop: async () => undefined, exit: (c) => void exits.push(c), timeoutMs: 1000 });
    on('SIGTERM');
    await new Promise((r) => setTimeout(r, 20));
    expect(exits).toEqual([0]);
  });

  it('a stop that hangs: after the timeout the children are killed and it exits 1', async () => {
    const exits: number[] = [];
    const p = spawn('sleep', ['30']);
    trackChild(p);
    const gone = new Promise((r) => p.once('exit', r));
    const on = shutdownHandler({ stop: () => new Promise(() => undefined), exit: (c) => void exits.push(c), timeoutMs: 100 });
    on('SIGTERM');
    await gone;
    expect(exits).toEqual([1]);
    expect(liveChildren()).toBe(0);
  });

  it('a second signal kills the children and exits at once', async () => {
    const exits: number[] = [];
    const p = spawn('sleep', ['30']);
    trackChild(p);
    const gone = new Promise((r) => p.once('exit', r));
    const on = shutdownHandler({ stop: () => new Promise(() => undefined), exit: (c) => void exits.push(c), timeoutMs: 60_000 });
    on('SIGTERM');
    on('SIGINT');
    await gone;
    expect(exits).toEqual([1]);
    killChildren();
  });
});

// The process 'exit' hook (src/children.ts): a node that spawned a sleep and
// calls process.exit leaves no sleep behind.
describe('children die with the process', () => {
  it('process.exit kills a tracked child', () => {
    const script = `const { spawn } = require('child_process'); const { trackChild } = require(${JSON.stringify(require.resolve('../src/children.ts'))}); const p = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' }); trackChild(p); console.log(p.pid); setTimeout(() => process.exit(0), 100);`;
    const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], { encoding: 'utf8', timeout: 20_000 });
    const pid = Number(r.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      try {
        process.kill(pid, 0);
        spawnSync('sleep', ['0.1']);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});
