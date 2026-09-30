import { describe, expect, it } from 'vitest';
import { refreshingTimeInfo } from '../src/analytics/time-info';
import type { TimeInfo } from '../src/camera/time';

const tz = (m: number): TimeInfo => ({ stdOffsetMinutes: m, dstOffsetMinutes: 0 });
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('refreshingTimeInfo', () => {
  it('picks up the zone once the camera becomes reachable, and follows a new client', async () => {
    let client: () => Promise<TimeInfo> = () => Promise.reject(new Error('camera down'));
    let calls = 0;
    const read = refreshingTimeInfo(() => (calls++, client()));
    expect(read()).toBeUndefined(); // camera down at start: UTC days
    await tick();
    expect(read()).toBeUndefined();
    await tick();
    client = () => Promise.resolve(tz(-360)); // camera back (or restart() built a new client)
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
});
