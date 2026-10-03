import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { addRecoveredEvents, closeEvent, insertEvent } from '../src/catalog/events';
import { compareEvents, eventsCheck, SPAN_AFTER_MS, SPAN_BEFORE_MS, type EventsInventoryDeps, type EventsSettings } from '../src/inventory/events';
import type { CameraListDeps } from '../src/inventory/camera-list';
import { SearchError, type RecordingEntry } from '../src/recordings/list';
import type { Kind } from '../src/recordings/names';
import type { CheckContext } from '../src/inventory/runner';
import { ReolinkClient } from '../src/camera/client';
import { RecordingList } from '../src/recordings/list';
import { createCamSim, type SeedClip } from 'cam-sim';

// Camera time is UTC here (offset 0): camera-local dates are UTC dates.
const NOW = Date.UTC(2026, 9, 2, 12, 0);
const T = (iso: string) => Date.parse(`${iso}Z`);
let dir: string;
let catalog: Catalog;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-invevents-'));
  catalog = openCatalog(join(dir, 'catalog.sqlite'));
});
afterEach(() => {
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

function event(kind: string, start: number, end: number | null, cam = 'cam1') {
  const e = insertEvent(catalog, { cam, source: 'onvif', kind, start_ts: start, raw: null });
  return end === null ? e : closeEvent(catalog, e.id, end, 'state');
}
const rec = (start: number, kinds: Kind[] = ['motion'], len = 30_000): RecordingEntry => ({
  id: `RecS0A_${new Date(start).toISOString().slice(0, 10).replaceAll('-', '')}_${new Date(start).toISOString().slice(11, 19).replaceAll(':', '')}_000000_0_55148000000000_100000.mp4`,
  path: `/mnt/sda/x/${start}.mp4`, start, end: start + len, stream: 'sub', size: 0x100000, kinds,
});
function camera(o: { months: Record<string, number[]>; recs: Record<string, RecordingEntry[]>; failing?: string[]; offline?: boolean; onDay?: (date: string) => void }) {
  const searched: string[] = [];
  const deps: CameraListDeps = {
    timeInfo: async () => ({ stdOffsetMinutes: 0, dstOffsetMinutes: 0 }),
    sleep: async () => undefined,
    list: {
      monthDays: async (m) => o.months[m] ?? [],
      day: async (date) => {
        searched.push(date);
        o.onDay?.(date);
        if (o.offline) throw new SearchError('camera_offline', 'the camera does not answer');
        if (o.failing?.includes(date)) throw new SearchError('search_failed', 'rspCode -17');
        return o.recs[date] ?? [];
      },
    },
  };
  return { deps, searched };
}
const settings = (o: Partial<EventsSettings> = {}): EventsSettings => ({ cam: 'cam1', eventsDays: 30, stream: 'sub', eventMaxOpenMin: 10, ...o });
const deps = (cam: CameraListDeps, o: Partial<EventsSettings> = {}): EventsInventoryDeps => ({ catalog, settings: () => settings(o), camera: cam });
const ctx = (o: Partial<CheckContext> = {}): CheckContext => ({ signal: new AbortController().signal, progress: () => undefined, now: NOW, options: {}, ...o });
const EDGE_NOTE = (n: number) => `${n} recording spans at the start of the events retention were not judged: an event that covered them may already be deleted`;
const MONTHS = { '2026-09': [30], '2026-10': [1, 2] };

// The SD card reaches back to 2026-09-30 08:00 (its oldest recording).
function fixture() {
  const r = {
    oldest: rec(T('2026-09-30T08:00:00')), // matched by a motion event
    both: rec(T('2026-10-01T09:00:00'), ['motion', 'person']), // motion event only: person missing
    a: rec(T('2026-10-01T10:00:00')), // a and b touch: one motion span, no event
    b: rec(T('2026-10-01T10:00:30')),
    vehicle: rec(T('2026-10-01T11:00:00'), ['vehicle']), // an event 8 s before: matched
    pet: rec(T('2026-10-01T12:00:00'), ['pet']), // an event 6 s after its end: missing
    timer: rec(T('2026-10-01T13:00:00'), []), // timer only: ignored, counted
    fresh: { ...rec(NOW - 120_000), end: NOW - 90_000 }, // ended less than 5 min ago: not judged
  };
  event('motion', T('2026-09-30T08:00:05'), T('2026-09-30T08:00:20'));
  event('motion', T('2026-10-01T09:00:02'), T('2026-10-01T09:00:10'));
  event('vehicle', T('2026-10-01T10:59:52'), T('2026-10-01T10:59:55'));
  const latePet = event('pet', T('2026-10-01T12:00:36'), T('2026-10-01T12:00:40'));
  const lonely = event('person', T('2026-10-01T14:00:00'), T('2026-10-01T14:00:10')); // no recording
  event('Visitor', T('2026-10-01T15:00:00'), T('2026-10-01T15:00:05')); // not a recording kind
  event('person', T('2026-09-30T07:00:00'), T('2026-09-30T07:00:05')); // before the SD card's reach: not judged
  event('person', T('2026-10-01T09:00:00'), null, 'cam2'); // another camera's
  const recs = { '2026-09-30': [r.oldest], '2026-10-01': [r.both, r.a, r.b, r.vehicle, r.pet, r.timer], '2026-10-02': [r.fresh] };
  return { r, recs, latePet, lonely };
}

describe('events inventory', () => {
  it('finds the recording spans without an event and the events without a recording, in the SD card\'s reach', async () => {
    const f = fixture();
    const cam = camera({ months: MONTHS, recs: f.recs });
    const res = await eventsCheck(deps(cam.deps))(ctx());
    expect([SPAN_BEFORE_MS, SPAN_AFTER_MS]).toEqual([10_000, 5_000]);
    expect(cam.searched).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']); // only the days with recordings
    expect(res.window).toEqual({
      from: T('2026-09-30T08:00:00'), to: NOW, reason: 'sd-card', retentionFrom: NOW - 30 * 86_400_000, eventsDays: 30,
      notes: [
        "The window is the SD card's reach, shorter than the 30-day events retention: older recordings are overwritten",
        'A recovered event spans its recordings, pre- and post-record included, so it starts a few seconds before what the camera saw',
      ],
      camera: { stream: 'sub', to: NOW - 300_000, oldestSdDay: '2026-09-30', unknownDays: [] },
    });
    expect(res.counts).toEqual({
      eventsDays: 30, cameraDays: 31, unknownDays: 0, recordings: 6, timerOnly: 1, spans: 6, matched: 3, missingEvents: 3,
      missingPerson: 1, missingVehicle: 0, missingPet: 1, missingMotion: 1, events: 5, eventsWithoutRecording: 2,
    });
    expect(res.items).toEqual([
      { type: 'missing-event', kind: 'person', start: f.r.both.start, end: f.r.both.end, date: '2026-10-01', recordings: [f.r.both.id] },
      { type: 'missing-event', kind: 'motion', start: f.r.a.start, end: f.r.b.end, date: '2026-10-01', recordings: [f.r.a.id, f.r.b.id] },
      { type: 'missing-event', kind: 'pet', start: f.r.pet.start, end: f.r.pet.end, date: '2026-10-01', recordings: [f.r.pet.id] },
      // Symmetric tolerance: the pet event starts 6 s after its recording ended.
      { type: 'event-without-recording', eventId: f.latePet.id, kind: 'pet', start: f.latePet.start_ts, end: f.latePet.end_ts, source: 'onvif' },
      { type: 'event-without-recording', eventId: f.lonely.id, kind: 'person', start: f.lonely.start_ts, end: f.lonely.end_ts, source: 'onvif' },
    ]);
    expect(res.top).toEqual([{ date: '2026-10-01', state: 'listed', spans: 5, missing: 3 }]);
    expect(res.message).toBe("3 of 6 recording spans without an event (person 1, pet 1, motion 1) since 2026-09-30 (the SD card's reach), 2 of 5 events without a recording, 0 days unknown");
  });

  it('an open event covers a span up to events.maxOpenMin after its start', async () => {
    const r = rec(T('2026-10-01T09:05:00'));
    event('motion', T('2026-10-01T09:00:00'), null); // open, counts to 09:10
    const cam = camera({ months: { '2026-10': [1] }, recs: { '2026-10-01': [r] } });
    expect((await eventsCheck(deps(cam.deps))(ctx())).counts).toMatchObject({ spans: 1, matched: 1, missingEvents: 0 });
    const late = await eventsCheck(deps(cam.deps, { eventMaxOpenMin: 4 }))(ctx());
    expect(late.counts).toMatchObject({ spans: 1, missingEvents: 1 });
  });

  it('recovered events match, so a check after a repair finds nothing missing', async () => {
    const r = rec(T('2026-10-01T09:00:00'), ['person']);
    const cam = camera({ months: { '2026-10': [1] }, recs: { '2026-10-01': [r] } });
    addRecoveredEvents(catalog, 'cam1', [{ kind: 'person', start_ts: r.start, end_ts: r.end, raw: null }], { beforeMs: SPAN_BEFORE_MS, afterMs: SPAN_AFTER_MS, openMs: 600_000 });
    expect((await eventsCheck(deps(cam.deps))(ctx())).counts).toMatchObject({ spans: 1, matched: 1, missingEvents: 0, events: 1, eventsWithoutRecording: 0 });
  });

  it('a day whose Search failed is unknown: nothing on it, or next to it, is judged', async () => {
    const f = fixture();
    const edge = rec(T('2026-09-30T23:59:50')); // its tolerance runs into the unknown day
    const cam = camera({ months: MONTHS, recs: { ...f.recs, '2026-09-30': [f.r.oldest, edge] }, failing: ['2026-10-01'] });
    const res = await eventsCheck(deps(cam.deps))(ctx());
    expect(res.counts).toMatchObject({ unknownDays: 1, spans: 1, matched: 1, missingEvents: 0, events: 1, eventsWithoutRecording: 0 });
    expect(res.window.camera).toEqual({ stream: 'sub', to: NOW - 300_000, oldestSdDay: '2026-09-30', unknownDays: ['2026-10-01'] });
    expect(res.window.notes).toContain('5 recording spans or events next to a day the camera did not list were not judged');
    expect(res.top).toEqual([{ date: '2026-10-01', state: 'unknown', spans: 0, missing: 0 }]);
    expect(res.message).toMatch(/, 1 days unknown$/);
  });

  it('the events retention bounds the window when it is shorter than the SD card\'s reach', async () => {
    const f = fixture();
    const cam = camera({ months: MONTHS, recs: f.recs });
    const res = await eventsCheck(deps(cam.deps, { eventsDays: 1 }))(ctx());
    expect(res.window).toMatchObject({ from: NOW - 86_400_000, reason: 'retention', retentionFrom: NOW - 86_400_000, eventsDays: 1 });
    expect(cam.searched).toEqual(['2026-10-01', '2026-10-02']);
    // The pet recording starts at the window's start: an event that covered
    // it may already be gone, so it is not judged (the next test).
    expect(res.counts).toMatchObject({ spans: 0, missingEvents: 0, missingPet: 0, events: 2, eventsWithoutRecording: 2 });
    expect(res.window.notes).toContain(EDGE_NOTE(1));
    expect(res.message).toMatch(/ since 2026-10-01 \(the 1-day retention\), /);
  });

  it('spans at the start of the events retention are not judged: an event that covered them may be deleted already', async () => {
    const from = NOW - 86_400_000; // 2026-10-01T12:00, the retention bound
    const old = rec(from - 10_000); // before the window: not judged either way
    const edge = rec(from + 300_000, ['person']); // an event from before `from`, open up to 10 min, could have covered it
    const late = rec(from + SPAN_BEFORE_MS + 600_000, ['person']); // no event before `from` reaches it: judged
    const cam = camera({ months: { '2026-10': [1] }, recs: { '2026-10-01': [old, edge, late] } });
    const res = await eventsCheck(deps(cam.deps, { eventsDays: 1 }))(ctx());
    expect(res.window).toMatchObject({ from, reason: 'retention' });
    expect(res.counts).toMatchObject({ spans: 1, missingEvents: 1, missingPerson: 1 });
    expect(res.items).toEqual([expect.objectContaining({ type: 'missing-event', kind: 'person', start: late.start })]);
    expect(res.window.notes).toContain(EDGE_NOTE(1));
  });

  it('an empty SD card: nothing judged', async () => {
    event('person', T('2026-10-01T14:00:00'), T('2026-10-01T14:00:10'));
    const cam = camera({ months: {}, recs: {} });
    const res = await eventsCheck(deps(cam.deps))(ctx());
    expect(res.window).toMatchObject({ from: null, reason: 'empty' });
    expect(res.counts).toMatchObject({ spans: 0, missingEvents: 0, events: 0 });
    expect(res.items).toEqual([]);
    expect(res.message).toBe('no recordings on the SD card (sub) in the last 30 days');
  });

  it('fails with camera_offline when the camera does not answer', async () => {
    const cam = camera({ months: MONTHS, recs: {}, offline: true });
    await expect(eventsCheck(deps(cam.deps))(ctx())).rejects.toThrow(/^camera_offline: /);
  });

  it('a cancel ends the listing; the result is partial', async () => {
    const f = fixture();
    const ac = new AbortController();
    const cam = camera({ months: MONTHS, recs: f.recs, onDay: (d) => d === '2026-09-30' && ac.abort() });
    const res = await compareEvents(deps(cam.deps), ctx({ signal: ac.signal }));
    expect(res.cancelled).toBe(true);
    expect(cam.searched).toEqual(['2026-09-30']);
    expect(res.counts.cameraDays).toBeLessThan(31);
    // Not "next to a day the camera did not list": the run was cancelled.
    // The four events of 2026-10-01 (its Search never ran) were not judged.
    expect(res.window.notes).toContain('4 recording spans or events were not judged: the run was cancelled before their days were listed');
    expect((res.window.notes as string[]).join(' ')).not.toMatch(/did not list/);
  });

  it('the repair\'s bound leaves out spans that ended after the check', async () => {
    const f = fixture();
    const cam = camera({ months: MONTHS, recs: f.recs });
    const res = await compareEvents(deps(cam.deps), ctx(), T('2026-10-01T11:00:00'));
    expect(res.missing.map((m) => m.kind)).toEqual(['person', 'motion']);
    expect(res.window.camera).toMatchObject({ to: T('2026-10-01T11:00:00') });
  });
});

describe('events inventory at scale', () => {
  // The real camera: ~100 recordings a day; 30 days of events, 1,000 a day.
  // Measured (M-series Mac): the worst step 22 ms (60 ms before the yields).
  it('3,000 recordings against 30k events: no step blocks the event loop long', async () => {
    const days = 30;
    const start = NOW - days * 86_400_000;
    const db = catalog.db;
    db.exec('BEGIN');
    const ev = db.prepare("INSERT INTO events (cam, source, kind, start_ts, end_ts, raw) VALUES ('cam1', 'onvif', ?, ?, ?, NULL)");
    for (let i = 0; i < 30_000; i++) {
      const t = start + Math.floor((i / 30_000) * days * 86_400_000);
      ev.run(['motion', 'person', 'Visitor'][i % 3], t, t + 20_000);
    }
    db.exec('COMMIT');
    const recs: Record<string, RecordingEntry[]> = {};
    const months: Record<string, number[]> = {};
    for (let i = 0; i < 3_000; i++) {
      const t = start + 60_000 + Math.floor((i / 3_000) * days * 86_400_000);
      const date = new Date(t).toISOString().slice(0, 10);
      (recs[date] ??= []).push(rec(t, ([['motion'], ['motion', 'person'], ['vehicle'], []] as Kind[][])[i % 4]));
      const m = date.slice(0, 7);
      months[m] = [...new Set([...(months[m] ?? []), Number(date.slice(8))])];
    }
    const cam = camera({ months, recs });
    let last = performance.now();
    let worst = 0;
    const timer = setInterval(() => {
      const t = performance.now();
      worst = Math.max(worst, t - last);
      last = t;
    }, 1);
    try {
      const r = await eventsCheck(deps(cam.deps))(ctx());
      worst = Math.max(worst, performance.now() - last);
      expect(r.counts.recordings).toBeGreaterThan(2_200);
      expect(r.counts.spans).toBeGreaterThan(2_500);
      expect(r.counts.events).toBeGreaterThan(19_000);
    } finally {
      clearInterval(timer);
    }
    expect(worst).toBeLessThan(250);
  }, 30_000);
});

// The real cam-sim: seeded SD recordings (camera time UTC, its clock at NOW),
// listed through RecordingList and the HTTP Search like the proxy does.
describe('events inventory against cam-sim', () => {
  it('finds the SD recordings without an event and the event without a recording', async () => {
    const seed: SeedClip[] = [
      { daysAgo: 2, start: '070000', end: '070030', triggers: ['motion'] }, // 2026-09-30: an event
      { daysAgo: 1, start: '080000', end: '080030', triggers: ['person'] }, // 2026-10-01: no event
      { daysAgo: 1, start: '090000', end: '090030', triggers: ['motion', 'person'] }, // a motion event only: person missing
      { daysAgo: 1, start: '100000', end: '100030', triggers: [] }, // the timer: ignored
      { daysAgo: 0, start: '060000', end: '060020', triggers: ['vehicle'] }, // 2026-10-02: an event
    ];
    const sim = await createCamSim({ users: [{ name: 'proxy', level: 'admin', password: 'proxy-pw' }], seedClips: seed, tz: 'UTC', clock: { now: () => new Date(NOW) } });
    const ports = await sim.listen({ http: 0, https: 0, control: 0, rtsp: 0, onvif: 0, baichuan: 0 }, '127.0.0.1');
    try {
      const client = new ReolinkClient({ id: 'cam1', host: `127.0.0.1:${ports.http}`, protocol: 'http', user: 'proxy', password: 'proxy-pw' });
      const list = new RecordingList({ search: (param) => client.command('Search', param), timeInfo: () => client.timeInfo() });
      event('motion', T('2026-09-30T07:00:03'), T('2026-09-30T07:00:20'));
      event('motion', T('2026-10-01T09:00:01'), T('2026-10-01T09:00:15'));
      event('vehicle', T('2026-10-02T05:59:55'), T('2026-10-02T06:00:05'));
      const lonely = event('pet', T('2026-10-01T11:00:00'), T('2026-10-01T11:00:10'));
      const r = await eventsCheck(deps({ list, timeInfo: () => client.timeInfo() }))(ctx());
      expect(r.window).toMatchObject({ from: T('2026-09-30T07:00:00'), reason: 'sd-card', camera: { stream: 'sub', oldestSdDay: '2026-09-30', unknownDays: [] } });
      expect(r.counts).toMatchObject({ cameraDays: 31, unknownDays: 0, recordings: 4, timerOnly: 1, spans: 5, matched: 3, missingEvents: 2, missingPerson: 2, events: 4, eventsWithoutRecording: 1 });
      const missing = r.items.filter((x) => (x as { type: string }).type === 'missing-event') as { kind: string; start: number; date: string; recordings: string[] }[];
      expect(missing.map((x) => [x.kind, x.start, x.date])).toEqual([
        ['person', T('2026-10-01T08:00:00'), '2026-10-01'],
        ['person', T('2026-10-01T09:00:00'), '2026-10-01'],
      ]);
      for (const x of missing) expect(x.recordings).toEqual([expect.stringMatching(/^RecS0A_\d{8}_\d{6}_\d{6}_/)]);
      expect(r.items).toContainEqual(expect.objectContaining({ type: 'event-without-recording', eventId: lonely.id, kind: 'pet' }));
      expect(r.message).toBe("2 of 5 recording spans without an event (person 2) since 2026-09-30 (the SD card's reach), 1 of 4 events without a recording, 0 days unknown");
    } finally {
      await sim.close();
    }
  }, 20_000);
});
