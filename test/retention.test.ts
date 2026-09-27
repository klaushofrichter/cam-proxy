import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog } from '../src/catalog/db';
import { insertEvent, listEvents } from '../src/catalog/events';
import { StreamLog } from '../src/stream/log';
import { Retention } from '../src/retention';
import { DEFAULTS } from '../src/config/defaults';

describe('retention (phase 1: rows)', () => {
  it('deletes events and stream log rows past their days, or only counts them in a dry run', () => {
    const c = openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-ret-')), 'catalog.sqlite'));
    let now = 100 * 86_400_000;
    const log = new StreamLog(c, () => now - 8 * 86_400_000);
    log.append('cam1', 'camera-status', { online: true });
    insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: now - 31 * 86_400_000, raw: null });
    insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: now - 1000, raw: null });
    const config = structuredClone(DEFAULTS);
    const r = new Retention({ catalog: c, log, config: () => config, now: () => now });
    expect(r.run({ dryRun: true }).deleted).toEqual({ events: 1, streamLog: 1 });
    expect(listEvents(c, { cam: 'cam1' })).toHaveLength(2);
    expect(r.run({}).deleted).toEqual({ events: 1, streamLog: 1 });
    expect(listEvents(c, { cam: 'cam1' })).toHaveLength(1);
    expect(r.lastRun()).toBe(now);
    expect(r.totals()).toEqual({ events: 1, streamLog: 1 });
    c.close();
  });

  it('a failing scheduled run is logged and retried later, never crashing the process', async () => {
    const c = openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-ret-')), 'catalog.sqlite'));
    const log = new StreamLog(c);
    const config = structuredClone(DEFAULTS);
    const r = new Retention({ catalog: c, log, config: () => config });
    const failures: string[] = [];
    r.on('failed', (msg: string) => failures.push(msg));
    c.close(); // every run now throws
    r.start({ firstMs: 0, everyMs: 20 });
    await new Promise((res) => setTimeout(res, 120));
    r.stop();
    expect(failures.length).toBeGreaterThanOrEqual(2);
  });
});
