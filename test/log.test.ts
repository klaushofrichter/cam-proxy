import { describe, it, expect } from 'vitest';
import { Writable } from 'stream';
import { createLogger, withoutQuery } from '../src/log';

function capture() {
  const lines: string[] = [];
  const dest = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  return { lines, dest };
}

describe('logger', () => {
  it('redacts passwords, tokens and authorization headers', () => {
    const { lines, dest } = capture();
    const log = createLogger('info', dest);
    log.info({ password: 'pw-secret', token: 'tok-secret', camera: { password: 'cam-secret' }, req: { headers: { authorization: 'Bearer abc-secret' } } }, 'x');
    const out = lines.join('');
    for (const s of ['pw-secret', 'tok-secret', 'cam-secret', 'abc-secret']) expect(out).not.toContain(s);
  });

  it('cuts query strings from URLs', () => {
    expect(withoutQuery('/cgi-bin/api.cgi?cmd=Snap&token=abc')).toBe('/cgi-bin/api.cgi');
    expect(withoutQuery('/api/stream')).toBe('/api/stream');
  });
});
