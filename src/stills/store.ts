import { EventEmitter } from 'events';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { open, type FileHandle } from 'fs/promises';
import { dirname, join } from 'path';
import sharp from 'sharp';
import { logger } from '../log';
import type { Frame } from './grabber';

// One minute of stills is one pack: the JPEGs back to back, a JSON footer
// (interval, size, quality and one [offset, length] per slot; length 0 means
// no still), the footer's length (uint32 LE) and the magic "CPK1". One minute
// of preview tiles is one sprite sheet plus a JSON sidecar. Both record the
// settings they were made with, so older minutes stay readable after a change.

const MAGIC = Buffer.from('CPK1');
const MINUTE = 60_000;
const FOOTER_CACHE = 5000;

export interface PackFooter { v: 1; minute: number; intervalS: number; size: string; quality: number; slots: [number, number][] }
export interface PreviewMinute { minute: number; cols: number; rows: number; tileW: number; tileH: number; intervalS: number; present: boolean[] }
interface Sidecar extends PreviewMinute { v: 1 }

export interface StoreOptions {
  dataDir: string;
  cam: string;
  intervalS: number;
  still: { size: string; quality: number };
  tile: { size: string; grid: string; quality: number };
}

const pad = (n: number) => String(n).padStart(2, '0');
export const minuteOf = (ts: number) => Math.floor(ts / MINUTE) * MINUTE;

// Where a minute's files live: <dataDir>/<kind>/<cam>/YYYY/MM/DD/HHMM (UTC).
export function minutePath(dataDir: string, kind: 'stills' | 'previews', cam: string, minute: number): string {
  const d = new Date(minute);
  return join(dataDir, kind, cam, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()), `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`);
}

function writeAtomic(file: string, data: Buffer | string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

// A pack's footer, read async and without the store's cache (the inventory
// walks thousands of packs): the same checks as MinuteStore's own read, plus
// an interval that divides the minute (a corrupt but parseable footer can't
// make a caller loop for ages). One read of the pack's tail when the footer
// fits in it (a 1 s minute's footer is about 1 KB). null for a missing, short
// or corrupt pack.
const TAIL_READ = 4096;
export async function readPackFooter(file: string): Promise<PackFooter | null> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(file, 'r');
    const { size } = await fh.stat();
    if (size < 8) return null;
    const n = Math.min(size, TAIL_READ);
    const tail = Buffer.alloc(n);
    await fh.read(tail, 0, n, size - n);
    const len = tail.readUInt32LE(n - 8);
    if (!tail.subarray(n - 4).equals(MAGIC) || len <= 0 || len >= 1_000_000 || len > size - 8) return null;
    let json: Buffer;
    if (len <= n - 8) json = tail.subarray(n - 8 - len, n - 8);
    else {
      json = Buffer.alloc(len);
      await fh.read(json, 0, len, size - 8 - len);
    }
    const f = JSON.parse(json.toString('utf8')) as PackFooter;
    return f.v === 1 && Array.isArray(f.slots) && Number.isInteger(f.intervalS) && f.intervalS > 0 && 60 % f.intervalS === 0 ? f : null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

interface Current { minute: number; stills: (Buffer | undefined)[]; tiles: (Buffer | undefined)[] }

// Collects the current minute in memory and writes it when the next minute
// starts (or on flush). Emits 'written' ({kind, bytes, files}) for the storage
// accounting.
export class MinuteStore extends EventEmitter {
  private current: Current | undefined;
  private queue: Promise<void> = Promise.resolve();
  private readonly footers = new Map<string, { mtimeMs: number; footer: PackFooter | null }>();
  private readonly slots: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly tileW: number;
  private readonly tileH: number;

  constructor(private readonly o: StoreOptions) {
    super();
    this.slots = 60 / o.intervalS;
    [this.cols, this.rows] = o.tile.grid.split('x').map(Number);
    [this.tileW, this.tileH] = o.tile.size.split('x').map(Number);
  }

  add(f: Frame): void {
    const minute = minuteOf(f.ts);
    if (this.current && this.current.minute !== minute) this.flush().catch(() => undefined);
    // Dense arrays: map() skips the holes of a sparse one.
    this.current ??= { minute, stills: Array.from({ length: this.slots }), tiles: Array.from({ length: this.slots }) };
    const slot = Math.floor((f.ts - minute) / (this.o.intervalS * 1000));
    if (slot < 0 || slot >= this.slots || this.current.stills[slot]) return;
    this.current.stills[slot] = f.still;
    this.current.tiles[slot] = f.tile;
  }

  // Writes the minute being collected (next minute, stop, restart).
  flush(): Promise<void> {
    const cur = this.current;
    this.current = undefined;
    if (cur) this.queue = this.queue.then(() => this.write(cur)).catch((err: Error) => logger.error({ err: err.message }, 'stills_write_failed'));
    return this.queue;
  }

  private async write(cur: Current): Promise<void> {
    const packFile = `${minutePath(this.o.dataDir, 'stills', this.o.cam, cur.minute)}.pack`;
    const base = minutePath(this.o.dataDir, 'previews', this.o.cam, cur.minute);
    let stills = cur.stills;
    let tiles = cur.tiles;
    let spriteBase: Buffer | undefined;
    let before = { stills: 0, previews: 0 };
    // A minute split by a restart: merge with what is there (kept first).
    const existing = this.footer(packFile);
    if (existing) {
      if (existing.intervalS !== this.o.intervalS) {
        logger.warn({ minute: cur.minute }, 'stills_minute_settings_changed_new_part_dropped');
        return;
      }
      const buf = readFileSync(packFile);
      stills = stills.map((s, i) => (existing.slots[i]?.[1] ? buf.subarray(existing.slots[i][0], existing.slots[i][0] + existing.slots[i][1]) : s));
      before.stills = statSync(packFile).size;
    }
    const sidecar = this.sidecar(`${base}.json`);
    if (sidecar && sidecar.intervalS === this.o.intervalS && sidecar.cols === this.cols && existsSync(`${base}.jpg`)) {
      spriteBase = readFileSync(`${base}.jpg`);
      before.previews = spriteBase.length;
      tiles = tiles.map((t, i) => (sidecar.present[i] ? undefined : t));
    }
    const tilePresent = tiles.map((t, i) => Boolean(t) || Boolean(sidecar?.present[i] && spriteBase));

    // The pack.
    const parts: Buffer[] = [];
    const slots: [number, number][] = [];
    let offset = 0;
    for (let i = 0; i < this.slots; i++) {
      const s = stills[i];
      slots.push(s ? [offset, s.length] : [0, 0]);
      if (s) (parts.push(s), (offset += s.length));
    }
    if (offset > 0) {
      const footer: PackFooter = { v: 1, minute: cur.minute, intervalS: this.o.intervalS, size: this.o.still.size, quality: this.o.still.quality, slots };
      const json = Buffer.from(JSON.stringify(footer));
      const len = Buffer.alloc(4);
      len.writeUInt32LE(json.length);
      const pack = Buffer.concat([...parts, json, len, MAGIC]);
      writeAtomic(packFile, pack);
      this.footers.delete(packFile);
      this.emit('written', { kind: 'stills', bytes: pack.length - before.stills, files: existing ? 0 : 1 });
    }

    // The sprite sheet (missing tiles dark), and its sidecar.
    const sprite = await this.compose(tiles, spriteBase);
    writeAtomic(`${base}.jpg`, sprite);
    const meta: Sidecar = { v: 1, minute: cur.minute, cols: this.cols, rows: this.rows, tileW: this.tileW, tileH: this.tileH, intervalS: this.o.intervalS, present: tilePresent };
    writeAtomic(`${base}.json`, JSON.stringify(meta));
    this.emit('written', { kind: 'previews', bytes: sprite.length - before.previews, files: spriteBase ? 0 : 2 });
  }

  private async compose(tiles: (Buffer | undefined)[], base?: Buffer): Promise<Buffer> {
    const width = this.cols * this.tileW;
    const height = this.rows * this.tileH;
    const layers = [];
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (!t) continue;
      const input = await sharp(t).resize(this.tileW, this.tileH, { fit: 'fill' }).toBuffer();
      layers.push({ input, left: (i % this.cols) * this.tileW, top: Math.floor(i / this.cols) * this.tileH });
    }
    const img = base ? sharp(base) : sharp({ create: { width, height, channels: 3, background: '#111111' } });
    return img.composite(layers).jpeg({ quality: Math.max(30, 100 - this.o.tile.quality * 5) }).toBuffer();
  }

  // The pack footer, or null for a missing or corrupt pack. Cached by mtime.
  private footer(file: string): PackFooter | null {
    let st;
    try {
      st = statSync(file);
    } catch {
      return null;
    }
    const hit = this.footers.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.footer;
    let footer: PackFooter | null = null;
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      const tail = Buffer.alloc(8);
      if (st.size >= 8) readSync(fd, tail, 0, 8, st.size - 8);
      const len = tail.readUInt32LE(0);
      if (tail.subarray(4).equals(MAGIC) && len > 0 && len < 1_000_000 && len <= st.size - 8) {
        const json = Buffer.alloc(len);
        readSync(fd, json, 0, len, st.size - 8 - len);
        const f = JSON.parse(json.toString('utf8')) as PackFooter;
        if (f.v === 1 && Array.isArray(f.slots)) footer = f;
      }
    } catch {
      footer = null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (!footer) logger.warn({ file }, 'stills_pack_unreadable');
    if (this.footers.size >= FOOTER_CACHE) this.footers.delete(this.footers.keys().next().value!);
    this.footers.set(file, { mtimeMs: st.mtimeMs, footer });
    return footer;
  }

  private sidecar(file: string): Sidecar | null {
    try {
      const s = JSON.parse(readFileSync(file, 'utf8')) as Sidecar;
      return s.v === 1 && Array.isArray(s.present) ? s : null;
    } catch {
      return null;
    }
  }

  async readStill(ts: number): Promise<Buffer | undefined> {
    const minute = minuteOf(ts);
    if (this.current?.minute === minute) {
      const slot = (ts - minute) / (this.o.intervalS * 1000);
      return Number.isInteger(slot) ? this.current.stills[slot] : undefined;
    }
    const file = `${minutePath(this.o.dataDir, 'stills', this.o.cam, minute)}.pack`;
    const f = this.footer(file);
    if (!f) return undefined;
    const slot = (ts - minute) / (f.intervalS * 1000);
    if (!Number.isInteger(slot) || !f.slots[slot]?.[1]) return undefined;
    const [off, len] = f.slots[slot];
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, off);
      return buf;
    } finally {
      await fh.close();
    }
  }

  // The oldest minute kept on disk (or the one being collected), or null:
  // the first entry of the sorted YYYY/MM/DD/HHMM folders. Cheap: a few
  // directory reads, not a scan.
  oldest(kind: 'stills' | 'previews'): number | null {
    const ext = kind === 'stills' ? '.pack' : '.json';
    const base = join(this.o.dataDir, kind, this.o.cam);
    const sorted = (dir: string, re: RegExp) => {
      try {
        return readdirSync(dir).filter((n) => re.test(n)).sort();
      } catch {
        return [];
      }
    };
    for (const y of sorted(base, /^\d{4}$/)) {
      for (const mo of sorted(join(base, y), /^\d{2}$/)) {
        for (const d of sorted(join(base, y, mo), /^\d{2}$/)) {
          const file = sorted(join(base, y, mo, d), new RegExp(`^\\d{4}\\${ext}$`))[0];
          if (file) return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(file.slice(0, 2)), Number(file.slice(2, 4)));
        }
      }
    }
    return this.current?.minute ?? null;
  }

  // Timestamps with a still, oldest first. The caller bounds the range.
  listStills(from: number, to: number): number[] {
    const out: number[] = [];
    for (let m = minuteOf(from); m <= to; m += MINUTE) {
      let stamps: number[];
      if (this.current?.minute === m) {
        stamps = this.current.stills.flatMap((s, i) => (s ? [m + i * this.o.intervalS * 1000] : []));
      } else {
        const file = `${minutePath(this.o.dataDir, 'stills', this.o.cam, m)}.pack`;
        if (!existsSync(file)) continue;
        const f = this.footer(file);
        if (!f) continue;
        stamps = f.slots.flatMap(([, len], i) => (len ? [m + i * f.intervalS * 1000] : []));
      }
      for (const t of stamps) if (t >= from && t <= to) out.push(t);
    }
    return out;
  }

  listPreviews(from: number, to: number): PreviewMinute[] {
    const out: PreviewMinute[] = [];
    for (let m = minuteOf(from); m <= to; m += MINUTE) {
      if (this.current?.minute === m) {
        out.push({ minute: m, cols: this.cols, rows: this.rows, tileW: this.tileW, tileH: this.tileH, intervalS: this.o.intervalS, present: this.current.tiles.map(Boolean) });
        continue;
      }
      const s = this.sidecar(`${minutePath(this.o.dataDir, 'previews', this.o.cam, m)}.json`);
      if (s) out.push({ minute: s.minute, cols: s.cols, rows: s.rows, tileW: s.tileW, tileH: s.tileH, intervalS: s.intervalS, present: s.present });
    }
    return out;
  }

  // A minute's sprite; the minute being collected is composed on demand.
  async readSprite(minute: number): Promise<Buffer | undefined> {
    if (this.current?.minute === minute) return this.compose(this.current.tiles);
    try {
      return readFileSync(`${minutePath(this.o.dataDir, 'previews', this.o.cam, minute)}.jpg`);
    } catch {
      return undefined;
    }
  }

  // Is this the minute still being collected (not final yet)?
  isCurrent(ts: number): boolean {
    return this.current?.minute === minuteOf(ts);
  }
}
