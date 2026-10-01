import { describe, expect, it } from 'vitest';
import { refreshingTimeInfo } from '../src/analytics/time-info';
import type { TimeInfo } from '../src/camera/time';

const tz = (m: number): TimeInfo => ({ stdOffsetMinutes: m, dstOffsetMinutes: 0 });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('refreshingTimeInfo', () => {
  it('picks up the zone once the camera becomes reachable, and follows a new client', async () => {
    let client: () => Promise<TimeInfo> = () => Promise.reject(new Error('camera down'));
    let calls = 0;
    let t = 0;
    const read = refreshingTimeInfo(() => (calls++, client()), () => t);
    expect(read()).toBeUndefined(); // camera down at start: UTC days
    await tick();
    expect(read()).toBeUndefined();
    await tick();
    client = () => Promise.resolve(tz(-360)); // camera back (or restart() built a new client)
    t += 60_000;
    read();
    await tick();
    expect(read()).toEqual(tz(-360));
    await tick();
    client = () => Promise.resolve(tz(60));
    read();
    await tick();
    expect(read()).toEqual(tz(60));
  });

  it('asks once at a time', async () => {
    let calls = 0;
    const read = refreshingTimeInfo(() => (calls++, new Promise<TimeInfo>(() => undefined)));
    read(); read(); read();
    expect(calls).toBe(1);
  });

  // Issue #52: while the camera is down and nothing is cached, not one GetTime per read.
  it('asks at most once a minute after a failure', async () => {
    let calls = 0;
    let t = 0;
    const read = refreshingTimeInfo(() => (calls++, Promise.reject(new Error('camera down'))), () => t);
    for (let i = 0; i < 5; i++) (read(), await tick());
    expect(calls).toBe(1);
    t += 59_999;
    read();
    await tick();
    expect(calls).toBe(1);
    t += 1;
    read();
    await tick();
    expect(calls).toBe(2);
  });
});
