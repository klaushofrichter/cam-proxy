import { describe, expect, it } from 'vitest';
import { coverage, duplicatesAmong, LATE_START_MS, pairByStart, spansByKind, START_SLACK_MS } from '../src/inventory/match';

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

// #342, measured on real cameras: an E1 Outdoor Pro's FTP clip starts about 8 s
// after the SD recording; on an RLC-1224A a clip at +13 s or later is another recording.
describe('pairByStart: a late FTP clip (#342)', () => {
  const T = 1_000_000;
  const sd = (id: string, start: number, seconds = 46, stream = 'sub') => ({ id, start, end: start + seconds * 1000, stream });
  const ftp = (id: number, start: number, stream = 'sub') => ({ id, start, stream, origin: 'ftp' as const });
  const fetched = (id: number, start: number) => ({ id, start, stream: 'sub', origin: 'camera' as const });
  const ids = (p: { pairs: { rec: { id: string }; clip: { id: number } }[] }) => p.pairs.map((x) => [x.rec.id, x.clip.id]);

  it('E1: an FTP clip at +8 s that overlaps the recording is the same recording', () => {
    expect(LATE_START_MS).toBe(10_000);
    const p = pairByStart([sd('e1', T)], [ftp(1, T + 8000)]);
    expect(ids(p)).toEqual([['e1', 1]]);
    expect(p.recsAlone).toEqual([]);
    expect(p.clipsAlone).toEqual([]);
  });

  it('takes exactly +10 s, not one millisecond more', () => {
    expect(ids(pairByStart([sd('a', T)], [ftp(1, T + 10_000)]))).toEqual([['a', 1]]);
    const p = pairByStart([sd('a', T)], [ftp(1, T + 10_001)]);
    expect(p.pairs).toEqual([]);
  });

  it.each([13, 14, 25, 33])('RLC-1224A: an overlapping FTP clip at +%i s stays a separate recording', (s) => {
    const p = pairByStart([sd('rlc', T, 60)], [ftp(1, T + s * 1000)]);
    expect(p.pairs).toEqual([]);
    expect(p.recsAlone.map((x) => x.id)).toEqual(['rlc']);
    expect(p.clipsAlone.map((x) => x.id)).toEqual([1]);
  });

  it('a recording that ended before the clip starts does not pair, even within 10 s', () => {
    const p = pairByStart([sd('short', T, 6)], [ftp(1, T + 8000)]);
    expect(p.pairs).toEqual([]);
    expect(p.recsAlone).toHaveLength(1);
  });

  it('a recording that ended just as the clip starts does not overlap it', () => {
    expect(pairByStart([sd('touch', T, 8)], [ftp(1, T + 8000)]).pairs).toEqual([]);
  });

  it('two recordings 8 s apart with one FTP clip: the clip pairs with exactly one, the closer', () => {
    const p = pairByStart([sd('a', T), sd('b', T + 8000)], [ftp(1, T + 8000)]);
    expect(ids(p)).toEqual([['b', 1]]);
    expect(p.recsAlone.map((x) => x.id)).toEqual(['a']);
    const q = pairByStart([sd('a', T), sd('b', T + 8000)], [ftp(1, T + 9000)]);
    expect(ids(q)).toEqual([['b', 1]]);
    expect(q.recsAlone.map((x) => x.id)).toEqual(['a']);
  });

  it('a clip within 5 s keeps priority over the new window', () => {
    // Clip 1 is 8 s after a and 2 s before b: it stays b's, and a stays alone.
    const p = pairByStart([sd('a', T), sd('b', T + 10_000)], [ftp(1, T + 8000)]);
    expect(ids(p)).toEqual([['b', 1]]);
    expect(p.recsAlone.map((x) => x.id)).toEqual(['a']);
    // Clip 1 at +3 s is a's; clip 2 at +8 s is left over, not a's second clip.
    const q = pairByStart([sd('a', T)], [ftp(1, T + 3000), ftp(2, T + 8000)]);
    expect(ids(q)).toEqual([['a', 1]]);
    expect(q.clipsAlone.map((x) => x.id)).toEqual([2]);
  });

  it('a fetched clip has its recording\'s own start: the window is for FTP clips only', () => {
    const p = pairByStart([sd('a', T)], [fetched(1, T + 8000)]);
    expect(p.pairs).toEqual([]);
    expect(ids(pairByStart([sd('a', T)], [fetched(1, T + 4000)]))).toEqual([['a', 1]]);
  });

  it('a clip that starts before the recording gets no wider window', () => {
    expect(pairByStart([sd('a', T)], [ftp(1, T - 8000)]).pairs).toEqual([]);
  });

  it('never pairs across streams, and is the same whatever the input order', () => {
    expect(pairByStart([sd('a', T, 46, 'main')], [ftp(1, T + 8000)]).pairs).toEqual([]);
    const recs = [sd('b', T + 60_000), sd('a', T)];
    const clips = [ftp(2, T + 68_000), ftp(1, T + 8000)];
    expect(ids(pairByStart(recs, clips))).toEqual([['a', 1], ['b', 2]]);
    expect(ids(pairByStart([...recs].reverse(), [...clips].reverse()))).toEqual([['a', 1], ['b', 2]]);
  });

  it('a recording without a known end gets no late pairing', () => {
    expect(pairByStart([{ id: 'x', start: T, stream: 'sub' }], [ftp(1, T + 8000)]).pairs).toEqual([]);
  });

  describe('duplicatesAmong', () => {
    const find = (recs: ReturnType<typeof sd>[], clips: (ReturnType<typeof ftp> | ReturnType<typeof fetched>)[]) => {
      const p = pairByStart(recs, clips);
      return duplicatesAmong(p.pairs, p.clipsAlone).map((d) => [d.rec.id, d.fetched.id, d.ftp.id]);
    };

    it('E1: a fetched clip at the recording\'s start and an FTP clip at +8 s are one recording twice', () => {
      expect(find([sd('e1', T)], [fetched(1, T), ftp(2, T + 8000)])).toEqual([['e1', 1, 2]]);
    });

    it('finds them the other way round too: the FTP clip paired, the fetched one left over', () => {
      expect(find([sd('a', T)], [ftp(1, T), fetched(2, T)])).toEqual([['a', 2, 1]]);
    });

    it.each([13, 14, 25, 33])('RLC-1224A: a fetched clip and an FTP clip at +%i s are not duplicates', (s) => {
      expect(find([sd('rlc', T, 60)], [fetched(1, T), ftp(2, T + s * 1000)])).toEqual([]);
    });

    it('an FTP clip that is another recording\'s is no duplicate: both stay', () => {
      expect(find([sd('a', T), sd('b', T + 8000)], [fetched(1, T), ftp(2, T + 8000)])).toEqual([]);
    });

    it('an FTP clip after the recording ended is no duplicate', () => {
      expect(find([sd('a', T, 6)], [fetched(1, T), ftp(2, T + 8000)])).toEqual([]);
    });

    it('a recording with one clip has no duplicate, whichever its origin', () => {
      expect(find([sd('a', T)], [fetched(1, T)])).toEqual([]);
      expect(find([sd('a', T)], [ftp(1, T + 8000)])).toEqual([]);
    });

    it('two copies of the same origin are not this kind of duplicate', () => {
      expect(find([sd('a', T)], [ftp(1, T), ftp(2, T + 8000)])).toEqual([]);
      expect(find([sd('a', T)], [fetched(1, T), fetched(2, T + 3000)])).toEqual([]);
    });

    it('one FTP clip keeps one fetched clip only: never two removals for one kept copy', () => {
      const clips = [fetched(1, T), fetched(2, T + 2000), ftp(3, T + 8000)];
      expect(find([sd('a', T), sd('b', T + 2000)], clips)).toEqual([['b', 2, 3]]); // the closer recording's
    });
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
