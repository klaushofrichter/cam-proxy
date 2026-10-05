import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { countEventsByKind, insertEvent } from '../src/catalog/events';
import { countAllClips, countClips, insertClip } from '../src/catalog/clips';
import { countAnalysesByStatus, saveAnalysis, type AnalysisStatus } from '../src/catalog/analyses';

let dir: string;
let c: Catalog;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-counts-'));
  c = openCatalog(join(dir, 'catalog.sqlite'));
});
afterEach(() => {
  c.close();
  rmSync(dir, { recursive: true, force: true });
});

const ev = (kind: string, start_ts: number, cam = 'cam1') => insertEvent(c, { cam, source: 'onvif', kind, start_ts, raw: null });
const clip = (received_at: number, cam = 'cam1') => insertClip(c, { cam, start_ts: received_at - 100, end_ts: null, path: `${cam}/${received_at}.mp4`, stream: 'main', size: 1, received_at, snapshot: null });
const analysis = (event_id: number, status: AnalysisStatus) => saveAnalysis(c, { event_id, provider: 'google-vision', status, reason: null, still_ts: null, image: null, requested_at: 1, took_ms: null, objects: null, raw: null, summary: null });

describe('catalog counts', () => {
  it('counts events by kind, clips received, and analyses by status in a range', () => {
    const p1 = ev('person', 1000);
    ev('person', 2000);
    const m = ev('motion', 3000);
    const out = ev('person', 9000);
    const other = ev('person', 1500, 'cam2');
    clip(1500);
    clip(9500);
    clip(1600, 'cam2');
    analysis(p1.id, 'ok');
    analysis(m.id, 'skipped');
    analysis(out.id, 'failed');
    analysis(other.id, 'ok');
    expect(countEventsByKind(c, 'cam1', 0, 5000)).toEqual({ person: 2, motion: 1 });
    expect(countEventsByKind(c, 'cam1', 1000, 1000)).toEqual({});
    expect(countClips(c, 'cam1', 0, 5000)).toBe(1);
    // A clip fetched from the SD card by a repair is not one received (#74).
    insertClip(c, { cam: 'cam1', start_ts: 1900, end_ts: 2000, path: 'cam1/r.mp4', stream: 'sub', size: 1, received_at: 2000, snapshot: null, origin: 'camera' });
    expect(countClips(c, 'cam1', 0, 5000)).toBe(1);
    expect(countAnalysesByStatus(c, 'cam1', 0, 5000)).toEqual({ ok: 1, skipped: 1 });
  });

  it('countAllClips: every camera, or one (the health summary per camera)', () => {
    insertClip(c, { cam: 'cam3', start_ts: 1, end_ts: 2, path: 'cam3/a.mp4', stream: 'sub', size: 1, received_at: 2, snapshot: null });
    insertClip(c, { cam: 'cam4', start_ts: 1, end_ts: 2, path: 'cam4/a.mp4', stream: 'sub', size: 1, received_at: 2, snapshot: null });
    expect(countAllClips(c)).toBe(2);
    expect(countAllClips(c, 'cam4')).toBe(1);
  });
});
