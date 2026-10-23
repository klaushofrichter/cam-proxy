import type { MoveCheck, MoveKind } from './types';

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

// Listed and neither verified nor failed → missing; failed (not verified) →
// failed, listed or not; expired → those no longer listed (one listed again
// is missing, a later pass may fetch it).
export function compareChunk(t: ChunkTally): { missing: string[]; failed: string[]; expired: string[] } {
  const listed = new Set(t.listed.map((f) => f.path));
  const missing: string[] = [];
  const failed: string[] = [];
  for (const p of listed) {
    if (t.verified.has(p)) continue;
    if (t.failed.has(p)) failed.push(p);
    else missing.push(p);
  }
  for (const p of t.failed) if (!listed.has(p) && !t.verified.has(p)) failed.push(p);
  const expired = [...t.expired].filter((p) => !listed.has(p));
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
