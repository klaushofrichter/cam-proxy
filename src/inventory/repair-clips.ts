import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, type WriteStream } from 'fs';
import { join } from 'path';
import { finished } from 'stream/promises';
import { BaichuanError } from '../camera/baichuan/errors';
import { clipNear } from '../catalog/clips';
import type { Catalog } from '../catalog/db';
import { ClipExistsError, type ClipIndexer } from '../clips/indexer';
import type { RecordingCache } from '../recordings/cache';
import { abortError, isAbort, type Fetch, type RecordingFetcher } from '../recordings/fetcher';
import { SearchError, type RecordingEntry, type RecordingList } from '../recordings/list';
import type { Stream } from '../recordings/names';
import { mb, type ClipItem } from './clips';
import { START_SLACK_MS } from './match';
import type { InventoryReport, RepairEntry, RepairResult } from './runner';

// The clips repair (#74 part 3, spec 2026-10-02-inventory-design §4): fetch
// the recordings a recent camera compare found missing locally, over Baichuan
// at `low` priority (a viewer's fetch, queued or running, goes first; a
// running repair fetch is not pre-empted), on ftp.stream, the OLDEST first
// (the SD card overwrites them first; ruling (a)). Each one is checked again
// first (storage not paused, inside the clips retention, same stream, no
// local clip within 5 s, still listed on the SD card), then fetched into the
// recordings cache, pinned only while it is copied into clips/ and indexed
// with origin 'camera' (ClipIndexer.addRecording). A file the cache can't keep
// (disk paused, over the cache cap, no room beside the pinned files) is
// streamed to a temp file instead. Caps per run: 50 clips (skipped ones
// count), 200 MB, ftp.maxGB; 1 s between downloads; it stops after 3 failures
// in a row, and at once on a refused download or an offline camera. A cancel
// ends it between clips and aborts its own running download (one a viewer
// joined runs on). The report's age (< 1 h) is checked by the runner.

export const REPAIR_MAX_CLIPS = 50;
export const REPAIR_MAX_BYTES = 200 * 2 ** 20;
export const REPAIR_GAP_MS = 1000;
export const REPAIR_MAX_FAILURES = 3;
const DAY = 86_400_000;

export type RepairStop = 'clip-cap' | 'byte-cap' | 'max-gb' | 'paused' | 'failures' | 'refused' | 'camera_offline';
const STOP_TEXT: Record<RepairStop, string> = {
  'clip-cap': `the ${REPAIR_MAX_CLIPS}-clip cap`,
  'byte-cap': `the ${REPAIR_MAX_BYTES / 2 ** 20} MB cap`,
  'max-gb': 'ftp.maxGB would be exceeded',
  paused: 'storage is paused (disk full)',
  failures: `${REPAIR_MAX_FAILURES} failures in a row`,
  refused: 'the camera refused a download',
  camera_offline: 'the camera is offline',
};
export type SkipReason = 'outside-retention' | 'already-local' | 'gone-from-camera' | 'other-stream';
// `streamed`: the cache couldn't keep the file; it went through a temp file.
export interface RepairItem { id: string; start: number; result: 'ok' | 'skipped' | 'failed'; reason?: SkipReason; error?: string; clipId?: number; bytes?: number; streamed?: true }

export interface ClipsRepairSettings { cam: string; stream: Stream; clipsDays: number; maxGB?: number }
export interface ClipsRepairDeps {
  catalog: Catalog;
  settings: () => ClipsRepairSettings; // read when a run starts
  list: Pick<RecordingList, 'find'>;
  fetcher: Pick<RecordingFetcher, 'get' | 'canKeep'>;
  cache: Pick<RecordingCache, 'open' | 'path'>;
  indexer: () => Pick<ClipIndexer, 'addRecording'>;
  // A folder on the data disk for a recording the cache can't keep; emptied
  // of leftover .part files when a run starts (runs hold the inventory lock).
  tempDir: () => string;
  paused: () => boolean;
  clipsBytes: () => number; // the clips' bytes on disk now (storage usage)
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  limits?: { clips?: number; bytes?: number }; // tests
}

type Candidate = Extract<ClipItem, { type: 'missing-locally' }>;
const missingItems = (r: InventoryReport) => (r.items as ClipItem[]).filter((x): x is Candidate => x.type === 'missing-locally');

const sleepFor = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

// The fetch's end, or an AbortError when the signal aborts: then the fetch
// is aborted too, unless someone else (a viewer) still waits for it, and
// given up to ABORT_WAIT_MS to end (its cmd 9 sent, its .part gone).
const ABORT_WAIT_MS = 2_000;
const settled = (fetch: Fetch, signal: AbortSignal, own?: WriteStream) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const fail = () => reject(abortError('cancelled'));
      if (!fetch.abortIfAlone(own)) return fail();
      const t = setTimeout(fail, ABORT_WAIT_MS);
      fetch.done.catch(() => undefined).finally(() => (clearTimeout(t), fail()));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    fetch.done.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });

const closed = (w: WriteStream) =>
  new Promise<void>((resolve) => {
    if (w.closed) return resolve();
    w.once('close', () => resolve());
    w.destroy();
  });

// A recording file to copy from, and what to do once copied (unpin, or remove).
interface Source { file: string; release: () => void; streamed: boolean }

export function clipsRepair(d: ClipsRepairDeps): RepairEntry {
  const ready = (source: InventoryReport): string | null => {
    if (!source.options?.camera) return 'compare the clips with the camera first';
    if (!missingItems(source).length) return 'nothing is missing locally';
    return null;
  };

  const run = async (ctx: Parameters<RepairEntry['run']>[0]): Promise<RepairResult> => {
    const s = d.settings();
    const maxClips = d.limits?.clips ?? REPAIR_MAX_CLIPS;
    const maxBytes = d.limits?.bytes ?? REPAIR_MAX_BYTES;
    const sleep = d.sleep ?? sleepFor;
    const retentionFrom = Math.floor((ctx.now - s.clipsDays * DAY) / DAY) * DAY;
    // Oldest first, whatever order the report lists them in (ruling (a)).
    const all = missingItems(ctx.source).sort((a, b) => a.start - b.start);
    const list = all.slice(0, maxClips);
    const counts = { candidates: all.length, requested: list.length, done: 0, failed: 0, skipped: 0, bytes: 0 };
    const items: RepairItem[] = [];
    const failures: { id: string; start: number; error: string }[] = [];
    let stopped: RepairStop | null = null;
    let inARow = 0;
    let downloads = 0;
    const tempDir = d.tempDir();
    try {
      mkdirSync(tempDir, { recursive: true });
      for (const name of readdirSync(tempDir)) if (name.endsWith('.part')) rmSync(join(tempDir, name), { force: true });
    } catch {
      // a temp file can't be made then: such a recording fails when it comes
    }

    const skip = (c: Candidate, reason: SkipReason) => {
      counts.skipped++;
      items.push({ id: c.id, start: c.start, result: 'skipped', reason });
    };
    const fail = (c: Candidate, error: string) => {
      counts.failed++;
      inARow++;
      items.push({ id: c.id, start: c.start, result: 'failed', error });
      failures.push({ id: c.id, start: c.start, error });
      if (inARow >= REPAIR_MAX_FAILURES) stopped = 'failures';
    };

    // One try at a file: the cache's copy (pinned), or a fetch at low
    // priority into the cache or, when the cache can't keep it (or on the
    // second try), streamed to a temp file. Null: neither (the fetch was
    // another's that was aborted, or the file went before it was pinned).
    const obtain = async (entry: RecordingEntry, attempt: number): Promise<Source | null> => {
      const cached = d.cache.open(entry.id);
      if (cached) return { file: d.cache.path(entry.id), release: cached, streamed: false };
      if (downloads++ > 0) await sleep(REPAIR_GAP_MS, ctx.signal);
      if (ctx.signal.aborted) throw abortError('cancelled');
      const { fetch, created } = d.fetcher.get(entry, { priority: 'low', signal: ctx.signal });
      let tmp: { path: string; w: WriteStream } | null = null;
      const drop = async () => {
        if (!tmp) return;
        await closed(tmp.w);
        rmSync(tmp.path, { force: true });
        tmp = null;
      };
      if (attempt > 0 || !d.fetcher.canKeep(entry.size)) {
        // entry.id is an SD name (fetcher.get checked it): no path separators.
        const path = join(tempDir, `${entry.id}.part`);
        const w = createWriteStream(path);
        w.on('error', () => undefined); // seen as an incomplete file below
        tmp = { path, w };
        if (!fetch.attach(w, () => undefined)) await drop(); // another client has it: wait for the cache
      }
      try {
        await settled(fetch, ctx.signal, tmp?.w);
      } catch (err) {
        await drop();
        if (isAbort(err) && !ctx.signal.aborted && !created) return null; // another's fetch was aborted: try again
        throw err;
      }
      if (fetch.kept) {
        const unpin = d.cache.open(entry.id);
        if (unpin) {
          await drop();
          return { file: d.cache.path(entry.id), release: unpin, streamed: false };
        }
      }
      if (tmp) {
        const t: { path: string; w: WriteStream } = tmp;
        const whole = await finished(t.w).then(() => statSync(t.path).size === entry.size, () => false);
        if (whole) return { file: t.path, release: () => rmSync(t.path, { force: true }), streamed: true };
      }
      await drop();
      return null;
    };

    for (const [i, c] of list.entries()) {
      if (ctx.signal.aborted || stopped) break;
      ctx.progress({ phase: 'repair', done: i, total: list.length, note: c.id });
      if (ctx.signal.aborted) break;
      if (d.paused()) {
        stopped = 'paused';
        break;
      }
      if (c.start < retentionFrom) {
        skip(c, 'outside-retention');
        continue;
      }
      if (c.stream !== s.stream) {
        skip(c, 'other-stream'); // ftp.stream changed since the compare
        continue;
      }
      if (clipNear(d.catalog, s.cam, s.stream, c.start, START_SLACK_MS)) {
        skip(c, 'already-local');
        continue;
      }
      if (counts.bytes + c.size > maxBytes) {
        stopped = 'byte-cap';
        break;
      }
      if (s.maxGB !== undefined && d.clipsBytes() + c.size > s.maxGB * 2 ** 30) {
        stopped = 'max-gb';
        break;
      }
      try {
        // The camera path comes from a Search (the 30 s day cache), never from the report.
        const entry = await d.list.find(c.id, ctx.signal);
        if (!entry) {
          skip(c, 'gone-from-camera');
          continue;
        }
        const src = (await obtain(entry, 0)) ?? (await obtain(entry, 1));
        if (!src) throw new Error('the recording could not be kept or streamed');
        try {
          const row = await d.indexer().addRecording(src.file, { start: entry.start, stream: s.stream });
          counts.done++;
          counts.bytes += row.size;
          inARow = 0;
          items.push({ id: c.id, start: c.start, result: 'ok', clipId: row.id, bytes: row.size, ...(src.streamed ? { streamed: true as const } : {}) });
        } finally {
          src.release(); // the pin is held only for the copy
        }
      } catch (err) {
        if (isAbort(err) && ctx.signal.aborted) break;
        if (err instanceof ClipExistsError) {
          skip(c, 'already-local'); // an FTP clip (or a row) landed meanwhile: not a failure
          continue;
        }
        if (err instanceof BaichuanError && err.code === 'not_found') {
          skip(c, 'gone-from-camera');
          continue;
        }
        fail(c, err instanceof Error ? err.message : String(err));
        const offline = (err instanceof SearchError && err.code === 'camera_offline') || (err instanceof BaichuanError && err.code === 'offline');
        if (offline) stopped = 'camera_offline';
        else if (err instanceof BaichuanError && err.code === 'refused') stopped = 'refused';
        if (stopped) break;
      }
    }
    if (!stopped && !ctx.signal.aborted && all.length > list.length) stopped = 'clip-cap';
    ctx.progress({ phase: 'repair', done: items.length, total: list.length });
    const message = `${counts.done} of ${counts.requested} fetched (${mb(counts.bytes)}), ${counts.failed} failed, ${counts.skipped} skipped${stopped ? `; stopped: ${STOP_TEXT[stopped]}` : ''}`;
    return { counts, top: failures, items, message, stopped };
  };

  return { run, ready };
}
