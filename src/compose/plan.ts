// Which source covers each second of a composed clip (spec 2026-09-28):
// the chosen clip, else another clip (earliest start), else that second's
// still, else a "No recording" card. Pure: no files, no ffmpeg.

export interface ClipSpan { id: number; start: number; end: number; path: string }
export type Segment =
  | { kind: 'clip'; clipId: number; path: string; inS: number; outS: number }
  | { kind: 'still'; ts: number }
  | { kind: 'card'; ts: number };
// stillAt: the still that shows at second t (the latest within the stills
// interval, so stills every 2 s don't flicker to cards), or null.
// span: the recording the viewer chose (cams: the SD-card file), whose
// start and end the rolls apply to; the clip's own span when not given. The
// proxy's FTP copy can start earlier or run longer than that recording
// (cams's Save dialog, 2026-10-04: 114 s, -100, +30 gave "at most 60 s").
// maxS: the size's limit (composeMaxS), COMPOSE_MAX_S when not given.
// Without a clip (#179 phase 3, "around a second") the span is the window's
// anchor, e.g. {at, at + 1000}, and every second is any clip that covers it,
// else a still, else a card.
interface PlanInput { clip?: ClipSpan; span?: { start: number; end: number }; preS: number; postS: number; maxS?: number; clips: ClipSpan[]; stillAt: (t: number) => number | null }
export type Plan = { ok: true; start: number; end: number; durationS: number; segments: Segment[] } | { ok: false; error: string };
export type Window = { ok: true; start: number; end: number; durationS: number } | { ok: false; error: string };

// The limits (Klaus, 2026-10-04), one place for the planner and the API: a
// composed clip is at most 5 minutes, 2 minutes at 1080p. Encoding time on
// the Pi 4, estimated from an M4 Mac (CPU time x12, about 2.5 cores busy):
// 300 s takes about 2 to 2.5 minutes at SD, 3 at 720p, but 6 to 8 at 1080p,
// so 1080p stays at 120 s (about 3 minutes). Peak memory doesn't grow with the
// length (one small encode per piece), and 300 s at SD is about 40 MB.
// cams mirrors these in server/clipLimits.ts.
export const COMPOSE_MAX_S = 300;
export const COMPOSE_MAX_S_1080P = 120;
export const composeMaxS = (size: string): number => (size === '1080p' ? COMPOSE_MAX_S_1080P : COMPOSE_MAX_S);
// Pre- and post-roll: whole seconds; a negative one cuts the recording. The
// result's length is the real limit; this only keeps the numbers sane.
const ROLL_LIMIT_S = 3600;

// Seconds as people read them: "44 s", and from a minute on "114 s (1:54)"
// (Klaus, 2026-10-04); the same rule as cams's dialog.
export function formatSeconds(s: number): string {
  return s < 60 ? `${s} s` : `${s} s (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})`;
}

const roll = (v: number) => Number.isInteger(v) && Math.abs(v) <= ROLL_LIMIT_S;

// The composed clip's window: [span.start - pre, span.end + post], whole
// seconds, at least 1 s of the span left, at most maxS long. The one rule for
// the result's length (cams's resultLength is the same rule on the same table
// of cases).
export function compositionWindow(span: { start: number; end: number }, preS: number, postS: number, maxS: number = COMPOSE_MAX_S): Window {
  if (!roll(preS) || !roll(postS)) return { ok: false, error: `pre-roll and post-roll are whole seconds from -${ROLL_LIMIT_S} to ${ROLL_LIMIT_S}` };
  const start = span.start - preS * 1000;
  const rawEnd = span.end + postS * 1000;
  const overlap = Math.min(rawEnd, span.end) - Math.max(start, span.start);
  if (overlap < 1000) return { ok: false, error: 'at least 1 s of the clip must remain' };
  // Whole seconds: a clip ends on a fractional second (the camera's file),
  // and its last partial second is its own, not a still's (final review).
  const durationS = Math.round((rawEnd - start) / 1000);
  if (durationS > maxS) return { ok: false, error: `at most ${formatSeconds(maxS)}` };
  return { ok: true, start, end: start + durationS * 1000, durationS };
}

export function planComposition(p: PlanInput): Plan {
  const anchor = p.span ?? p.clip;
  if (!anchor) return { ok: false, error: 'a clip or a span is required' };
  const w = compositionWindow(anchor, p.preS, p.postS, p.maxS);
  if (!w.ok) return w;
  const { start, end, durationS } = w;

  const others = p.clips.filter((c) => c.id !== p.clip?.id).sort((a, b) => a.start - b.start || a.id - b.id);
  const candidates = p.clip ? [p.clip, ...others] : others;
  // A clip covers a second it fills at least half of.
  const covering = (t: number) => candidates.find((c) => t >= c.start && t + 1000 <= c.end + 500);
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
      const still = p.stillAt(t);
      segments.push(still === null ? { kind: 'card', ts: t } : { kind: 'still', ts: still });
    }
  }
  return { ok: true, start, end, durationS, segments };
}

// What a plan is made of, in seconds (a clip's partial last second counts as
// one, as in the length table): the dry run's answer and the audit record.
export function planSeconds(plan: Extract<Plan, { ok: true }>): { clip: number; still: number; card: number } {
  const n = { clip: 0, still: 0, card: 0 };
  for (const x of plan.segments) n[x.kind] += x.kind === 'clip' ? Math.ceil(x.outS - x.inS) : 1;
  return n;
}
