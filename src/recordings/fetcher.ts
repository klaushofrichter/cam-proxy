// src/recordings/fetcher.ts
// One download at a time per camera (spec "One download at a time per
// camera"): a second cmd 8 on the one connection would end the first, and a
// second connection would use more of the camera's 12 sessions. Two
// priorities: client requests are high; low is for background work (#74).
// The file goes into the cache (as .part, renamed when complete) and, through
// the tee, to the request that started it, while it arrives. One fetch per id
// (single flight): a second request for an id that is queued or running joins
// it and never opens a second writer on the same .part.
import { createWriteStream, mkdirSync, type WriteStream } from 'fs';
import { dirname } from 'path';
import { Writable } from 'stream';
import { finished } from 'stream/promises';
import { BaichuanError, type BaichuanErrorCode } from '../camera/baichuan/errors';
import type { RecordingCache } from './cache';
import type { RecordingEntry } from './list';
import { logger } from '../log';
import { validId, type Stream } from './names';

export type Priority = 'high' | 'low';
export type FetchResult = 'ok' | BaichuanErrorCode;
export interface FetchOutcome { id: string; at: number; result: FetchResult; stream: Stream; bytes: number; ms: number }
export interface FetcherDeps {
  cache: RecordingCache;
  // Never ends `out` (vod.ts); the fetcher does, through the tee.
  download: (path: string, size: number, out: Writable) => Promise<number>;
  stillListed: (e: RecordingEntry) => Promise<boolean>;
  paused: () => boolean; // the disk is below its floor: stream without keeping
  noteWritten: (bytes: number) => void; // called after the rename to the final name
  onDone: (o: FetchOutcome) => void;
  now?: () => number;
  // While caching: how long a client may stop reading before it is dropped
  // (the cache keeps filling). Well below the download's 20 s stall.
  clientStallMs?: number;
}

export const abortError = (why = 'aborted'): Error => Object.assign(new Error(why), { name: 'AbortError' });
export const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

const noop = () => undefined;

const drained = (w: Writable) =>
  new Promise<void>((resolve) => {
    const done = () => {
      w.off('drain', done);
      w.off('close', done);
      w.off('error', done);
      resolve();
    };
    w.on('drain', done);
    w.on('close', done);
    w.on('error', done);
  });

const closed = (w: WriteStream) =>
  new Promise<void>((resolve) => {
    if (w.closed) return resolve();
    w.once('close', () => resolve());
    if (!w.writableFinished) w.destroy();
  });

// Every chunk to the cache file and to the first client, waiting for both, so
// TCP slows the camera down. A client that leaves is dropped and the cache
// keeps filling; a cache file that fails is dropped and the client keeps
// receiving. With neither left (disk paused, or the file failed, and the
// client gone), the download is aborted. While caching, a client that stops
// reading for clientStallMs is dropped (destroyed) so the cache copy survives
// a paused <video>; without a cache file, the client paces the download.
class Tee extends Writable {
  private client: { res: Writable; onStart: () => void; started: boolean } | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();
  fileFailed = false;
  written = 0; // bytes passed on (to the file and/or the client)

  constructor(
    private file: WriteStream | null,
    private readonly clientStallMs: number,
  ) {
    super({ highWaterMark: 1024 * 1024 });
    file?.on('error', () => {
      this.fileFailed = true;
      this.file = null;
    });
  }

  // Refused once a byte has gone through: a late client would get a body
  // without its start, ended as if whole.
  attach(res: Writable, onStart: () => void): boolean {
    if (this.client || this.written > 0 || res.destroyed || res.writableEnded) return false;
    const c = { res, onStart, started: false };
    this.client = c;
    res.on('error', noop); // the response's own owner reports it; never an uncaught error here
    res.once('close', () => {
      if (this.client === c) this.client = null;
    });
    return true;
  }

  // The client's drain, raced against clientStallMs: on expiry the client is
  // destroyed and dropped; the file's own backpressure still paces the camera.
  private clientDrained(c: { res: Writable }): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(t);
        if (this.client === c) this.client = null;
        c.res.destroy();
        resolve();
      }, this.clientStallMs);
      this.timers.add(t);
      void drained(c.res).then(() => {
        clearTimeout(t);
        this.timers.delete(t);
        resolve();
      });
    });
  }

  private live() {
    const c = this.client;
    return c && !c.res.destroyed && !c.res.writableEnded ? c : null;
  }

  private start(c: { res: Writable; onStart: () => void; started: boolean }): void {
    if (c.started) return;
    c.started = true;
    c.onStart();
  }

  // A failure after the first byte: the response can't be completed, so it
  // is destroyed (never ended as if the file were whole). Before the first
  // byte the owner can still answer with an error status.
  abortClient(): void {
    const c = this.live();
    if (c?.started) c.res.destroy();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const c = this.live();
    const file = this.file;
    if (!file && !c) return cb(abortError('no reader left'));
    this.written += chunk.length;
    const waits: Promise<void>[] = [];
    if (file && !file.write(chunk)) waits.push(drained(file));
    if (c) {
      this.start(c);
      if (!c.res.write(chunk)) waits.push(file ? this.clientDrained(c) : drained(c.res));
    }
    if (!waits.length) return cb();
    void Promise.all(waits).then(() => cb());
  }

  override _final(cb: (err?: Error | null) => void): void {
    const c = this.live();
    if (c) {
      this.start(c); // an empty file: headers, then the end
      c.res.end();
    }
    const file = this.file;
    if (!file) return cb();
    let called = false;
    const done = (err?: Error | null) => {
      if (called) return;
      called = true;
      if (err) this.fileFailed = true; // the client has the whole file; only the cache lost it
      cb();
    };
    file.once('error', done);
    file.end(() => done());
  }

  override _destroy(err: Error | null, cb: (err?: Error | null) => void): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    cb(err);
  }
}

export class Fetch {
  readonly done: Promise<void>;
  state: 'queued' | 'running' | 'done' = 'queued';
  kept = false; // the file is in the cache (else it was only streamed)
  private live: { res: Writable; onStart: () => void } | null = null;
  private tee: Tee | null = null;
  private waiters = 0;
  private settle!: { resolve: () => void; reject: (e: unknown) => void };

  constructor(
    readonly entry: RecordingEntry,
    public priority: Priority,
    private readonly abandoned: (f: Fetch) => void,
  ) {
    this.done = new Promise<void>((resolve, reject) => (this.settle = { resolve, reject }));
    this.done.catch(noop); // waiters handle it; no unhandled rejection
  }

  join(signal?: AbortSignal): void {
    this.waiters++;
    const leave = () => {
      this.waiters--;
      if (this.waiters === 0 && this.state === 'queued') this.abandoned(this);
    };
    if (signal?.aborted) return leave();
    signal?.addEventListener('abort', leave, { once: true });
  }

  // The first client: it gets the file through the tee while it arrives.
  // False when refused (another client has it, a byte already went through,
  // or the fetch is over): wait for `done`, then serve from the cache (or
  // fetch again when `kept` is false).
  attach(res: Writable, onStart: () => void): boolean {
    if (this.live || this.state === 'done') return false;
    if (this.tee && !this.tee.attach(res, onStart)) return false;
    this.live = { res, onStart };
    return true;
  }

  begin(tee: Tee): void {
    this.state = 'running';
    this.tee = tee;
    if (this.live) tee.attach(this.live.res, this.live.onStart);
  }

  finish(err?: unknown): void {
    this.state = 'done';
    this.tee = null;
    if (err) this.settle.reject(err);
    else this.settle.resolve();
  }
}

export class RecordingFetcher {
  private readonly byId = new Map<string, Fetch>();
  private readonly queue: Fetch[] = [];
  private active: Fetch | null = null;
  private stopped = false;

  constructor(private readonly d: FetcherDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  get(entry: RecordingEntry, o: { priority: Priority; signal?: AbortSignal }): { fetch: Fetch; created: boolean } {
    if (!validId(entry.id)) throw new Error('invalid recording id');
    const known = this.byId.get(entry.id);
    if (known) {
      if (o.priority === 'high' && known.priority === 'low' && known.state === 'queued') {
        known.priority = 'high';
        this.sort();
      }
      known.join(o.signal);
      return { fetch: known, created: false };
    }
    const f = new Fetch(entry, o.priority, (x) => this.abandon(x));
    if (this.stopped) {
      f.finish(new BaichuanError('offline', 'the proxy is stopping'));
      return { fetch: f, created: true };
    }
    this.byId.set(entry.id, f);
    this.queue.push(f);
    this.sort();
    f.join(o.signal);
    // After the caller attached its response (same tick).
    queueMicrotask(() => this.pump());
    return { fetch: f, created: true };
  }

  queued(): string[] {
    return this.queue.map((f) => f.entry.id);
  }

  stop(): void {
    this.stopped = true;
    for (const f of this.queue.splice(0)) {
      this.byId.delete(f.entry.id);
      f.finish(new BaichuanError('offline', 'the proxy is stopping'));
    }
  }

  private sort(): void {
    const high = this.queue.filter((f) => f.priority === 'high');
    const low = this.queue.filter((f) => f.priority === 'low');
    this.queue.splice(0, this.queue.length, ...high, ...low);
  }

  private abandon(f: Fetch): void {
    const i = this.queue.indexOf(f);
    if (i < 0) return;
    this.queue.splice(i, 1);
    this.byId.delete(f.entry.id);
    f.finish(abortError('every request left while queued'));
  }

  private pump(): void {
    if (this.active || this.stopped) return;
    const f = this.queue.shift();
    if (!f) return;
    this.active = f;
    void this.run(f).finally(() => {
      this.active = null;
      this.pump();
    });
  }

  // A throwing listener must not turn a finished fetch into a second outcome.
  private report(o: FetchOutcome): void {
    try {
      this.d.onDone(o);
    } catch (err) {
      logger.warn({ err: (err as Error).message, id: o.id }, 'recording_ondone_failed');
    }
  }

  // Whether the file can go into the cache: not paused, not over the cap, and
  // room beside the pinned files. makeRoom can free less than asked (pinned
  // files), so the room is checked again after it: never evict for nothing.
  private roomFor(size: number): boolean {
    const { cache } = this.d;
    if (this.d.paused()) return false;
    const cap = cache.capBytes();
    if (size > cap) return false;
    const files = cache.files();
    const pinned = files.filter((x) => cache.busy(x.path)).reduce((n, x) => n + x.bytes, 0);
    if (pinned + size > cap) return false;
    const total = files.reduce((n, x) => n + x.bytes, 0);
    if (total + size > cap) cache.makeRoom(size);
    return cache.usage().bytes + size <= cap;
  }

  private async run(f: Fetch): Promise<void> {
    const { entry } = f;
    const { cache } = this.d;
    const t0 = this.now();
    let file: WriteStream | null = null;
    let unpin: () => void = noop;
    try {
      if (this.roomFor(entry.size)) {
        const part = cache.partPath(entry.id);
        mkdirSync(dirname(part), { recursive: true });
        unpin = cache.pin(part);
        file = createWriteStream(part);
      }
    } catch {
      file = null; // no cache for this one; the client still gets it
    }
    const tee = new Tee(file, this.d.clientStallMs ?? 5_000);
    tee.on('error', noop); // reaches the download through its own listener
    f.begin(tee);
    let bytes = 0;
    try {
      bytes = await this.d.download(entry.path, entry.size, tee);
      tee.end();
      await finished(tee);
      if (file) {
        await closed(file);
        if (tee.fileFailed) cache.discard(entry.id);
        else {
          try {
            cache.commit(entry.id);
            f.kept = true;
          } catch {
            cache.discard(entry.id);
          }
          if (f.kept) this.d.noteWritten(entry.size);
        }
      }
      this.byId.delete(entry.id);
      this.report({ id: entry.id, at: this.now(), result: 'ok', stream: entry.stream, bytes, ms: this.now() - t0 });
      f.finish();
    } catch (err) {
      bytes = tee.written;
      tee.abortClient();
      tee.destroy();
      if (file) {
        await closed(file); // closed before the unlink, or a late open leaves a .part
        cache.discard(entry.id);
      }
      this.byId.delete(entry.id);
      if (isAbort(err)) return f.finish(err);
      let e = err instanceof BaichuanError ? err : new BaichuanError('protocol', 'the download failed');
      // A 400 for a file the list had: gone from the card (not found), or refused?
      if (e.code === 'refused' && e.status === 400 && !(await this.d.stillListed(entry).catch(() => true))) {
        e = new BaichuanError('not_found', 'the camera no longer has the recording', 400);
      }
      this.report({ id: entry.id, at: this.now(), result: e.code, stream: entry.stream, bytes, ms: this.now() - t0 });
      f.finish(e);
    } finally {
      unpin();
    }
  }
}
