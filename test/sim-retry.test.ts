import { describe, expect, it } from 'vitest';
import { retryMediaStart } from './helpers/sim';

// A cam-sim start whose MediaMTX lost its port to another listener (release
// run 41931287468) is tried again; anything else fails at once.
describe('retryMediaStart', () => {
  const flaky = (failures: string[]) => {
    let calls = 0;
    return { start: async () => (calls < failures.length ? Promise.reject(new Error(failures[calls++])) : (calls++, 'sim')), calls: () => calls };
  };
  it('a MediaMTX that exited during start: tried again', async () => {
    const f = flaky(['MediaMTX exited during start']);
    expect(await retryMediaStart(f.start)).toBe('sim');
    expect(f.calls()).toBe(2);
  });
  it('one that did not start: tried again, at most 3 times in all', async () => {
    const f = flaky(['MediaMTX did not start (port in use or binary not runnable?)', 'MediaMTX exited during start', 'MediaMTX exited during start']);
    await expect(retryMediaStart(f.start)).rejects.toThrow('MediaMTX exited during start');
    expect(f.calls()).toBe(3);
  });
  it('any other error: at once', async () => {
    const f = flaky(['listen EADDRINUSE']);
    await expect(retryMediaStart(f.start)).rejects.toThrow('EADDRINUSE');
    expect(f.calls()).toBe(1);
  });
});
