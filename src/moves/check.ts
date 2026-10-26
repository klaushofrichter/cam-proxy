import { relOk } from './import';
import { KIND_FOLDERS, parseChunkId } from './inventory';
import type { MoveRecord } from './journal';
import type { KeepList, MoveCheck, MoveKind } from './types';

// The completeness check on the receiving side (step 4 spec §3): before a move
// concludes, the target compares per chunk the sender's listing with what it
// holds and verified. Missing files still on the sender get one more copy
// pass (copier.ts `completeness`); what failed, or what the sender's
// retention removed meanwhile, is reported, not retried.

// One file of a chunk's manifest at the source.
export interface ManifestFile { path: string; size: number; sha256: string }

// One chunk at the check: the source's listing now, and what the target knows
// of it (verified: in its part file or on disk by size and hash; failed: the
// part's `ff`; expired: the part's `xf`, files the source's retention removed
// while they were copied).
export interface ChunkTally { kind: MoveKind; listed: ManifestFile[]; verified: Set<string>; failed: Set<string>; expired: Set<string> }

// Not verified: failed → failed, listed or not; expired → expired, listed or
// not (the source answers a relist from its manifest cache, so a file its
// retention removed stays listed); the other listed ones → missing.
export function compareChunk(t: ChunkTally): { missing: string[]; failed: string[]; expired: string[] } {
  const listed = new Set(t.listed.map((f) => f.path));
  const missing: string[] = [];
  const failed: string[] = [];
  for (const p of listed) {
    if (t.verified.has(p)) continue;
    if (t.failed.has(p)) failed.push(p);
    else if (!t.expired.has(p)) missing.push(p);
  }
  for (const p of t.failed) if (!listed.has(p) && !t.verified.has(p)) failed.push(p);
  const expired = [...t.expired].filter((p) => !t.verified.has(p) && !t.failed.has(p));
  return { missing, failed, expired };
}

// The counts per kind (only kinds with a count); complete = nothing missing, nothing failed.
export function tallyCheck(rows: { kind: MoveKind; missing: number; recovered: number; failed: number; expired: number }[]): MoveCheck {
  const check: MoveCheck = { complete: true, missing: {}, recovered: {}, failed: {}, expired: {} };
  for (const r of rows) {
    for (const k of ['missing', 'recovered', 'failed', 'expired'] as const) {
      if (r[k] > 0) check[k][r.kind] = (check[k][r.kind] ?? 0) + r[k];
    }
  }
  check.complete = Object.keys(check.missing).length === 0 && Object.keys(check.failed).length === 0;
  return check;
}

// ---- What the sending side keeps (step 4 Task 6, spec "Decisions for Klaus" 1-2) ----
//
// The receiving side reports, per chunk, the paths the source has to keep (or
// the whole chunk), straight to the sending proxy (PUT /api/moves/:id/outcome,
// ruling 4); the source then deletes only the rest. Archive is never deleted
// un-copied: every Archive chunk not verified here is kept whole, and the
// source deletes an Archive item only when the receiver names its chunk as
// copied with the very listing the source still has (purge.ts purgeExcept).

// What the source has to keep of one chunk: `all` for the whole chunk; `own`:
// files of those names the target stored itself (the overlap minute's still
// pack holds the seconds before the switch-over).
export interface ChunkKeep { missing: string[]; failed: string[]; own?: string[]; all?: true }
export type ChunkListing = { files: number; bytes: number; rows: number };
// The report's body: the keep list, the Archive paths of it still missing (the
// "Kept here" note's reason), the Archive chunks copied as they were listed.
export interface MoveOutcome { keep: KeepList; missing?: string[]; copied?: Record<string, ChunkListing> }
// The source's answers to the outcome report that sending again cannot change.
export const OUTCOME_REFUSED: readonly number[] = [400, 403, 404, 409, 413];

export const KEEP_PATHS_MAX = 1000;
export const OUTCOME_BYTES_MAX = 1024 * 1024;
// The receiver's own bound, with room for the JSON around the lists.
const OUTCOME_AIM = OUTCOME_BYTES_MAX - 64 * 1024;

const kindOf = (chunkId: string): MoveKind => chunkId.split(':')[0] as MoveKind;

// The keep list of a move on the target. From the check (`perChunk`): missing,
// failed and own paths; whole chunks the check could not compare. From the
// record: a chunk whose rows never imported is kept whole (they exist only at
// the source), and every Archive chunk not verified and not in `perChunk`
// (failed, skipped, not reached) is kept whole. More than 1000 paths in a
// chunk keep the whole chunk (ruling 22). `abandoned`: the transfer ended
// early (no check ran); the same rules, so what was not verified stays.
export function keepListOf(r: Pick<MoveRecord, 'manifest' | 'chunks'>, perChunk: Map<string, ChunkKeep>, abandoned: boolean): KeepList {
  void abandoned;
  const keep: KeepList = {};
  for (const [id, k] of perChunk) {
    if (k.all) {
      keep[id] = 'all';
      continue;
    }
    const paths = [...new Set([...k.missing, ...k.failed, ...(k.own ?? [])])];
    if (paths.length) keep[id] = paths.length > KEEP_PATHS_MAX ? 'all' : paths;
  }
  const ids = [...new Set([...(r.manifest ?? []).map((c) => c.id), ...Object.keys(r.chunks)])];
  for (const id of ids) {
    if (keep[id] === 'all') continue;
    const rec = r.chunks[id];
    const rowsOnlyThere = rec?.state === 'failed' && rec.rowsInserted === undefined && (rec.meta?.rows ?? 0) > 0;
    // Not verified here: a chunk cams-admin reported done (B34) has no `v` (never checked on this proxy).
    const verifiedHere = rec?.state === 'verified' && rec.v !== undefined;
    if (rowsOnlyThere || (kindOf(id) === 'archive' && !verifiedHere && !perChunk.has(id))) keep[id] = 'all';
  }
  return keep;
}

// The whole report: the keep list, the missing Archive paths, and the Archive
// chunks copied here (verified or failed, as the source listed them). Bounded
// below 1 MiB: the longest lists become 'all' until it fits (keeps more).
export function outcomeOf(r: Pick<MoveRecord, 'manifest' | 'chunks'>, perChunk: Map<string, ChunkKeep>, abandoned: boolean): MoveOutcome {
  const keep = keepListOf(r, perChunk, abandoned);
  const missing = [...perChunk].filter(([id]) => kindOf(id) === 'archive').flatMap(([, k]) => k.missing);
  const copied: Record<string, ChunkListing> = {};
  for (const [id, rec] of Object.entries(r.chunks)) {
    // Only chunks copied and checked here (a done-list chunk, B34, has no `v`: never copied).
    if (kindOf(id) === 'archive' && (rec.state === 'verified' || rec.state === 'failed') && rec.v !== undefined && rec.meta) copied[id] = { files: rec.meta.files, bytes: rec.meta.bytes, rows: rec.meta.rows };
  }
  const out: MoveOutcome = { keep, ...(missing.length ? { missing: [...new Set(missing)] } : {}), ...(Object.keys(copied).length ? { copied } : {}) };
  let size = Buffer.byteLength(JSON.stringify(out));
  while (size > OUTCOME_AIM) {
    const lists = Object.entries(keep).filter((e): e is [string, string[]] => Array.isArray(e[1]));
    if (!lists.length) {
      // Only the reasons left to cut: the items stay all the same (reason failed instead of missing).
      delete out.missing;
      break;
    }
    const [id] = lists.reduce((a, b) => (Buffer.byteLength(JSON.stringify(b[1])) > Buffer.byteLength(JSON.stringify(a[1])) ? b : a));
    keep[id] = 'all';
    size = Buffer.byteLength(JSON.stringify(out));
  }
  return out;
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const chunkKind = (id: string): MoveKind | null => {
  try {
    return parseChunkId(id).kind;
  } catch {
    return null;
  }
};
const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;

// A report as the source takes it (Review Focus 5): null when not of the
// shape; paths outside the camera's folders of the chunk's kind are dropped
// (they can only ever make the source keep more, never delete more).
export function parseOutcome(cam: string, body: unknown): MoveOutcome | null {
  if (!plain(body) || !plain(body.keep)) return null;
  for (const k of Object.keys(body)) if (!['keep', 'missing', 'copied'].includes(k)) return null;
  const keep: KeepList = {};
  for (const [id, v] of Object.entries(body.keep)) {
    const kind = chunkKind(id);
    if (!kind) return null;
    if (v === 'all') keep[id] = 'all';
    else if (Array.isArray(v) && v.every((p) => typeof p === 'string')) keep[id] = [...new Set((v as string[]).filter((p) => relOk(cam, p, KIND_FOLDERS[kind])))];
    else return null;
  }
  const out: MoveOutcome = { keep };
  if (body.missing !== undefined) {
    if (!Array.isArray(body.missing) || !body.missing.every((p) => typeof p === 'string')) return null;
    out.missing = [...new Set((body.missing as string[]).filter((p) => relOk(cam, p, KIND_FOLDERS.archive)))];
  }
  if (body.copied !== undefined) {
    if (!plain(body.copied)) return null;
    const copied: Record<string, ChunkListing> = {};
    for (const [id, v] of Object.entries(body.copied)) {
      if (chunkKind(id) !== 'archive' || !plain(v) || !count(v.files) || !count(v.bytes) || !count(v.rows)) return null;
      copied[id] = { files: v.files as number, bytes: v.bytes as number, rows: v.rows as number };
    }
    out.copied = copied;
  }
  return out;
}

// A later report only ever keeps more: keep lists are a union ('all' wins),
// missing paths a union, and an Archive chunk counts as copied only when every
// report named it alike (a report without `copied` names none: from then on no
// Archive chunk counts as copied).
export function mergeOutcome(r: Pick<MoveRecord, 'keep' | 'keepMissing' | 'keepCopied'>, o: MoveOutcome): void {
  const firstReport = r.keep === undefined && r.keepCopied === undefined;
  const keep: KeepList = { ...(r.keep ?? {}) };
  for (const [id, v] of Object.entries(o.keep)) {
    const was = keep[id];
    if (was === 'all' || v === 'all') keep[id] = 'all';
    else {
      const paths = [...new Set([...(was ?? []), ...v])];
      if (paths.length || was) keep[id] = paths;
    }
  }
  r.keep = keep;
  if (o.missing?.length || r.keepMissing) r.keepMissing = [...new Set([...(r.keepMissing ?? []), ...(o.missing ?? [])])];
  const copied = o.copied ?? {};
  const same = (a: ChunkListing, b: ChunkListing | undefined) => !!b && a.files === b.files && a.bytes === b.bytes && a.rows === b.rows;
  // The first report sets it (none named: {}); every later one can only narrow it.
  r.keepCopied = firstReport ? { ...copied } : Object.fromEntries(Object.entries(r.keepCopied ?? {}).filter(([id, v]) => same(v, copied[id])));
}
