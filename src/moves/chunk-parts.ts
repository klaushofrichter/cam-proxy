import { readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { PrivateFileInvalid, readPrivateJson, writePrivateJson } from '../fleet/private-file';
import type { ImportMap } from './import';
import { isMoveId } from './journal';

// What one copied chunk brought to the target, beside the move's journal
// record (final review 6): <dataDir>/admin/moves/<moveId>.chunks/<chunk>.json,
// mode 600 in a 700 folder, compact JSON, written once at the chunk's end. The
// record keeps the chunk's state and counts only, so it stays small however
// much a chunk holds and its frequent progress saves stay cheap.
// `vf`: the id-named files verified (their staged copies are renamed by the
// import, so a disk check can't find them again); `imported`: source id →
// target id and the row's natural key, per table (a delete-cancel removes a
// row only when its key still matches, purge.ts). Removed with the move
// (finish, cancel) and by the journal's sweep when no record names it.
export interface ChunkPart {
  vf?: string[];
  imported?: ImportMap;
}

const CHUNK = /^(stills|clips|events|checks|archive):\d{4}-\d{2}-\d{2}$/;

export function chunkPartsDir(dataDir: string, moveId: string): string {
  if (!isMoveId(moveId)) throw new Error('invalid move id');
  return join(dataDir, 'admin', 'moves', `${moveId}.chunks`);
}

function partPath(dataDir: string, moveId: string, chunkId: string): string {
  if (!CHUNK.test(chunkId)) throw new Error('invalid chunk id');
  return join(chunkPartsDir(dataDir, moveId), `${chunkId.replace(':', '_')}.json`);
}

// null when the chunk has none (not copied yet) or its file is not readable as one.
export function readChunkPart(dataDir: string, moveId: string, chunkId: string): ChunkPart | null {
  try {
    const v = readPrivateJson(partPath(dataDir, moveId, chunkId)) as ChunkPart | null;
    return v && typeof v === 'object' ? v : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || err instanceof PrivateFileInvalid) return null;
    throw err;
  }
}

export function writeChunkPart(dataDir: string, moveId: string, chunkId: string, part: ChunkPart): void {
  writePrivateJson(partPath(dataDir, moveId, chunkId), part, false);
}

// Every chunk part of a move (a delete-cancel's import maps).
export function allChunkParts(dataDir: string, moveId: string): ChunkPart[] {
  let names: string[];
  try {
    names = readdirSync(chunkPartsDir(dataDir, moveId));
  } catch {
    return [];
  }
  const out: ChunkPart[] = [];
  for (const n of names.sort()) {
    const m = /^(stills|clips|events|checks|archive)_(\d{4}-\d{2}-\d{2})\.json$/.exec(n);
    if (!m) continue;
    const p = readChunkPart(dataDir, moveId, `${m[1]}:${m[2]}`);
    if (p) out.push(p);
  }
  return out;
}

export function removeChunkParts(dataDir: string, moveId: string): void {
  rmSync(chunkPartsDir(dataDir, moveId), { recursive: true, force: true });
}
