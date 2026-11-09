import { describe, it, expect } from 'vitest';
import { attr, notifications } from '../src/events/soap';

describe('ONVIF reply parsing', () => {
  it('reads attributes in any form', () => {
    expect(attr(' Name="IsMotion" Value=\'true\'', 'Value')).toBe('true');
    expect(attr(' tt:UtcTime = "2026-09-27T02:44:54Z" PropertyOperation="Changed"', 'UtcTime')).toBe('2026-09-27T02:44:54Z');
    expect(attr(' a="x&amp;y"', 'a')).toBe('x&y');
    expect(attr(' Name="IsMotion"', 'Value')).toBeUndefined();
  });

  it('stays fast on a hostile reply (long attribute text without =)', () => {
    const junk = 'a'.repeat(200_000);
    const xml = `<wsnt:NotificationMessage><wsnt:Topic>tns1:X</wsnt:Topic><tt:Message ${junk}><tt:Data><tt:SimpleItem ${junk} /></tt:Data></tt:Message></wsnt:NotificationMessage>`;
    // This thread's CPU time, not the wall time: a busy machine is not a slow parser
    // (a backtracking regex on 200 kB takes seconds of CPU).
    const cpu = () => {
      const u = process.threadCpuUsage();
      return (u.user + u.system) / 1000;
    };
    const t0 = cpu();
    notifications(xml);
    attr(` ${junk}`, 'Value');
    expect(cpu() - t0).toBeLessThan(200);
  });
});
