import { spawn } from 'child_process';
import { describe, expect, it } from 'vitest';
import { killChildren, liveChildren, trackChild } from '../src/children';

// Children go with the proxy (live test 2026-10-05: an orphaned go2rtc kept its ports).
describe('tracked children', () => {
  it('are killed together, and forgotten once they exit', async () => {
    const p = spawn('sleep', ['30']);
    trackChild(p);
    expect(liveChildren()).toBe(1);
    const exited = new Promise((r) => p.once('exit', (_c, sig) => r(sig)));
    killChildren();
    expect(await exited).toBe('SIGKILL');
    expect(liveChildren()).toBe(0);
  });
});
