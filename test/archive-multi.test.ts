import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import { insertArchive } from '../src/catalog/archive';
import { DEFAULTS } from '../src/config/defaults';
import { Archive } from '../src/archive/service';
import type { AuditLog } from '../src/audit/audit-log';
import { StreamLog, type StreamMessage } from '../src/stream/log';

describe('archive stream messages per camera (Ruling P1-14)', () => {
  it('a delete across two cameras sends one message per camera', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-armulti-'));
    const c = openCatalog(join(dir, 'catalog.sqlite'));
    const log = new StreamLog(c);
    const config = structuredClone(DEFAULTS);
    config.server.dataDir = dir;
    const a = new Archive({
      dataDir: dir, catalog: c, log, audit: { write: () => undefined } as unknown as AuditLog, config: () => config, disk: () => ({ free: 1e12, size: 2e12 }), timeInfo: () => undefined,
      cameraName: (cam) => `name-${cam}`, cameraModel: () => null, version: 'test',
      stillsIn: () => [], readStill: async () => undefined,
    });
    const row = (cam: string) => insertArchive(c, { cam, name: cam, labels: [], retention_days: 365, created_at: 1000, recorded_from: 1, recorded_to: 2, quality: 'sd', original: 0, duration_s: 1, bytes: 3, files: '{}', source: '{}', thumb_from: 'none', thumb_at: null, created_by: 'client', metadata: '{}' });
    const r3 = row('cam3');
    const r4 = row('cam4');
    const sent: StreamMessage[] = [];
    log.on('message', (m: StreamMessage) => sent.push(m));
    a.delete([r3.id, r4.id], { user: 'admin' });
    expect(sent.filter((m) => m.type === 'archive').map((m) => [m.cam, m.data.ids])).toEqual([['cam3', [r3.id]], ['cam4', [r4.id]]]);
  });
});
