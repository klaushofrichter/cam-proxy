// The streamed ZIP (spec 2026-10-05-archive-design §4.4): layout, ZIP64,
// and archives read back by the real unzip.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { createWriteStream, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough, Readable } from 'stream';
import { finished } from 'stream/promises';
import { crc32 } from 'zlib';
import { planZip, writeZip, ZipSizeError, type ZipEntry } from '../src/archive/zip';

const MTIME = Date.UTC(2026, 9, 5, 14, 3, 22);
const entry = (name: string, data: Buffer): ZipEntry => ({ name, size: data.length, crc32: crc32(data), mtime: MTIME, open: () => Readable.from([data.subarray(0, 3), data.subarray(3)]) });
const u16 = (b: Buffer, o: number) => b.readUInt16LE(o);
const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);
const u64 = (b: Buffer, o: number) => Number(b.readBigUInt64LE(o));

async function toFile(entries: ZipEntry[], o: { forceZip64?: boolean } = {}): Promise<{ file: string; total: number }> {
  const file = join(mkdtempSync(join(tmpdir(), 'camproxy-zip-')), 'a.zip');
  const layout = planZip(entries, o);
  const out = createWriteStream(file);
  await writeZip(out, entries, layout);
  out.end();
  await finished(out);
  return { file, total: layout.total };
}

describe('planZip', () => {
  it('offsets and the exact length; no ZIP64 for small archives', () => {
    const a = Buffer.from('hello world'), b = Buffer.from('{"x":1}');
    const layout = planZip([entry('a.mp4', a), entry('Füchse 🦊.json', b)]);
    const nameB = Buffer.byteLength('Füchse 🦊.json');
    expect(layout.entries[0].offset).toBe(0);
    expect(layout.entries[1].offset).toBe(30 + 5 + a.length);
    const cd = (46 + 5) + (46 + nameB);
    expect(layout.total).toBe(30 + 5 + a.length + 30 + nameB + b.length + cd + 22);
    expect(layout.zip64).toBe(false);
    const lfh = layout.entries[1].header;
    expect(u32(lfh, 0)).toBe(0x04034b50);
    expect(u16(lfh, 6) & 0x0800).toBe(0x0800); // UTF-8 names
    expect(u16(lfh, 8)).toBe(0); // stored
    expect(u32(lfh, 14)).toBe(crc32(b));
    expect(u32(lfh, 18)).toBe(b.length);
    expect(u32(lfh, 22)).toBe(b.length);
    // 2026-10-05 14:03:22 as DOS time and date.
    expect(u16(lfh, 10)).toBe((14 << 11) | (3 << 5) | 11);
    expect(u16(lfh, 12)).toBe(((2026 - 1980) << 9) | (10 << 5) | 5);
  });

  it('ZIP64 for an entry past 4 GB: extra fields, the EOCD64 record and its locator', () => {
    const big = 5 * 2 ** 30;
    const small = Buffer.from('{}');
    const layout = planZip([{ name: 'big.mp4', size: big, crc32: 0x12345678, mtime: MTIME, open: () => Readable.from([]) }, entry('b.json', small)]);
    expect(layout.zip64).toBe(true);
    const [e0, e1] = layout.entries;
    // The big entry's local header: sizes in the ZIP64 extra.
    expect(u16(e0.header, 4)).toBe(45);
    expect(u32(e0.header, 18)).toBe(0xffffffff);
    expect(u32(e0.header, 22)).toBe(0xffffffff);
    const extraAt = 30 + 'big.mp4'.length;
    expect(u16(e0.header, extraAt)).toBe(0x0001);
    expect(u16(e0.header, extraAt + 2)).toBe(16);
    expect(u64(e0.header, extraAt + 4)).toBe(big);
    expect(u64(e0.header, extraAt + 12)).toBe(big);
    // The next entry starts past 4 GB: its central record has a ZIP64 offset.
    expect(e1.offset).toBe(e0.header.length + big);
    const cd = layout.central;
    const second = 46 + 'big.mp4'.length + 4 + 16; // the first record: name and its extra (sizes)
    expect(u32(cd, second)).toBe(0x02014b50);
    expect(u32(cd, second + 42)).toBe(0xffffffff); // the offset is in the extra
    expect(u32(cd, second + 20)).toBe(small.length); // small sizes stay in place
    const ex = second + 46 + 'b.json'.length;
    expect(u16(cd, ex)).toBe(0x0001);
    expect(u16(cd, ex + 2)).toBe(8);
    expect(u64(cd, ex + 4)).toBe(e1.offset);
    // End records: EOCD64, locator, EOCD with 0xFFFFFFFF.
    const end = layout.end;
    const cdOffset = e1.offset + e1.header.length + small.length;
    expect(u32(end, 0)).toBe(0x06064b50);
    expect(u64(end, 4)).toBe(44);
    expect(u64(end, 24)).toBe(2); // entries on this disk
    expect(u64(end, 32)).toBe(2);
    expect(u64(end, 40)).toBe(cd.length);
    expect(u64(end, 48)).toBe(cdOffset);
    expect(u32(end, 56)).toBe(0x07064b50);
    expect(u64(end, 64)).toBe(cdOffset + cd.length); // where the EOCD64 is
    expect(u32(end, 72)).toBe(1);
    expect(u32(end, 76)).toBe(0x06054b50);
    expect(u32(end, 76 + 16)).toBe(0xffffffff); // cd offset
    expect(layout.total).toBe(cdOffset + cd.length + end.length);
    expect(layout.total).toBeGreaterThan(big);
  });

  it('more than 65534 entries need ZIP64 too', () => {
    const many = Array.from({ length: 65_535 }, (_, i) => ({ name: `${i}`, size: 0, crc32: 0, mtime: MTIME, open: () => Readable.from([]) }));
    const layout = planZip(many);
    expect(layout.zip64).toBe(true);
    expect(u16(layout.end, layout.end.length - 22 + 10)).toBe(0xffff);
  });
});

describe('writeZip, read back by unzip', () => {
  const a = Buffer.alloc(100_000, 7), b = Buffer.from('{"name":"Fox"}'), c = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const entries = () => [entry('2026-10-05 14-03-22 Den (1).mp4', a), entry('2026-10-05 14-03-22 Den (1).json', b), entry('Füchse 🦊 (2).jpg', c)];

  it.each([[false], [true]])('unzip -t passes and each file comes back (forced ZIP64: %s)', async (forceZip64) => {
    const { file, total } = await toFile(entries(), { forceZip64 });
    expect(readFileSync(file).length).toBe(total);
    expect(execFileSync('unzip', ['-t', file]).toString()).toMatch(/No errors detected/);
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-unzip-'));
    execFileSync('unzip', ['-q', file, '-d', dir]);
    expect(readFileSync(join(dir, '2026-10-05 14-03-22 Den (1).mp4')).equals(a)).toBe(true);
    expect(readFileSync(join(dir, '2026-10-05 14-03-22 Den (1).json')).equals(b)).toBe(true);
    expect(readFileSync(join(dir, 'Füchse 🦊 (2).jpg')).equals(c)).toBe(true);
    if (forceZip64) expect(execFileSync('zipinfo', ['-v', file]).toString()).toMatch(/PKWARE 64-bit sizes/);
  });

  it('a file shorter or longer than planned fails the stream (never a ZIP with a wrong length)', async () => {
    const out = new PassThrough();
    out.resume();
    const short = { ...entry('x.mp4', Buffer.from('abc')), size: 5 };
    await expect(writeZip(out, [short], planZip([short]))).rejects.toThrow(ZipSizeError);
    const long = { ...entry('x.mp4', Buffer.from('abcdef')), size: 5 };
    await expect(writeZip(new PassThrough().resume(), [long], planZip([long]))).rejects.toThrow(ZipSizeError);
  });

  it('stops when the client goes away', async () => {
    const out = new PassThrough({ highWaterMark: 16 });
    const big = entry('x.mp4', Buffer.alloc(1_000_000, 1));
    const p = writeZip(out, [big], planZip([big]));
    setTimeout(() => out.destroy(), 10);
    await expect(p).rejects.toThrow();
  });
});
