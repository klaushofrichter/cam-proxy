import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { MinuteStore } from '../src/stills/store';
import type { Frame } from '../src/stills/grabber';

const M = Date.UTC(2026, 8, 27, 14, 3); // 2026-09-27 14:03 UTC
const stillOf: Buffer[] = [];
const tileOf: Buffer[] = [];
beforeAll(async () => {
  for (let i = 0; i < 60; i++) {
    const background = { r: i * 4, g: 255 - i * 4, b: 100 };
    stillOf.push(await sharp({ create: { width: 64, height: 36, channels: 3, background } }).jpeg().toBuffer());
    tileOf.push(await sharp({ create: { width: 16, height: 9, channels: 3, background } }).jpeg().toBuffer());
  }
});
const frame = (minute: number, i: number, step = 1000): Frame => ({ ts: minute + i * step, still: stillOf[i], tile: tileOf[i] });
const store = (dataDir: string, intervalS = 1, grid = '10x6') =>
  new MinuteStore({ dataDir, cam: 'cam1', intervalS, still: { size: '64x36', quality: 5 }, tile: { size: '16x9', grid, quality: 7 } });

describe('MinuteStore', () => {
  it('writes a minute as one pack and one sprite, and reads each second back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-store-'));
    const s = store(dir);
    for (let i = 0; i < 60; i++) if (i !== 17) s.add(frame(M, i));
    s.add(frame(M + 60_000, 0)); // the next minute: the first one is written
    await s.flush();
    expect(readdirSync(join(dir, 'stills/cam1/2026/09/27'))).toContain('1403.pack');
    expect(readdirSync(join(dir, 'previews/cam1/2026/09/27')).sort()).toEqual(['1403.jpg', '1403.json', '1404.jpg', '1404.json']);
    for (const i of [0, 16, 18, 59]) expect(Buffer.compare((await s.readStill(M + i * 1000))!, stillOf[i])).toBe(0);
    expect(await s.readStill(M + 17_000)).toBeUndefined();
    expect(await s.readStill(M - 1000)).toBeUndefined();
    expect(s.listStills(M, M + 59_999)).toHaveLength(59);
  });

  it('reads the minute still being collected from memory', async () => {
    const s = store(mkdtempSync(join(tmpdir(), 'camproxy-store-')));
    s.add(frame(M, 5));
    expect(Buffer.compare((await s.readStill(M + 5000))!, stillOf[5])).toBe(0);
    expect(s.listStills(M, M + 59_999)).toEqual([M + 5000]);
  });

  it('merges a minute split by a restart, losing nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-store-'));
    const a = store(dir);
    for (let i = 0; i < 30; i++) a.add(frame(M, i));
    await a.flush();
    const b = store(dir);
    for (let i = 30; i < 60; i++) b.add(frame(M, i));
    await b.flush();
    const c = store(dir);
    expect(c.listStills(M, M + 59_999)).toHaveLength(60);
    for (const i of [0, 29, 30, 59]) expect(Buffer.compare((await c.readStill(M + i * 1000))!, stillOf[i])).toBe(0);
    const [p] = c.listPreviews(M, M + 59_999);
    expect(p.present.every(Boolean)).toBe(true);
  });

  it('makes a sprite sheet with the grid, tile size and present flags', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-store-'));
    const s = store(dir);
    for (let i = 0; i < 60; i += 2) s.add(frame(M, i));
    await s.flush();
    const [p] = s.listPreviews(M, M + 59_999);
    expect(p).toMatchObject({ minute: M, cols: 10, rows: 6, tileW: 16, tileH: 9, intervalS: 1 });
    expect(p.present.filter(Boolean)).toHaveLength(30);
    expect(await sharp((await s.readSprite(M))!).metadata()).toMatchObject({ format: 'jpeg', width: 160, height: 54 });
  });

  it('keeps minutes made with different settings readable side by side', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-store-'));
    const two = store(dir, 2, '6x5');
    for (let i = 0; i < 30; i++) two.add(frame(M, i, 2000));
    await two.flush();
    const one = store(dir, 1);
    for (let i = 0; i < 60; i++) one.add(frame(M + 60_000, i));
    await one.flush();
    expect(one.listStills(M, M + 59_999)).toHaveLength(30);
    expect(one.listStills(M, M + 59_999)[1]).toBe(M + 2000);
    expect(Buffer.compare((await one.readStill(M + 58_000))!, stillOf[29])).toBe(0);
    expect(one.listPreviews(M, M + 119_999).map((p) => [p.intervalS, p.cols, p.rows])).toEqual([[2, 6, 5], [1, 10, 6]]);
  });

  it('treats a corrupt pack as missing, without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-store-'));
    const s = store(dir);
    s.add(frame(M, 0));
    await s.flush();
    writeFileSync(join(dir, 'stills/cam1/2026/09/27/1403.pack'), 'garbage');
    const fresh = store(dir);
    expect(await fresh.readStill(M)).toBeUndefined();
    expect(fresh.listStills(M, M + 59_999)).toEqual([]);
  });

  it('finds its oldest minute of stills and of previews (the History strip’s left edge)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-store-'));
    const s = store(dir);
    expect(s.oldest('stills')).toBeNull();
    const day2 = M + 86_400_000;
    s.add(frame(day2, 0));
    s.add(frame(M, 3)); // older, and a different day folder
    s.add(frame(M + 60_000, 0));
    s.add(frame(day2 + 60_000, 0));
    await s.flush();
    expect(s.oldest('stills')).toBe(M);
    expect(s.oldest('previews')).toBe(M);
  });
});

