// src/recordings/cache.ts
// The recordings cache (spec "The cache"): <dataDir>/recordings/<cam>/<id>,
// written as <id>.part and renamed when complete. Last use is the file's
// mtime, touched on every read, so the LRU order survives a restart. A pinned
// file (being read) is never deleted; a .part is never counted or evicted.
// Callers validate ids with validId (names.ts); path() also refuses anything
// that could leave the folder.
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync } from 'fs';
import { join } from 'path';

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
    if (!id || id.startsWith('.') || /[/\\\0]/.test(id)) throw new Error('invalid recording id');
    return join(this.d.dir(), id);
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
      return statSync(this.path(id)).isFile();
    } catch {
      return false;
    }
  }

  pin(path: string): () => void {
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
    return this.pins.has(path);
  }

  open(id: string): (() => void) | null {
    if (!this.has(id)) return null;
    const unpin = this.pin(this.path(id));
    this.touch(id);
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
        const s = statSync(path);
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

  makeRoom(incoming: number): number {
    const files = this.files();
    const cap = this.d.capBytes();
    let total = files.reduce((n, f) => n + f.bytes, 0);
    let freed = 0;
    for (const f of files) {
      if (total + incoming <= cap) break;
      if (this.busy(f.path)) continue;
      try {
        unlinkSync(f.path);
        total -= f.bytes;
        freed += f.bytes;
      } catch {
        // gone
      }
    }
    return freed;
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
