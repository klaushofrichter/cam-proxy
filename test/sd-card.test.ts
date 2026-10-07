import { describe, expect, it } from 'vitest';
import { CameraError } from '../src/camera/client';
import { parseSd, readCameraSd, SdWatch, SD_CHECK_MS, SD_STALL_LOOKBACK_MS } from '../src/camera/sd-card';

// Issue #199: on 2026-10-06 06:14:57 cam1's 30 GB card filled and, with
// overwrite 0, the camera stopped recording to it; FTP went on, so nothing
// looked wrong for 28 h. The answers below are the real camera's (measured
// 2026-10-07, RLC-1224A).
const HDD_FULL = { HddInfo: [{ capacity: 30432, format: 1, mount: 1, number: 0, size: 900, storageType: 2 }] };
const rec = (over: Record<string, unknown> = {}) => ({ Rec: { bSmartRec: 0, enable: 1, overwrite: 0, packTime: '', postRec: '15 Seconds', preRec: 1, saveDay: 7, schedule: { channel: 0, table: {} }, ...over } });
const H = 3600_000;
const NOW = Date.UTC(2026, 9, 7, 12, 0);

describe('parseSd (GetHddInfo + GetRecV20)', () => {
  it('the real camera on 2026-10-07: 30432 MB, 900 MB free, mounted, formatted, overwrite off, recording on', () => {
    expect(parseSd(HDD_FULL, rec())).toEqual({ present: true, mounted: true, formatted: true, capacityMB: 30432, freeMB: 900, overwrite: false, recordingEnabled: true });
  });
  it('overwrite 1, recording 0', () => {
    expect(parseSd(HDD_FULL, rec({ overwrite: 1, enable: 0 }))).toMatchObject({ overwrite: true, recordingEnabled: false });
  });
  it('mount 0 and format 0', () => {
    const hdd = { HddInfo: [{ ...HDD_FULL.HddInfo[0], mount: 0, format: 0 }] };
    expect(parseSd(hdd, rec())).toMatchObject({ present: true, mounted: false, formatted: false });
  });
  it('no card: an empty HddInfo list', () => {
    expect(parseSd({ HddInfo: [] }, rec())).toEqual({ present: false, mounted: false, formatted: false, capacityMB: null, freeMB: null, overwrite: false, recordingEnabled: true });
  });
  it('a Rec object without the fields: null, never guessed', () => {
    expect(parseSd(HDD_FULL, { Rec: {} })).toMatchObject({ overwrite: null, recordingEnabled: null });
  });
  it('an answer without HddInfo or Rec is an error', () => {
    expect(() => parseSd({}, rec())).toThrow(/HddInfo/);
    expect(() => parseSd(HDD_FULL, {})).toThrow(/Rec/);
  });
});

describe('readCameraSd', () => {
  it('reads GetHddInfo and GetRecV20 (channel 0), nothing else', async () => {
    const calls: [string, object][] = [];
    const client = { command: async (cmd: string, param: object = {}) => (calls.push([cmd, param]), cmd === 'GetHddInfo' ? HDD_FULL : rec()) };
    expect(await readCameraSd(client)).toMatchObject({ freeMB: 900, overwrite: false });
    expect(calls).toEqual([['GetHddInfo', {}], ['GetRecV20', { channel: 0 }]]);
  });
});

type Rec = { start: number; end: number };
function watch(o: { hdd?: unknown; rec?: unknown; online?: boolean; lastClip?: number | null; recordings?: Rec[]; fail?: Error; searchFails?: boolean } = {}) {
  let now = NOW;
  const searches: [number, number][] = [];
  const st = { online: o.online ?? true, reads: 0, fail: o.fail, hdd: o.hdd ?? HDD_FULL, rec: o.rec ?? rec() };
  const w = new SdWatch({
    read: async () => {
      st.reads++;
      if (st.fail) throw st.fail;
      return parseSd(st.hdd, st.rec);
    },
    active: () => st.online,
    lastClip: () => (o.lastClip === undefined ? null : o.lastClip),
    recordings: async (from, to) => {
      searches.push([from, to]);
      if (o.searchFails) throw new Error('search_failed');
      return (o.recordings ?? []).filter((r) => r.start <= to && r.end >= from);
    },
    now: () => now,
  });
  return { w, st, searches, tick: (ms: number) => (now += ms) };
}

describe('SdWatch', () => {
  it('reads every 5 minutes by default', () => {
    expect(SD_CHECK_MS).toBe(5 * 60_000);
  });
  it('nothing before the first read; then the reading with checkedAt', async () => {
    const { w } = watch();
    expect(w.view()).toBeNull();
    await w.checkNow();
    expect(w.view()).toMatchObject({ mounted: true, formatted: true, capacityMB: 30432, freeMB: 900, overwrite: false, recordingEnabled: true, checkedAt: NOW, error: null });
  });
  it('an offline camera is not read', async () => {
    const { w, st } = watch({ online: false });
    await w.checkNow();
    expect(st.reads).toBe(0);
    expect(w.view()).toBeNull();
  });
  it('a failed read keeps the last reading and names the error', async () => {
    const { w, st, tick } = watch();
    await w.checkNow();
    st.fail = new CameraError('camera_offline', 'timed out');
    tick(60_000);
    await w.checkNow();
    expect(w.view()).toMatchObject({ freeMB: 900, checkedAt: NOW, error: 'camera_offline' });
  });
  it('concurrent callers share one read', async () => {
    const { w, st } = watch();
    await Promise.all([w.checkNow(), w.checkNow()]);
    expect(st.reads).toBe(1);
  });

  describe('the newest SD recording against the newest FTP clip', () => {
    it('a recording within the hour before the clip: found, from the first search', async () => {
      const clip = NOW - 10 * 60_000;
      const { w, searches } = watch({ lastClip: clip, recordings: [{ start: clip - 90_000, end: clip - 60_000 }] });
      await w.checkNow();
      expect(searches).toEqual([[clip - H, NOW]]);
      expect(w.view()).toMatchObject({ lastClipAt: clip, lastRecordingAt: clip - 60_000, recordingsFrom: clip - H });
    });
    it('none in that hour: the newest of the last 48 h (the incident: 28 h before)', async () => {
      const clip = NOW - 5 * 60_000;
      const last = NOW - 28 * H;
      const { w, searches } = watch({ lastClip: clip, recordings: [{ start: last - 30_000, end: last }] });
      await w.checkNow();
      expect(searches).toEqual([[clip - H, NOW], [NOW - SD_STALL_LOOKBACK_MS, clip - H]]);
      expect(w.view()).toMatchObject({ lastClipAt: clip, lastRecordingAt: last, recordingsFrom: NOW - SD_STALL_LOOKBACK_MS });
    });
    it('none in 48 h at all: lastRecordingAt null, searched from 48 h back', async () => {
      const clip = NOW - 5 * 60_000;
      const { w } = watch({ lastClip: clip });
      await w.checkNow();
      expect(w.view()).toMatchObject({ lastClipAt: clip, lastRecordingAt: null, recordingsFrom: NOW - 48 * H });
    });
    it('no search without a clip, with a clip older than 48 h, or while the card cannot record', async () => {
      for (const o of [{ lastClip: null }, { lastClip: NOW - 49 * H }, { lastClip: NOW - H, rec: rec({ enable: 0 }) }, { lastClip: NOW - H, hdd: { HddInfo: [] } }]) {
        const { w, searches } = watch(o);
        await w.checkNow();
        expect(searches).toEqual([]);
        expect(w.view()).toMatchObject({ lastClipAt: null, lastRecordingAt: null, recordingsFrom: null });
      }
    });
    it('a failed search compares nothing (no false alarm)', async () => {
      const { w } = watch({ lastClip: NOW - H, searchFails: true });
      await w.checkNow();
      expect(w.view()).toMatchObject({ freeMB: 900, lastClipAt: null, recordingsFrom: null });
    });
  });
});
