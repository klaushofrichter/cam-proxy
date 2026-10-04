// test/compose-plan.test.ts
import { describe, expect, it } from 'vitest';
import { compositionWindow, COMPOSE_MAX_S, COMPOSE_MAX_S_1080P, composeMaxS, formatSeconds, planComposition, planSeconds, type ClipSpan } from '../src/compose/plan';

const T = Date.UTC(2026, 8, 28, 19, 0, 0);
const s = (sec: number) => T + sec * 1000;
const clip: ClipSpan = { id: 1, start: s(0), end: s(20), path: '/c/1.mp4' };
const none = () => null;
const all = (t: number) => t;

describe('planComposition', () => {
  it('is the clip alone for 0/0', () => {
    const p = planComposition({ clip, preS: 0, postS: 0, clips: [clip], stillAt: all });
    expect(p).toEqual({ ok: true, start: s(0), end: s(20), durationS: 20, segments: [{ kind: 'clip', clipId: 1, path: '/c/1.mp4', inS: 0, outS: 20 }] });
  });

  it('fills a pre-roll with stills, one per second', () => {
    const p = planComposition({ clip, preS: 3, postS: 0, clips: [clip], stillAt: all });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments.slice(0, 3)).toEqual([{ kind: 'still', ts: s(-3) }, { kind: 'still', ts: s(-2) }, { kind: 'still', ts: s(-1) }]);
    expect(p.durationS).toBe(23);
  });

  it('reaches into the next clip: 20 s of stills, then 10 s of it (the spec example)', () => {
    const next: ClipSpan = { id: 2, start: s(40), end: s(70), path: '/c/2.mp4' };
    const p = planComposition({ clip, preS: 0, postS: 30, clips: [clip, next], stillAt: all });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments[0]).toEqual({ kind: 'clip', clipId: 1, path: '/c/1.mp4', inS: 0, outS: 20 });
    expect(p.segments.slice(1, 21).every((x) => x.kind === 'still')).toBe(true);
    expect(p.segments[21]).toEqual({ kind: 'clip', clipId: 2, path: '/c/2.mp4', inS: 0, outS: 10 });
    expect(p.durationS).toBe(50);
  });

  it('prefers the chosen clip where clips overlap, then the earliest other', () => {
    const early: ClipSpan = { id: 3, start: s(-5), end: s(5), path: '/c/3.mp4' };
    const p = planComposition({ clip, preS: 5, postS: 0, clips: [early, clip], stillAt: none });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments).toEqual([
      { kind: 'clip', clipId: 3, path: '/c/3.mp4', inS: 0, outS: 5 },
      { kind: 'clip', clipId: 1, path: '/c/1.mp4', inS: 0, outS: 20 },
    ]);
  });

  it('uses cards where there is neither a clip nor a still (e.g. older than 24 h)', () => {
    const p = planComposition({ clip, preS: 2, postS: 0, clips: [clip], stillAt: none });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments.slice(0, 2)).toEqual([{ kind: 'card', ts: s(-2) }, { kind: 'card', ts: s(-1) }]);
  });

  it('trims with negative values', () => {
    const p = planComposition({ clip, preS: -5, postS: -3, clips: [clip], stillAt: all });
    expect(p).toMatchObject({ ok: true, start: s(5), end: s(17), durationS: 12, segments: [{ kind: 'clip', inS: 5, outS: 17 }] });
  });

  it.each([
    [{ preS: 0, postS: 281 }, 'at most 300 s (5:00)'],          // 20 + 281
    [{ preS: 3601, postS: 0 }, 'pre-roll and post-roll are whole seconds from -3600 to 3600'],
    [{ preS: 1.5, postS: 0 }, 'pre-roll and post-roll are whole seconds from -3600 to 3600'],
    [{ preS: -20, postS: 0 }, 'at least 1 s of the clip must remain'],
    [{ preS: -10, postS: -10 }, 'at least 1 s of the clip must remain'],
  ])('refuses %j', (roll, error) => {
    expect(planComposition({ clip, clips: [clip], stillAt: all, ...roll })).toEqual({ ok: false, error });
  });

  it('ignores clips that only touch the window edge', () => {
    const before: ClipSpan = { id: 4, start: s(-10), end: s(-2), path: '/c/4.mp4' };
    const p = planComposition({ clip, preS: 2, postS: 0, clips: [before, clip], stillAt: none });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments.slice(0, 2).map((x) => x.kind)).toEqual(['card', 'card']);
  });

  // Final review I1: real clips end on a fractional second (20.48 s).
  it('does not add a card or a still for the partial last second of a clip', () => {
    const real: ClipSpan = { id: 5, start: s(0), end: s(0) + 20_480, path: '/c/5.mp4' };
    const p = planComposition({ clip: real, preS: 0, postS: 0, clips: [real], stillAt: all });
    expect(p).toEqual({ ok: true, start: s(0), end: s(20), durationS: 20, segments: [{ kind: 'clip', clipId: 5, path: '/c/5.mp4', inS: 0, outS: 20 }] });
  });

  it('keeps a clip ending past the half second to its real end, and a 300 s result at 300 s', () => {
    const real: ClipSpan = { id: 6, start: s(0), end: s(0) + 20_600, path: '/c/6.mp4' };
    const p = planComposition({ clip: real, preS: 0, postS: 0, clips: [real], stillAt: all });
    expect(p).toMatchObject({ ok: true, durationS: 21, segments: [{ kind: 'clip', inS: 0, outS: 20.6 }] });
    const q = planComposition({ clip: real, preS: 0, postS: 279, clips: [real], stillAt: all });
    expect(q).toMatchObject({ ok: true, durationS: 300 });
    if (q.ok) expect(q.segments.filter((x) => x.kind !== 'clip')).toHaveLength(279);
  });

  // cams's Save dialog (2026-10-04, image 16): a 114 s recording on the SD
  // card, pre-roll -100, post-roll 30 → 44 s. The proxy's FTP copy of it was
  // longer (here 245 s, from 131 s earlier: the camera uploaded one clip for
  // two SD files), and the rolls were applied to that copy: 175 s, "at most
  // 60 s". The rolls belong to the recording the viewer chose (span).
  it('applies the rolls to the span the viewer chose, not to a longer FTP copy (the 114 s / -100 / +30 case)', () => {
    const ftp: ClipSpan = { id: 9, start: s(-131), end: s(114), path: '/c/9.mp4' };
    const p = planComposition({ clip: ftp, span: { start: s(0), end: s(114) }, preS: -100, postS: 30, clips: [ftp], stillAt: all });
    if (!p.ok) throw new Error(p.error);
    expect(p).toMatchObject({ start: s(100), end: s(144), durationS: 44 });
    expect(p.segments[0]).toEqual({ kind: 'clip', clipId: 9, path: '/c/9.mp4', inS: 231, outS: 245 });
    expect(p.segments.slice(1)).toHaveLength(30);
    expect(p.segments.slice(1).every((x) => x.kind === 'still')).toBe(true);
  });

  it('checks "1 s must remain" against the span, and limits 1080p to 120 s', () => {
    const ftp: ClipSpan = { id: 9, start: s(-131), end: s(114), path: '/c/9.mp4' };
    expect(planComposition({ clip: ftp, span: { start: s(0), end: s(114) }, preS: -114, postS: 0, clips: [ftp], stillAt: all })).toEqual({ ok: false, error: 'at least 1 s of the clip must remain' });
    expect(planComposition({ clip: ftp, span: { start: s(0), end: s(114) }, preS: 0, postS: 7, maxS: composeMaxS('1080p'), clips: [ftp], stillAt: all })).toEqual({ ok: false, error: 'at most 120 s (2:00)' });
  });

  // Issue #30: with stills every 2 s, the second between two stills holds the
  // earlier one instead of flickering to a card.
  it('holds the last still up to the stills interval', () => {
    const every2 = (t: number) => (Math.floor((t - s(-10)) / 2000) * 2000 + s(-10) >= t - 1000 ? Math.floor((t - s(-10)) / 2000) * 2000 + s(-10) : null);
    const p = planComposition({ clip, preS: 4, postS: 0, clips: [clip], stillAt: every2 });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments.slice(0, 4)).toEqual([{ kind: 'still', ts: s(-4) }, { kind: 'still', ts: s(-4) }, { kind: 'still', ts: s(-2) }, { kind: 'still', ts: s(-2) }]);
  });
});

// The result's length: the same table as cams's (web/src/lib/clipLimits.test.ts
// there), so the dialog and the proxy never disagree. A 114 s recording;
// a number is the result in seconds, a string the refusal.
const C = 114;
const LENGTH_CASES: [string, number, number, number, number | string][] = [
  ['the clip alone', 0, 0, COMPOSE_MAX_S, 114],
  ['image 16: cut 100 s at the start, 30 s after', -100, 30, COMPOSE_MAX_S, 44],
  ['cut at the end', 0, -14, COMPOSE_MAX_S, 100],
  ['cut at the start', -14, 0, COMPOSE_MAX_S, 100],
  ['pre-roll into the neighbour clip and the gap, up to the limit', 186, 0, COMPOSE_MAX_S, 300],
  ['one second over the limit', 187, 0, COMPOSE_MAX_S, 'at most 300 s (5:00)'],
  ['both rolls to the limit', 10, 176, COMPOSE_MAX_S, 300],
  ['1 s left', -113, 0, COMPOSE_MAX_S, 1],
  ['nothing left', -114, 0, COMPOSE_MAX_S, 'at least 1 s of the clip must remain'],
  ['1 s left between two cuts', -60, -53, COMPOSE_MAX_S, 1],
  ['the cuts cross', -60, -54, COMPOSE_MAX_S, 'at least 1 s of the clip must remain'],
  ['a cut at the end past the start', 0, -200, COMPOSE_MAX_S, 'at least 1 s of the clip must remain'],
  ['a pre-roll with the clip cut to its first second', 50, -113, COMPOSE_MAX_S, 51],
  ['1080p: the clip alone', 0, 0, COMPOSE_MAX_S_1080P, 114],
  ['1080p: over its limit', 0, 7, COMPOSE_MAX_S_1080P, 'at most 120 s (2:00)'],
  ['not whole seconds', 1.5, 0, COMPOSE_MAX_S, 'pre-roll and post-roll are whole seconds from -3600 to 3600'],
];

describe('compositionWindow and the planner agree on the length', () => {
  const span = { start: s(0), end: s(C) };
  // Neighbours with gaps: one ending 30 s before, one starting 40 s after.
  const prev: ClipSpan = { id: 2, start: s(-90), end: s(-30), path: '/c/2.mp4' };
  const next: ClipSpan = { id: 3, start: s(C + 40), end: s(C + 100), path: '/c/3.mp4' };
  const self: ClipSpan = { id: 1, ...span, path: '/c/1.mp4' };
  it.each(LENGTH_CASES)('%s (pre %d, post %d, at most %d)', (_name, preS, postS, maxS, want) => {
    const w = compositionWindow(span, preS, postS, maxS);
    const p = planComposition({ clip: self, preS, postS, maxS, clips: [prev, self, next], stillAt: none });
    if (typeof want === 'number') {
      expect(w).toEqual({ ok: true, start: s(-preS), end: s(-preS + want), durationS: want });
      expect(p).toMatchObject({ ok: true, durationS: want });
      if (p.ok) expect(p.segments.reduce((n, x) => n + (x.kind === 'clip' ? Math.ceil(x.outS - x.inS) : 1), 0)).toBe(want);
    } else {
      expect(w).toEqual({ ok: false, error: want });
      expect(p).toEqual({ ok: false, error: want });
    }
  });
});

// Phase 3 of #179: a window around a second (`at`), no anchor clip. The span
// is the second itself; each second is a clip that covers it, else a still,
// else a card (spec 2026-10-04-still-checks-design §13).
describe('planComposition around a second', () => {
  const at = s(100);
  const second = { start: at, end: at + 1000 };
  const kinds = (p: ReturnType<typeof planComposition>) => (p.ok ? p.segments.map((x) => x.kind) : p.error);

  it('is the clip where one covers the whole window', () => {
    const c: ClipSpan = { id: 7, start: s(80), end: s(130), path: '/c/7.mp4' };
    const p = planComposition({ span: second, preS: 10, postS: 10, clips: [c], stillAt: all });
    expect(p).toEqual({ ok: true, start: s(90), end: s(111), durationS: 21, segments: [{ kind: 'clip', clipId: 7, path: '/c/7.mp4', inS: 10, outS: 31 }] });
  });

  it('crosses a clip edge: stills before the clip starts, the clip after', () => {
    const c: ClipSpan = { id: 8, start: s(97), end: s(140), path: '/c/8.mp4' };
    const p = planComposition({ span: second, preS: 10, postS: 10, clips: [c], stillAt: all });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments.slice(0, 7)).toEqual([90, 91, 92, 93, 94, 95, 96].map((x) => ({ kind: 'still', ts: s(x) })));
    expect(p.segments[7]).toEqual({ kind: 'clip', clipId: 8, path: '/c/8.mp4', inS: 0, outS: 14 });
    expect(planSeconds(p)).toEqual({ clip: 14, still: 7, card: 0 });
  });

  it('is stills only where no clip is near', () => {
    const p = planComposition({ span: second, preS: 10, postS: 10, clips: [], stillAt: all });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments).toHaveLength(21);
    expect(p.segments.every((x) => x.kind === 'still')).toBe(true);
    expect(planSeconds(p)).toEqual({ clip: 0, still: 21, card: 0 });
  });

  it('shows a gap in the stills as cards', () => {
    const gap = (t: number) => (t >= s(95) && t < s(98) ? null : t);
    const p = planComposition({ span: second, preS: 10, postS: 10, clips: [], stillAt: gap });
    expect(kinds(p)).toEqual([...Array(5).fill('still'), 'card', 'card', 'card', ...Array(13).fill('still')]);
    if (p.ok) expect(planSeconds(p)).toEqual({ clip: 0, still: 18, card: 3 });
  });

  it('plans all cards where nothing covers it (the API refuses that)', () => {
    const p = planComposition({ span: second, preS: 1, postS: 1, clips: [], stillAt: none });
    expect(kinds(p)).toEqual(['card', 'card', 'card']);
    if (p.ok) expect(planSeconds(p)).toEqual({ clip: 0, still: 0, card: 3 });
  });

  it('refuses a plan with neither a clip nor a span', () => {
    expect(planComposition({ preS: 0, postS: 0, clips: [], stillAt: all })).toEqual({ ok: false, error: 'a clip or a span is required' });
  });
});

// The same length rule around a second: the anchor is 1 s long, so the
// result is pre + 1 + post (cams's AT_LENGTH_CASES are the same table).
const AT_LENGTH_CASES: [string, number, number, number, number | string][] = [
  ['the second alone', 0, 0, COMPOSE_MAX_S, 1],
  ['the default, -10/+10', 10, 10, COMPOSE_MAX_S, 21],
  ['up to the limit', 149, 150, COMPOSE_MAX_S, 300],
  ['one second over the limit', 150, 150, COMPOSE_MAX_S, 'at most 300 s (5:00)'],
  ['all before', 299, 0, COMPOSE_MAX_S, 300],
  ['1080p: up to its limit', 60, 59, COMPOSE_MAX_S_1080P, 120],
  ['1080p: over its limit', 60, 60, COMPOSE_MAX_S_1080P, 'at most 120 s (2:00)'],
  ['a negative roll cuts the second', -1, 5, COMPOSE_MAX_S, 'at least 1 s of the clip must remain'],
];

describe('compositionWindow around a second', () => {
  const second = { start: s(0), end: s(1) };
  it.each(AT_LENGTH_CASES)('%s (pre %d, post %d, at most %d)', (_name, preS, postS, maxS, want) => {
    const w = compositionWindow(second, preS, postS, maxS);
    const p = planComposition({ span: second, preS, postS, maxS, clips: [], stillAt: all });
    if (typeof want === 'number') {
      expect(w).toEqual({ ok: true, start: s(-preS), end: s(-preS + want), durationS: want });
      expect(p).toMatchObject({ ok: true, durationS: want });
      if (p.ok) expect(p.segments).toHaveLength(want);
    } else {
      expect(w).toEqual({ ok: false, error: want });
      expect(p).toEqual({ ok: false, error: want });
    }
  });
});

describe('formatSeconds', () => {
  it.each([[0, '0 s'], [44, '44 s'], [59, '59 s'], [60, '60 s (1:00)'], [114, '114 s (1:54)'], [300, '300 s (5:00)'], [600, '600 s (10:00)'], [3725, '3725 s (62:05)']])('%d → %s', (n, text) => {
    expect(formatSeconds(n)).toBe(text);
  });
});
