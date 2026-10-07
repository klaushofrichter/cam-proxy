import { describe, expect, it } from 'vitest';
import { buildHealth, type HealthInput } from '../src/health/summary';
import type { SdView } from '../src/camera/sd-card';
import { H, NOW, input } from './helpers/health-input';

// Issue #199 (Klaus, 2026-10-07): overwrite off is a warning on its own,
// whatever the free space; a nearly full card (free < 5 %) with overwrite
// off, a card that isn't there, mounted or formatted, recording off, and
// recording to SD that stopped while clips still come are problems.
const sd = (over: Partial<SdView> = {}): SdView => ({
  present: true, mounted: true, formatted: true, capacityMB: 30432, freeMB: 20000, overwrite: true, recordingEnabled: true,
  checkedAt: NOW - 60_000, error: null, lastClipAt: null, lastRecordingAt: null, recordingsFrom: null, ...over,
});
const health = (over: Partial<SdView> = {}, more: Partial<HealthInput> = {}) => buildHealth(input({ sd: sd(over), ...more }));
const item = (h: ReturnType<typeof buildHealth>) => h.items.find((i) => i.id === 'sd');

describe('the sd item', () => {
  it('all fine: free of capacity in GB and overwrite on; no problem, no warning', () => {
    const h = health();
    expect(item(h)).toEqual({ id: 'sd', label: 'SD card', value: 'ok', text: '19.5 of 29.7 GB free, overwrite on', problem: false });
    expect(h.ok).toBe(true);
  });
  it('comes right after the camera items (camera, stream, events, ftp, sd, then the host)', () => {
    expect(health().items.map((i) => i.id).slice(0, 6)).toEqual(['camera', 'stream', 'events', 'ftp', 'sd', 'storage']);
  });
  it('overwrite off with plenty of space: a warning, not a problem', () => {
    const h = health({ overwrite: false });
    expect(item(h)).toEqual({ id: 'sd', label: 'SD card', value: 'overwrite_off', text: 'Overwrite is off: the camera stops recording to its SD card when it is full', problem: false, warning: true });
    expect([h.ok, h.problemCount]).toEqual([true, 0]);
  });
  it('the incident: 900 of 30432 MB free (under 5 %) and overwrite off: a problem', () => {
    const h = health({ freeMB: 900, overwrite: false });
    expect(item(h)).toMatchObject({ value: 'almost_full', text: 'SD card almost full and overwrite is off: recording to the SD card will stop', problem: true });
    expect(item(h)).not.toHaveProperty('warning');
    expect([h.ok, h.problemCount]).toEqual([false, 1]);
  });
  it('almost full with overwrite on: fine (the oldest recordings go)', () => {
    expect(item(health({ freeMB: 900 }))).toMatchObject({ value: 'ok', problem: false });
  });
  it('5 % free exactly is not "almost full"', () => {
    expect(item(health({ freeMB: 30432 * 0.05, overwrite: false }))).toMatchObject({ value: 'overwrite_off', problem: false });
  });
  it('no card, not mounted, not formatted, recording off: problems', () => {
    expect(item(health({ present: false, mounted: false, formatted: false, capacityMB: null, freeMB: null }))).toMatchObject({ value: 'no_card', text: "No SD card: the camera can't record", problem: true });
    expect(item(health({ mounted: false }))).toMatchObject({ value: 'not_mounted', text: "The SD card isn't mounted: the camera can't record to it", problem: true });
    expect(item(health({ formatted: false }))).toMatchObject({ value: 'not_formatted', text: "The SD card isn't formatted: the camera can't record to it", problem: true });
    expect(item(health({ recordingEnabled: false }))).toMatchObject({ value: 'recording_off', text: "Recording is off: the camera doesn't record to its SD card", problem: true });
  });
  it('recording to SD stopped: the newest recording more than 1 h before the newest clip, camera online', () => {
    const last = Date.UTC(2026, 9, 2, 11, 14, 57); // 06:14:57 at UTC-5, 25 h before NOW
    const h = health({ lastClipAt: NOW - 10 * 60_000, lastRecordingAt: last, recordingsFrom: NOW - 48 * H, offsetMinutes: -300 } as Partial<SdView>);
    expect(item(h)).toMatchObject({ value: 'stalled', text: "The camera hasn't recorded to its SD card since 2026-10-02 06:14", problem: true });
  });
  it('without the camera\'s offset the time is UTC, and said so', () => {
    const h = health({ lastClipAt: NOW, lastRecordingAt: NOW - 3 * H, recordingsFrom: NOW - 4 * H });
    expect(item(h)?.text).toBe("The camera hasn't recorded to its SD card since 2026-10-03 09:00 UTC");
  });
  it('none found in the 48 h searched', () => {
    expect(item(health({ lastClipAt: NOW, lastRecordingAt: null, recordingsFrom: NOW - 48 * H }))).toMatchObject({ value: 'stalled', text: "The camera hasn't recorded to its SD card for more than 48 h", problem: true });
  });
  it('within the hour, not compared, or the camera offline: not stalled', () => {
    expect(item(health({ lastClipAt: NOW, lastRecordingAt: NOW - H + 1000, recordingsFrom: NOW - H }))).toMatchObject({ value: 'ok' });
    expect(item(health({ lastClipAt: null, lastRecordingAt: null, recordingsFrom: null }))).toMatchObject({ value: 'ok' });
    const offline = input().camera;
    expect(item(health({ lastClipAt: NOW, lastRecordingAt: NOW - 5 * H, recordingsFrom: NOW - 48 * H }, { camera: { ...offline, state: { ...offline.state, online: false } } }))).toMatchObject({ value: 'ok' });
  });
  it('a problem wins over the overwrite warning in the text', () => {
    expect(item(health({ overwrite: false, recordingEnabled: false }))).toMatchObject({ value: 'recording_off', problem: true });
  });
  it('overwrite unknown (null): no warning, nothing said about it', () => {
    expect(item(health({ overwrite: null }))).toMatchObject({ value: 'ok', text: '19.5 of 29.7 GB free', problem: false });
  });
  it('not read yet (null): no item, camera.sd null; no sd in the input: no item and no sd key (schema 1, additive)', () => {
    const unread = buildHealth(input({ sd: null }));
    expect(item(unread)).toBeUndefined();
    expect(unread.camera.sd).toBeNull();
    const none = buildHealth(input());
    expect(item(none)).toBeUndefined();
    expect(none.camera).not.toHaveProperty('sd');
  });
});

describe('camera.sd', () => {
  it('the card and the setting, on the top level and in cameras[0]', () => {
    const h = health({ freeMB: 900, overwrite: false, lastClipAt: NOW, lastRecordingAt: NOW - 2 * H, recordingsFrom: NOW - H });
    const want = { mounted: true, formatted: true, capacityMB: 30432, freeMB: 900, overwrite: false, recordingEnabled: true, checkedAt: NOW - 60_000, lastRecordingAt: NOW - 2 * H, stalled: true };
    expect(h.camera.sd).toEqual(want);
    expect(h.cameras[0].camera.sd).toEqual(want);
    expect(h.cameras[0].items.find((i) => i.id === 'sd')).toEqual(item(h));
  });
});

describe('several cameras', () => {
  const other = (id: string, s: SdView | null | undefined) => ({ camera: { ...input().camera, id, name: id }, stream: input().stream, intake: input().intake, ftp: input().ftp, ...(s === undefined ? {} : { sd: s }) });
  it('one item: the camera with the problem named; a warning only when no camera has a problem', () => {
    const bad = buildHealth(input({ sd: sd(), others: [other('cam2', sd({ recordingEnabled: false })), other('cam3', sd({ overwrite: false }))] }));
    expect(item(bad)).toEqual({ id: 'sd', label: 'SD card', value: 2, text: "cam2 Recording is off: the camera doesn't record to its SD card", problem: true });
    const warn = buildHealth(input({ sd: sd(), others: [other('cam2', sd()), other('cam3', sd({ overwrite: false }))] }));
    expect(item(warn)).toEqual({ id: 'sd', label: 'SD card', value: 3, text: 'cam3 Overwrite is off: the camera stops recording to its SD card when it is full', problem: false, warning: true });
    const two = buildHealth(input({ sd: sd({ overwrite: false }), others: [other('cam2', sd()), other('cam3', sd({ overwrite: false }))] }));
    expect(item(two)).toMatchObject({ text: '2 of 3 cameras with a warning', problem: false, warning: true });
    const fine = buildHealth(input({ sd: sd(), others: [other('cam2', sd())] }));
    expect(item(fine)).toMatchObject({ value: 2, text: 'no problem (2 cameras)', problem: false });
  });
  it('only the cameras read; none read: no item', () => {
    const h = buildHealth(input({ sd: null, others: [other('cam2', sd({ overwrite: false }))] }));
    expect(item(h)).toMatchObject({ text: 'Overwrite is off: the camera stops recording to its SD card when it is full', warning: true });
    expect(item(buildHealth(input({ sd: null, others: [other('cam2', null)] })))).toBeUndefined();
  });
});
