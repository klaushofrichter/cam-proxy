import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Issue #52: the by-hand script says what is missing and fails when every call
// failed. Never Google: no key at all, or a URL nothing listens on.
const run = (env: Record<string, string>, ...files: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/analytics-live.ts'), ...files], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env }, timeout: 30_000 });

describe('scripts/analytics-live.ts', () => {
  it('says the key is missing, without a stack trace, and exits 2', () => {
    const r = run({});
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe('set CAMPROXY_GOOGLE_VISION_KEY');
  });

  it('exits 1 when every call failed', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'camproxy-live-')), 'a.jpg');
    writeFileSync(f, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const r = run({ CAMPROXY_GOOGLE_VISION_KEY: 'k-test-not-a-key', CAMPROXY_GOOGLE_VISION_URL: 'http://127.0.0.1:9' }, f);
    expect(r.stdout).toContain('"error":"network"');
    expect(r.status).toBe(1);
  }, 30_000);
});
