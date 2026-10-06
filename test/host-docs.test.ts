import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const guide = () => readFileSync(join(__dirname, '..', 'docs', 'multi-camera-host.md'), 'utf8');

describe('docs/multi-camera-host.md', () => {
  it('names every host script that exists, and nothing that does not', () => {
    const paths = [...guide().matchAll(/`((?:deploy|scripts)\/[\w./-]+)`/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(4);
    for (const p of paths) expect(existsSync(join(__dirname, '..', p)), p).toBe(true);
  });
  it('has the sections the spec asks for', () => {
    for (const h of ['## 1. Install Debian 13', '## 4. The PoE switch (GPS-208) on 192.168.60.2', '## 5. The router route', '## 6. Test the route on the device', '## 7. If the route fails: the fallbacks, ranked', '## 9. Checklist', '## 11. Sizing (measured)', '## 12. Camera measurements']) expect(guide()).toContain(h);
    expect(guide()).toContain('Two proxies on one data volume are not supported');
  });
});
