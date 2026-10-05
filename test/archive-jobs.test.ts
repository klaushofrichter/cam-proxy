// Archive jobs (spec 2026-10-05-archive-design §2.2): copy with CRC, the
// space check, cancel, the in-flight cap, and the SD recording source with
// a real fetcher and cache over a fake download.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Writable } from 'stream';
import { crc32 } from 'zlib';
import { openCatalog } from '../src/catalog/db';
import { archiveById } from '../src/catalog/archive';
import { ArchiveStore } from '../src/archive/store';
import { ArchiveJobs, createStatus, MAX_JOBS, type ArchiveRequest, type JobDeps, type JobView } from '../src/archive/jobs';
import { ArchiveJobError, fileSource, recordingSource, type Obtain } from '../src/archive/sources';
import { RecordingCache } from '../src/recordings/cache';
import { RecordingFetcher } from '../src/recordings/fetcher';
import { BaichuanError } from '../src/camera/baichuan/errors';
import type { RecordingEntry } from '../src/recordings/list';
import type { Taken } from '../src/archive/metadata';

const T = 1_759_689_000_000;
const taken: Taken = { snapshot: { camera: { id: 'cam1', name: 'Den', model: null }, window: { from: T, to: T + 30_000 }, events: [], stillChecks: [], eventKinds: ['person'], found: [], proxy: { version: 't' }, archivedAt: T }, images: { analyses: new Map(), checks: new Map() } };

function setup(over: Partial<JobDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-aj-'));
  const catalog = openCatalog(join(dir, 'catalog.sqlite'));
  const store = new ArchiveStore({ dataDir: dir, catalog });
  const done: JobView[] = [];
  const failed: JobView[] = [];
  const jobs = new ArchiveJobs({
    store,
    now: () => T + 100_000,
    checkSpace: () => undefined,
    snapshot: () => taken,
    thumbDeps: () => ({ stillNear: async () => undefined, readImage: async () => undefined, frame: async () => Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]) }),
    duration: async () => 29.94,
    defaultName: (from) => `name-${from}`,
    onDone: (_row, _req, job) => done.push(job),
    onFailed: (_req, job) => failed.push(job),
    ...over,
  });
  return { dir, catalog, store, jobs, done, failed };
}
const request = (obtain: Obtain, over: Partial<ArchiveRequest> = {}): ArchiveRequest => ({
  cam: 'cam1', source: { type: 'clip', clipId: 3, stream: 'sub' }, kind: 'clip', window: { from: T, to: T + 30_000 }, quality: 'sd', original: true, size: 0, durationS: 30,
  obtain, labels: ['Pet'], retentionDays: 365, createdBy: 'client', ...over,
});
const fileOf = (dir: string, data: Buffer) => {
  const p = join(dir, 'src.mp4');
  writeFileSync(p, data);
  return p;
};

describe('ArchiveJobs', () => {
  it('copies the file with its CRC, the thumbnail and the row; the view says done', async () => {
    const { dir, catalog, jobs, done } = setup();
    const data = Buffer.alloc(300_000, 3);
    const job = jobs.start(request(fileSource(fileOf(dir, data)), { size: data.length })) as JobView;
    expect(job).toMatchObject({ state: 'running', phase: 'copying', progress: 0, size: data.length });
    const v = await jobs.wait(job.id, 5000);
    expect(v).toMatchObject({ state: 'done', phase: null, progress: 1, bytes: data.length, archiveId: 1 });
    expect(v!.item).toMatchObject({ id: 1, name: `name-${T}`, labels: ['Pet'], durationS: 29.9, bytes: data.length, original: true, thumbnail: { from: 'frame', at: null }, eventKinds: ['person'] });
    const row = archiveById(catalog, 1)!;
    expect(JSON.parse(row.files)).toEqual({ clip: { bytes: data.length, crc32: crc32(data) }, thumb: { bytes: 5, crc32: crc32(Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9])) } });
    expect(readFileSync(join(dir, 'archive/cam1/1/clip.mp4')).equals(data)).toBe(true);
    expect(readFileSync(join(dir, 'archive/cam1/1/thumb.jpg'))).toHaveLength(5);
    expect(JSON.parse(readFileSync(join(dir, 'archive/cam1/1/meta.json'), 'utf8'))).toMatchObject({ schema: 1, item: { id: 1, name: `name-${T}` } });
    expect(done.map((x) => x.id)).toEqual([job.id]);
    expect(readdirSync(join(dir, 'archive/.incoming'))).toEqual([]);
  });

  it('the given name, no thumbnail at all, the window length when ffprobe cannot tell', async () => {
    const { dir, jobs } = setup({ duration: async () => null, thumbDeps: () => ({ stillNear: async () => undefined, readImage: async () => undefined, frame: async () => undefined }) });
    const data = Buffer.from('abc');
    const job = jobs.start(request(fileSource(fileOf(dir, data)), { size: 3, name: 'Fox' })) as JobView;
    const v = await jobs.wait(job.id, 5000);
    expect(v!.item).toMatchObject({ name: 'Fox', durationS: 30, thumbnail: { from: 'none', at: null } });
    expect(existsSync(join(dir, 'archive/cam1/1/thumb.jpg'))).toBe(false);
  });

  it('insufficient space fails the job; nothing stays', async () => {
    const { dir, jobs, failed } = setup({ checkSpace: () => { throw new ArchiveJobError('insufficient_space', 'no room', { needed: 1, free: 0, minFreeBytes: 0 }); } });
    const job = jobs.start(request(fileSource(fileOf(dir, Buffer.from('abc'))), { size: 3 })) as JobView;
    expect(await jobs.wait(job.id, 5000)).toMatchObject({ state: 'failed', error: 'insufficient_space' });
    expect(failed).toHaveLength(1);
    expect(existsSync(join(dir, 'archive/cam1'))).toBe(false);
  });

  it('a source file gone: source_gone', async () => {
    const { jobs } = setup();
    const job = jobs.start(request(fileSource('/nonexistent/x.mp4'), { size: 3 })) as JobView;
    expect(await jobs.wait(job.id, 5000)).toMatchObject({ state: 'failed', error: 'source_gone' });
  });

  it('cancel while obtaining; the in-flight cap; finished jobs are swept after 15 min', async () => {
    let now = T;
    const { jobs } = setup({ now: () => now });
    const hang: Obtain = ({ signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new ArchiveJobError('cancelled', 'cancelled'))));
    const views = Array.from({ length: MAX_JOBS }, () => jobs.start(request(hang, { size: 1, kind: 'recording' })) as JobView);
    expect(views[0].phase).toBe('fetching');
    expect(jobs.start(request(hang, { size: 1 }))).toBe('busy');
    expect(jobs.cancel(views[0].id)).toBe(true);
    expect(await jobs.wait(views[0].id, 5000)).toMatchObject({ state: 'cancelled', error: 'cancelled' });
    expect(jobs.start(request(hang, { size: 1 }))).not.toBe('busy');
    expect(jobs.cancel('nope')).toBe(false);
    now += 16 * 60_000;
    jobs.sweep();
    expect(jobs.get(views[0].id)).toBeUndefined();
    expect(jobs.get(views[1].id)).toMatchObject({ state: 'running' }); // running jobs stay
    await jobs.stop();
    expect(jobs.get(views[1].id)).toMatchObject({ state: 'cancelled' });
  });
});

describe('recordingSource', () => {
  const ID = 'RecS03_20261005_140320_140350_6D28808_A5C1F.mp4';
  const entry = (size: number): RecordingEntry => ({ id: ID, path: `Mp4Record/2026-10-05/${ID}`, start: T, end: T + 30_000, stream: 'sub', size, kinds: ['people'] as never[] });
  function side(capBytes: number, download: (out: Writable, size: number) => Promise<number>) {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-ar-'));
    const cache = new RecordingCache({ dir: () => join(dir, 'recordings'), capBytes: () => capBytes });
    cache.init();
    const fetcher = new RecordingFetcher({ cache, download: (_p, size, out) => download(out, size), stillListed: async () => true, paused: () => false, noteWritten: () => undefined, onDone: () => undefined });
    const jobDir = join(dir, 'job');
    mkdirSync(jobDir);
    return { cache, fetcher, jobDir };
  }
  const send = (data: Buffer) => async (out: Writable) => {
    for (let i = 0; i < data.length; i += 1000) if (!out.write(data.subarray(i, i + 1000))) await new Promise((r) => out.once('drain', r));
    return data.length;
  };

  it('a cached recording: the pinned cache file', async () => {
    const data = Buffer.alloc(5000, 9);
    const s = side(1e6, send(data));
    mkdirSync(join(s.jobDir, '..', 'recordings'), { recursive: true });
    writeFileSync(s.cache.path(ID), data);
    const got = await recordingSource({ entry: entry(data.length), cache: s.cache, fetcher: s.fetcher })({ dir: s.jobDir, signal: new AbortController().signal, progress: () => undefined });
    expect(got.path).toBe(s.cache.path(ID));
    expect(got.crc32).toBeUndefined(); // copied (and counted) by the job
    got.release();
  });

  it('not cached: fetched; the job file takes the stream with its CRC and progress', async () => {
    const data = Buffer.alloc(20_000, 5);
    const s = side(1e6, send(data));
    const seen: number[] = [];
    const got = await recordingSource({ entry: entry(data.length), cache: s.cache, fetcher: s.fetcher })({ dir: s.jobDir, signal: new AbortController().signal, progress: (b) => seen.push(b) });
    expect(got.path).toBe(join(s.jobDir, 'fetch.part'));
    expect(readFileSync(got.path).equals(data)).toBe(true);
    expect(got.crc32).toBe(crc32(data));
    expect(seen.at(-1)).toBe(data.length);
    got.release();
    expect(existsSync(join(s.jobDir, 'fetch.part'))).toBe(false);
  });

  it('too big for the cache: still streamed into the job file', async () => {
    const data = Buffer.alloc(20_000, 6);
    const s = side(100, send(data));
    const got = await recordingSource({ entry: entry(data.length), cache: s.cache, fetcher: s.fetcher })({ dir: s.jobDir, signal: new AbortController().signal, progress: () => undefined });
    expect(readFileSync(got.path).equals(data)).toBe(true);
    expect(s.cache.open(ID)).toBeNull(); // not kept
  });

  it('the camera says not found / offline: the job error codes', async () => {
    const nf = side(1e6, async () => { throw new BaichuanError('not_found', 'gone', 400); });
    await expect(recordingSource({ entry: entry(10), cache: nf.cache, fetcher: nf.fetcher })({ dir: nf.jobDir, signal: new AbortController().signal, progress: () => undefined })).rejects.toMatchObject({ code: 'unknown_recording' });
    const off = side(1e6, async () => { throw new BaichuanError('offline', 'down'); });
    await expect(recordingSource({ entry: entry(10), cache: off.cache, fetcher: off.fetcher })({ dir: off.jobDir, signal: new AbortController().signal, progress: () => undefined })).rejects.toMatchObject({ code: 'camera_offline' });
    expect(existsSync(join(off.jobDir, 'fetch.part'))).toBe(false);
  });

  it('a short download fails', async () => {
    const s = side(1e6, send(Buffer.alloc(100, 1)));
    await expect(recordingSource({ entry: entry(200), cache: s.cache, fetcher: s.fetcher })({ dir: s.jobDir, signal: new AbortController().signal, progress: () => undefined })).rejects.toBeInstanceOf(ArchiveJobError);
  });
});

describe('createStatus', () => {
  const v = (o: Partial<JobView>): JobView => ({ id: 'x', cam: 'cam1', state: 'failed', phase: null, progress: 0, bytes: 0, size: 1, ...o });
  it('201 done, 202 running, else the error status', () => {
    expect(createStatus(v({ state: 'done' }))).toBe(201);
    expect(createStatus(v({ state: 'running' }))).toBe(202);
    expect(createStatus(v({ error: 'insufficient_space' }))).toBe(507);
    expect(createStatus(v({ error: 'camera_offline' }))).toBe(503);
    expect(createStatus(v({ error: 'unknown_recording' }))).toBe(404);
    expect(createStatus(v({ error: 'source_gone' }))).toBe(404);
    expect(createStatus(v({ error: 'fetch_failed' }))).toBe(502);
    expect(createStatus(v({ error: 'store_failed' }))).toBe(500);
    expect(createStatus(v({ state: 'cancelled', error: 'cancelled' }))).toBe(409);
  });
});
