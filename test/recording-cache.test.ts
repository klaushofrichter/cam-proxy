// test/recording-cache.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { RecordingCache } from '../src/recordings/cache';

const NOW = Date.UTC(2026, 9, 2, 12, 0);
function setup(cap = 3000) {
  const dir = join(mkdtempSync(join(tmpdir(), 'camproxy-rec-')), 'recordings', 'cam1');
  const clock = { t: NOW };
  const make = () => new RecordingCache({ dir: () => dir, capBytes: () => cap, now: () => clock.t });
  const cache = make();
  cache.init();
  const put = (id: string, bytes: number, usedAt: number) => {
    const p = join(dir, id);
    writeFileSync(p, Buffer.alloc(bytes, 1));
    utimesSync(p, new Date(usedAt), new Date(usedAt));
    return p;
  };
  return { dir, cache, make, put, clock };
}

describe('RecordingCache', () => {
  it('a pin made through path() is seen by busy() in any path form, and path() stays inside the folder', () => {
    const { dir, cache, put } = setup();
    put('a.mp4', 10, NOW);
    const unpin = cache.pin(cache.path('a.mp4'));
    expect(cache.busy(join(dir, 'a.mp4'))).toBe(true); // storage's join() form
    expect(cache.busy(relative(process.cwd(), join(dir, 'a.mp4')))).toBe(true); // a relative data dir
    unpin();
    expect(cache.busy(join(dir, 'a.mp4'))).toBe(false);
    for (const bad of ['..', '../x.mp4', 'x/../../y.mp4']) expect(() => cache.path(bad)).toThrow();
  });

  it('init deletes leftover .part files and keeps complete ones', () => {
    const { dir, make, put } = setup();
    put('a.mp4', 10, NOW);
    writeFileSync(join(dir, 'b.mp4.part'), 'x');
    make().init();
    expect(existsSync(join(dir, 'b.mp4.part'))).toBe(false);
    expect(existsSync(join(dir, 'a.mp4'))).toBe(true);
  });

  it('commit renames the .part and marks it used now; discard deletes the .part', () => {
    const { cache, clock } = setup();
    writeFileSync(cache.partPath('a.mp4'), 'data');
    expect(cache.has('a.mp4')).toBe(false);
    clock.t = NOW + 5000;
    cache.commit('a.mp4');
    expect(cache.has('a.mp4')).toBe(true);
    expect(Math.round(statSync(cache.path('a.mp4')).mtimeMs / 1000)).toBe(Math.round((NOW + 5000) / 1000));
    writeFileSync(cache.partPath('b.mp4'), 'x');
    cache.discard('b.mp4');
    expect(existsSync(cache.partPath('b.mp4'))).toBe(false);
  });

  it('keeps the least-recently-used order across a restart (mtime), and a read touches the file', () => {
    const { make, put, clock } = setup();
    put('old.mp4', 10, NOW - 3000_000);
    put('mid.mp4', 10, NOW - 2000_000);
    put('new.mp4', 10, NOW - 1000_000);
    const again = make();
    expect(again.files().map((f) => f.id)).toEqual(['old.mp4', 'mid.mp4', 'new.mp4']);
    clock.t = NOW;
    again.open('old.mp4')!();
    expect(again.files().map((f) => f.id)).toEqual(['mid.mp4', 'new.mp4', 'old.mp4']);
  });

  it('counts complete files only', () => {
    const { cache, put } = setup();
    put('a.mp4', 1000, NOW);
    writeFileSync(cache.partPath('b.mp4'), Buffer.alloc(500));
    expect(cache.usage()).toEqual({ bytes: 1000, files: 1 });
  });

  it('makeRoom deletes least-recently-used files until the new file fits the cap', () => {
    const { cache, put } = setup(3000);
    const a = put('a.mp4', 1000, NOW - 3000_000);
    const b = put('b.mp4', 1000, NOW - 2000_000);
    const c = put('c.mp4', 1000, NOW - 1000_000);
    expect(cache.makeRoom(1500)).toBe(true);
    expect([existsSync(a), existsSync(b), existsSync(c)]).toEqual([false, false, true]);
    expect(cache.makeRoom(500)).toBe(true);
  });

  // Review Focus 3.
  it('never evicts a pinned file (being read); the next least-recently-used goes instead', () => {
    const { cache, put } = setup(3000);
    const a = put('a.mp4', 1000, NOW - 3000_000);
    const b = put('b.mp4', 1000, NOW - 2000_000);
    const c = put('c.mp4', 1000, NOW - 1000_000);
    const unpin = cache.open('a.mp4')!;
    expect(cache.busy(a)).toBe(true);
    cache.makeRoom(1500);
    expect([existsSync(a), existsSync(b), existsSync(c)]).toEqual([true, false, false]);
    unpin();
    unpin(); // idempotent
    expect(cache.busy(a)).toBe(false);
  });

  it('open answers null for a file that is not cached', () => {
    expect(setup().cache.open('nope.mp4')).toBeNull();
  });

  it('refuses an id that could leave the folder', () => {
    const { cache } = setup();
    for (const id of ['../x.mp4', 'a/b.mp4', '', '..', '.', 'a\0b.mp4', 'a.mp4.part']) expect(() => cache.path(id)).toThrow();
  });

  it('a symlink is not cached: not listed, not opened, never touched or evicted', () => {
    const { dir, cache, clock } = setup(100);
    const target = join(mkdtempSync(join(tmpdir(), 'camproxy-out-')), 'secret');
    writeFileSync(target, Buffer.alloc(5000, 1));
    utimesSync(target, new Date(NOW - 9000_000), new Date(NOW - 9000_000));
    symlinkSync(target, join(dir, 'l.mp4'));
    clock.t = NOW;
    expect(cache.files()).toEqual([]);
    expect(cache.has('l.mp4')).toBe(false);
    expect(cache.open('l.mp4')).toBeNull();
    expect(cache.makeRoom(50)).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(Math.round(statSync(target).mtimeMs)).toBe(NOW - 9000_000);
  });

  // #99 (Task 7).
  it('makeRoom counts .part bytes (they use the disk) but never deletes a .part', () => {
    const { cache, put } = setup(3000);
    const a = put('a.mp4', 1000, NOW - 3000_000);
    const b = put('b.mp4', 1000, NOW - 2000_000);
    writeFileSync(cache.partPath('c.mp4'), Buffer.alloc(1000));
    expect(cache.makeRoom(1000)).toBe(true);
    expect([existsSync(a), existsSync(b), existsSync(cache.partPath('c.mp4'))]).toEqual([false, true, true]);
  });

  it('makeRoom answers whether the file fits, not what it freed', () => {
    const { cache, put } = setup(3000);
    put('a.mp4', 1000, NOW - 3000_000);
    const unpin = cache.open('a.mp4')!;
    expect(cache.makeRoom(2000)).toBe(true); // nothing freed, but it fits
    expect(cache.makeRoom(2500)).toBe(false); // a is pinned: it can't fit
    unpin();
    expect(cache.makeRoom(2500)).toBe(true);
  });

  it('a read touches the file only when its last use is 60 s old or more', () => {
    const { cache, put, dir, clock } = setup();
    put('a.mp4', 10, NOW - 30_000);
    cache.open('a.mp4')!();
    expect(Math.round(statSync(join(dir, 'a.mp4')).mtimeMs)).toBe(NOW - 30_000);
    clock.t = NOW + 30_000;
    cache.open('a.mp4')!();
    expect(Math.round(statSync(join(dir, 'a.mp4')).mtimeMs)).toBe(NOW + 30_000);
  });
});
