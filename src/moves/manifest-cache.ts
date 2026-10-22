import { readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { PrivateFileInvalid, readPrivateJson, writePrivateJson } from '../fleet/private-file';
import { parseChunkId, type ManifestFile } from './inventory';
import { isMoveId } from './journal';

// The source's cached chunk manifests (P5), one private file per chunk under
// <dataDir>/admin/moves/<moveId>.manifests/<kind>-<YYYY-MM-DD>.json (600 in a
// 700 folder; tightenAdminFiles sweeps it). Kept out of the journal record so
// the guard's per-request journal read stays small. The paths the target may
// fetch are indexed in memory per move, built from the files on first use.
export interface CachedManifest { files: ManifestFile[]; rows: number; expired: number }

export function manifestCacheDir(dataDir: string, moveId: string): string {
  if (!isMoveId(moveId)) throw new Error('invalid move id');
  return join(dataDir, 'admin', 'moves', `${moveId}.manifests`);
}

// <kind>-<day>.json for a valid chunk id (throws otherwise); no ':' in names.
function fileName(chunkId: string): string {
  const { kind, day } = parseChunkId(chunkId);
  return `${kind}-${day}.json`;
}

const FILE = /^(stills|clips|events|checks|archive)-(\d{4}-\d{2}-\d{2})\.json$/;

// Removed when the move ends (ManifestCache.forget, Task 10).
export function removeManifestCache(dataDir: string, moveId: string): void {
  rmSync(manifestCacheDir(dataDir, moveId), { recursive: true, force: true });
}

function valid(v: unknown): v is CachedManifest {
  const m = v as (Partial<CachedManifest> & { v?: unknown }) | null;
  return !!m && m.v === 1 && Array.isArray(m.files) && typeof m.rows === 'number' && typeof m.expired === 'number'
    && m.files.every((f) => !!f && typeof f.path === 'string' && typeof f.size === 'number' && typeof f.sha256 === 'string');
}

export class ManifestCache {
  // moveId -> path -> chunkId
  private readonly index = new Map<string, Map<string, string>>();

  constructor(private readonly dataDir: string) {}

  // null when not cached (or the file is no cached manifest: computed again).
  // An unsafe file (another owner, stays loose) throws.
  get(moveId: string, chunkId: string): CachedManifest | null {
    let raw: unknown;
    try {
      raw = readPrivateJson(join(manifestCacheDir(this.dataDir, moveId), fileName(chunkId)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof PrivateFileInvalid) return null;
      throw err;
    }
    return valid(raw) ? { files: raw.files, rows: raw.rows, expired: raw.expired } : null;
  }

  set(moveId: string, chunkId: string, m: CachedManifest): void {
    writePrivateJson(join(manifestCacheDir(this.dataDir, moveId), fileName(chunkId)), { v: 1, chunkId, ...m }, false);
    const idx = this.index.get(moveId);
    if (idx) for (const f of m.files) idx.set(f.path, chunkId);
  }

  drop(moveId: string, chunkIds: Iterable<string>): void {
    const ids = new Set(chunkIds);
    for (const id of ids) rmSync(join(manifestCacheDir(this.dataDir, moveId), fileName(id)), { force: true });
    const idx = this.index.get(moveId);
    if (idx) for (const [p, c] of idx) if (ids.has(c)) idx.delete(p);
  }

  // The move ended (finished, cancelled, failed): its cached manifests go, on disk and in memory.
  forget(moveId: string): void {
    removeManifestCache(this.dataDir, moveId);
    this.index.delete(moveId);
  }

  // Whether a cached manifest of the move lists the path.
  lists(moveId: string, path: string): boolean {
    let idx = this.index.get(moveId);
    if (!idx) {
      idx = new Map();
      let names: string[] = [];
      try {
        names = readdirSync(manifestCacheDir(this.dataDir, moveId));
      } catch {
        /* nothing cached yet */
      }
      for (const n of names) {
        const m = FILE.exec(n);
        if (!m) continue;
        const chunkId = `${m[1]}:${m[2]}`;
        for (const f of this.get(moveId, chunkId)?.files ?? []) idx.set(f.path, chunkId);
      }
      this.index.set(moveId, idx);
    }
    return idx.has(path);
  }
}
