// MinuteStore.readStill against a pack that changes under it: pruned between
// the footer and the read, or shorter than its footer says. Both are "no
// still" (undefined), never an error or a zero-padded JPEG.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as fsp from 'fs/promises';
import { MinuteStore } from '../src/stills/store';

vi.mock('fs/promises', async (orig) => {
  const real = await orig<typeof import('fs/promises')>();
  return { ...real, open: vi.fn(real.open) };
});

const M = Date.UTC(2026, 8, 27, 14, 3);
const still = Buffer.from('a still, not really a JPEG');
async function packed() {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-store-race-'));
  const s = new MinuteStore({ dataDir: dir, cam: 'cam1', intervalS: 1, still: { size: '64x36', quality: 5 }, tile: { size: '16x9', grid: '10x6', quality: 7 } });
  s.add({ ts: M, still, tile: Buffer.alloc(0) });
  await s.flush();
  expect(await s.readStill(M)).toEqual(still); // the footer is cached now
  return s;
}

describe('MinuteStore.readStill races', () => {
  it('a pack pruned between the footer and the read: no still', async () => {
    const s = await packed();
    vi.mocked(fsp.open).mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    await expect(s.readStill(M)).resolves.toBeUndefined();
  });

  it('a pack shorter than its footer says: no still', async () => {
    const s = await packed();
    // The next open reads a file cut after 4 bytes of the still.
    const real = vi.mocked(fsp.open).getMockImplementation()!;
    vi.mocked(fsp.open).mockImplementationOnce(async (path, flags) => {
      const fh = await real(path, flags);
      const read = fh.read.bind(fh);
      fh.read = ((buf: Buffer, off: number, len: number, pos: number) => read(buf, off, Math.min(len, 4), pos)) as typeof fh.read;
      return fh;
    });
    await expect(s.readStill(M)).resolves.toBeUndefined();
  });
});
