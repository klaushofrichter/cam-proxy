import { unlinkSync } from 'fs';
import type { RecordingCache } from './cache';

// The recordings cache of the host (spec 2026-10-05-multi-camera-host-design
// §8.3): every camera's folder counts against one cap, recordings.cacheMB,
// and the least recently used file of any camera goes first; a pinned file
// (being read) never.
export class CachePool {
  private readonly caches = new Set<RecordingCache>();

  constructor(private readonly capBytes: () => number) {}

  add(c: RecordingCache): void {
    this.caches.add(c);
  }

  remove(c: RecordingCache): void {
    this.caches.delete(c);
  }

  private all() {
    return [...this.caches].flatMap((c) => c.files().map((f) => ({ ...f, cache: c }))).sort((a, b) => a.used - b.used);
  }

  usage(): { bytes: number; files: number; capBytes: number } {
    const f = this.all();
    return { bytes: f.reduce((n, x) => n + x.bytes, 0), files: f.length, capBytes: this.capBytes() };
  }

  pinnedBytes(): number {
    return this.all().filter((f) => f.cache.busy(f.path)).reduce((n, f) => n + f.bytes, 0);
  }

  // Evicts least-recently-used files of any camera (never a pinned one) until
  // `incoming` fits beside everything kept and every .part; answers whether it fits.
  makeRoom(incoming: number): boolean {
    const files = this.all();
    const cap = this.capBytes();
    let total = files.reduce((n, f) => n + f.bytes, 0) + [...this.caches].reduce((n, c) => n + c.partBytes(), 0);
    for (const f of files) {
      if (total + incoming <= cap) break;
      if (f.cache.busy(f.path)) continue;
      try {
        unlinkSync(f.path);
        total -= f.bytes;
      } catch {
        // gone
      }
    }
    return total + incoming <= cap;
  }
}
