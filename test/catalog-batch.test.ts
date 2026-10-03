// The batched lookups the client API lists use answer exactly what the
// one-row-at-a-time queries answer.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog } from '../src/catalog/db';
import { clipNear, clipsNear, insertClip, overlappingEvents, overlappingEventsOf } from '../src/catalog/clips';
import { closeEvent, insertEvent } from '../src/catalog/events';

const T = Date.UTC(2026, 9, 2, 2, 0, 0);

function catalog() {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-batch-'));
  return { c: openCatalog(join(dir, 'catalog.sqlite')), done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('clipsNear', () => {
  it('matches clipNear for every start, ties to the lower id', () => {
    const { c, done } = catalog();
    const base = { cam: 'cam1', end_ts: null, path: '/x.mp4', size: 1, received_at: T, snapshot: null };
    for (const [stream, off] of [['sub', 0], ['sub', 4000], ['sub', -4000], ['main', 1000], ['sub', 20_000], ['sub', 25_000], ['sub', 30_000]] as const) {
      insertClip(c, { ...base, stream, start_ts: T + off });
    }
    insertClip(c, { ...base, cam: 'cam2', stream: 'sub', start_ts: T });
    const wanted = [-9000, -5000, -2000, 0, 2000, 3000, 5000, 9000, 12_500, 22_500, 27_500, 35_000, 40_000].flatMap((off) => (['sub', 'main'] as const).map((stream) => ({ stream, ts: T + off })));
    const batched = clipsNear(c, 'cam1', wanted, 5000);
    expect(batched.map((r) => r?.id)).toEqual(wanted.map((w) => clipNear(c, 'cam1', w.stream, w.ts, 5000)?.id));
    expect(clipsNear(c, 'cam1', [], 5000)).toEqual([]);
    done();
  });
});

describe('overlappingEventsOf', () => {
  it('matches overlappingEvents for every span, open events included', () => {
    const { c, done } = catalog();
    const ev = (start: number, end: number | null, cam = 'cam1') => {
      const e = insertEvent(c, { cam, source: 'onvif', kind: 'motion', start_ts: T + start, raw: null });
      if (end !== null) closeEvent(c, e.id, T + end, 'state');
    };
    ev(0, 10_000);
    ev(5000, 6000);
    ev(5000, 20_000);
    ev(30_000, 31_000);
    ev(40_000, null);
    ev(-60_000, -50_000);
    ev(0, 100_000, 'cam2');
    const spans = [[-70_000, -65_000], [-55_000, -45_000], [0, 0], [6000, 6000], [7000, 25_000], [31_000, 39_999], [45_000, 50_000], [0, 100_000]].map(([from, to]) => ({ from: T + from, to: T + to }));
    expect(overlappingEventsOf(c, 'cam1', spans)).toEqual(spans.map((s) => overlappingEvents(c, 'cam1', s.from, s.to)));
    expect(overlappingEventsOf(c, 'cam1', [])).toEqual([]);
    done();
  });
});
