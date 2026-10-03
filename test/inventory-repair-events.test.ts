import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { closeEvent, insertEvent, listEvents } from '../src/catalog/events';
import { eventsCheck, type EventsInventoryDeps } from '../src/inventory/events';
import { eventsRepair, RECOVER_MAX } from '../src/inventory/repair-events';
import type { CameraListDeps } from '../src/inventory/camera-list';
import type { RecordingEntry } from '../src/recordings/list';
import type { Kind } from '../src/recordings/names';
import type { InventoryReport, RepairContext } from '../src/inventory/runner';
import { SETTLE_MS } from '../src/inventory/clips';
import { ReolinkClient } from '../src/camera/client';
import { RecordingList } from '../src/recordings/list';
import { StreamLog } from '../src/stream/log';
import { EventTracker } from '../src/events/tracker';
import { EventIntake } from '../src/events/intake';
import { createCamSim } from 'cam-sim';

// Camera time is UTC here (offset 0).
const NOW = Date.UTC(2026, 9, 2, 12, 0);
const T = (iso: string) => Date.parse(`${iso}Z`);
let dir: string;
let catalog: Catalog;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-repairevents-'));
  catalog = openCatalog(join(dir, 'catalog.sqlite'));
});
afterEach(() => {
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

const rec = (start: number, kinds: Kind[] = ['motion']): RecordingEntry => ({
  id: `RecS0A_${new Date(start).toISOString().slice(0, 10).replaceAll('-', '')}_${new Date(start).toISOString().slice(11, 19).replaceAll(':', '')}_000000_0_55148000000000_100000.mp4`,
  path: `/mnt/sda/x/${start}.mp4`, start, end: start + 30_000, stream: 'sub', size: 0x100000, kinds,
});
// 2026-10-01: four recordings without events (one with two kinds: five spans).
const RECS = [rec(T('2026-10-01T08:00:00'), ['motion', 'person']), rec(T('2026-10-01T09:00:00')), rec(T('2026-10-01T10:00:00'), ['vehicle']), rec(T('2026-10-01T11:00:00'), ['pet'])];
let recs: RecordingEntry[];
const camera: CameraListDeps = {
  timeInfo: async () => ({ stdOffsetMinutes: 0, dstOffsetMinutes: 0 }),
  sleep: async () => undefined,
  list: { monthDays: async (m) => (m === '2026-10' ? [1] : []), day: async (date) => (date === '2026-10-01' ? recs : []) },
};
const deps = (): EventsInventoryDeps => ({ catalog, settings: () => ({ cam: 'cam1', eventsDays: 30, stream: 'sub', eventMaxOpenMin: 10 }), camera });
const ctx = (source: InventoryReport, o: Partial<RepairContext> = {}): RepairContext => ({ signal: new AbortController().signal, progress: () => undefined, now: NOW + 60_000, runId: 'eventsrepair-1-abcdef', source, ...o });
async function check(): Promise<InventoryReport> {
  const r = await eventsCheck(deps())({ signal: new AbortController().signal, progress: () => undefined, now: NOW });
  return { runId: 'events-1-abcdef', kind: 'events', op: 'check', camera: 'cam1', startedAt: NOW, tookMs: 5, outcome: 'ok', requestedBy: 'token', itemsTruncated: false, ...r };
}
beforeEach(() => {
  recs = [...RECS];
});

describe('events repair', () => {
  it('is ready only when the check found events missing', async () => {
    const r = eventsRepair(deps());
    const source = await check();
    expect(source.counts.missingEvents).toBe(5);
    expect(r.ready(source)).toBeNull();
    expect(r.ready({ ...source, counts: { ...source.counts, missingEvents: 0 } })).toBe('no events are missing');
  });

  it('adds one recovered event per missing span, oldest first, marked with the run; a check afterwards finds none missing', async () => {
    const source = await check();
    const res = await eventsRepair(deps()).run(ctx(source));
    expect(res.counts).toEqual({ checked: 5, candidates: 5, requested: 5, done: 5, failed: 0, skipped: 0, donePerson: 1, doneVehicle: 1, donePet: 1, doneMotion: 2 });
    expect(res.stopped).toBeNull();
    expect(res.message).toBe('5 of 5 missing events added (person 1, vehicle 1, pet 1, motion 2), 0 had an event by then');
    const rows = listEvents(catalog, { cam: 'cam1' }).reverse();
    expect(rows.map((e) => [e.kind, e.source, e.start_ts, e.end_ts, e.end_reason])).toEqual([
      ['motion', 'recovered', RECS[0].start, RECS[0].end, 'recovered'],
      ['person', 'recovered', RECS[0].start, RECS[0].end, 'recovered'],
      ['motion', 'recovered', RECS[1].start, RECS[1].end, 'recovered'],
      ['vehicle', 'recovered', RECS[2].start, RECS[2].end, 'recovered'],
      ['pet', 'recovered', RECS[3].start, RECS[3].end, 'recovered'],
    ]);
    expect(rows[0].raw).toEqual({ runId: 'eventsrepair-1-abcdef', check: 'events-1-abcdef', recordings: [RECS[0].id], stream: 'sub', bounds: "the recordings' start and end, pre- and post-record included" });
    expect(res.items).toEqual(rows.map((e) => ({ eventId: e.id, kind: e.kind, start: e.start_ts, end: e.end_ts, result: 'ok' })));
    expect((await check()).counts).toMatchObject({ spans: 5, matched: 5, missingEvents: 0 });
  });

  it('compares again: a span that got its event since the check is not added, and nothing past the check\'s bound', async () => {
    const source = await check();
    const live = insertEvent(catalog, { cam: 'cam1', source: 'onvif', kind: 'pet', start_ts: RECS[3].start + 2000, raw: null });
    closeEvent(catalog, live.id, RECS[3].start + 9000, 'state');
    recs.push({ ...rec(NOW - 60_000, ['person']) }); // ended after the check's bound (NOW − 5 min)
    const res = await eventsRepair(deps()).run(ctx(source));
    expect(res.counts).toMatchObject({ checked: 5, candidates: 4, requested: 4, done: 4 });
    expect(listEvents(catalog, { cam: 'cam1', kind: 'pet' })).toEqual([expect.objectContaining({ id: live.id, source: 'onvif' })]);
    expect(listEvents(catalog, { cam: 'cam1', kind: 'person' }).map((e) => e.start_ts)).toEqual([RECS[0].start]);
  });

  it('adds at most the cap per run, the oldest first, and says it stopped there', async () => {
    expect(RECOVER_MAX).toBe(1000);
    const source = await check();
    const res = await eventsRepair(deps(), { events: 2 }).run(ctx(source));
    expect(res).toMatchObject({ stopped: 'event-cap', counts: { candidates: 5, requested: 2, done: 2 } });
    expect(res.message).toMatch(/; stopped: the 2-event cap$/);
    expect(listEvents(catalog, { cam: 'cam1' }).map((e) => e.start_ts)).toEqual([RECS[0].start, RECS[0].start]);
  });

  it('a cancel during the compare adds nothing', async () => {
    const source = await check();
    const ac = new AbortController();
    ac.abort();
    const res = await eventsRepair(deps()).run(ctx(source, { signal: ac.signal }));
    expect(res).toMatchObject({ counts: { requested: 0, done: 0 }, message: 'nothing added', stopped: null });
    expect(listEvents(catalog, { cam: 'cam1' })).toEqual([]);
  });

  it('fails when the camera is offline, adding nothing', async () => {
    const source = await check();
    const offline: EventsInventoryDeps = { ...deps(), camera: { ...camera, timeInfo: async () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })) } };
    await expect(eventsRepair(offline).run(ctx(source))).rejects.toThrow(/^camera_offline: /);
    expect(listEvents(catalog, { cam: 'cam1' })).toEqual([]);
  });
});

// The real camera's pattern, through the proxy's intake (#75 handoff): a
// person sets the person AND the motion detection state, and its recording
// carries both flags; ONVIF sends both, so the proxy has both events and the
// check finds nothing missing. Only a trigger the proxy did not see (it was
// down) is missing: one person span and one motion span.
describe('events repair against cam-sim, through the intake', () => {
  const until = async (cond: () => boolean, ms = 15_000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it('a person seen by the proxy is not missing; one it missed is added once, as person and motion', async () => {
    const token = 'ctl-token-1234567890';
    const sim = await createCamSim({ users: [{ name: 'proxy', level: 'admin', password: 'proxy-pw' }], seedClips: [], tz: 'UTC', controlToken: token });
    const ports = await sim.listen({ http: 0, https: 0, control: 0, rtsp: 0, onvif: 0, baichuan: 0 }, '127.0.0.1');
    sim.engine.settings.running.Rec.postRec = '1 Second'; // short recordings: the test waits for them
    const client = new ReolinkClient({ id: 'cam1', host: `127.0.0.1:${ports.http}`, protocol: 'http', user: 'proxy', password: 'proxy-pw' });
    const tracker = new EventTracker(catalog, new StreamLog(catalog), 'cam1', { maxOpenMin: 10 });
    const intake = new EventIntake({
      client, tracker,
      cfg: { onvif: { subscribeMin: 1, pullTimeoutS: 1 }, poll: { enabled: false, intervalS: 1, afterOnvifDownS: 1 }, maxOpenMin: 10 },
      onvif: { host: '127.0.0.1', port: ports.onvif, user: 'proxy', password: 'proxy-pw' },
      backoff: { minMs: 100, maxMs: 500 },
    });
    // A RecordingList per run: its 30 s day cache would hide the new recording.
    const simDeps = (): EventsInventoryDeps => ({
      ...deps(),
      camera: { list: new RecordingList({ search: (param) => client.command('Search', param), timeInfo: () => client.timeInfo() }), timeInfo: () => client.timeInfo() },
    });
    // Judge what just ended: the run's "now" is past the settle time.
    const settledNow = () => Date.now() + SETTLE_MS + 5_000;
    const simCheck = async (): Promise<InventoryReport> => {
      const now = settledNow();
      const r = await eventsCheck(simDeps())({ signal: new AbortController().signal, progress: () => undefined, now });
      return { runId: `events-${now}-abcdef`, kind: 'events', op: 'check', camera: 'cam1', startedAt: now, tookMs: 5, outcome: 'ok', requestedBy: 'token', itemsTruncated: false, ...r };
    };
    const person = async () => {
      const recorded = new Promise((r) => sim.engine.events.once('recording', r));
      const res = await fetch(`http://127.0.0.1:${ports.control}/sim/api/events`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'person', durationS: 1 }),
      });
      expect(res.status).toBe(201);
      await recorded; // the recording has ended on the SD card
    };
    try {
      intake.start();
      await until(() => intake.state().onvif === 'subscribed');
      await new Promise((r) => setTimeout(r, 200)); // the Initialized pull
      await person();
      await until(() => listEvents(catalog, { cam: 'cam1' }).filter((e) => e.end_ts !== null).length >= 2);
      expect(listEvents(catalog, { cam: 'cam1' }).map((e) => `${e.kind}/${e.source}`).sort()).toEqual(['motion/onvif', 'person/onvif']);
      const seen = await simCheck();
      expect(seen.counts).toMatchObject({ recordings: 1, spans: 2, matched: 2, missingEvents: 0, missingPerson: 0, missingMotion: 0 });

      // The proxy is down for the next person; far enough from the first
      // that neither its recording nor its tolerance touches the first one.
      await intake.stop();
      const first = Math.max(...listEvents(catalog, { cam: 'cam1' }).map((e) => e.end_ts!));
      await until(() => Date.now() > first + 22_000, 30_000);
      await person();
      const source = await simCheck();
      expect(source.counts).toMatchObject({ recordings: 2, spans: 4, matched: 2, missingEvents: 2, missingPerson: 1, missingMotion: 1 });
      const res = await eventsRepair(simDeps()).run(ctx(source, { now: settledNow() }));
      expect(res.counts).toMatchObject({ candidates: 2, requested: 2, done: 2, skipped: 0, donePerson: 1, doneMotion: 1 });
      const recovered = listEvents(catalog, { cam: 'cam1' }).filter((e) => e.source === 'recovered');
      expect(recovered.map((e) => e.kind).sort()).toEqual(['motion', 'person']);
      expect((await simCheck()).counts).toMatchObject({ spans: 4, matched: 4, missingEvents: 0 });
      const again = await eventsRepair(simDeps()).run(ctx(source, { now: settledNow() }));
      expect(again.counts).toMatchObject({ candidates: 0, requested: 0, done: 0 });
      expect(listEvents(catalog, { cam: 'cam1' })).toHaveLength(4);
    } finally {
      await intake.stop();
      await sim.close();
    }
  }, 60_000);
});
