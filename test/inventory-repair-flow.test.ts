import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createCamSim, type CamSim, type Model, type SeedClip } from 'cam-sim';
import { ReolinkClient } from '../src/camera/client';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { clipById, insertClip, listClips } from '../src/catalog/clips';
import { listEvents } from '../src/catalog/events';
import { ClipIndexer } from '../src/clips/indexer';
import { DEFAULTS, type Config } from '../src/config/defaults';
import { clipsCheck } from '../src/inventory/clips';
import { eventsCheck } from '../src/inventory/events';
import { clipsRepair, type RepairItem } from '../src/inventory/repair-clips';
import { duplicatesRepair, type DuplicateRepairItem } from '../src/inventory/repair-duplicates';
import { eventsRepair } from '../src/inventory/repair-events';
import { InventoryRunner, type InventoryReport } from '../src/inventory/runner';
import { createRecordingsSide, type RecordingsSide } from '../src/recordings/side';
import { httpDownload } from '../src/recordings/http-download';
import { Storage } from '../src/storage';
import { StreamLog } from '../src/stream/log';
import { DAY, dayStart, utcDayParts, utcHhmm } from '../src/time-units';

// The whole check → repair flow (spec 2026-10-02-inventory-design, amendment
// 2026-11-02) against a real cam-sim: its SD card (seeded recordings), its
// HTTP Search and its Baichuan downloads; the proxy's real recordings side,
// indexer, storage and inventory runner, wired as in proxy.ts. The clock is
// fixed (NOW for the proxy and the camera); the 1 s gap between downloads is
// skipped.

const NOW = Date.UTC(2026, 9, 2, 12, 0);
const WHO = { requestedBy: 'token' as const };

interface World {
  sim: CamSim;
  catalog: Catalog;
  config: Config;
  storage: Storage;
  runner: InventoryRunner;
  dir: string;
  check: () => Promise<InventoryReport>;
  repair: (source: InventoryReport) => Promise<InventoryReport>;
  events: () => Promise<InventoryReport>;
  repairEvents: (source: InventoryReport) => Promise<InventoryReport>;
  local: (start: number, bytes: number) => number; // an FTP clip here: its id
  size: number; // every seeded recording's size on sub
  side: RecordingsSide;
  close: () => Promise<void>;
}

const open: World[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function world(o: { seed: SeedClip[]; tz?: string; model?: Model; tweak?: (c: Config) => void; limits?: { clips?: number; bytes?: number }; capBytes?: number }): Promise<World> {
  const sim = await createCamSim({ users: [{ name: 'proxy', level: 'admin', password: 'proxy-pw' }], seedClips: o.seed, tz: o.tz ?? 'UTC', clock: { now: () => new Date(NOW) }, ...(o.model ? { model: o.model } : {}) });
  const ports = await sim.listen({ http: 0, https: 0, control: 0, rtsp: 0, onvif: 0, baichuan: 0 }, '127.0.0.1');
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-repairflow-'));
  const catalog = openCatalog(join(dir, 'catalog.sqlite'));
  const config = structuredClone(DEFAULTS);
  config.server.dataDir = dir;
  config.retention.clipsDays = 3;
  o.tweak?.(config);
  const client = new ReolinkClient({ id: 'cam1', host: `127.0.0.1:${ports.http}`, protocol: 'http', user: 'proxy', password: 'proxy-pw' });
  const side = createRecordingsSide({
    dataDir: dir,
    cam: () => 'cam1',
    target: () => ({ host: '127.0.0.1', port: ports.baichuan!, user: 'proxy', password: 'proxy-pw' }),
    capBytes: () => o.capBytes ?? 512 * 2 ** 20,
    search: (param) => client.command('Search', param),
    timeInfo: () => client.timeInfo(),
    paused: () => false,
    noteWritten: () => undefined,
    httpDownload: (path, size, out, hooks) => httpDownload(() => client, path, size, out, hooks), // as the worker wires it
  });
  const storage = new Storage({ catalog, log: new StreamLog(catalog, () => NOW), config: () => config, now: () => NOW, statfs: () => ({ free: 2 ** 40, size: 2 ** 41 }) });
  const indexer = new ClipIndexer({ catalog, log: new StreamLog(catalog), config: () => config, timeInfo: () => client.timeInfo(), dataDir: dir, cam: 'cam1' });
  const camera = () => ({ list: side.list, timeInfo: () => client.timeInfo() });
  const eventsDeps = { catalog, settings: (cam: string) => ({ cam, eventsDays: config.retention.eventsDays, stream: 'sub' as const, eventMaxOpenMin: config.events.maxOpenMin }), camera };
  const runner = new InventoryRunner({
    dir: join(dir, 'inventory'),
    audit: { write: () => null },
    now: () => NOW,
    checks: {
      clips: {
        label: 'Clips',
        camera: true,
        run: clipsCheck({ dataDir: dir, catalog, settings: (cam) => ({ cam, clipsDays: config.retention.clipsDays, stream: 'sub', ftpEnabled: true, eventMaxOpenMin: config.events.maxOpenMin }), camera }),
        repair: clipsRepair({
          catalog,
          settings: (cam) => ({ cam, stream: 'sub', clipsDays: config.retention.clipsDays }),
          list: () => side.list,
          fetcher: () => side.fetcher,
          cache: () => side.cache,
          indexer: () => indexer,
          tempDir: () => join(dir, 'inventory', 'tmp'),
          paused: () => storage.paused(),
          space: (cam) => storage.clipSpace(cam),
          prune: () => void storage.run({}),
          sleep: async () => undefined,
          limits: o.limits,
        }),
      },
      events: { label: 'Events', run: eventsCheck(eventsDeps), repair: eventsRepair(eventsDeps) },
    },
    repairs: { duplicates: { label: 'Duplicate clips', source: 'clips', repair: duplicatesRepair({ catalog, dataDir: dir, prune: () => void storage.run({}) }) } },
  });
  const local = (start: number, bytes: number) => {
    const path = join(dir, 'clips', 'cam1', ...utcDayParts(start), `${utcHhmm(start)}-${start}.mp4`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes));
    return insertClip(catalog, { cam: 'cam1', start_ts: start, end_ts: start + 30_000, path, stream: 'sub', size: bytes, received_at: start + 60_000, snapshot: null }).id;
  };
  const sizes = new Set(sim.engine.sd.all().map((r) => r.files.sub.size));
  expect(sizes.size).toBe(1);
  const w: World = {
    sim, catalog, config, storage, runner, dir, local, size: [...sizes][0], side,
    check: async () => {
      side.list.clear(); // the day list is cached 30 s
      return runner.start('clips', WHO, { cam: 'cam1', camera: true }).done;
    },
    repair: async (source) => (await runner.repair('clips', WHO, source.runId)).done,
    events: async () => {
      side.list.clear();
      return runner.start('events', WHO, { cam: 'cam1' }).done;
    },
    repairEvents: async (source) => (await runner.repair('events', WHO, source.runId)).done,
    close: async () => {
      await runner.stop();
      await side.stop();
      catalog.close();
      await sim.close();
    },
  };
  open.push(w);
  return w;
}

const T = (iso: string) => Date.parse(`${iso}Z`);
const missingStarts = (r: InventoryReport) => (r.items as { type: string; start: number }[]).filter((x) => x.type === 'missing-locally').map((x) => x.start);
const tried = (r: InventoryReport) => (r.items as RepairItem[]).map((x) => [x.start, x.reason ?? x.result]);
const fromCamera = (w: World) => listClips(w.catalog, 'cam1', 0, NOW + DAY).filter((c) => c.origin === 'camera').map((c) => c.start_ts);

describe('clips check → repair against cam-sim', () => {
  it('an outage gap: finds exactly the recordings of the last days missing here, fetches them newest first, and then finds none', async () => {
    // Two recordings a day on 2026-09-29 .. 10-02 (camera time UTC); here the
    // first two days arrived over FTP, the outage lost the last two.
    const seed: SeedClip[] = [3, 2, 1, 0].flatMap((daysAgo) => [
      { daysAgo, start: '080000', end: '080030', triggers: ['motion'] },
      { daysAgo, start: '100000', end: '100030', triggers: ['person'] },
    ]);
    const w = await world({ seed });
    for (const day of ['2026-09-29', '2026-09-30']) for (const t of ['08:00', '10:00']) w.local(T(`${day}T${t}:00`), 1000);
    const lost = [T('2026-10-02T10:00:00'), T('2026-10-02T08:00:00'), T('2026-10-01T10:00:00'), T('2026-10-01T08:00:00')];
    const check = await w.check();
    expect(check.counts).toMatchObject({ recordings: 8, paired: 4, missingLocally: 4, unknownDays: 0 });
    expect(missingStarts(check)).toEqual(lost); // newest first
    const repair = await w.repair(check);
    expect(repair).toMatchObject({ outcome: 'ok', stopped: null, counts: { candidates: 4, requested: 4, done: 4, failed: 0, skipped: 0 } });
    expect(tried(repair)).toEqual(lost.map((t) => [t, 'ok']));
    // Stored in that order: each later row (id) is an older clip.
    const rows = listClips(w.catalog, 'cam1', T('2026-10-01T00:00:00'), NOW).sort((a, b) => a.id - b.id);
    expect(rows.map((r) => [r.start_ts, r.origin])).toEqual(lost.map((t) => [t, 'camera']));
    const again = await w.check();
    expect(again.counts).toMatchObject({ missingLocally: 0, paired: 8, fromCamera: 4 });
  }, 60_000);

  // #342: measured on an E1 Outdoor Pro: the FTP clip starts 8 s after the SD recording.
  const ftpFrom = (w: World, file: string, start: number, end: number) => {
    const path = join(w.dir, 'clips', 'cam1', ...utcDayParts(start), `${utcHhmm(start)}-${start}.mp4`);
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(file, path);
    return insertClip(w.catalog, { cam: 'cam1', start_ts: start, end_ts: end, path, stream: 'sub', size: 1000, received_at: NOW, snapshot: null });
  };

  it('E1 Outdoor Pro: an FTP clip at +8 s holds its recording, so the check finds nothing to fetch', async () => {
    const w = await world({ seed: [{ daysAgo: 1, start: '021328', end: '021414', triggers: ['motion'] }], model: 'E1-Outdoor-Pro' });
    w.local(T('2026-10-01T02:13:36'), 1000);
    const check = await w.check();
    expect(check.counts).toMatchObject({ recordings: 1, paired: 1, missingLocally: 0, goneFromCamera: 0, duplicates: 0 });
    await expect(w.repair(check)).rejects.toMatchObject({ code: 'not_repairable' }); // so a move's sync has nothing to fetch either
    await expect(w.runner.repair('duplicates', WHO, check.runId)).rejects.toMatchObject({ code: 'not_repairable', message: 'no recording is held twice' });
  }, 60_000);

  it('a duplicate made before the fix: reported, and removed down to the FTP copy; then nothing is missing and nothing is reported', async () => {
    const start = T('2026-10-01T02:13:28');
    const w = await world({ seed: [{ daysAgo: 1, start: '021328', end: '021414', triggers: ['motion'] }] });
    const first = await w.check();
    expect(first.counts.missingLocally).toBe(1);
    await w.repair(first);
    const fetched = listClips(w.catalog, 'cam1', 0, NOW + DAY)[0];
    expect(fetched).toMatchObject({ origin: 'camera', start_ts: start });
    const ftp = ftpFrom(w, fetched.path, start + 8000, start + 49_000);
    const check = await w.check();
    expect(check.counts).toMatchObject({ paired: 1, missingLocally: 0, goneFromCamera: 0, duplicates: 1, duplicatesBytes: fetched.size });
    const rep = await (await w.runner.repair('duplicates', WHO, check.runId)).done;
    expect(rep).toMatchObject({ kind: 'duplicates', op: 'repair', outcome: 'ok', source: check.runId, stopped: null, counts: { done: 1, skipped: 0, failed: 0 } });
    expect((rep.items as DuplicateRepairItem[]).map((x) => [x.result, x.clipId, x.keptClipId])).toEqual([['ok', fetched.id, ftp.id]]);
    expect(listClips(w.catalog, 'cam1', 0, NOW + DAY).map((c) => c.id)).toEqual([ftp.id]);
    expect(existsSync(fetched.path)).toBe(false);
    expect(existsSync(ftp.path)).toBe(true);
    const after = await w.check();
    expect(after.counts).toMatchObject({ paired: 1, missingLocally: 0, goneFromCamera: 0, duplicates: 0, fromCamera: 0 });
  }, 60_000);

  // The E1 Outdoor Pro's names (cam-sim as measured 2026-11-02: RecS03_…,
  // no animal-type field, 7-digit flags). Before #318 its check found none.
  it('the E1 Outdoor Pro: its short names are listed, missing ones found and fetched, and nothing is unreadable', async () => {
    const seed: SeedClip[] = [
      { daysAgo: 1, start: '070556', end: '070624', triggers: ['motion'] },
      { daysAgo: 1, start: '134721', end: '134751', triggers: ['motion'] },
      { daysAgo: 0, start: '065854', end: '065924', triggers: ['motion'] },
    ];
    const w = await world({ seed, model: 'E1-Outdoor-Pro' });
    expect(w.sim.engine.sd.all().map((r) => r.files.sub.name.slice(r.files.sub.name.lastIndexOf('/') + 1))).toEqual(
      ['RecS03_20261001_070556_070624_2B14808', 'RecS03_20261001_134721_134751_2B14808', 'RecS03_20261002_065854_065924_2B14808'].map((p) => `${p}_${w.size.toString(16).toUpperCase()}.mp4`),
    );
    w.local(T('2026-10-01T07:05:56'), 1000); // arrived over FTP
    const lost = [T('2026-10-02T06:58:54'), T('2026-10-01T13:47:21')];
    const check = await w.check();
    expect(check.outcome).toBe('ok');
    expect(check.counts).toMatchObject({ recordings: 3, timerOnly: 0, unknownKinds: 0, unreadableNames: 0, paired: 1, missingLocally: 2, unknownDays: 0 });
    expect(missingStarts(check)).toEqual(lost);
    const repair = await w.repair(check);
    expect(repair).toMatchObject({ outcome: 'ok', stopped: null, counts: { candidates: 2, requested: 2, done: 2, failed: 0 } });
    expect(fromCamera(w)).toEqual([...lost].reverse());
    expect((await w.check()).counts).toMatchObject({ missingLocally: 0, paired: 3, fromCamera: 2 });
    // The E1 refuses the Baichuan download (cam-sim as measured 2026-11-02):
    // once, then HTTP Download for both.
    const c = w.sim.engine.counters;
    expect([c.baichuanDownloads, c.downloads]).toEqual([0, 2]);
    expect(w.sim.engine.requests.recent(500).filter((x) => x.port === 'baichuan' && x.cmd === '8').map((x) => x.status)).toEqual([400]);
    expect(w.side.status().download).toMatchObject({ path: 'http', baichuanRefusal: { status: 400 } });
  }, 60_000);

  // Streamed to a temp file (the cache can't keep it): the file is whole
  // when it has the HTTP body's length, which may differ from the name's
  // (the camera's remux; here cam-sim's stored size made 1000 bytes smaller,
  // a test-only poke at its SD index).
  it('the E1 into a temp file: an HTTP body longer than the name\'s size is still whole', async () => {
    const w = await world({ seed: [{ daysAgo: 0, start: '065854', end: '065924', triggers: ['motion'] }], model: 'E1-Outdoor-Pro', capBytes: 1 });
    const stored = (w.sim.engine.sd as unknown as { recs: { sizes: { sub: number } }[] }).recs;
    stored[0].sizes = { ...stored[0].sizes, sub: w.size - 1000 };
    const check = await w.check();
    expect(check.counts).toMatchObject({ missingLocally: 1 });
    const repair = await w.repair(check);
    expect(repair).toMatchObject({ outcome: 'ok', counts: { done: 1, failed: 0 } });
    expect(repair.items).toMatchObject([{ result: 'ok', streamed: true, bytes: w.size }]);
    expect(w.sim.engine.counters.downloads).toBe(1);
  }, 60_000);

  it('the retention window: an SD card that reaches further back offers and fetches nothing older than the clips retention (camera at UTC+9)', async () => {
    // clipsDays 3: the retention starts 2026-09-29T00:00Z, 09:00 on the
    // camera's 2026-09-29. Its card reaches back to 09-25.
    const seed: SeedClip[] = [
      { daysAgo: 7, start: '120000', end: '120030', triggers: ['motion'] }, // 09-25 local
      { daysAgo: 4, start: '200000', end: '200030', triggers: ['motion'] }, // 09-28 local, 11:00Z
      { daysAgo: 3, start: '085900', end: '085930', triggers: ['motion'] }, // 09-29 local, 09-28T23:59Z: a minute too old
      { daysAgo: 3, start: '090000', end: '090030', triggers: ['motion'] }, // 09-29T00:00Z: the first minute of the retention
      { daysAgo: 1, start: '120000', end: '120030', triggers: ['person'] }, // 10-01T03:00Z
    ];
    const w = await world({ seed, tz: 'Asia/Tokyo' });
    const check = await w.check();
    const from = dayStart(NOW - 3 * DAY);
    expect(from).toBe(T('2026-09-29T00:00:00'));
    expect(check.window).toMatchObject({ from, reason: 'retention' });
    expect(missingStarts(check)).toEqual([T('2026-10-01T03:00:00'), from]);
    const repair = await w.repair(check);
    expect(tried(repair)).toEqual([[T('2026-10-01T03:00:00'), 'ok'], [from, 'ok']]);
    expect(fromCamera(w)).toEqual([from, T('2026-10-01T03:00:00')]);
    // Storage keeps both (nothing fetched that the next run ages out).
    w.storage.run({});
    expect(fromCamera(w)).toEqual([from, T('2026-10-01T03:00:00')]);
  }, 60_000);

  it('the per-run cap: the first run takes the newest batch, a rerun after a new check the next older one', async () => {
    const seed: SeedClip[] = [2, 1, 0].flatMap((daysAgo) => ['060000', '070000', '080000'].map((start) => ({ daysAgo, start, end: `${start.slice(0, 4)}30`, triggers: ['motion' as const] })));
    const w = await world({ seed, limits: { clips: 4 } });
    const all = await w.check();
    const starts = missingStarts(all);
    expect(starts).toHaveLength(9);
    const first = await w.repair(all);
    expect(first).toMatchObject({ stopped: 'clip-cap', counts: { candidates: 9, requested: 4, done: 4 } });
    expect(tried(first).map(([t]) => t)).toEqual(starts.slice(0, 4));
    const next = await w.check();
    expect(missingStarts(next)).toEqual(starts.slice(4));
    const second = await w.repair(next);
    expect(second).toMatchObject({ stopped: 'clip-cap', counts: { candidates: 5, requested: 4, done: 4 } });
    expect(tried(second).map(([t]) => t)).toEqual(starts.slice(4, 8));
    const last = await w.repair(await w.check());
    expect(last).toMatchObject({ stopped: null, counts: { candidates: 1, done: 1 } });
    expect((await w.check()).counts.missingLocally).toBe(0);
  }, 60_000);

  it('a full store: newer recordings are stored by pruning older clips; it stops at one older than what storage would keep; nothing newer is deleted', async () => {
    const seed: SeedClip[] = [
      { daysAgo: 2, start: '050000', end: '050030', triggers: ['motion'] }, // missing, older than everything here
      { daysAgo: 2, start: '060000', end: '060030', triggers: ['motion'] }, // here (FTP)
      { daysAgo: 2, start: '070000', end: '070030', triggers: ['motion'] }, // here (FTP)
      { daysAgo: 1, start: '080000', end: '080030', triggers: ['motion'] }, // missing
      { daysAgo: 0, start: '080000', end: '080030', triggers: ['motion'] }, // missing
    ];
    const w = await world({
      seed,
      tweak: (c) => {
        c.storage.keepHours = { stills: 0, clips: 0, previews: 0 };
      },
    });
    // ftp.maxGB: room for three recordings.
    w.config.ftp.maxGB = (3 * w.size + 100) / 2 ** 30;
    const older = w.local(T('2026-09-30T06:00:00'), w.size);
    const newer = w.local(T('2026-09-30T07:00:00'), w.size);
    const check = await w.check();
    expect(missingStarts(check)).toEqual([T('2026-10-02T08:00:00'), T('2026-10-01T08:00:00'), T('2026-09-30T05:00:00')]);
    const repair = await w.repair(check);
    // 10-02 fits (three of three); 10-01 makes room by pruning the 06:00 clip
    // (older); 05:00 would only push out newer clips: the run stops there.
    expect(repair).toMatchObject({ outcome: 'ok', stopped: 'retention-full', counts: { candidates: 3, done: 2, failed: 0, skipped: 0 } });
    expect(tried(repair)).toEqual([[T('2026-10-02T08:00:00'), 'ok'], [T('2026-10-01T08:00:00'), 'ok']]);
    expect(repair.message).toMatch(/stopped: storage is full: the next recording is older than the clips storage keeps$/);
    // The normal storage run made the room: the older FTP clip went, nothing newer.
    expect(clipById(w.catalog, older)).toBeUndefined();
    expect(clipById(w.catalog, newer)).toBeDefined();
    expect(fromCamera(w)).toEqual([T('2026-10-01T08:00:00'), T('2026-10-02T08:00:00')]);
    for (const c of listClips(w.catalog, 'cam1', 0, NOW + DAY)) expect(existsSync(c.path)).toBe(true);
    expect(w.storage.usage().clips.bytes).toBeLessThanOrEqual(w.config.ftp.maxGB! * 2 ** 30);
    // Another run changes nothing: the one left is still older than all that is kept.
    const again = await w.repair(await w.check());
    expect(again).toMatchObject({ stopped: 'retention-full', counts: { done: 0 } });
    expect(clipById(w.catalog, newer)).toBeDefined();
  }, 60_000);
});

describe('events check → repair after a clips repair against cam-sim', () => {
  it('adds the events the outage lost, and then finds none missing', async () => {
    const seed: SeedClip[] = [
      { daysAgo: 1, start: '080000', end: '080030', triggers: ['person'] },
      { daysAgo: 0, start: '090000', end: '090030', triggers: ['vehicle'] },
    ];
    const w = await world({ seed });
    const clips = await w.repair(await w.check());
    expect(clips.counts).toMatchObject({ done: 2 });
    const check = await w.events();
    expect(check.counts).toMatchObject({ missingEvents: 2, missingPerson: 1, missingVehicle: 1 });
    const repair = await w.repairEvents(check);
    expect(repair).toMatchObject({ outcome: 'ok', stopped: null, counts: { done: 2 } });
    expect(listEvents(w.catalog, { cam: 'cam1' }).map((e) => [e.kind, e.source])).toEqual(expect.arrayContaining([['person', 'recovered'], ['vehicle', 'recovered']]));
    expect((await w.events()).counts.missingEvents).toBe(0);
  }, 60_000);
});
