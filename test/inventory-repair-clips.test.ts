import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { promisify } from 'util';
import type { Writable } from 'stream';
import { createCamSim, type SeedClip } from 'cam-sim';
import { BaichuanError } from '../src/camera/baichuan/errors';
import { ReolinkClient } from '../src/camera/client';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { insertClip, listClips } from '../src/catalog/clips';
import { ClipExistsError, ClipIndexer, NotAVideoError } from '../src/clips/indexer';
import { DEFAULTS } from '../src/config/defaults';
import { RecordingCache } from '../src/recordings/cache';
import { abortError, RecordingFetcher } from '../src/recordings/fetcher';
import { RecordingList, SearchError, type RecordingEntry } from '../src/recordings/list';
import { createRecordingsSide } from '../src/recordings/side';
import { StreamLog } from '../src/stream/log';
import { clipsCheck, mb, type ClipItem } from '../src/inventory/clips';
import { clipsRepair, REPAIR_GAP_MS, REPAIR_MAX_BYTES, REPAIR_MAX_CLIPS, REPAIR_MAX_FAILURES, type ClipsRepairDeps, type ClipsRepairSettings } from '../src/inventory/repair-clips';
import type { InventoryReport, RepairContext } from '../src/inventory/runner';

const run = promisify(execFile);
const NOW = Date.UTC(2026, 9, 2, 12, 0);
const pad = (n: number) => String(n).padStart(2, '0');
let video: Buffer;
beforeAll(async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'camproxy-repairsrc-')), 'rec.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  video = readFileSync(file);
}, 30_000);

// The SD recording i of 2026-10-01 (10:<i>:00 UTC), as the list and the report know it.
const recording = (i: number, o: Partial<RecordingEntry> = {}): RecordingEntry => {
  const size = o.size ?? video.length;
  const id = `RecS0A_20261001_10${pad(i)}00_10${pad(i)}30_0_55148000000000_${size.toString(16).toUpperCase()}.mp4`;
  const start = Date.UTC(2026, 9, 1, 10, i);
  return { id, path: `/mnt/sda/Mp4Record/2026-10-01/${id}`, start, end: start + 30_000, stream: 'sub', size, kinds: ['motion'], ...o };
};
const missing = (e: RecordingEntry): ClipItem => ({ type: 'missing-locally', id: e.id, date: '2026-10-01', start: e.start, end: e.end, size: e.size, stream: e.stream, kinds: e.kinds });
const report = (items: ClipItem[], o: Partial<InventoryReport> = {}): InventoryReport => ({
  runId: 'clips-1-abcdef', kind: 'clips', op: 'check', camera: 'cam1', startedAt: NOW - 60_000, tookMs: 10, outcome: 'ok', requestedBy: 'token',
  options: { camera: true }, window: { from: NOW - 7 * 86_400_000, to: NOW, reason: 'retention' }, counts: {}, top: [], items, itemsTruncated: false, message: '', ...o,
});

// A real fetcher, cache and indexer; the camera is a fake list and download.
// A gated download waits for its gate, or ends as an abort when the tee goes.
function setup(o: { settings?: Partial<ClipsRepairSettings>; fail?: (path: string) => Error | undefined; gated?: string[]; listed?: boolean; paused?: boolean; clipsBytes?: number; limits?: ClipsRepairDeps['limits']; cap?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-repair-'));
  const catalog = openCatalog(join(dir, 'catalog.sqlite'));
  const cache = new RecordingCache({ dir: () => join(dir, 'recordings', 'cam1'), capBytes: () => o.cap ?? 50 * 2 ** 20 });
  cache.init();
  const calls: string[] = [];
  const gates = new Map<string, () => void>();
  const fetcher = new RecordingFetcher({
    cache,
    download: async (path: string, _size: number, out: Writable) => {
      calls.push(path);
      if (o.gated?.includes(path)) {
        await new Promise<void>((resolve, reject) => {
          gates.set(path, resolve);
          out.once('close', () => reject(abortError()));
        });
      }
      const f = o.fail?.(path);
      if (f) throw f;
      out.write(video);
      return video.length;
    },
    stillListed: async () => o.listed ?? true,
    paused: () => false,
    noteWritten: () => undefined,
    onDone: () => undefined,
  });
  const known = new Map<string, RecordingEntry>();
  const sleeps: number[] = [];
  const config = structuredClone(DEFAULTS);
  config.server.dataDir = dir;
  const indexer = new ClipIndexer({ catalog, log: new StreamLog(catalog), config: () => config, timeInfo: async () => ({ stdOffsetMinutes: 0, dstOffsetMinutes: 0 }), dataDir: dir, cam: 'cam1' });
  const tempDir = join(dir, 'inventory', 'tmp');
  const deps: ClipsRepairDeps = {
    catalog,
    settings: () => ({ cam: 'cam1', stream: 'sub', clipsDays: 7, ...o.settings }),
    list: { find: async (id) => known.get(id) },
    fetcher,
    cache,
    indexer: () => indexer,
    tempDir: () => tempDir,
    paused: () => o.paused ?? false,
    clipsBytes: () => o.clipsBytes ?? 0,
    sleep: async (ms) => void sleeps.push(ms),
    limits: o.limits,
  };
  const onCamera = (...es: RecordingEntry[]) => es.forEach((e) => known.set(e.id, e));
  return { dir, catalog, cache, fetcher, deps, calls, gates, sleeps, onCamera, tempDir };
}
const ctx = (source: InventoryReport, o: Partial<RepairContext> = {}): RepairContext => ({ signal: new AbortController().signal, progress: () => undefined, now: NOW, source, ...o });
const until = async (ok: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!ok()) {
    if (Date.now() - t > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('clips repair', () => {
  it('fetches the missing recordings at low priority after a viewer\'s fetch, 1 s apart, and indexes them from the camera', async () => {
    expect([REPAIR_MAX_CLIPS, REPAIR_MAX_BYTES, REPAIR_GAP_MS, REPAIR_MAX_FAILURES]).toEqual([50, 200 * 2 ** 20, 1000, 3]);
    const s = setup({ gated: [recording(9).path] });
    const [a, b, viewer] = [recording(1), recording(2), recording(9)];
    s.onCamera(a, b, viewer);
    // A viewer's download is running: the repair waits for it.
    const v = s.fetcher.get(viewer, { priority: 'high' });
    const progress: string[] = [];
    const done = clipsRepair(s.deps).run(ctx(report([missing(a), missing(b)]), { progress: (p) => progress.push(`${p.done}/${p.total}`) }));
    await new Promise((r) => setTimeout(r, 50));
    expect(s.calls).toEqual([viewer.path]);
    s.gates.get(viewer.path)!();
    await v.fetch.done;
    const r = await done;
    expect(s.calls).toEqual([viewer.path, a.path, b.path]);
    expect(s.sleeps).toEqual([1000]);
    expect(r.stopped).toBeNull();
    expect(r.counts).toEqual({ candidates: 2, requested: 2, done: 2, failed: 0, skipped: 0, bytes: 2 * video.length });
    expect(r.message).toBe(`2 of 2 fetched (${mb(2 * video.length)}), 0 failed, 0 skipped`);
    expect(progress).toEqual(['0/2', '1/2', '2/2']);
    const rows = listClips(s.catalog, 'cam1', a.start, b.end);
    expect(rows.map((x) => [x.start_ts, x.origin, x.stream])).toEqual([[a.start, 'camera', 'sub'], [b.start, 'camera', 'sub']]);
    expect(r.items).toEqual([
      { id: a.id, start: a.start, result: 'ok', clipId: rows[0].id, bytes: video.length },
      { id: b.id, start: b.start, result: 'ok', clipId: rows[1].id, bytes: video.length },
    ]);
    expect(readFileSync(rows[0].path).equals(video)).toBe(true);
    // The cached copy stays for viewers, unpinned once copied.
    expect(s.cache.has(a.id)).toBe(true);
    expect(s.cache.busy(s.cache.path(a.id))).toBe(false);
    expect(s.cache.busy(s.cache.path(b.id))).toBe(false);
  });

  it('takes the oldest first (the SD card overwrites them first); skipped ones count toward the clip cap', async () => {
    const s = setup({ limits: { clips: 2 } });
    const [a, b, c] = [recording(1), recording(2), recording(3)];
    s.onCamera(a, b, c);
    // The compare lists newest first for display; the oldest (a) is outside the retention.
    const r = await clipsRepair(s.deps).run(ctx(report([c, b, { ...a, start: NOW - 8 * 86_400_000 }].map(missing))));
    expect(r.items.map((x) => (x as { id: string }).id)).toEqual([a.id, b.id]);
    expect(r.counts).toMatchObject({ candidates: 3, requested: 2, done: 1, skipped: 1 });
    expect(s.calls).toEqual([b.path]);
    expect(r.stopped).toBe('clip-cap');
  });

  it('checks each one again: outside the retention, another stream, already local, gone from the card', async () => {
    const s = setup({ listed: false, fail: (p) => (p.includes('_1005') ? new BaichuanError('refused', 'refused', 400) : undefined) });
    const old = recording(1, { start: NOW - 8 * 86_400_000 });
    const main = recording(2, { stream: 'main' });
    const local = recording(3);
    const unlisted = recording(4);
    const vanished = recording(5); // listed, then the camera answers 400 and no longer lists it
    s.onCamera(old, main, local, vanished);
    insertClip(s.catalog, { cam: 'cam1', start_ts: local.start + 4000, end_ts: local.end, path: '/x.mp4', stream: 'sub', size: 1, received_at: NOW, snapshot: null, origin: 'camera' });
    const r = await clipsRepair(s.deps).run(ctx(report([old, main, local, unlisted, vanished].map(missing))));
    expect(r.items.map((x) => (x as { reason?: string }).reason)).toEqual(['outside-retention', 'other-stream', 'already-local', 'gone-from-camera', 'gone-from-camera']);
    expect(r.counts).toMatchObject({ done: 0, failed: 0, skipped: 5 });
    expect(r.stopped).toBeNull();
  });

  it('the indexer\'s typed errors: a clip that exists is skipped (not a failure), not a video fails', async () => {
    const s = setup();
    const es = [1, 2, 3, 4, 5, 6].map((i) => recording(i));
    s.onCamera(...es);
    const errors = [new NotAVideoError(), new NotAVideoError(), new ClipExistsError('file'), new ClipExistsError('row'), new NotAVideoError(), undefined];
    let n = 0;
    s.deps.indexer = () => ({
      addRecording: async () => {
        const e = errors[n++];
        if (e) throw e;
        return { id: 77, size: video.length } as never;
      },
    });
    const r = await clipsRepair(s.deps).run(ctx(report(es.map(missing))));
    // Two failures, two skips (no reset, no count), a third failure: not yet 3 in a row? It is: skips don't break the row.
    expect(r.items.map((x) => (x as { result: string; reason?: string }).reason ?? (x as { result: string }).result)).toEqual(['failed', 'failed', 'already-local', 'already-local', 'failed']);
    expect(r.stopped).toBe('failures');
    expect(r.counts).toMatchObject({ done: 0, failed: 3, skipped: 2 });
    expect(r.top).toEqual([0, 1, 4].map((i) => ({ id: es[i].id, start: es[i].start, error: 'the recording is not a video' })));
    // Unpinned after each attempt.
    for (const e of es.slice(0, 5)) expect(s.cache.busy(s.cache.path(e.id))).toBe(false);
  });

  it('stops at once when the camera refuses a download', async () => {
    const s = setup({ fail: () => new BaichuanError('refused', 'the camera refused the download', 400) });
    const [a, b] = [recording(1), recording(2)];
    s.onCamera(a, b);
    const r = await clipsRepair(s.deps).run(ctx(report([a, b].map(missing))));
    expect(r.stopped).toBe('refused');
    expect(s.calls).toEqual([a.path]);
    expect(r.counts).toMatchObject({ done: 0, failed: 1 });
    expect(r.top).toEqual([{ id: a.id, start: a.start, error: 'the camera refused the download' }]);
    expect(r.message).toBe('0 of 2 fetched (0.0 MB), 1 failed, 0 skipped; stopped: the camera refused a download');
  });

  it('stops after 3 failures in a row; a success resets the count', async () => {
    const bad = new Set([1, 3, 4, 5].map((i) => recording(i).path));
    const s = setup({ fail: (p) => (bad.has(p) ? new BaichuanError('protocol', 'the download failed') : undefined) });
    const es = [1, 2, 3, 4, 5, 6].map((i) => recording(i));
    s.onCamera(...es);
    const r = await clipsRepair(s.deps).run(ctx(report(es.map(missing))));
    expect(r.stopped).toBe('failures');
    expect(r.counts).toMatchObject({ done: 1, failed: 4 });
    expect(s.calls).toHaveLength(5); // the sixth is never tried
  });

  it('stops on an offline camera: the list, or the download', async () => {
    const s = setup();
    s.deps.list = { find: async () => { throw new SearchError('camera_offline', 'the camera does not answer'); } };
    const r = await clipsRepair(s.deps).run(ctx(report([recording(1), recording(2)].map(missing))));
    expect(r.stopped).toBe('camera_offline');
    expect(r.counts).toMatchObject({ failed: 1, done: 0 });
    const t = setup({ fail: () => new BaichuanError('offline', 'connect ECONNREFUSED') });
    t.onCamera(recording(1), recording(2));
    const q = await clipsRepair(t.deps).run(ctx(report([recording(1), recording(2)].map(missing))));
    expect([q.stopped, q.counts.failed, t.calls.length]).toEqual(['camera_offline', 1, 1]);
  });

  it('keeps to the caps: clips per run, bytes per run, ftp.maxGB, and a paused disk', async () => {
    const es = [1, 2, 3].map((i) => recording(i));
    const clipCap = setup({ limits: { clips: 2 } });
    clipCap.onCamera(...es);
    const a = await clipsRepair(clipCap.deps).run(ctx(report(es.map(missing))));
    expect([a.stopped, a.counts.requested, a.counts.done, a.counts.candidates]).toEqual(['clip-cap', 2, 2, 3]);
    const byteCap = setup({ limits: { bytes: Math.floor(video.length * 1.5) } });
    byteCap.onCamera(...es);
    const b = await clipsRepair(byteCap.deps).run(ctx(report(es.map(missing))));
    expect([b.stopped, b.counts.done]).toEqual(['byte-cap', 1]);
    const full = setup({ settings: { maxGB: 1 }, clipsBytes: 2 ** 30 - 10 });
    full.onCamera(...es);
    const c = await clipsRepair(full.deps).run(ctx(report(es.map(missing))));
    expect([c.stopped, c.counts.done, full.calls.length]).toEqual(['max-gb', 0, 0]);
    const paused = setup({ paused: true });
    paused.onCamera(...es);
    const d = await clipsRepair(paused.deps).run(ctx(report(es.map(missing))));
    expect([d.stopped, d.counts.done, paused.calls.length]).toEqual(['paused', 0, 0]);
  });

  it('uses a recording a viewer already cached without fetching it again', async () => {
    const s = setup();
    const a = recording(1);
    s.onCamera(a);
    await s.fetcher.get(a, { priority: 'high' }).fetch.done;
    const r = await clipsRepair(s.deps).run(ctx(report([missing(a)])));
    expect(r.counts.done).toBe(1);
    expect(s.calls).toEqual([a.path]); // the viewer's download only
  });

  it('a recording the cache can\'t keep is streamed to a temp file, indexed, and the temp file removed', async () => {
    const s = setup({ cap: Math.floor(video.length / 2) });
    const a = recording(1);
    s.onCamera(a);
    mkdirSync(s.tempDir, { recursive: true });
    writeFileSync(join(s.tempDir, 'leftover.part'), 'x'); // a crash's leftover goes
    const r = await clipsRepair(s.deps).run(ctx(report([missing(a)])));
    expect(r.counts).toMatchObject({ done: 1, failed: 0 });
    expect(r.items).toEqual([expect.objectContaining({ result: 'ok', streamed: true, bytes: video.length })]);
    const [row] = listClips(s.catalog, 'cam1', a.start, a.end);
    expect(readFileSync(row.path).equals(video)).toBe(true);
    expect(s.cache.has(a.id)).toBe(false);
    expect(readdirSync(s.tempDir)).toEqual([]);
  });

  it('stops between clips when cancelled', async () => {
    const s = setup();
    const es = [1, 2, 3].map((i) => recording(i));
    s.onCamera(...es);
    const ac = new AbortController();
    const r = await clipsRepair(s.deps).run(ctx(report(es.map(missing)), { signal: ac.signal, progress: (p) => p.done === 1 && ac.abort() }));
    expect(r.counts.done).toBe(1);
    expect(r.items).toHaveLength(1);
    expect(r.stopped).toBeNull();
  });

  it('a cancel aborts its own running download; one a viewer joined runs on for the viewer', async () => {
    const [a, b] = [recording(1), recording(2)];
    const s = setup({ gated: [a.path, b.path] });
    s.onCamera(a, b);
    const ac = new AbortController();
    const done = clipsRepair(s.deps).run(ctx(report([missing(a)]), { signal: ac.signal }));
    await until(() => s.calls.length === 1);
    ac.abort();
    const r = await done;
    expect([r.counts.done, r.counts.failed, r.items.length]).toEqual([0, 0, 0]);
    await until(() => s.fetcher.queued().length === 0);
    expect(readdirSync(join(s.dir, 'recordings', 'cam1'))).toEqual([]); // no .part left
    // Joined by a viewer: the cancel leaves the download to the viewer.
    const ac2 = new AbortController();
    const done2 = clipsRepair(s.deps).run(ctx(report([missing(b)]), { signal: ac2.signal }));
    await until(() => s.calls.length === 2);
    const v = s.fetcher.get(b, { priority: 'high' });
    ac2.abort();
    expect((await done2).items).toEqual([]);
    s.gates.get(b.path)!();
    await v.fetch.done;
    expect(s.cache.has(b.id)).toBe(true);
  });

  it('is ready only for a camera compare with something missing locally', () => {
    const { ready } = clipsRepair(setup().deps);
    expect(ready(report([missing(recording(1))]))).toBeNull();
    expect(ready(report([missing(recording(1))], { options: undefined }))).toBe('compare the clips with the camera first');
    expect(ready(report([{ type: 'gone-from-camera', clipId: 1, start: 0 }]))).toBe('nothing is missing locally');
  });
});

// The real cam-sim: the clips check finds two recordings missing locally; the
// repair fetches them over Baichuan (real list, fetcher, cache, indexer).
describe('clips repair against cam-sim', () => {
  let catalog: Catalog | undefined;
  it('repairs two missing clips: byte for byte the camera\'s recordings, origin camera', async () => {
    const seed: SeedClip[] = [
      { daysAgo: 1, start: '080000', end: '080030', triggers: ['motion'] },
      { daysAgo: 1, start: '090000', end: '090030', triggers: ['person'] },
    ];
    const sim = await createCamSim({ users: [{ name: 'proxy', level: 'admin', password: 'proxy-pw' }], seedClips: seed, tz: 'UTC', clock: { now: () => new Date(NOW) } });
    const ports = await sim.listen({ http: 0, https: 0, control: 0, rtsp: 0, onvif: 0, baichuan: 0 }, '127.0.0.1');
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-repairsim-'));
    const client = new ReolinkClient({ id: 'cam1', host: `127.0.0.1:${ports.http}`, protocol: 'http', user: 'proxy', password: 'proxy-pw' });
    const side = createRecordingsSide({
      dataDir: dir,
      cam: () => 'cam1',
      target: () => ({ host: '127.0.0.1', port: ports.baichuan!, user: 'proxy', password: 'proxy-pw' }),
      capBytes: () => 512 * 2 ** 20,
      search: (param) => client.command('Search', param),
      timeInfo: () => client.timeInfo(),
      paused: () => false,
      noteWritten: () => undefined,
    });
    try {
      catalog = openCatalog(join(dir, 'catalog.sqlite'));
      const list: RecordingList = side.list;
      const settings = { cam: 'cam1', clipsDays: 2, stream: 'sub' as const };
      const check = await clipsCheck({ dataDir: dir, catalog, settings: () => ({ ...settings, ftpEnabled: true, eventMaxOpenMin: 10 }), camera: { list, timeInfo: () => client.timeInfo() } })({ signal: new AbortController().signal, progress: () => undefined, now: NOW, options: { camera: true } });
      expect(check.counts).toMatchObject({ missingLocally: 2 });
      const source = report(check.items as ClipItem[], { window: check.window });
      const config = structuredClone(DEFAULTS);
      config.server.dataDir = dir;
      const indexer = new ClipIndexer({ catalog, log: new StreamLog(catalog), config: () => config, timeInfo: () => client.timeInfo(), dataDir: dir, cam: 'cam1' });
      const r = await clipsRepair({
        catalog, settings: () => settings, list, fetcher: side.fetcher, cache: side.cache, indexer: () => indexer, tempDir: () => join(dir, 'inventory', 'tmp'),
        paused: () => false, clipsBytes: () => 0, sleep: async () => undefined,
      }).run(ctx(source));
      expect(r.stopped).toBeNull();
      expect(r.counts).toMatchObject({ candidates: 2, requested: 2, done: 2, failed: 0, skipped: 0 });
      const rows = listClips(catalog, 'cam1', Date.UTC(2026, 9, 1), NOW);
      expect(rows.map((x) => [x.start_ts, x.origin, x.stream])).toEqual([
        [Date.UTC(2026, 9, 1, 8), 'camera', 'sub'],
        [Date.UTC(2026, 9, 1, 9), 'camera', 'sub'],
      ]);
      for (const row of rows) {
        const rec = sim.engine.sd.all().find((x) => Date.parse(`${x.date}T${x.start.replace(/(\d\d)(\d\d)(\d\d)/, '$1:$2:$3')}Z`) === row.start_ts)!;
        const media = sim.engine.mediaFor(rec);
        expect(media.clipSize('sub')).toBe(rec.files.sub.size);
        expect(readFileSync(row.path).equals(readFileSync(media.clipPath('sub')))).toBe(true);
        expect(side.cache.has(basename(rec.files.sub.name))).toBe(true);
      }
      expect(r.counts.bytes).toBe(rows.reduce((n, x) => n + x.size, 0));
    } finally {
      await side.stop();
      catalog?.close();
      await sim.close();
    }
  }, 30_000);
});
