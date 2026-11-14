import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import { StreamLog } from '../src/stream/log';

describe('StreamLog.append', () => {
  it('prepares its insert once and stores every message in order', () => {
    const c = openCatalog(join(mkdtempSync(join(tmpdir(), 'cp-streamlog-')), 'catalog.db'));
    let t = 1000;
    const log = new StreamLog(c, () => t++);
    const prepare = vi.spyOn(c.db, 'prepare');
    const seen: unknown[] = [];
    log.on('message', (m) => seen.push(m));
    const a = log.append('cam1', 'still', { ts: 1 });
    const b = log.append('cam2', 'still', { ts: 2, nested: { x: [1] } });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(b.id).toBe(a.id + 1);
    expect(seen).toEqual([a, b]);
    expect(b).toMatchObject({ cam: 'cam2', type: 'still', ts: 1001, data: { ts: 2, nested: { x: [1] } } });
    c.close();
  });
});
