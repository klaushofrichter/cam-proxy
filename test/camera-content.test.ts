import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { ArchiveStore } from '../src/archive/store';
import { openCatalog } from '../src/catalog/db';
import { cameraContent, deleteCameraContent } from '../src/onboarding/content';

// What camera.remove.preview counts and camera.remove's content delete
// removes (decommission spec A1, A2): the Archive stays without a move note
// unless asked; another camera is never touched.
function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-content-'));
  const catalog = openCatalog(join(dataDir, 'catalog.db'));
  const db = catalog.db;
  const put = (path: string, bytes: number) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes, 1));
  };
  for (const cam of ['cam3', 'cam4']) {
    const clip = join(dataDir, 'clips', cam, '2026/10/01', '1200-1.mp4');
    put(clip, 30);
    db.prepare("INSERT INTO clips (cam, start_ts, path, stream, size, received_at) VALUES (?, 1, ?, 'sub', 30, 1)").run(cam, clip);
    db.prepare("INSERT INTO events (cam, source, kind, start_ts) VALUES (?, 'onvif', 'person', 1)").run(cam);
    const id = Number(db.prepare("INSERT INTO archive (cam, name, labels, created_at, recorded_from, recorded_to, quality, original, duration_s, bytes, files, source, thumb_from, created_by, metadata) VALUES (?, 'a', '[]', 1, 1, 2, 'sub', 1, 1, 5, '[]', 's', 'f', 'u', '{}')").run(cam).lastInsertRowid);
    put(join(dataDir, 'stills', cam, '2026/10/01', '1200.pack'), 10);
    put(join(dataDir, 'stills', cam, '2026/10/01', '1201.pack'), 10);
    put(join(dataDir, 'previews', cam, '2026/10/01', '1200.jpg'), 20);
    put(join(dataDir, 'archive', cam, String(id), 'clip.mp4'), 70);
  }
  const d = { catalog, dataDir, storage: { recount: vi.fn() }, archive: { store: new ArchiveStore({ dataDir, catalog }) } };
  return { d, db };
}

describe('camera content', () => {
  it('counts clips, stills (not previews), archived clips; bytes of every file', () => {
    const { d } = fixture();
    expect(cameraContent(d, 'cam3')).toEqual({ clips: 1, stills: 2, archivedClips: 1, bytes: 30 + 10 + 10 + 20 + 70 });
    expect(cameraContent(d, 'cam9')).toEqual({ clips: 0, stills: 0, archivedClips: 0, bytes: 0 });
  });

  it('delete without archive: clips, stills, events go; the Archive item stays untouched (no move note); cam4 untouched', () => {
    const { d, db } = fixture();
    expect(deleteCameraContent(d, 'cam3', false)).toEqual({ clips: 1, stills: 2, archivedClips: 0 });
    expect(cameraContent(d, 'cam3')).toEqual({ clips: 0, stills: 0, archivedClips: 1, bytes: 70 });
    expect((db.prepare("SELECT metadata FROM archive WHERE cam = 'cam3'").get() as { metadata: string }).metadata).toBe('{}');
    expect((db.prepare("SELECT COUNT(*) n FROM events WHERE cam = 'cam3'").get() as { n: number }).n).toBe(0);
    expect(cameraContent(d, 'cam4')).toEqual({ clips: 1, stills: 2, archivedClips: 1, bytes: 140 });
    expect(d.storage.recount).toHaveBeenCalled();
  });

  it('delete with archive: the Archive goes too', () => {
    const { d } = fixture();
    expect(deleteCameraContent(d, 'cam3', true)).toEqual({ clips: 1, stills: 2, archivedClips: 1 });
    expect(existsSync(join(d.dataDir, 'archive', 'cam3'))).toBe(false);
    expect(cameraContent(d, 'cam4').archivedClips).toBe(1);
  });
});
