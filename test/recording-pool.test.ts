import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { RecordingCache } from '../src/recordings/cache';
import { CachePool } from '../src/recordings/pool';

describe('one LRU over every camera (spec 2026-10-05-multi-camera-host-design §8.3)', () => {
  it("evicts the oldest file of any camera, never a pinned one, within the host's cap", () => {
    const root = mkdtempSync(join(tmpdir(), 'camproxy-pool-'));
    const pool = new CachePool(() => 3000);
    const mk = (cam: string) => {
      const dir = join(root, cam);
      mkdirSync(dir, { recursive: true });
      const c = new RecordingCache({ dir: () => dir, capBytes: () => 3000, pool });
      pool.add(c);
      return { c, dir };
    };
    const a = mk('cam3');
    const b = mk('cam4');
    const file = (d: string, id: string, ageS: number) => {
      writeFileSync(join(d, id), Buffer.alloc(1000));
      const t = Date.now() / 1000 - ageS;
      utimesSync(join(d, id), t, t);
    };
    file(a.dir, 'RecA1.mp4', 300); // oldest
    file(b.dir, 'RecB1.mp4', 200);
    file(a.dir, 'RecA2.mp4', 100);
    expect(pool.usage()).toEqual({ bytes: 3000, files: 3, capBytes: 3000 });
    const unpin = b.c.pin(join(b.dir, 'RecB1.mp4'));
    expect(pool.makeRoom(2000)).toBe(true); // A1 and A2 go; B1 is pinned
    expect(pool.usage().files).toBe(1);
    unpin();
    expect(pool.makeRoom(3500)).toBe(false); // above the cap
  });

  it("a camera's cache with a pool makes room through it: another camera's file goes", () => {
    const root = mkdtempSync(join(tmpdir(), 'camproxy-pool-'));
    const pool = new CachePool(() => 2000);
    const dirs = ['cam3', 'cam4'].map((c) => (mkdirSync(join(root, c)), join(root, c)));
    const [a, b] = dirs.map((dir) => {
      const c = new RecordingCache({ dir: () => dir, capBytes: () => 2000, pool });
      pool.add(c);
      return c;
    });
    writeFileSync(join(dirs[1], 'RecB1.mp4'), Buffer.alloc(1500));
    expect(a.fits(1000)).toBe(true);
    expect(a.makeRoom(1000)).toBe(true);
    expect(b.usage().files).toBe(0);
    pool.remove(b);
    expect(pool.usage().files).toBe(0);
  });
});
