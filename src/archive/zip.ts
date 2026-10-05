import { once } from 'events';
import type { Readable, Writable } from 'stream';

// A ZIP written while it is sent (spec 2026-10-05-archive-design §4.4,
// ruling 7): entries stored (no compression; video doesn't compress), the
// CRC and sizes known up front and put in the local headers (no data
// descriptors), so the whole layout and its length are planned before the
// first byte. ZIP64 records only where needed: an entry or an offset at or
// past 0xFFFFFFFF, or more than 65534 entries (or forced, for tests).
// APPNOTE.TXT 6.3.x, sections 4.3 and 4.5.3.

export interface ZipEntry {
  name: string; // UTF-8 (flag bit 11)
  size: number;
  crc32: number;
  mtime: number; // unix ms, written as a DOS date in UTC
  open: () => Readable;
}
interface Planned { offset: number; header: Buffer }
export interface ZipLayout { entries: Planned[]; central: Buffer; end: Buffer; total: number; zip64: boolean }
export class ZipSizeError extends Error {}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
const FLAGS = 0x0800; // UTF-8 names
const MADE_BY = (3 << 8) | 45; // Unix, 4.5
const ATTRS = (0o100644 << 16) >>> 0; // a regular file, rw-r--r--

function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  if (d.getUTCFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const extra = (fields: number[]) => {
  if (!fields.length) return Buffer.alloc(0);
  const head = Buffer.alloc(4);
  head.writeUInt16LE(0x0001, 0);
  head.writeUInt16LE(fields.length * 8, 2);
  return Buffer.concat([head, ...fields.map(u64)]);
};

export function planZip(entries: Omit<ZipEntry, 'open'>[], o: { forceZip64?: boolean } = {}): ZipLayout {
  const force = !!o.forceZip64;
  let offset = 0;
  let any64 = force;
  const planned: Planned[] = [];
  const centrals: Buffer[] = [];
  for (const e of entries) {
    if (!Number.isSafeInteger(e.size) || e.size < 0) throw new ZipSizeError(`bad size for ${e.name}`);
    const name = Buffer.from(e.name, 'utf8');
    const big = force || e.size >= MAX32;
    const farOffset = force || offset >= MAX32;
    any64 ||= big || farOffset;
    const { time, date } = dosTime(e.mtime);
    const need = big || farOffset ? 45 : 20;
    const lx = extra(big ? [e.size, e.size] : []);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(need, 4);
    h.writeUInt16LE(FLAGS, 6);
    h.writeUInt16LE(0, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(e.crc32 >>> 0, 14);
    h.writeUInt32LE(big ? MAX32 : e.size, 18);
    h.writeUInt32LE(big ? MAX32 : e.size, 22);
    h.writeUInt16LE(name.length, 26);
    h.writeUInt16LE(lx.length, 28);
    const header = Buffer.concat([h, name, lx]);
    planned.push({ offset, header });
    // The central record: the ZIP64 extra holds the fields set to 0xFFFFFFFF, in order.
    const cx = extra([...(big ? [e.size, e.size] : []), ...(farOffset ? [offset] : [])]);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(MADE_BY, 4);
    c.writeUInt16LE(need, 6);
    c.writeUInt16LE(FLAGS, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(e.crc32 >>> 0, 16);
    c.writeUInt32LE(big ? MAX32 : e.size, 20);
    c.writeUInt32LE(big ? MAX32 : e.size, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(cx.length, 30);
    c.writeUInt16LE(0, 32); // comment
    c.writeUInt16LE(0, 34); // disk
    c.writeUInt16LE(0, 36); // internal attributes
    c.writeUInt32LE(ATTRS, 38);
    c.writeUInt32LE(farOffset ? MAX32 : offset, 42);
    centrals.push(Buffer.concat([c, name, cx]));
    offset += header.length + e.size;
  }
  const central = Buffer.concat(centrals);
  const cdOffset = offset;
  const count = entries.length;
  const zip64 = any64 || count > MAX16 - 1 || central.length >= MAX32 || cdOffset >= MAX32;
  const parts: Buffer[] = [];
  if (zip64) {
    const r = Buffer.alloc(56);
    r.writeUInt32LE(0x06064b50, 0);
    r.writeBigUInt64LE(44n, 4);
    r.writeUInt16LE(MADE_BY, 12);
    r.writeUInt16LE(45, 14);
    r.writeUInt32LE(0, 16);
    r.writeUInt32LE(0, 20);
    r.writeBigUInt64LE(BigInt(count), 24);
    r.writeBigUInt64LE(BigInt(count), 32);
    r.writeBigUInt64LE(BigInt(central.length), 40);
    r.writeBigUInt64LE(BigInt(cdOffset), 48);
    const l = Buffer.alloc(20);
    l.writeUInt32LE(0x07064b50, 0);
    l.writeUInt32LE(0, 4);
    l.writeBigUInt64LE(BigInt(cdOffset + central.length), 8);
    l.writeUInt32LE(1, 16);
    parts.push(r, l);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(0, 4);
  e.writeUInt16LE(0, 6);
  e.writeUInt16LE(zip64 ? MAX16 : count, 8);
  e.writeUInt16LE(zip64 ? MAX16 : count, 10);
  e.writeUInt32LE(zip64 ? MAX32 : central.length, 12);
  e.writeUInt32LE(zip64 ? MAX32 : cdOffset, 16);
  e.writeUInt16LE(0, 20);
  parts.push(e);
  const end = Buffer.concat(parts);
  return { entries: planned, central, end, total: cdOffset + central.length + end.length, zip64 };
}

// Writes one chunk, waiting while the client's buffer is full; throws when
// the client has gone.
async function put(out: Writable, chunk: Buffer): Promise<void> {
  if (out.destroyed || out.writableEnded) throw new Error('the client went away');
  if (out.write(chunk)) return;
  const ac = new AbortController();
  try {
    await Promise.race([once(out, 'drain', { signal: ac.signal }), once(out, 'close', { signal: ac.signal }).then(() => { throw new Error('the client went away'); })]);
  } finally {
    ac.abort();
  }
}

// The planned layout, entry by entry; each file must have exactly its
// planned size (else ZipSizeError: the caller destroys the response). Does
// not end `out`.
export async function writeZip(out: Writable, entries: ZipEntry[], layout: ZipLayout): Promise<void> {
  for (const [i, e] of entries.entries()) {
    await put(out, layout.entries[i].header);
    const src = e.open();
    let n = 0;
    try {
      for await (const chunk of src) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        n += b.length;
        if (n > e.size) throw new ZipSizeError(`${e.name} is longer than planned`);
        await put(out, b);
      }
    } finally {
      src.destroy();
    }
    if (n !== e.size) throw new ZipSizeError(`${e.name} is shorter than planned`);
  }
  await put(out, layout.central);
  await put(out, layout.end);
}
