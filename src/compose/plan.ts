// Which source covers each second of a composed clip (spec 2026-09-28):
// the chosen clip, else another clip (earliest start), else that second's
// still, else a "No recording" card. Pure: no files, no ffmpeg.

export interface ClipSpan { id: number; start: number; end: number; path: string }
export type Segment =
  | { kind: 'clip'; clipId: number; path: string; inS: number; outS: number }
  | { kind: 'still'; ts: number }
  | { kind: 'card'; ts: number };
export interface PlanInput { clip: ClipSpan; preS: number; postS: number; clips: ClipSpan[]; hasStill: (ts: number) => boolean }
export type Plan = { ok: true; start: number; end: number; durationS: number; segments: Segment[] } | { ok: false; error: string };

export const MAX_S = 60;
export const MIN_ROLL = -600;
export const MAX_ROLL = 60;

const roll = (v: number) => Number.isInteger(v) && v >= MIN_ROLL && v <= MAX_ROLL;

export function planComposition(p: PlanInput): Plan {
  if (!roll(p.preS) || !roll(p.postS)) return { ok: false, error: 'pre-roll and post-roll are whole seconds from -600 to 60' };
  const start = p.clip.start - p.preS * 1000;
  const rawEnd = p.clip.end + p.postS * 1000;
  const overlap = Math.min(rawEnd, p.clip.end) - Math.max(start, p.clip.start);
  if (overlap < 1000) return { ok: false, error: 'at least 1 s of the clip must remain' };
  // Whole seconds: a clip ends on a fractional second (the camera's file),
  // and its last partial second is its own, not a still's (final review).
  const durationS = Math.round((rawEnd - start) / 1000);
  if (durationS > MAX_S) return { ok: false, error: `at most ${MAX_S} s` };
  const end = start + durationS * 1000;

  const others = p.clips.filter((c) => c.id !== p.clip.id).sort((a, b) => a.start - b.start || a.id - b.id);
  // A clip covers a second it fills at least half of.
  const covering = (t: number) => [p.clip, ...others].find((c) => t >= c.start && t + 1000 <= c.end + 500);
  const segments: Segment[] = [];
  for (let t = start; t < end; t += 1000) {
    const c = covering(t);
    const last = segments[segments.length - 1];
    if (c) {
      const inS = (t - c.start) / 1000;
      const outS = Math.min(inS + 1, (c.end - c.start) / 1000);
      if (last?.kind === 'clip' && last.clipId === c.id && last.outS === inS) last.outS = outS;
      else segments.push({ kind: 'clip', clipId: c.id, path: c.path, inS, outS });
    } else {
      segments.push({ kind: p.hasStill(t) ? 'still' : 'card', ts: t });
    }
  }
  return { ok: true, start, end, durationS, segments };
}
