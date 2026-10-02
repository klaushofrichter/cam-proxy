// The pairing rules (spec 2026-10-02-inventory-design §4, decision 7): an SD
// recording and a local clip are the same recording when they have the same
// stream and their starts are at most 5 s apart (cams' rule, and clipNear's).
// Each clip pairs with one recording at most and the reverse: the closest
// starts pair first; on a tie the earlier recording, then the lower clip id.

export const START_SLACK_MS = 5_000;

export interface Pairable { start: number; stream: string }
export interface Pairing<R, L> { pairs: { rec: R; clip: L }[]; recsAlone: R[]; clipsAlone: L[] }

export function pairByStart<R extends Pairable, L extends Pairable & { id: number }>(recs: R[], clips: L[], slackMs = START_SLACK_MS): Pairing<R, L> {
  const sortedClips = [...clips].sort((a, b) => a.start - b.start || a.id - b.id);
  const cand: { r: number; c: number; d: number }[] = [];
  let lo = 0;
  const order = recs.map((_, i) => i).sort((a, b) => recs[a].start - recs[b].start || a - b);
  for (const r of order) {
    const rec = recs[r];
    while (lo < sortedClips.length && sortedClips[lo].start < rec.start - slackMs) lo++;
    for (let c = lo; c < sortedClips.length && sortedClips[c].start <= rec.start + slackMs; c++) {
      if (sortedClips[c].stream === rec.stream) cand.push({ r, c, d: Math.abs(sortedClips[c].start - rec.start) });
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
