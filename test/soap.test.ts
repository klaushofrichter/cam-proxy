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
    const t0 = Date.now();
    notifications(xml);
    attr(` ${junk}`, 'Value');
    expect(Date.now() - t0).toBeLessThan(200);
  });
});
