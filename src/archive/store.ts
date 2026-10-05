import { randomBytes } from 'crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Catalog } from '../catalog/db';
import { allArchive, archiveById, deleteArchive, insertArchive, type ArchiveInput, type ArchiveRow } from '../catalog/archive';
import { logger } from '../log';
import { archivePath, archiveRoot, CAM_ID, inside, type ArchiveFile } from './paths';

// The Archive's folders (spec 2026-10-05-archive-design §1.2–1.4). A new
// clip is assembled in archive/.incoming/<random>/ and becomes
// archive/<cam>/<id>/ inside the transaction that inserts its row: a crash
// leaves nothing, or a folder without a row (removed by sweep()).
export class ArchiveStore {
  constructor(private readonly d: { dataDir: string; catalog: Catalog }) {}

  private incoming(): string {
    return inside(this.d.dataDir, join(archiveRoot(this.d.dataDir), '.incoming'));
  }

  // A fresh folder for a clip being assembled.
  stage(): string {
    const dir = inside(this.d.dataDir, join(this.incoming(), randomBytes(12).toString('hex')));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // Drops a staged folder (a failed or cancelled job).
  discard(dir: string): void {
    rmSync(inside(this.d.dataDir, dir), { recursive: true, force: true });
  }

  file(row: Pick<ArchiveRow, 'cam' | 'id'>, name: ArchiveFile): string {
    return archivePath(this.d.dataDir, row.cam, row.id, name);
  }

  // The row and the folder together; `meta` gives meta.json for the new row.
  // Throws (and leaves neither) when any step fails.
  commit(staged: string, input: ArchiveInput, meta: (row: ArchiveRow) => string): ArchiveRow {
    const from = inside(this.d.dataDir, staged);
    const db = this.d.catalog.db;
    let moved: string | null = null;
    db.exec('BEGIN');
    try {
      const row = insertArchive(this.d.catalog, input);
      const to = archivePath(this.d.dataDir, row.cam, row.id);
      mkdirSync(join(to, '..'), { recursive: true });
      rmSync(to, { recursive: true, force: true }); // a leftover of an id rolled back before
      renameSync(from, to);
      moved = to;
      writeFileSync(this.file(row, 'meta.json'), meta(row));
      db.exec('COMMIT');
      return row;
    } catch (err) {
      db.exec('ROLLBACK');
      rmSync(moved ?? from, { recursive: true, force: true });
      throw err;
    }
  }

  writeMeta(row: ArchiveRow, json: string): void {
    const path = this.file(row, 'meta.json');
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, json);
    renameSync(tmp, path);
  }

  // The row first, then the folder (a folder left behind is swept at the
  // next start). The removed row, or undefined.
  remove(id: number): ArchiveRow | undefined {
    const row = archiveById(this.d.catalog, id);
    if (!row || !deleteArchive(this.d.catalog, id)) return undefined;
    this.removeFolder(row);
    return row;
  }

  removeFolder(row: Pick<ArchiveRow, 'cam' | 'id'>): void {
    try {
      rmSync(archivePath(this.d.dataDir, row.cam, row.id), { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err: (err as Error).message, id: row.id }, 'archive_folder_remove_failed');
    }
  }

  // At start: .incoming emptied; folders under <cam>/ named like an id with
  // no row removed (an interrupted create or delete). Rows whose clip file
  // is missing stay (ruling 15) and are named in the answer.
  sweep(): { orphans: number; missing: number[] } {
    const root = archiveRoot(this.d.dataDir);
    const incoming = this.incoming();
    mkdirSync(incoming, { recursive: true });
    for (const f of readdirSync(incoming)) rmSync(join(incoming, f), { recursive: true, force: true });
    const rows = allArchive(this.d.catalog);
    const known = new Set(rows.map((r) => `${r.cam}/${r.id}`));
    let orphans = 0;
    for (const cam of readdirSync(root)) {
      if (!CAM_ID.test(cam)) continue;
      const camDir = join(root, cam);
      if (!lstatSync(camDir).isDirectory()) continue; // a symlink is never followed
      for (const id of readdirSync(camDir)) {
        if (!/^[1-9]\d{0,15}$/.test(id) || known.has(`${cam}/${id}`)) continue;
        if (lstatSync(join(camDir, id)).isSymbolicLink()) continue; // not ours: left alone
        rmSync(archivePath(this.d.dataDir, cam, Number(id)), { recursive: true, force: true });
        orphans++;
      }
    }
    const missing = rows.filter((r) => {
      try {
        return !existsSync(this.file(r, 'clip.mp4'));
      } catch {
        return true;
      }
    }).map((r) => r.id);
    if (orphans) logger.warn({ orphans }, 'archive_orphans_removed');
    if (missing.length) logger.warn({ ids: missing }, 'archive_file_missing');
    return { orphans, missing };
  }
}
