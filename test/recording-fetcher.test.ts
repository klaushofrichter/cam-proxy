// test/recording-fetcher.test.ts
import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough, Writable } from 'stream';
import { randomBytes } from 'crypto';
import { BaichuanError } from '../src/camera/baichuan/errors';
import { RecordingCache } from '../src/recordings/cache';
import { abortError, RecordingFetcher, type FetchOutcome } from '../src/recordings/fetcher';
import type { RecordingEntry } from '../src/recordings/list';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const entry = (n: number, size: number): RecordingEntry => {
  const id = `RecS0A_DST20261001_21110${n}_211207_0_5514C080000000_${size.toString(16).toUpperCase()}.mp4`;
  return { id, path: `/mnt/sda/Mp4Record/2026-10-01/${id}`, start: 0, end: 1, stream: 'sub', size, kinds: [] };
};

interface DlOptions { chunk?: number; delayMs?: number; fail?: BaichuanError; gated?: boolean }
function downloader(files: Map<string, Buffer>, o: DlOptions) {
  const calls: string[] = [];
  const gates = new Map<string, () => void>();
  let fullWrites = 0;
  const download = async (path: string, _size: number, out: Writable): Promise<number> => {
    calls.push(path);
    if (o.gated) await new Promise<void>((r) => gates.set(path, r));
    if (o.fail) throw o.fail;
    const state = { failed: false };
    out.on('error', () => (state.failed = true));
    const data = files.get(path)!;
    const step = o.chunk ?? 10_000;
    for (let off = 0; off < data.length; off += step) {
      if (o.delayMs) await sleep(o.delayMs);
      if (state.failed) throw abortError();
      if (!out.write(data.subarray(off, off + step))) {
        fullWrites++;
        await new Promise<void>((r) => {
          out.once('drain', r);
          out.once('error', () => r());
        });
      }
    }
    if (state.failed) throw abortError();
    return data.length;
  };
  return { download, calls, release: (path: string) => gates.get(path)?.(), fullWrites: () => fullWrites };
}

function setup(o: DlOptions & { cap?: number; paused?: boolean; listed?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-fetch-'));
  const cache = new RecordingCache({ dir: () => dir, capBytes: () => o.cap ?? 10_000_000 });
  cache.init();
  const files = new Map<string, Buffer>();
  const add = (n: number, size = 50_000) => {
    const e = entry(n, size);
    files.set(e.path, randomBytes(size));
    return e;
  };
  const dl = downloader(files, o);
  const outcomes: FetchOutcome[] = [];
  const written: number[] = [];
  const state = { paused: o.paused ?? false, listed: o.listed ?? true };
  const fetcher = new RecordingFetcher({ cache, download: dl.download, stillListed: async () => state.listed, paused: () => state.paused, noteWritten: (b) => written.push(b), onDone: (x) => outcomes.push(x) });
  return { dir, cache, files, add, dl, outcomes, written, fetcher };
}
function collector(highWaterMark = 1 << 20, delayMs = 0) {
  const parts: Buffer[] = [];
  const w = new Writable({
    highWaterMark,
    write(c: Buffer, _e, cb) {
      parts.push(c);
      if (delayMs) setTimeout(cb, delayMs);
      else cb();
    },
  });
  return { w, bytes: () => Buffer.concat(parts) };
}

describe('RecordingFetcher', () => {
  it('fetches into the cache and streams to the first client while it arrives', async () => {
    const x = setup({ delayMs: 2 });
    const e = x.add(1);
    const { fetch, created } = x.fetcher.get(e, { priority: 'high' });
    expect(created).toBe(true);
    const c = collector();
    let atStart = -1;
    fetch.attach(c.w, () => (atStart = c.bytes().length));
    await fetch.done;
    expect(atStart).toBe(0);
    expect(c.bytes()).toEqual(x.files.get(e.path));
    await vi.waitFor(() => expect(c.w.writableEnded).toBe(true));
    expect(readFileSync(x.cache.path(e.id))).toEqual(x.files.get(e.path));
    expect(x.written).toEqual([e.size]);
    expect(x.outcomes).toMatchObject([{ id: e.id, result: 'ok', stream: 'sub', bytes: e.size }]);
  });

  it('a second request for the same id joins the running fetch: one transfer', async () => {
    const x = setup({ delayMs: 2 });
    const e = x.add(1);
    const a = x.fetcher.get(e, { priority: 'high' });
    const b = x.fetcher.get(e, { priority: 'high' });
    expect(b.created).toBe(false);
    expect(b.fetch).toBe(a.fetch);
    await b.fetch.done;
    expect(x.dl.calls).toHaveLength(1);
  });

  it('one download at a time; high goes ahead of every queued low, also when it joins one', async () => {
    const x = setup({ gated: true });
    const [a, b, c, d] = [x.add(1), x.add(2), x.add(3), x.add(4)];
    const fa = x.fetcher.get(a, { priority: 'low' }).fetch;
    await vi.waitFor(() => expect(x.dl.calls).toEqual([a.path]));
    x.fetcher.get(b, { priority: 'low' });
    x.fetcher.get(c, { priority: 'high' });
    x.fetcher.get(d, { priority: 'low' });
    expect(x.fetcher.queued()).toEqual([c.id, b.id, d.id]);
    x.fetcher.get(d, { priority: 'high' });
    expect(x.fetcher.queued()).toEqual([c.id, d.id, b.id]);
    x.dl.release(a.path);
    await fa.done;
    for (const next of [c, d, b]) {
      await vi.waitFor(() => expect(x.dl.calls[x.dl.calls.length - 1]).toBe(next.path));
      x.dl.release(next.path);
    }
    expect(x.dl.calls).toEqual([a.path, c.path, d.path, b.path]);
  });

  it('a request whose client leaves while queued leaves the queue (unless another still waits)', async () => {
    const x = setup({ gated: true });
    const [a, b] = [x.add(1), x.add(2)];
    x.fetcher.get(a, { priority: 'high' });
    await vi.waitFor(() => expect(x.dl.calls).toEqual([a.path]));
    const one = new AbortController();
    const two = new AbortController();
    const fb = x.fetcher.get(b, { priority: 'high', signal: one.signal }).fetch;
    x.fetcher.get(b, { priority: 'high', signal: two.signal });
    one.abort();
    expect(x.fetcher.queued()).toEqual([b.id]);
    two.abort();
    expect(x.fetcher.queued()).toEqual([]);
    await expect(fb.done).rejects.toMatchObject({ name: 'AbortError' });
    x.dl.release(a.path);
    await sleep(20);
    expect(x.dl.calls).toEqual([a.path]);
  });

  it('a failure before the first chunk: no headers, no .part, the outcome and the error', async () => {
    const x = setup({ fail: new BaichuanError('timeout', 'no data after the download request') });
    const e = x.add(1);
    const { fetch } = x.fetcher.get(e, { priority: 'high' });
    let started = false;
    fetch.attach(collector().w, () => (started = true));
    await expect(fetch.done).rejects.toMatchObject({ code: 'timeout' });
    expect(started).toBe(false);
    expect(existsSync(x.cache.partPath(e.id))).toBe(false);
    expect(x.cache.has(e.id)).toBe(false);
    expect(x.outcomes).toMatchObject([{ id: e.id, result: 'timeout' }]);
  });

  it('a 400: not_found when the camera no longer lists the file, refused when it still does', async () => {
    for (const [listed, code] of [[false, 'not_found'], [true, 'refused']] as const) {
      const x = setup({ fail: new BaichuanError('refused', 'the download answered 400', 400), listed });
      const e = x.add(1);
      await expect(x.fetcher.get(e, { priority: 'high' }).fetch.done).rejects.toMatchObject({ code });
      expect(x.outcomes[0].result).toBe(code);
    }
  });

  // Review Focus 2.
  it('a waiter gets the whole file after the first client left mid-stream', async () => {
    const x = setup({ delayMs: 3 });
    const e = x.add(1, 100_000);
    const first = x.fetcher.get(e, { priority: 'high' }).fetch;
    const client = new PassThrough();
    let got = 0;
    client.on('data', (c: Buffer) => {
      got += c.length;
      if (got > 20_000) client.destroy();
    });
    first.attach(client, () => undefined);
    const second = x.fetcher.get(e, { priority: 'high' });
    expect(second.created).toBe(false);
    await second.fetch.done;
    expect(readFileSync(x.cache.path(e.id))).toEqual(x.files.get(e.path));
    expect(x.outcomes[0].result).toBe('ok');
  });

  it('disk paused: streamed to the client, nothing kept', async () => {
    const x = setup({ paused: true });
    const e = x.add(1);
    const { fetch } = x.fetcher.get(e, { priority: 'high' });
    const c = collector();
    fetch.attach(c.w, () => undefined);
    await fetch.done;
    expect(c.bytes()).toEqual(x.files.get(e.path));
    expect(x.cache.has(e.id)).toBe(false);
    expect(existsSync(x.cache.partPath(e.id))).toBe(false);
    expect(x.written).toEqual([]);
  });

  it('disk paused and the client leaves: the download is aborted, no outcome', async () => {
    const x = setup({ paused: true, delayMs: 3 });
    const e = x.add(1, 100_000);
    const { fetch } = x.fetcher.get(e, { priority: 'high' });
    const client = new PassThrough();
    let got = 0;
    client.on('data', (c: Buffer) => {
      got += c.length;
      if (got >= 20_000) client.destroy();
    });
    fetch.attach(client, () => undefined);
    await expect(fetch.done).rejects.toMatchObject({ name: 'AbortError' });
    expect(x.outcomes).toEqual([]);
  });

  it('a file bigger than the cap is streamed, not kept', async () => {
    const x = setup({ cap: 10_000 });
    const e = x.add(1);
    const { fetch } = x.fetcher.get(e, { priority: 'high' });
    const c = collector();
    fetch.attach(c.w, () => undefined);
    await fetch.done;
    expect(c.bytes()).toEqual(x.files.get(e.path));
    expect(x.cache.has(e.id)).toBe(false);
  });

  it('makes room in the cache before the fetch', async () => {
    const x = setup({ cap: 120_000 });
    const old = join(x.dir, 'old.mp4');
    writeFileSync(old, Buffer.alloc(100_000));
    utimesSync(old, new Date(0), new Date(0));
    const e = x.add(1);
    await x.fetcher.get(e, { priority: 'high' }).fetch.done;
    expect(existsSync(old)).toBe(false);
    expect(x.cache.has(e.id)).toBe(true);
  });

  it('a slow client slows the download (the tee waits for it)', async () => {
    const x = setup({ chunk: 16_384 });
    const e = x.add(1, 2_000_000);
    const { fetch } = x.fetcher.get(e, { priority: 'high' });
    const c = collector(16_384, 1);
    fetch.attach(c.w, () => undefined);
    await fetch.done;
    expect(x.dl.fullWrites()).toBeGreaterThan(0);
    expect(c.bytes()).toEqual(x.files.get(e.path));
  });

  it('stop fails queued fetches as offline', async () => {
    const x = setup({ gated: true });
    const [a, b] = [x.add(1), x.add(2)];
    x.fetcher.get(a, { priority: 'high' });
    await vi.waitFor(() => expect(x.dl.calls).toHaveLength(1));
    const fb = x.fetcher.get(b, { priority: 'high' }).fetch;
    x.fetcher.stop();
    await expect(fb.done).rejects.toMatchObject({ code: 'offline' });
    x.dl.release(a.path);
  });

  // Binding rules from earlier reviews (ledger "→ Task 10").
  it('never evicts for nothing: a file that cannot fit beside the pinned ones is streamed, the cache untouched', async () => {
    const x = setup({ cap: 120_000 });
    const pinned = join(x.dir, 'pinned.mp4');
    const other = join(x.dir, 'other.mp4');
    writeFileSync(pinned, Buffer.alloc(100_000));
    writeFileSync(other, Buffer.alloc(10_000));
    utimesSync(pinned, new Date(0), new Date(0));
    utimesSync(other, new Date(0), new Date(0));
    const unpin = x.cache.pin(pinned);
    const e = x.add(1);
    const { fetch } = x.fetcher.get(e, { priority: 'high' });
    const c = collector();
    fetch.attach(c.w, () => undefined);
    await fetch.done;
    unpin();
    expect(c.bytes()).toEqual(x.files.get(e.path));
    expect(existsSync(pinned)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(x.cache.has(e.id)).toBe(false);
    expect(fetch.kept).toBe(false);
    expect(x.written).toEqual([]);
    expect(x.outcomes[0].result).toBe('ok');
  });

  it('pins the .part while writing; nothing pinned afterwards', async () => {
    const x = setup({ gated: true, delayMs: 2 });
    const e = x.add(1);
    const { fetch } = x.fetcher.get(e, { priority: 'high' });
    await vi.waitFor(() => expect(x.dl.calls).toHaveLength(1));
    expect(x.cache.busy(x.cache.partPath(e.id))).toBe(true);
    x.dl.release(e.path);
    await fetch.done;
    expect(fetch.kept).toBe(true);
    expect(x.cache.busy(x.cache.partPath(e.id))).toBe(false);
    expect(x.cache.busy(x.cache.path(e.id))).toBe(false);
  });

  it('a failure leaves no .part and no entry: the next request starts a new fetch', async () => {
    const x = setup({ fail: new BaichuanError('timeout', 'stalled') });
    const e = x.add(1);
    const first = x.fetcher.get(e, { priority: 'high' }).fetch;
    await expect(first.done).rejects.toMatchObject({ code: 'timeout' });
    expect(existsSync(x.cache.partPath(e.id))).toBe(false);
    const again = x.fetcher.get(e, { priority: 'high' });
    expect(again.created).toBe(true);
    await expect(again.fetch.done).rejects.toMatchObject({ code: 'timeout' });
    expect(x.dl.calls).toHaveLength(2);
  });

  it('a failure mid-stream destroys the client response (never ends it as if complete)', async () => {
    const x = setup({ delayMs: 2 });
    const e = x.add(1, 100_000);
    x.files.set(e.path, x.files.get(e.path)!.subarray(0, 30_000)); // the camera stops short
    const short = async (path: string, size: number, out: Writable) => {
      await x.dl.download(path, size, out);
      throw new BaichuanError('timeout', 'the download stalled');
    };
    const fetcher = new RecordingFetcher({ cache: x.cache, download: short, stillListed: async () => true, paused: () => false, noteWritten: () => undefined, onDone: () => undefined });
    const { fetch } = fetcher.get(e, { priority: 'high' });
    const c = collector();
    let started = false;
    fetch.attach(c.w, () => (started = true));
    await expect(fetch.done).rejects.toMatchObject({ code: 'timeout' });
    expect(started).toBe(true);
    expect(c.w.destroyed).toBe(true);
    expect(c.w.writableEnded).toBe(false);
    expect(existsSync(x.cache.partPath(e.id))).toBe(false);
    expect(x.cache.has(e.id)).toBe(false);
  });

  it('a cache write error: the client still gets the whole file, nothing kept', async () => {
    const x = setup({ delayMs: 1 });
    const e = x.add(1);
    mkdirSync(x.cache.partPath(e.id)); // the .part can't be opened as a file
    const { fetch } = x.fetcher.get(e, { priority: 'high' });
    const c = collector();
    fetch.attach(c.w, () => undefined);
    await fetch.done;
    expect(c.bytes()).toEqual(x.files.get(e.path));
    await vi.waitFor(() => expect(c.w.writableEnded).toBe(true));
    expect(x.cache.has(e.id)).toBe(false);
    expect(fetch.kept).toBe(false);
    expect(x.written).toEqual([]);
  });

  it('a client attached after the download started still gets the rest through the tee', async () => {
    const x = setup({ gated: true, delayMs: 2 });
    const e = x.add(1);
    const { fetch } = x.fetcher.get(e, { priority: 'high' });
    await vi.waitFor(() => expect(x.dl.calls).toHaveLength(1));
    const c = collector();
    fetch.attach(c.w, () => undefined);
    x.dl.release(e.path);
    await fetch.done;
    expect(c.bytes()).toEqual(x.files.get(e.path));
  });

  it('an empty recording: onStart runs and the response is ended', async () => {
    const x = setup();
    const e = x.add(1, 0);
    const { fetch } = x.fetcher.get(e, { priority: 'high' });
    const c = collector();
    let started = false;
    fetch.attach(c.w, () => (started = true));
    await fetch.done;
    expect(started).toBe(true);
    await vi.waitFor(() => expect(c.w.writableEnded).toBe(true));
    expect(x.cache.has(e.id)).toBe(true);
  });

  it('refuses an id that is not an SD name before touching the cache', () => {
    const x = setup();
    const bad = { ...entry(1, 10), id: '../escape.mp4' };
    expect(() => x.fetcher.get(bad, { priority: 'high' })).toThrow(/invalid recording id/);
    expect(x.dl.calls).toEqual([]);
  });
});
