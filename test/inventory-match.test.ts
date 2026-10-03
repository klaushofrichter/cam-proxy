import { describe, expect, it } from 'vitest';
import { coverage, pairByStart, spansByKind, START_SLACK_MS } from '../src/inventory/match';

const rec = (id: string, start: number, stream = 'sub') => ({ id, start, stream });
const clip = (id: number, start: number, stream = 'sub') => ({ id, start, stream });

describe('pairByStart', () => {
  it('pairs a recording with the clip of the same stream starting within 5 s', () => {
    const p = pairByStart([rec('a', 10_000), rec('b', 60_000)], [clip(1, 14_000), clip(2, 66_000)]);
    expect(START_SLACK_MS).toBe(5000);
    expect(p.pairs.map((x) => [x.rec.id, x.clip.id])).toEqual([['a', 1]]);
    expect(p.recsAlone.map((x) => x.id)).toEqual(['b']); // 6 s apart: not the same
    expect(p.clipsAlone.map((x) => x.id)).toEqual([2]);
  });

  it('takes the boundary: exactly 5 s pairs, before and after', () => {
    const p = pairByStart([rec('a', 10_000), rec('b', 50_000)], [clip(1, 5_000), clip(2, 55_000)]);
    expect(p.pairs.map((x) => [x.rec.id, x.clip.id])).toEqual([['a', 1], ['b', 2]]);
  });

  it('never pairs across streams', () => {
    const p = pairByStart([rec('a', 10_000, 'sub')], [clip(1, 10_000, 'main')]);
    expect(p.pairs).toEqual([]);
    expect(p.recsAlone).toHaveLength(1);
    expect(p.clipsAlone).toHaveLength(1);
  });

  it('pairs one to one, closest first: two recordings near one clip leave one alone', () => {
    const p = pairByStart([rec('a', 10_000), rec('b', 13_000)], [clip(1, 12_500)]);
    expect(p.pairs.map((x) => [x.rec.id, x.clip.id])).toEqual([['b', 1]]);
    expect(p.recsAlone.map((x) => x.id)).toEqual(['a']);
    // A tie goes to the earlier recording.
    const tie = pairByStart([rec('b', 14_000), rec('a', 10_000)], [clip(7, 12_000)]);
    expect(tie.pairs.map((x) => x.rec.id)).toEqual(['a']);
  });

  it('a clip claimed by a closer recording leaves the next best to the other', () => {
    const p = pairByStart([rec('a', 10_000), rec('b', 12_000)], [clip(1, 11_900), clip(2, 8_000)]);
    expect(p.pairs.map((x) => [x.rec.id, x.clip.id])).toEqual([['a', 2], ['b', 1]]);
  });

  it('is greedy closest-first, not a maximum matching (pinned)', () => {
    // A maximum matching would pair a-2 (5.0 s) and b-1 (4.5 s); closest first takes a-1 (1.0 s) and strands b.
    const p = pairByStart([rec('a', 10_000), rec('b', 15_500)], [clip(1, 11_000), clip(2, 5_000)]);
    // a-1 (1.0 s) first; b-1 is 4.5 s but 1 is taken, b-2 is 10.5 s: out of reach.
    expect(p.pairs.map((x) => [x.rec.id, x.clip.id])).toEqual([['a', 1]]);
    expect(p.recsAlone.map((x) => x.id)).toEqual(['b']);
    expect(p.clipsAlone.map((x) => x.id)).toEqual([2]);
  });
});

describe('coverage', () => {
  it('tells whether any span overlaps a range, ends inclusive, also a long early span', () => {
    const covers = coverage([{ start: 100, end: 200 }, { start: 0, end: 1000 }, { start: 5000, end: 5000 }]);
    expect(covers(1000, 1200)).toBe(true); // touches the long one's end
    expect(covers(1001, 4999)).toBe(false);
    expect(covers(4000, 5000)).toBe(true); // touches the point span
    expect(covers(-50, -1)).toBe(false);
    expect(coverage([])(0, 10)).toBe(false);
  });
});

describe('spansByKind', () => {
  const r = (id: string, start: number, end: number, kinds: string[]) => ({ id, start, end, kinds });
  it('merges overlapping or touching recordings per kind; a recording with two kinds is in a span of each', () => {
    const recs = [r('a', 0, 30, ['motion']), r('b', 30, 60, ['motion', 'person']), r('c', 61, 90, ['motion']), r('d', 10, 20, ['person']), r('t', 0, 100, [])];
    expect(spansByKind(recs).map((s) => [s.kind, s.start, s.end, s.recs.map((x) => x.id)])).toEqual([
      ['motion', 0, 60, ['a', 'b']],
      ['person', 10, 20, ['d']],
      ['person', 30, 60, ['b']],
      ['motion', 61, 90, ['c']],
    ]);
  });
  it('keeps a recording inside a longer one in the same span, and ignores timer-only ones', () => {
    expect(spansByKind([r('a', 0, 100, ['pet']), r('b', 10, 20, ['pet']), r('c', 50, 150, ['pet'])]).map((s) => [s.start, s.end, s.recs.length])).toEqual([[0, 150, 3]]);
    expect(spansByKind([r('t', 0, 100, [])])).toEqual([]);
  });
});
