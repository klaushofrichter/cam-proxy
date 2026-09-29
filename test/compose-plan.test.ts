// test/compose-plan.test.ts
import { describe, expect, it } from 'vitest';
import { planComposition, type ClipSpan } from '../src/compose/plan';

const T = Date.UTC(2026, 8, 28, 19, 0, 0);
const s = (sec: number) => T + sec * 1000;
const clip: ClipSpan = { id: 1, start: s(0), end: s(20), path: '/c/1.mp4' };
const none = () => false;
const all = () => true;

describe('planComposition', () => {
  it('is the clip alone for 0/0', () => {
    const p = planComposition({ clip, preS: 0, postS: 0, clips: [clip], hasStill: all });
    expect(p).toEqual({ ok: true, start: s(0), end: s(20), durationS: 20, segments: [{ kind: 'clip', clipId: 1, path: '/c/1.mp4', inS: 0, outS: 20 }] });
  });

  it('fills a pre-roll with stills, one per second', () => {
    const p = planComposition({ clip, preS: 3, postS: 0, clips: [clip], hasStill: all });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments.slice(0, 3)).toEqual([{ kind: 'still', ts: s(-3) }, { kind: 'still', ts: s(-2) }, { kind: 'still', ts: s(-1) }]);
    expect(p.durationS).toBe(23);
  });

  it('reaches into the next clip: 20 s of stills, then 10 s of it (the spec example)', () => {
    const next: ClipSpan = { id: 2, start: s(40), end: s(70), path: '/c/2.mp4' };
    const p = planComposition({ clip, preS: 0, postS: 30, clips: [clip, next], hasStill: all });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments[0]).toEqual({ kind: 'clip', clipId: 1, path: '/c/1.mp4', inS: 0, outS: 20 });
    expect(p.segments.slice(1, 21).every((x) => x.kind === 'still')).toBe(true);
    expect(p.segments[21]).toEqual({ kind: 'clip', clipId: 2, path: '/c/2.mp4', inS: 0, outS: 10 });
    expect(p.durationS).toBe(50);
  });

  it('prefers the chosen clip where clips overlap, then the earliest other', () => {
    const early: ClipSpan = { id: 3, start: s(-5), end: s(5), path: '/c/3.mp4' };
    const p = planComposition({ clip, preS: 5, postS: 0, clips: [early, clip], hasStill: none });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments).toEqual([
      { kind: 'clip', clipId: 3, path: '/c/3.mp4', inS: 0, outS: 5 },
      { kind: 'clip', clipId: 1, path: '/c/1.mp4', inS: 0, outS: 20 },
    ]);
  });

  it('uses cards where there is neither a clip nor a still (e.g. older than 24 h)', () => {
    const p = planComposition({ clip, preS: 2, postS: 0, clips: [clip], hasStill: none });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments.slice(0, 2)).toEqual([{ kind: 'card', ts: s(-2) }, { kind: 'card', ts: s(-1) }]);
  });

  it('trims with negative values', () => {
    const p = planComposition({ clip, preS: -5, postS: -3, clips: [clip], hasStill: all });
    expect(p).toMatchObject({ ok: true, start: s(5), end: s(17), durationS: 12, segments: [{ kind: 'clip', inS: 5, outS: 17 }] });
  });

  it.each([
    [{ preS: 0, postS: 41 }, 'at most 60 s'],          // 20 + 41
    [{ preS: 61, postS: 0 }, 'pre-roll and post-roll are whole seconds from -600 to 60'],
    [{ preS: 1.5, postS: 0 }, 'pre-roll and post-roll are whole seconds from -600 to 60'],
    [{ preS: -20, postS: 0 }, 'at least 1 s of the clip must remain'],
    [{ preS: -10, postS: -10 }, 'at least 1 s of the clip must remain'],
  ])('refuses %j', (roll, error) => {
    expect(planComposition({ clip, clips: [clip], hasStill: all, ...roll })).toEqual({ ok: false, error });
  });

  it('ignores clips that only touch the window edge', () => {
    const before: ClipSpan = { id: 4, start: s(-10), end: s(-2), path: '/c/4.mp4' };
    const p = planComposition({ clip, preS: 2, postS: 0, clips: [before, clip], hasStill: none });
    if (!p.ok) throw new Error(p.error);
    expect(p.segments.slice(0, 2).map((x) => x.kind)).toEqual(['card', 'card']);
  });

  // Final review I1: real clips end on a fractional second (20.48 s).
  it('does not add a card or a still for the partial last second of a clip', () => {
    const real: ClipSpan = { id: 5, start: s(0), end: s(0) + 20_480, path: '/c/5.mp4' };
    const p = planComposition({ clip: real, preS: 0, postS: 0, clips: [real], hasStill: all });
    expect(p).toEqual({ ok: true, start: s(0), end: s(20), durationS: 20, segments: [{ kind: 'clip', clipId: 5, path: '/c/5.mp4', inS: 0, outS: 20 }] });
  });

  it('keeps a clip ending past the half second to its real end, and a 60 s result at 60 s', () => {
    const real: ClipSpan = { id: 6, start: s(0), end: s(0) + 20_600, path: '/c/6.mp4' };
    const p = planComposition({ clip: real, preS: 0, postS: 0, clips: [real], hasStill: all });
    expect(p).toMatchObject({ ok: true, durationS: 21, segments: [{ kind: 'clip', inS: 0, outS: 20.6 }] });
    const q = planComposition({ clip: real, preS: 0, postS: 39, clips: [real], hasStill: all });
    expect(q).toMatchObject({ ok: true, durationS: 60 });
    if (q.ok) expect(q.segments.filter((x) => x.kind !== 'clip')).toHaveLength(39);
  });
});
