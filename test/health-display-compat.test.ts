import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { buildHealth } from '../src/health/summary';
import { input } from './helpers/health-input';

// Every key the display's fixtures have (deep), as dotted paths; arrays by their first element.
const keys = (v: unknown, prefix = ''): string[] =>
  Array.isArray(v) ? (v.length ? keys(v[0], `${prefix}[]`) : []) : typeof v === 'object' && v !== null ? Object.entries(v).flatMap(([k, x]) => [`${prefix}${k}`, ...keys(x, `${prefix}${k}.`)]) : [];

describe('the e-paper display keeps working (spec §6.5, decision 5)', () => {
  for (const name of ['pi-ok.json', 'cluster.json']) {
    it(`one camera: every key of the display's ${name} is still there, schema 1`, () => {
      const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'display', name), 'utf8'));
      const h = buildHealth(input());
      const have = new Set(keys(h));
      expect(keys(fixture).filter((k) => !have.has(k))).toEqual([]);
      expect(h.schema).toBe(1);
    });
  }
  it('one camera: the item list is today\'s, and cameras[0] is the top level', () => {
    const h = buildHealth(input());
    expect(h.items.map((i) => i.id)).toEqual(['camera', 'stream', 'events', 'ftp', 'storage', 'disk', 'cpuTemp', 'underVoltage', 'inventory', 'version']);
    expect(h.cameras).toHaveLength(1);
    expect(h.cameras[0]).toMatchObject({ camera: h.camera, stream: h.stream, events: h.events, ftp: h.ftp, cert: null });
    expect(h.cameras[0].items).toEqual(h.items.filter((i) => ['camera', 'stream', 'events', 'ftp'].includes(i.id)));
  });
});
