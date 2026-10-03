// src/recordings/cache.ts
// The recordings cache (spec "The cache"): <dataDir>/recordings/<cam>/<id>,
// written as <id>.part and renamed when complete. Last use is the file's
// mtime, touched on a read (at most once a minute: a seeking player sends many
// Range requests), so the LRU order survives a restart. A pinned file (being
// read) is never deleted; a .part counts toward the cap when room is made
// (it uses the disk) but is never listed or evicted.
// Callers validate ids with validId (names.ts); path() also refuses anything
// that could leave the folder.
import { lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync, utimesSync } from 'fs';
import { join, resolve, sep } from 'path';

const TOUCH_EVERY_MS = 60_000;

export interface CachedFile { id: string; path: string; bytes: number; used: number }

function safeDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export class RecordingCache {
  private readonly pins = new Map<string, number>();

  constructor(private readonly d: { dir: () => string; capBytes: () => number; now?: () => number }) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  path(id: string): string {
    if (!id || id.startsWith('.') || id.endsWith('.part') || /[/\\\0]/.test(id)) throw new Error('invalid recording id');
    // Resolved and kept inside the cache folder (also what CodeQL checks for).
    const root = resolve(this.d.dir());
    const path = resolve(root, id);
    if (!path.startsWith(root + sep)) throw new Error('invalid recording id');
    return path;
  }

  partPath(id: string): string {
    return `${this.path(id)}.part`;
  }

  capBytes(): number {
    return this.d.capBytes();
  }

  init(): void {
    const dir = this.d.dir();
    mkdirSync(dir, { recursive: true });
    for (const name of safeDir(dir)) {
      if (!name.endsWith('.part')) continue;
      try {
        unlinkSync(join(dir, name));
      } catch {
        // gone
      }
    }
  }

  has(id: string): boolean {
    try {
      return lstatSync(this.path(id)).isFile();
    } catch {
      return false;
    }
  }

  // Pins are keyed by the resolved path, so callers may pass join() or resolve() forms.
  pin(p: string): () => void {
    const path = resolve(p);
    this.pins.set(path, (this.pins.get(path) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.pins.get(path) ?? 1) - 1;
      if (n <= 0) this.pins.delete(path);
      else this.pins.set(path, n);
    };
  }

  busy(path: string): boolean {
    return this.pins.has(resolve(path));
  }

  open(id: string): (() => void) | null {
    let used: number;
    try {
      const s = lstatSync(this.path(id));
      if (!s.isFile()) return null;
      used = s.mtimeMs;
    } catch {
      return null;
    }
    const unpin = this.pin(this.path(id));
    if (this.now() - used >= TOUCH_EVERY_MS) this.touch(id);
    return unpin;
  }

  touch(id: string): void {
    const t = new Date(this.now());
    try {
      utimesSync(this.path(id), t, t);
    } catch {
      // gone
    }
  }

  files(): CachedFile[] {
    const dir = this.d.dir();
    const out: CachedFile[] = [];
    for (const id of safeDir(dir)) {
      if (id.endsWith('.part')) continue;
      const path = join(dir, id);
      try {
        const s = lstatSync(path);
        if (s.isFile()) out.push({ id, path, bytes: s.size, used: s.mtimeMs });
      } catch {
        // gone
      }
    }
    return out.sort((a, b) => a.used - b.used);
  }

  usage(): { bytes: number; files: number } {
    const f = this.files();
    return { bytes: f.reduce((n, x) => n + x.bytes, 0), files: f.length };
  }

  private partBytes(): number {
    const dir = this.d.dir();
    let n = 0;
    for (const name of safeDir(dir)) {
      if (!name.endsWith('.part')) continue;
      try {
        const s = lstatSync(join(dir, name));
        if (s.isFile()) n += s.size;
      } catch {
        // gone
      }
    }
    return n;
  }

  // Whether a file of `size` could be kept: within the cap, and room beside
  // the pinned files. Evicts nothing (makeRoom does).
  fits(size: number): boolean {
    const cap = this.capBytes();
    if (size > cap) return false;
    const pinned = this.files().filter((x) => this.busy(x.path)).reduce((n, x) => n + x.bytes, 0);
    return pinned + size <= cap;
  }

  // Evicts least-recently-used files (never a pinned one) until `incoming`
  // fits beside the rest and any .part files; answers whether it fits.
  makeRoom(incoming: number): boolean {
    const files = this.files();
    const cap = this.d.capBytes();
    let total = files.reduce((n, f) => n + f.bytes, 0) + this.partBytes();
    for (const f of files) {
      if (total + incoming <= cap) break;
      if (this.busy(f.path)) continue;
      try {
        unlinkSync(f.path);
        total -= f.bytes;
      } catch {
        // gone
      }
    }
    return total + incoming <= cap;
  }

  commit(id: string): void {
    renameSync(this.partPath(id), this.path(id));
    this.touch(id);
  }

  discard(id: string): void {
    try {
      unlinkSync(this.partPath(id));
    } catch {
      // gone
    }
  }
}
