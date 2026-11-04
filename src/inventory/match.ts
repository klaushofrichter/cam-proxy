// The pairing rules (spec 2026-10-02-inventory-design §4, decision 7; #342): an
// SD recording and a local clip are the same recording when they have the same
// stream and either
// - their starts are at most 5 s apart (clipNear's rule), or
// - the clip came by FTP, starts more than 5 s and at most 10 s after the
//   recording, and before the recording ended. An E1 Outdoor Pro's FTP clip
//   starts about 8 s after the SD recording (measured 2026-11-03/04). A fetched
//   clip starts exactly where its recording does, so this window is not for it;
//   an RLC-1224A's clips at +13 s and later are other recordings (no wider).
// Each clip pairs with one recording at most and the reverse: the closest
// starts pair first, so a clip within 5 s always wins over the late window; on
// a tie the earlier recording, then the lower clip id.

// Greedy closest-first is not a maximum matching: it can leave a recording and
// a clip alone that a different choice would have paired. That needs two
// same-stream clips (or recordings) less than 10 s apart, which is rare, and
// the closest pair is the likeliest to be the same recording. Pinned by a test.
export const START_SLACK_MS = 5_000;
export const LATE_START_MS = 10_000;

interface Pairable { start: number; stream: string }
// `end`: a recording's end; without it, no late clip pairs with it.
interface PairableRec extends Pairable { end?: number }
// `origin`: only an FTP clip may start late.
interface PairableClip extends Pairable { id: number; origin?: string }
interface Pairing<R, L> { pairs: { rec: R; clip: L }[]; recsAlone: R[]; clipsAlone: L[] }

// Whether a clip is a recording's by the rules above (the distance decides who wins).
export function sameRecording(rec: PairableRec, clip: Pick<PairableClip, 'start' | 'stream' | 'origin'>): boolean {
  if (clip.stream !== rec.stream) return false;
  if (Math.abs(clip.start - rec.start) <= START_SLACK_MS) return true;
  return clip.origin === 'ftp' && rec.end !== undefined && clip.start > rec.start && clip.start <= rec.start + LATE_START_MS && clip.start < rec.end;
}

export function pairByStart<R extends PairableRec, L extends PairableClip>(recs: R[], clips: L[]): Pairing<R, L> {
  const sortedClips = [...clips].sort((a, b) => a.start - b.start || a.id - b.id);
  const cand: { r: number; c: number; d: number }[] = [];
  let lo = 0;
  const order = recs.map((_, i) => i).sort((a, b) => recs[a].start - recs[b].start || a - b);
  for (const r of order) {
    const rec = recs[r];
    while (lo < sortedClips.length && sortedClips[lo].start < rec.start - START_SLACK_MS) lo++;
    for (let c = lo; c < sortedClips.length && sortedClips[c].start <= rec.start + LATE_START_MS; c++) {
      if (sameRecording(rec, sortedClips[c])) cand.push({ r, c, d: Math.abs(sortedClips[c].start - rec.start) });
    }
  }
  cand.sort((a, b) => a.d - b.d || recs[a.r].start - recs[b.r].start || a.r - b.r || sortedClips[a.c].id - sortedClips[b.c].id);
  const recUsed = new Set<number>();
  const clipUsed = new Set<number>();
  const pairs: { rec: R; clip: L }[] = [];
  for (const x of cand) {
    if (recUsed.has(x.r) || clipUsed.has(x.c)) continue;
    recUsed.add(x.r);
    clipUsed.add(x.c);
    pairs.push({ rec: recs[x.r], clip: sortedClips[x.c] });
  }
  pairs.sort((a, b) => a.rec.start - b.rec.start);
  return {
    pairs,
    recsAlone: order.filter((r) => !recUsed.has(r)).map((r) => recs[r]),
    clipsAlone: sortedClips.filter((_, c) => !clipUsed.has(c)),
  };
}

// A recording held twice (#342): the clip paired with it and a clip left over
// that is the same recording by the rules above, one fetched from the camera
// and one that came by FTP. Only left-over clips count, so a clip that is
// another recording's is never called a duplicate, and one FTP clip answers for
// one fetched clip at most (closest first, as the pairing).
export interface Duplicate<R, L> { rec: R; fetched: L; ftp: L }
export function duplicatesAmong<R extends PairableRec, L extends PairableClip>(pairs: { rec: R; clip: L }[], clipsAlone: L[]): Duplicate<R, L>[] {
  const cand: { p: number; c: number; d: number }[] = [];
  for (const [p, { rec, clip }] of pairs.entries()) {
    if (clip.origin !== 'camera' && clip.origin !== 'ftp') continue;
    for (const [c, other] of clipsAlone.entries()) {
      if ((other.origin === 'camera' || other.origin === 'ftp') && other.origin !== clip.origin && sameRecording(rec, other)) cand.push({ p, c, d: Math.abs(other.start - rec.start) });
    }
  }
  cand.sort((a, b) => a.d - b.d || a.p - b.p || clipsAlone[a.c].id - clipsAlone[b.c].id);
  const pairUsed = new Set<number>();
  const clipUsed = new Set<number>();
  const out: Duplicate<R, L>[] = [];
  for (const x of cand) {
    if (pairUsed.has(x.p) || clipUsed.has(x.c)) continue;
    pairUsed.add(x.p);
    clipUsed.add(x.c);
    const { rec, clip } = pairs[x.p];
    const other = clipsAlone[x.c];
    out.push(clip.origin === 'camera' ? { rec, fetched: clip, ftp: other } : { rec, fetched: other, ftp: clip });
  }
  return out.sort((a, b) => b.rec.start - a.rec.start);
}

// Whether any span overlaps [start, end] (both ends inclusive): the spans
// sorted by start, with the running maximum of their ends; the last span
// starting at or before `end` tells (binary search). Linear to build,
// logarithmic per question. Shared by the clips and the events checks.
export function coverage(spans: { start: number; end: number }[]): (start: number, end: number) => boolean {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const starts = sorted.map((x) => x.start);
  const maxEnd: number[] = [];
  for (const [i, x] of sorted.entries()) maxEnd.push(Math.max(x.end, i ? maxEnd[i - 1] : -Infinity));
  return (start, end) => {
    let lo = 0;
    let hi = starts.length; // the first span starting after `end`
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= end) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && maxEnd[lo - 1] >= start;
  };
}

// The events rule (spec §5, decision 9): per trigger kind, recordings whose
// times overlap (or touch) are one span; a recording with several kinds is
// in a span of each kind. Timer-only recordings (no kind) are in none.
// Oldest first; on a tie by kind name.
interface KindSpan<R> { kind: string; start: number; end: number; recs: R[] }
export function spansByKind<R extends { start: number; end: number; kinds: readonly string[] }>(recs: R[]): KindSpan<R>[] {
  const byKind = new Map<string, R[]>();
  for (const r of recs) {
    for (const k of new Set(r.kinds)) {
      const list = byKind.get(k) ?? [];
      list.push(r);
      byKind.set(k, list);
    }
  }
  const out: KindSpan<R>[] = [];
  for (const [kind, list] of byKind) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    let cur: KindSpan<R> | null = null;
    for (const r of list) {
      if (cur && r.start <= cur.end) {
        cur.end = Math.max(cur.end, r.end);
        cur.recs.push(r);
      } else {
        cur = { kind, start: r.start, end: r.end, recs: [r] };
        out.push(cur);
      }
    }
  }
  return out.sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind));
}
