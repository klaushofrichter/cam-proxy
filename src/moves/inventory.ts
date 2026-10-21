import { createHash } from 'crypto';
import { constants, existsSync, lstatSync, readdirSync } from 'fs';
import { open } from 'fs/promises';
import { join, relative, resolve, sep } from 'path';
import { CAM_ID } from '../archive/paths';
import type { Catalog } from '../catalog/db';
import type { KindSummary, MoveKind, MoveSummary } from './types';
import { MOVE_KINDS } from './types';

// What one camera has to move, as chunks of one kind and one UTC day (plan P6,
// chunk id `<kind>:<YYYY-MM-DD>`), their file manifests and their catalog rows.
// Pure reads: hashes are computed on demand (P5), caching is the journal's job.
//
// Paths (B13). Folders per kind: stills = stills + previews, clips = clips,
// events = analytics, checks = still-checks, archive = archive; all under
// <dataDir>/<folder>/<cam>/. Path columns of the catalog (absolute on the
// source): clips.path, clips.snapshot, analyses.image, still_checks.image.
// `chunkRows` returns them as dataDir-relative posix paths (null when the file
// lies outside the camera's folders); a clip row whose path is not valid is
// not part of the chunk. Files named by a catalog id: archive/<cam>/<id>/*,
// analytics/<cam>/<eventId>.jpg, still-checks/<cam>/check-<id>.jpg; the
// importer renames them with the new row id. Source row ids are kept in the
// rows (events.id, analyses.event_id, ...). Not moved (P6): stream_log,
// analytics_usage, clip_arrivals, annotations, the recordings cache.

export interface InventoryDeps { catalog: Pick<Catalog, 'db'>; dataDir: string }
export interface ChunkMeta { id: string; kind: MoveKind; day: string; files: number; bytes: number; rows: number }
export interface ManifestFile { path: string; size: number; sha256: string }
export interface TableRows { table: string; rows: object[] }

const FOLDERS: Record<MoveKind, string[]> = { stills: ['stills', 'previews'], clips: ['clips'], events: ['analytics'], checks: ['still-checks'], archive: ['archive'] };
// Every folder a camera's moved content lies in (<dataDir>/<folder>/<cam>/...).
export const CONTENT_FOLDERS: readonly string[] = Object.values(FOLDERS).flat();
// Within a day: small and most-opened first (P11).
const ORDER: MoveKind[] = ['clips', 'events', 'checks', 'archive', 'stills'];
const DAY_MS = 86_400_000;
const CHUNK_ID = /^(stills|clips|events|checks|archive):(\d{4})-(\d{2})-(\d{2})$/;

const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);

function camCheck(cam: string): void {
  if (!CAM_ID.test(cam)) throw new Error('not a camera id');
}

export function parseChunkId(id: string): { kind: MoveKind; day: string; from: number; to: number } {
  const m = CHUNK_ID.exec(id);
  const from = m ? Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4])) : NaN;
  if (!m || Number.isNaN(from) || dayOf(from) !== id.slice(m[1].length + 1)) throw new Error('not a chunk id');
  return { kind: m[1] as MoveKind, day: id.slice(m[1].length + 1), from, to: from + DAY_MS };
}

class Cam {
  constructor(readonly d: InventoryDeps, readonly cam: string) {
    camCheck(cam);
  }

  // The absolute path when it lies inside one of the camera's content folders.
  valid(path: unknown): string | null {
    if (typeof path !== 'string' || !path) return null;
    const p = resolve(path);
    for (const folder of Object.values(FOLDERS).flat()) {
      if (p.startsWith(join(resolve(this.d.dataDir), folder, this.cam) + sep)) return p;
    }
    return null;
  }

  rel(abs: string): string {
    return relative(resolve(this.d.dataDir), abs).split(sep).join('/');
  }

  relOrNull(path: unknown): string | null {
    const p = this.valid(path);
    return p ? this.rel(p) : null;
  }

  // A regular file's size (links are not followed), or null.
  size(abs: string | null): number | null {
    if (!abs) return null;
    try {
      const st = lstatSync(abs);
      return st.isFile() ? st.size : null;
    } catch {
      return null;
    }
  }

  // Regular files below a folder, sorted.
  walk(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const go = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) go(p);
        else if (e.isFile()) out.push(p);
      }
    };
    go(dir);
    return out.sort();
  }

  rows<T>(sql: string, ...args: (string | number)[]): T[] {
    return this.d.catalog.db.prepare(sql).all(...args) as T[];
  }
}


// One kind of one camera as items: stills days are folders; the others are rows
// with their files. `range` limits the rows (by their day timestamp) for a chunk.
function items(c: Cam, kind: MoveKind, range?: { from: number; to: number }): { ts: number; files: string[]; rows: { table: string; row: Record<string, unknown> }[] }[] {
  const lo = range?.from ?? -Infinity;
  const hi = range?.to ?? Infinity;
  const { dataDir } = c.d;
  const out: { ts: number; files: string[]; rows: { table: string; row: Record<string, unknown> }[] }[] = [];
  if (kind === 'stills') {
    for (const folder of FOLDERS.stills) {
      const base = join(dataDir, folder, c.cam);
      for (const f of c.walk(base)) {
        const m = /^(\d{4})\/(\d{2})\/(\d{2})\//.exec(c.rel(f).slice(`${folder}/${c.cam}/`.length));
        const hm = /^(\d{2})(\d{2})/.exec(f.slice(f.lastIndexOf(sep) + 1));
        if (!m || !hm) continue;
        const ts = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(hm[1]), Number(hm[2]));
        if (!Number.isNaN(ts) && ts >= lo && ts < hi) out.push({ ts, files: [f], rows: [] });
      }
    }
  } else if (kind === 'clips') {
    for (const r of c.rows<Record<string, unknown> & { start_ts: number }>('SELECT * FROM clips WHERE cam = ? AND start_ts >= ? AND start_ts < ? ORDER BY start_ts, id', c.cam, Math.max(lo, -1e18), Math.min(hi, 1e18))) {
      const path = c.relOrNull(r.path);
      if (!path) continue;
      const snapshot = c.relOrNull(r.snapshot);
      const files = [c.valid(r.path)!, ...(snapshot ? [c.valid(r.snapshot)!] : [])];
      out.push({ ts: r.start_ts, files, rows: [{ table: 'clips', row: { ...r, path, snapshot } }] });
    }
  } else if (kind === 'events') {
    for (const e of c.rows<Record<string, unknown> & { id: number; start_ts: number }>('SELECT * FROM events WHERE cam = ? AND start_ts >= ? AND start_ts < ? ORDER BY start_ts, id', c.cam, Math.max(lo, -1e18), Math.min(hi, 1e18))) {
      const analyses = c.rows<Record<string, unknown>>('SELECT * FROM analyses WHERE event_id = ? ORDER BY id', e.id).map((a) => ({ ...a, image: c.relOrNull(a.image) }));
      const files = analyses.flatMap((a) => (a.image ? [join(resolve(dataDir), a.image as string)] : []));
      out.push({ ts: e.start_ts, files, rows: [{ table: 'events', row: e }, ...analyses.map((a) => ({ table: 'analyses', row: a }))] });
    }
  } else if (kind === 'checks') {
    for (const r of c.rows<Record<string, unknown> & { still_ts: number }>('SELECT * FROM still_checks WHERE cam = ? AND still_ts >= ? AND still_ts < ? ORDER BY still_ts, id', c.cam, Math.max(lo, -1e18), Math.min(hi, 1e18))) {
      const image = c.relOrNull(r.image);
      out.push({ ts: r.still_ts, files: image ? [join(resolve(dataDir), image)] : [], rows: [{ table: 'still_checks', row: { ...r, image } }] });
    }
  } else {
    for (const r of c.rows<Record<string, unknown> & { id: number; created_at: number }>('SELECT * FROM archive WHERE cam = ? AND created_at >= ? AND created_at < ? ORDER BY created_at, id', c.cam, Math.max(lo, -1e18), Math.min(hi, 1e18))) {
      out.push({ ts: r.created_at, files: c.walk(join(dataDir, 'archive', c.cam, String(r.id))), rows: [{ table: 'archive', row: r }] });
    }
  }
  return out;
}

// Files of an item that exist (a file removed by retention is simply absent).
function existing(c: Cam, files: string[]): { abs: string; size: number }[] {
  return files.flatMap((abs) => {
    const size = c.size(abs);
    return size === null ? [] : [{ abs, size }];
  });
}

export function summarize(d: InventoryDeps, cam: string): MoveSummary {
  const c = new Cam(d, cam);
  const out = {} as MoveSummary;
  for (const kind of MOVE_KINDS) {
    const s: KindSummary = { files: 0, bytes: 0, rows: 0, oldest: null, newest: null };
    const seen = new Set<string>();
    for (const it of items(c, kind)) {
      for (const f of existing(c, it.files)) {
        if (seen.has(f.abs)) continue;
        seen.add(f.abs);
        s.files++;
        s.bytes += f.size;
      }
      s.rows += it.rows.length;
      s.oldest = s.oldest === null ? it.ts : Math.min(s.oldest, it.ts);
      s.newest = s.newest === null ? it.ts : Math.max(s.newest, it.ts);
    }
    out[kind] = s;
  }
  return out;
}

// Newest day first, then clips, events, checks, archive, stills (P11).
export function listChunks(d: InventoryDeps, cam: string, kinds: MoveKind[]): ChunkMeta[] {
  const c = new Cam(d, cam);
  const out: ChunkMeta[] = [];
  for (const kind of ORDER.filter((k) => kinds.includes(k))) {
    const byDay = new Map<string, { files: Map<string, number>; rows: number }>();
    for (const it of items(c, kind)) {
      const day = dayOf(it.ts);
      const e = byDay.get(day) ?? { files: new Map(), rows: 0 };
      for (const f of existing(c, it.files)) e.files.set(f.abs, f.size);
      e.rows += it.rows.length;
      byDay.set(day, e);
    }
    for (const [day, e] of byDay) out.push({ id: `${kind}:${day}`, kind, day, files: e.files.size, bytes: [...e.files.values()].reduce((a, b) => a + b, 0), rows: e.rows });
  }
  return out.sort((a, b) => (a.day === b.day ? ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) : a.day < b.day ? 1 : -1));
}

// Opens the file (a link is refused), checks it is a regular file and streams
// it through the hash. The size is the number of bytes hashed, so the two
// always describe the same bytes even if the file is replaced meanwhile.
async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await fh.stat()).isFile()) throw new Error('not a regular file');
    const h = createHash('sha256');
    let size = 0;
    for await (const chunk of fh.createReadStream({ autoClose: false })) {
      h.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
    return { size, sha256: h.digest('hex') };
  } finally {
    await fh.close();
  }
}

// Hashes the chunk's files now, without blocking the event loop. A file that
// vanishes meanwhile (ENOENT: retention) is left out and counted `expired`;
// any other read error (a link, a folder, EACCES, EIO, ...) rejects, so a
// manifest silently missing a file is never cached (P5). `hooks` is for tests.
export async function chunkManifest(d: InventoryDeps, cam: string, chunkId: string, hooks: { beforeOpen?: (abs: string) => void } = {}): Promise<{ files: ManifestFile[]; rows: number; expired: number }> {
  const c = new Cam(d, cam);
  const { kind, from, to } = parseChunkId(chunkId);
  const files = new Set<string>();
  let rows = 0;
  for (const it of items(c, kind, { from, to })) {
    for (const f of existing(c, it.files)) files.add(f.abs);
    rows += it.rows.length;
  }
  const out: ManifestFile[] = [];
  let expired = 0;
  for (const abs of files) {
    if (!c.valid(abs)) continue;
    try {
      hooks.beforeOpen?.(abs);
      out.push({ path: c.rel(abs), ...(await hashFile(abs)) });
    } catch (err) {
      // removed by retention between listing and hashing
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      expired++;
    }
  }
  return { files: out.sort((x, y) => (x.path < y.path ? -1 : 1)), rows, expired };
}

// Rows in insert order (an event's analyses follow the events), paths made relative.
export function chunkRows(d: InventoryDeps, cam: string, chunkId: string): TableRows[] {
  const c = new Cam(d, cam);
  const { kind, from, to } = parseChunkId(chunkId);
  const tables = new Map<string, object[]>();
  for (const it of items(c, kind, { from, to })) for (const r of it.rows) tables.set(r.table, [...(tables.get(r.table) ?? []), r.row]);
  // events first, then analyses (rows of one table keep their order).
  return ['events', 'analyses', 'clips', 'still_checks', 'archive'].flatMap((t) => (tables.has(t) ? [{ table: t, rows: tables.get(t)! }] : []));
}
