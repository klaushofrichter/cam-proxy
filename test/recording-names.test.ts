// test/recording-names.test.ts
import { describe, it, expect } from 'vitest';
import type { TimeInfo } from '../src/camera/time';
import { decodeKinds, localDate, localDays, parseSdName, recordingTimes, stillRecording, validId } from '../src/recordings/names';

// The camera's zone: America/Chicago (GetTime), DST second Sunday of March to first Sunday of November, 02:00.
const CHI: TimeInfo = { stdOffsetMinutes: -360, dstOffsetMinutes: 60, dstRule: { startMon: 3, startWeek: 2, startWeekday: 0, startHour: 2, startMin: 0, endMon: 11, endWeek: 1, endWeekday: 0, endHour: 2, endMin: 0 } };
const SUB = 'RecS0A_DST20261001_211129_211207_0_5514C080000000_108CE9.mp4';
const PATH = `/mnt/sda/Mp4Record/2026-10-01/${SUB}`;

describe('SD names', () => {
  it('parses the spec example: stream, DST, date, times, size from the last hex field, kinds', () => {
    expect(parseSdName(PATH)).toEqual({ id: SUB, stream: 'sub', dst: true, date: '2026-10-01', start: '211129', end: '211207', size: 1_084_649, kinds: ['person', 'motion'] });
    expect(parseSdName(SUB)?.id).toBe(SUB);
  });

  it('a main file, no animal-type field, no triggers', () => {
    expect(parseSdName('RecM0A_DST20261002_040758_040820_0_7B288200000000_667C2E.mp4')).toMatchObject({ stream: 'main', size: 6_716_462, kinds: [] });
    expect(parseSdName('RecS0A_20261002_040758_040819_55148080000000_7224E.mp4')).toMatchObject({ dst: false, size: 467_534, kinds: ['motion'] });
  });

  it('decodes the trigger flags (bit 55 − position)', () => {
    expect(decodeKinds('5514C080000000')).toEqual(['person', 'motion']);
    expect(decodeKinds('55148080000000')).toEqual(['motion']);
    expect(decodeKinds('nothex')).toEqual([]);
    expect(decodeKinds('5514C08000000')).toEqual([]); // 13 digits: an unknown name version
  });

  it('rejects names that are not SD recordings', () => {
    for (const n of ['RecS0A_DST20261340_211129_211207_0_5514C080000000_108CE9.mp4', 'RecS0A_DST20261001_256129_211207_0_5514C080000000_108CE9.mp4', 'RecS0A_DST20261001_211129_211207_0_5514C080000000_108CE9.MP4', 'Rec_x.mp4', 'snapshot.jpg']) {
      expect(parseSdName(n), n).toBeNull();
    }
  });

  it('validId: the spec pattern, at most 128 characters, no folder', () => {
    expect(validId(SUB)).toBe(true);
    expect(validId(PATH)).toBe(false);
    expect(validId('../' + SUB)).toBe(false);
    expect(validId(SUB.replace('.mp4', '.MP4'))).toBe(false);
    expect(validId(SUB.replace('_108CE9', `_${'A'.repeat(128 - SUB.length + 6)}`))).toBe(true); // exactly 128
    expect(validId(SUB.replace('_108CE9', `_${'A'.repeat(129 - SUB.length + 6)}`))).toBe(false); // 129
  });

  it('a recording still being written ends 000000, unless it starts in the last minutes before midnight', () => {
    expect(stillRecording(parseSdName('RecS0A_DST20261001_211129_000000_0_5514C080000000_0.mp4')!)).toBe(true);
    expect(stillRecording(parseSdName('RecS0A_DST20261001_235830_000000_0_5514C080000000_108CE9.mp4')!)).toBe(false);
    expect(stillRecording(parseSdName(SUB)!)).toBe(false);
  });
});

describe('times', () => {
  it('camera-local times with the name’s DST flag to unix ms', () => {
    expect(recordingTimes(parseSdName(SUB)!, CHI)).toEqual({ start: Date.UTC(2026, 9, 2, 2, 11, 29), end: Date.UTC(2026, 9, 2, 2, 12, 7) });
  });

  it('a recording past midnight ends the next day', () => {
    const n = parseSdName('RecS0A_DST20261001_235950_000020_0_5514C080000000_108CE9.mp4')!;
    expect(recordingTimes(n, CHI)).toEqual({ start: Date.UTC(2026, 9, 2, 4, 59, 50), end: Date.UTC(2026, 9, 2, 5, 0, 20) });
  });

  // Review Focus 1.
  it('the fall-back night: 01:30 with and without DST are an hour apart, and the window still finds the right days', () => {
    const a = recordingTimes(parseSdName('RecS0A_DST20261101_013000_013020_0_5514C080000000_3E8.mp4')!, CHI);
    const b = recordingTimes(parseSdName('RecS0A_20261101_013000_013020_0_5514C080000000_3E8.mp4')!, CHI);
    expect(a.start).toBe(Date.UTC(2026, 10, 1, 6, 30));
    expect(b.start - a.start).toBe(3_600_000);
    // 23:00 CDT Oct 31 to 23:30 CST Nov 1 (25.5 hours).
    expect(localDays(Date.UTC(2026, 10, 1, 4, 0), Date.UTC(2026, 10, 2, 5, 30), CHI)).toEqual(['2026-10-31', '2026-11-01']);
  });

  it('the camera-local date of an instant, summer and winter', () => {
    expect(localDate(Date.UTC(2026, 9, 2, 3, 0), CHI)).toBe('2026-10-01'); // 22:00 CDT
    expect(localDate(Date.UTC(2026, 9, 2, 5, 0), CHI)).toBe('2026-10-02'); // 00:00 CDT
    expect(localDate(Date.UTC(2026, 0, 15, 5, 30), CHI)).toBe('2026-01-14'); // 23:30 CST
    expect(localDate(Date.UTC(2026, 9, 1, 23, 30), { stdOffsetMinutes: 60, dstOffsetMinutes: 0 })).toBe('2026-10-02');
  });

  it('a 47-hour window touches three camera days', () => {
    expect(localDays(Date.UTC(2026, 9, 1, 4, 0), Date.UTC(2026, 9, 3, 3, 0), CHI)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
    expect(localDays(Date.UTC(2026, 9, 2, 12, 0), Date.UTC(2026, 9, 2, 13, 0), CHI)).toEqual(['2026-10-02']);
  });
});
