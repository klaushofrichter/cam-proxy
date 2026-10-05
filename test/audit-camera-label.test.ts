import { mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { AuditLog, withCamera } from '../src/audit/audit-log';

describe('audit labels per record (spec §5.2)', () => {
  it('labels.camera only on records that concern a camera', () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-auditlbl-'));
    const a = new AuditLog({ dir, version: 'test' });
    a.write({ action: 'proxy-start', category: ['process'], type: ['start'], outcome: 'success', user: 'system', message: 'start' });
    withCamera(a, 'cam4').write({ action: 'camera-reboot', category: ['host'], type: ['start'], outcome: 'success', user: 'admin', message: 'reboot' });
    const lines = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].labels).toBeUndefined();
    expect(lines[1].labels).toEqual({ camera: 'cam4' });
  });
});
