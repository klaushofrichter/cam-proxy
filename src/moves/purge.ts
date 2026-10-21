import { existsSync, lstatSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import type { Archive } from '../archive/service';
import { CAM_ID } from '../archive/paths';
import type { Catalog } from '../catalog/db';
import type { Storage } from '../storage';
import type { MoveKind } from './types';
import { MOVE_KINDS } from './types';

// What a finished move deletes from the source (S §11): every row and file of
// one camera, nothing of another. Content folders count per kind (P6): stills =
// stills + previews, clips = clip files + snapshots, events = analysis images,
// checks = still-check images, archive = archive folders. The recordings cache
// goes too but is not counted, nor are the rows of stream_log, analytics_usage,
// clip_arrivals and annotations (rebuilt or not content, B49/X13).
export type Purged = Record<MoveKind, { files: number; bytes: number }>;
export interface PurgeDeps {
  catalog: Catalog;
  dataDir: string;
  storage: Pick<Storage, 'recount'>;
  archive: Pick<Archive, 'store'>;
}

const FOLDERS: Record<MoveKind, string[]> = { stills: ['stills', 'previews'], clips: ['clips'], events: ['analytics'], checks: ['still-checks'], archive: ['archive'] };
const UNCOUNTED_FOLDERS = ['recordings'];

// Files and bytes under a folder (links are not followed, counted as a file).
function measure(dir: string): { files: number; bytes: number } {
  const out = { files: 0, bytes: 0 };
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        out.files++;
        out.bytes += lstatSync(p).size;
      }
    }
  };
  walk(dir);
  return out;
}

// Idempotent: a camera already purged answers zeros. The rows go in one
// transaction (an event's analyses with it), then the folders, then the
// storage units are recounted.
export function purgeCamera(d: PurgeDeps, cam: string): { deleted: Purged } {
  if (!CAM_ID.test(cam)) throw new Error('purgeCamera: not a camera id');
  const deleted = Object.fromEntries(MOVE_KINDS.map((k) => [k, { files: 0, bytes: 0 }])) as Purged;
  for (const k of MOVE_KINDS) {
    for (const folder of FOLDERS[k]) {
      const m = measure(join(d.dataDir, folder, cam));
      deleted[k].files += m.files;
      deleted[k].bytes += m.bytes;
    }
  }
  const db = d.catalog.db;
  const archiveIds = (db.prepare('SELECT id FROM archive WHERE cam = ?').all(cam) as { id: number }[]).map((r) => r.id);
  db.exec('BEGIN');
  try {
    // analyses go with their event (ON DELETE CASCADE).
    for (const t of ['events', 'annotations', 'clips', 'still_checks', 'archive', 'stream_log', 'analytics_usage', 'clip_arrivals']) db.prepare(`DELETE FROM ${t} WHERE cam = ?`).run(cam);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  for (const id of archiveIds) d.archive.store.removeFolder({ cam, id });
  for (const folder of [...Object.values(FOLDERS).flat(), ...UNCOUNTED_FOLDERS]) rmSync(join(d.dataDir, folder, cam), { recursive: true, force: true });
  d.storage.recount();
  return { deleted };
}
