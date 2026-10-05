// The Archive's metadata snapshot, thumbnail choice and JSON (spec
// 2026-10-05-archive-design §2.5, §2.6; docs/archive.md).
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog } from '../src/catalog/db';
import { closeEvent, insertEvent } from '../src/catalog/events';
import { saveAnalysis } from '../src/catalog/analyses';
import { insertCheck, setCheckImage } from '../src/catalog/still-checks';
import { insertArchive } from '../src/catalog/archive';
import { chooseThumbnail, takeSnapshot, type ThumbDeps } from '../src/archive/metadata';
import { itemJson, metadataJson } from '../src/archive/json';

const fresh = () => openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-am-')), 'catalog.sqlite'));
const T = 1_759_689_000_000; // a whole second
const ok = (c: ReturnType<typeof fresh>, eventId: number, stillTs: number, summary: object[], image: string | null = null) =>
  saveAnalysis(c, { event_id: eventId, provider: 'google-vision', status: 'ok', reason: null, still_ts: stillTs, image, requested_at: stillTs + 1000, took_ms: 500, objects: JSON.stringify([{ name: 'Dog', score: 0.9 }]), raw: '{}', summary: JSON.stringify(summary) });

function scene() {
  const c = fresh();
  // Before the window (ended 6 s before it: out), touching it (ended 3 s before: in), inside, an open one, after it.
  const before = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'motion', start_ts: T - 60_000, raw: null });
  closeEvent(c, before.id, T - 6000, 'state');
  const touch = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'motion', start_ts: T - 30_000, raw: null });
  closeEvent(c, touch.id, T - 3000, 'state');
  const person = insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'person', start_ts: T + 4200, raw: null });
  closeEvent(c, person.id, T + 20_000, 'state');
  const pet = insertEvent(c, { cam: 'cam1', source: 'poll', kind: 'pet', start_ts: T + 8000, raw: null });
  insertEvent(c, { cam: 'cam1', source: 'onvif', kind: 'vehicle', start_ts: T + 31_000, raw: null });
  insertEvent(c, { cam: 'cam2', source: 'onvif', kind: 'person', start_ts: T + 5000, raw: null }); // another camera
  ok(c, person.id, T + 5000, []); // Vision found nothing for the person
  ok(c, pet.id, T + 9000, [{ category: 'pet', score: 0.91 }], '/data/analytics/cam1/pet.jpg');
  const check = insertCheck(c, { cam: 'cam1', still_ts: T + 12_000, provider: 'google-vision', requested_at: T + 50_000, requested_via: 'token', took_ms: 400, objects: '[{"name":"Car"}]', raw: null, summary: '[{"category":"vehicle","score":0.7}]' });
  setCheckImage(c, check.id, '/data/still-checks/cam1/check-1.jpg');
  return { c, person, pet, touch, check };
}
const snap = (c: ReturnType<typeof fresh>) =>
  takeSnapshot({ catalog: c, cam: 'cam1', cameraName: 'Den', model: 'RLC-1224A', version: 'test', maxOpenMs: 600_000, now: T + 100_000 }, T, T + 30_000);

describe('the snapshot', () => {
  it('events overlapping the window (5 s slack, open ones), their analyses, the still checks, kinds and found', () => {
    const { c, person, pet, touch, check } = scene();
    const { snapshot } = snap(c);
    expect(snapshot.camera).toEqual({ id: 'cam1', name: 'Den', model: 'RLC-1224A' });
    expect(snapshot.window).toEqual({ from: T, to: T + 30_000 });
    expect(snapshot.events.map((e) => e.id)).toEqual([touch.id, person.id, pet.id]);
    expect(snapshot.events[2]).toMatchObject({ kind: 'pet', source: 'poll', end: null, recovered: false, analysis: { provider: 'google-vision', status: 'ok', stillTs: T + 9000, summary: [{ category: 'pet', score: 0.91 }], objects: [{ name: 'Dog', score: 0.9 }] } });
    expect(snapshot.events[0].analysis).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain('/data/'); // no server paths
    expect(snapshot.stillChecks).toEqual([{ id: check.id, stillTs: T + 12_000, provider: 'google-vision', objects: [{ name: 'Car' }], summary: [{ category: 'vehicle', score: 0.7 }] }]);
    expect(snapshot.eventKinds).toEqual(['motion', 'person', 'pet']);
    expect(snapshot.found).toEqual(['pet', 'vehicle']);
    expect(snapshot).toMatchObject({ proxy: { version: 'test' }, archivedAt: T + 100_000 });
  });
});

describe('the thumbnail', () => {
  const deps = (o: { stills?: Record<number, string>; images?: Record<string, string>; frame?: string | null }): ThumbDeps & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      stillNear: async (ts) => (asked.push(`still ${ts - T}`), o.stills?.[ts - T] ? { ts, jpeg: Buffer.from(o.stills[ts - T]) } : undefined),
      readImage: async (p) => (asked.push(`image ${p}`), o.images?.[p] ? Buffer.from(o.images[p]) : undefined),
      frame: async () => (asked.push('frame'), o.frame ? Buffer.from(o.frame) : undefined),
    };
  };

  it("cams's second first, as a still", async () => {
    const { c } = scene();
    const s = snap(c);
    const d = deps({ stills: { 2000: 'S2' } });
    expect(await chooseThumbnail(d, s, T + 2000)).toEqual({ from: 'still', at: T + 2000, jpeg: Buffer.from('S2') });
  });

  it("cams's second that is an analysed still: its kept copy", async () => {
    const { c } = scene();
    const d = deps({ images: { '/data/analytics/cam1/pet.jpg': 'A' } });
    expect(await chooseThumbnail(d, snap(c), T + 9000)).toEqual({ from: 'analysis', at: T + 9000, jpeg: Buffer.from('A') });
  });

  it("#157: the confirmed event's analysed copy, then its still", async () => {
    const { c } = scene();
    expect(await chooseThumbnail(deps({ images: { '/data/analytics/cam1/pet.jpg': 'A' } }), snap(c))).toMatchObject({ from: 'analysis', at: T + 9000 });
    expect(await chooseThumbnail(deps({ stills: { 9000: 'S9' } }), snap(c))).toEqual({ from: 'still', at: T + 9000, jpeg: Buffer.from('S9') });
  });

  it('#157: else the detection second of the first AI event', async () => {
    const { c } = scene();
    const d = deps({ stills: { 4200: 'S4' } });
    expect(await chooseThumbnail(d, snap(c))).toEqual({ from: 'still', at: T + 4200, jpeg: Buffer.from('S4') });
  });

  it('then a still check that found something, then the first frame, then none', async () => {
    const { c } = scene();
    expect(await chooseThumbnail(deps({ images: { '/data/still-checks/cam1/check-1.jpg': 'C' } }), snap(c))).toEqual({ from: 'check', at: T + 12_000, jpeg: Buffer.from('C') });
    expect(await chooseThumbnail(deps({ frame: 'F' }), snap(c))).toEqual({ from: 'frame', at: null, jpeg: Buffer.from('F') });
    expect(await chooseThumbnail(deps({}), snap(c))).toEqual({ from: 'none', at: null });
  });

  it('a window without AI events goes straight to the first frame', async () => {
    const c = fresh();
    const d = deps({ frame: 'F' });
    const s = takeSnapshot({ catalog: c, cam: 'cam1', cameraName: 'Den', model: null, version: 'v', maxOpenMs: 600_000, now: T }, T, T + 1000);
    expect(await chooseThumbnail(d, s)).toMatchObject({ from: 'frame' });
    expect(d.asked).toEqual(['frame']);
  });
});

describe('the JSON', () => {
  it('item and metadata from a row: current name and labels, snapshot kept', () => {
    const { c } = scene();
    const { snapshot } = snap(c);
    const row = insertArchive(c, {
      cam: 'cam1', name: 'Fox', labels: ['Pet', 'SD'], retention_days: 10, created_at: T + 100_000, recorded_from: T, recorded_to: T + 30_000, quality: 'sd', original: 0,
      duration_s: 30, bytes: 1234, files: JSON.stringify({ clip: { bytes: 1234, crc32: 99 }, thumb: null }), source: JSON.stringify({ type: 'clip', clipId: 4, stream: 'sub' }),
      thumb_from: 'still', thumb_at: T + 4000, created_by: 'client', metadata: JSON.stringify(snapshot),
    });
    const item = itemJson(row);
    expect(item).toEqual({
      id: row.id, cam: 'cam1', cameraName: 'Den', name: 'Fox', labels: ['Pet', 'SD'], retentionDays: 10, createdAt: T + 100_000, expiresAt: T + 100_000 + 10 * 86_400_000,
      recordedFrom: T, recordedTo: T + 30_000, durationS: 30, quality: 'sd', original: false, bytes: 1234, source: { type: 'clip', clipId: 4, stream: 'sub' },
      eventKinds: ['motion', 'person', 'pet'], found: ['pet', 'vehicle'], thumbnail: { from: 'still', at: T + 4000 }, createdBy: 'client',
      urls: { video: `/api/archive/${row.id}/video`, thumbnail: `/api/archive/${row.id}/thumbnail`, metadata: `/api/archive/${row.id}/metadata` },
    });
    const meta = metadataJson(row);
    expect(meta.schema).toBe(1);
    expect(meta.item).toEqual(Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'urls')));
    expect(meta).toMatchObject({ camera: snapshot.camera, window: snapshot.window, events: snapshot.events, stillChecks: snapshot.stillChecks, proxy: { version: 'test' }, archivedAt: T + 100_000 });
    expect('eventKinds' in meta).toBe(false); // on the item, not repeated
  });

  it('a corrupt JSON column does not fail the item', () => {
    const c = fresh();
    const row = insertArchive(c, { cam: 'cam1', name: 'x', labels: [], retention_days: null, created_at: 1, recorded_from: 1, recorded_to: 2, quality: '4k', original: 1, duration_s: 1, bytes: 1, files: '{', source: '{', thumb_from: 'none', thumb_at: null, created_by: 'admin', metadata: 'nope' });
    expect(itemJson(row)).toMatchObject({ cameraName: null, source: null, eventKinds: [], found: [], original: true, expiresAt: null, retentionDays: null });
  });
});
