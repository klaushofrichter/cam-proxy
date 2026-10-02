import { describe, expect, it } from 'vitest';
import { pairByStart, START_SLACK_MS } from '../src/inventory/match';

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
});
