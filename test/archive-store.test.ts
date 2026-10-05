// The Archive's files (spec 2026-10-05-archive-design §1.2–1.4): the path
// guard, the commit (row and folder together), delete and the start-up sweep.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { openCatalog } from '../src/catalog/db';
import { archiveById, type ArchiveInput } from '../src/catalog/archive';
import { ArchivePathError, archivePath } from '../src/archive/paths';
import { ArchiveStore } from '../src/archive/store';

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-as-'));
  const catalog = openCatalog(join(dir, 'catalog.sqlite'));
  const store = new ArchiveStore({ dataDir: dir, catalog });
  return { dir, catalog, store };
};
const input = (over: Partial<ArchiveInput> = {}): ArchiveInput => ({
  cam: 'cam1', name: 'Fox', labels: [], retention_days: 365, created_at: 1000, recorded_from: 1, recorded_to: 2, quality: 'sd', original: 0, duration_s: 1, bytes: 3,
  files: '{}', source: '{}', thumb_from: 'none', thumb_at: null, created_by: 'client', metadata: '{}', ...over,
});
// A folder the way a job leaves it in .incoming.
const staged = (store: ArchiveStore) => {
  const d = store.stage();
  writeFileSync(join(d, 'clip.mp4'), 'mp4');
  return d;
};

describe('archivePath', () => {
  it('a file of a clip, inside <dataDir>/archive', () => {
    expect(archivePath('/data', 'cam1', 12, 'clip.mp4')).toBe(resolve('/data/archive/cam1/12/clip.mp4'));
    expect(archivePath('/data', 'cam-2', 1)).toBe(resolve('/data/archive/cam-2/1'));
  });
  it.each([
    ['../x', 1, 'clip.mp4'],
    ['cam1/..', 1, 'clip.mp4'],
    ['Cam1', 1, 'clip.mp4'],
    ['', 1, 'clip.mp4'],
    ['cam1', 0, 'clip.mp4'],
    ['cam1', 1.5, 'clip.mp4'],
    ['cam1', -1, 'clip.mp4'],
    ['cam1', 1, '../catalog.sqlite'],
    ['cam1', 1, 'other.mp4'],
  ])('refuses %j %j %j', (cam, id, file) => {
    expect(() => archivePath('/data', cam as string, id as number, file as 'clip.mp4')).toThrow(ArchivePathError);
  });
});

describe('ArchiveStore', () => {
  it('commit: the row and the folder together; meta.json written from the row', () => {
    const { dir, catalog, store } = setup();
    const row = store.commit(staged(store), input(), (r) => JSON.stringify({ id: r.id }));
    expect(row.id).toBe(1);
    expect(readFileSync(join(dir, 'archive/cam1/1/clip.mp4'), 'utf8')).toBe('mp4');
    expect(JSON.parse(readFileSync(join(dir, 'archive/cam1/1/meta.json'), 'utf8'))).toEqual({ id: 1 });
    expect(readdirSync(join(dir, 'archive/.incoming'))).toEqual([]);
    expect(archiveById(catalog, 1)).toBeDefined();
  });

  it('a failed commit leaves no row and no folder', () => {
    const { dir, catalog, store } = setup();
    const d = staged(store);
    expect(() => store.commit(d, input(), () => { throw new Error('meta failed'); })).toThrow('meta failed');
    expect(archiveById(catalog, 1)).toBeUndefined();
    expect(existsSync(join(dir, 'archive/cam1/1'))).toBe(false);
    expect(existsSync(d)).toBe(false);
  });

  it('remove: the row, then the folder; a second remove finds nothing', () => {
    const { dir, catalog, store } = setup();
    const row = store.commit(staged(store), input(), () => '{}');
    expect(store.remove(row.id)).toMatchObject({ id: row.id });
    expect(archiveById(catalog, row.id)).toBeUndefined();
    expect(existsSync(join(dir, 'archive/cam1/1'))).toBe(false);
    expect(store.remove(row.id)).toBeUndefined();
  });

  it('start-up sweep: .incoming emptied, folders without a row removed, a row without its file kept', () => {
    const { dir, catalog, store } = setup();
    const kept = store.commit(staged(store), input(), () => '{}');
    const lost = store.commit(staged(store), input(), () => '{}');
    // A clip whose file went missing, an interrupted create, an orphan folder, a stray file.
    const lostFile = join(dir, 'archive/cam1', String(lost.id), 'clip.mp4');
    unlinkSync(lostFile);
    mkdirSync(join(dir, 'archive/.incoming/abc'), { recursive: true });
    mkdirSync(join(dir, 'archive/cam1/77'), { recursive: true });
    mkdirSync(join(dir, 'archive/cam9/3'), { recursive: true });
    writeFileSync(join(dir, 'archive/cam1/notes.txt'), 'x');
    const r = store.sweep();
    expect(r).toEqual({ orphans: 2, missing: [lost.id] });
    expect(readdirSync(join(dir, 'archive/.incoming'))).toEqual([]);
    expect(existsSync(join(dir, 'archive/cam1/77'))).toBe(false);
    expect(existsSync(join(dir, 'archive/cam9/3'))).toBe(false);
    expect(existsSync(join(dir, 'archive/cam1/notes.txt'))).toBe(true); // not ours: left alone
    expect(existsSync(join(dir, 'archive/cam1', String(kept.id), 'clip.mp4'))).toBe(true);
    expect(archiveById(catalog, lost.id)).toBeDefined(); // ruling 15
  });

  it('rewrites meta.json; the file paths of a row', () => {
    const { dir, store } = setup();
    const row = store.commit(staged(store), input(), () => '{"v":1}');
    store.writeMeta(row, '{"v":2}');
    expect(readFileSync(join(dir, 'archive/cam1/1/meta.json'), 'utf8')).toBe('{"v":2}');
    expect(store.file(row, 'clip.mp4')).toBe(resolve(dir, 'archive/cam1/1/clip.mp4'));
  });

  it('a row with a camera id that is no path is never used as one', () => {
    const { catalog, store } = setup();
    const row = store.commit(staged(store), input(), () => '{}');
    catalog.db.prepare("UPDATE archive SET cam = '../x' WHERE id = ?").run(row.id);
    expect(() => store.file(archiveById(catalog, row.id)!, 'clip.mp4')).toThrow(ArchivePathError);
  });
});
