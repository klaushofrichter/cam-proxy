import { createWriteStream, mkdirSync, openSync, readdirSync, rmSync, statSync } from 'fs';
import { join, resolve, sep } from 'path';
import type { Writable } from 'stream';
import { finished } from 'stream/promises';
import { BaichuanError } from '../camera/baichuan/errors';
import { clipNear } from '../catalog/clips';
import type { Catalog } from '../catalog/db';
import { ClipExistsError, type ClipIndexer } from '../clips/indexer';
import type { RecordingCache } from '../recordings/cache';
import { abortError, isAbort, sleep as defaultSleep } from '../async';
import type { Fetch, RecordingFetcher, Waiter } from '../recordings/fetcher';
import { errorMessage, logger } from '../log';
import { SearchError, type RecordingEntry, type RecordingList } from '../recordings/list';
import { settlesAt, type Stream } from '../recordings/names';
import { withBusyRetry } from './camera-list';
import { mb, type ClipItem } from './clips';
import { START_SLACK_MS } from './match';
import type { InventoryReport, RepairEntry, RepairResult } from './runner';
import { DAY, dayStart } from '../time-units';

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
// streamed to a temp file instead, unless a viewer streams it: then the
// viewer has it and the clip is skipped (`viewer`). Caps per run: 50 clips (skipped ones
// count); 200 MB: a recording larger than that alone is skipped (`too-big`),
// one that would pass it after others is skipped (`byte-cap`) and the scan
// goes on for smaller ones; ftp.maxGB stops the run. A busy Search in the
// still-listed check is tried 3 times 1 s apart, then the clip is skipped
// (`busy`, not a failure: a viewer browsing never stops the repair). 1 s
// between downloads; it stops after 3 failures
// in a row, and at once on a refused download or an offline camera. A cancel
// ends it between clips and aborts its own running download (one a viewer
// joined runs on). The report's age (< 1 h) is checked by the runner.

export const REPAIR_MAX_CLIPS = 50;
export const REPAIR_MAX_BYTES = 200 * 2 ** 20;
export const REPAIR_GAP_MS = 1000;
export const REPAIR_MAX_FAILURES = 3;

type RepairStop = 'clip-cap' | 'byte-cap' | 'max-gb' | 'paused' | 'failures' | 'refused' | 'camera_offline';
const STOP_TEXT: Record<RepairStop, string> = {
  'clip-cap': `the ${REPAIR_MAX_CLIPS}-clip cap`,
  'byte-cap': `the ${REPAIR_MAX_BYTES / 2 ** 20} MB cap`,
  'max-gb': 'ftp.maxGB would be exceeded',
  paused: 'storage is paused (disk full)',
  failures: `${REPAIR_MAX_FAILURES} failures in a row`,
  refused: 'the camera refused a download',
  camera_offline: 'the camera is offline',
};
// `viewer`: in temp mode a viewer took the fetch's one client slot (viewers first).
// `too-big`: larger than one run's byte cap; `byte-cap`: would pass it after
// the clips fetched before; `busy`: the camera's Search stayed busy.
// `still-recording`: a late-night recording that may still be written (names.ts settlesAt).
type SkipReason = 'outside-retention' | 'already-local' | 'gone-from-camera' | 'other-stream' | 'viewer' | 'invalid' | 'too-big' | 'byte-cap' | 'busy' | 'still-recording';
// `streamed`: the cache couldn't keep the file; it went through a temp file.
export interface RepairItem { id: string; start: number; result: 'ok' | 'skipped' | 'failed'; reason?: SkipReason; error?: string; clipId?: number; bytes?: number; streamed?: true }

export interface ClipsRepairSettings { cam: string; stream: Stream; clipsDays: number; maxGB?: number }
export interface ClipsRepairDeps {
  catalog: Catalog;
  // Each for the run's camera (spec 2026-10-05-multi-camera-host-design §3.1).
  settings: (cam: string) => ClipsRepairSettings; // read when a run starts
  list: (cam: string) => Pick<RecordingList, 'find'>;
  fetcher: (cam: string) => Pick<RecordingFetcher, 'get' | 'canKeep'>;
  cache: (cam: string) => Pick<RecordingCache, 'open' | 'path'>;
  indexer: (cam: string) => Pick<ClipIndexer, 'addRecording'>;
  // A folder on the data disk for a recording the cache can't keep; emptied
  // of leftover .part files when a run starts (runs hold the inventory lock).
  tempDir: () => string;
  paused: () => boolean;
  clipsBytes: () => number; // the clips' bytes on disk now (storage usage)
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  limits?: { clips?: number; bytes?: number }; // tests
  openTemp?: (path: string) => Writable; // tests; opens synchronously (throws when it can't)
}

type Candidate = Extract<ClipItem, { type: 'missing-locally' }>;
const missingItems = (r: InventoryReport) => (r.items as ClipItem[]).filter((x): x is Candidate => x.type === 'missing-locally');

// The fetch's end, or an AbortError when the signal aborts (also the Archive's fetch): then the fetch
// is aborted too, unless someone else (a viewer) still waits for it, and
// given up to ABORT_WAIT_MS to end (its cmd 9 sent, its .part gone).
const ABORT_WAIT_MS = 2_000;
export const settled = (fetch: Fetch, signal: AbortSignal, mine: { waiter: Waiter; res?: Writable }) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const fail = () => reject(abortError('cancelled'));
      if (!fetch.abortIfAlone(mine)) return fail();
      const t = setTimeout(fail, ABORT_WAIT_MS);
      fetch.done.catch(() => undefined).finally(() => (clearTimeout(t), fail()));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    fetch.done.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });

const closed = (w: Writable) =>
  new Promise<void>((resolve) => {
    if (w.closed) return resolve();
    w.once('close', () => resolve());
    w.destroy();
  });

// The temp file, opened at once (so a bad folder fails before any fetch).
const openTempFile = (path: string): Writable => createWriteStream(path, { fd: openSync(path, 'w') });


// Cleanup never turns a done clip into a failure, nor hides the real error.
const quietly = (what: string, f: () => void) => {
  try {
    f();
  } catch (err) {
    logger.warn({ err: errorMessage(err) }, what);
  }
};

// A recording file to copy from, and what to do once copied (unpin, or remove).
interface Source { file: string; release: () => void; streamed: boolean }

export function clipsRepair(d: ClipsRepairDeps): RepairEntry {
  const ready = (source: InventoryReport): string | null => {
    if (!source.options?.camera) return 'compare the clips with the camera first';
    if (!missingItems(source).length) return 'nothing is missing locally';
    return null;
  };

  const run = async (ctx: Parameters<RepairEntry['run']>[0]): Promise<RepairResult> => {
    const s = d.settings(ctx.cam);
    // The run's camera's recordings side.
    const rec = { list: d.list(ctx.cam), fetcher: d.fetcher(ctx.cam), cache: d.cache(ctx.cam), indexer: () => d.indexer(ctx.cam) };
    const maxClips = d.limits?.clips ?? REPAIR_MAX_CLIPS;
    const maxBytes = d.limits?.bytes ?? REPAIR_MAX_BYTES;
    const sleep = d.sleep ?? defaultSleep;
    const retentionFrom = dayStart(ctx.now - s.clipsDays * DAY);
    // Oldest first, whatever order the report lists them in (ruling (a)).
    const all = missingItems(ctx.source).sort((a, b) => a.start - b.start);
    const list = all.slice(0, maxClips);
    const counts = { candidates: all.length, requested: list.length, done: 0, failed: 0, skipped: 0, bytes: 0 };
    const items: RepairItem[] = [];
    const failures: { id: string; start: number; error: string }[] = [];
    let stopped: RepairStop | null = null;
    let inARow = 0;
    let downloads = 0;
    let overCap = false;
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
    // second try), streamed to a temp file. 'viewer': in temp mode a viewer
    // took the client slot (it has the file). Null: nothing usable (the fetch
    // was another's that was aborted, or the file went before it was pinned).
    const obtain = async (entry: RecordingEntry, attempt: number, signal: AbortSignal): Promise<Source | 'viewer' | 'invalid' | null> => {
      const cached = rec.cache.open(entry.id);
      if (cached) return { file: rec.cache.path(entry.id), release: cached, streamed: false };
      if (downloads++ > 0) await sleep(REPAIR_GAP_MS, signal);
      if (signal.aborted) throw abortError('cancelled');
      let tmp: { path: string; w: Writable; err?: Error } | null = null;
      if (attempt > 0 || !rec.fetcher.canKeep(entry.size)) {
        // entry.id is an SD name (the list's): no path separators; checked
        // anyway before it becomes a file name.
        const path = join(tempDir, `${entry.id}.part`);
        if (!resolve(path).startsWith(resolve(tempDir) + sep)) return 'invalid';
        let w: Writable;
        try {
          w = (d.openTemp ?? openTempFile)(path);
        } catch (err) {
          throw new Error(`the temp file could not be made: ${errorMessage(err)}`);
        }
        const t: { path: string; w: Writable; err?: Error } = { path, w };
        w.on('error', (err) => void (t.err ??= err));
        tmp = t;
      }
      const diskError = () => (tmp?.err ? new Error(`the temp file failed: ${tmp.err.message}`) : null);
      let keep = false;
      try {
        const { fetch, created, waiter } = rec.fetcher.get(entry, { priority: 'low', signal });
        // Viewers first: the temp writer takes the client slot only when the
        // fetch starts and no viewer has attached meanwhile.
        if (tmp) fetch.attachWhenRunning(tmp.w, () => undefined);
        try {
          await settled(fetch, signal, { waiter, res: tmp?.w });
        } catch (err) {
          const disk = diskError();
          if (disk) throw disk; // the temp file failed (a full disk): not "no reader left"
          if (isAbort(err) && !signal.aborted && !created) return null; // another's fetch was aborted: try again
          throw err;
        }
        const disk = diskError();
        if (disk) throw disk;
        if (fetch.kept) {
          const unpin = rec.cache.open(entry.id);
          if (unpin) return { file: rec.cache.path(entry.id), release: unpin, streamed: false };
        }
        if (!tmp) return null;
        if (!fetch.holds(tmp.w)) return fetch.kept ? null : 'viewer';
        const t = tmp;
        const whole = await finished(t.w).then(() => statSync(t.path).size === entry.size, () => false);
        const late = diskError();
        if (late) throw late;
        if (!whole) return null;
        keep = true;
        return { file: t.path, release: () => rmSync(t.path, { force: true }), streamed: true };
      } finally {
        if (tmp && !keep) {
          const t = tmp;
          await closed(t.w);
          quietly('repair_temp_cleanup_failed', () => rmSync(t.path, { force: true }));
        }
      }
    };

    // The still-listed check; a busy Search (a viewer browsing) is tried
    // BUSY_TRIES times 1 s apart like the compare's, then 'busy'.
    const findListed = async (id: string, signal: AbortSignal): Promise<RecordingEntry | undefined | 'busy'> => {
      try {
        return await withBusyRetry(() => rec.list.find(id, signal), signal, sleep);
      } catch (err) {
        if (err instanceof SearchError && err.code === 'busy' && !signal.aborted) return 'busy';
        throw err;
      }
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
      if (c.size > maxBytes) {
        skip(c, 'too-big'); // it would block every run (oldest first)
        continue;
      }
      if (counts.bytes + c.size > maxBytes) {
        skip(c, 'byte-cap'); // a smaller one later may still fit
        overCap = true;
        continue;
      }
      if (s.maxGB !== undefined && d.clipsBytes() + c.size > s.maxGB * 2 ** 30) {
        stopped = 'max-gb';
        break;
      }
      // This clip's own signal, linked to the run's and unlinked after the
      // clip: the fetcher's and the waits' listeners never pile up on the run's.
      const clip = new AbortController();
      const link = () => clip.abort();
      ctx.signal.addEventListener('abort', link, { once: true });
      try {
        // The camera path comes from a Search (the 30 s day cache), never from the report.
        const entry = await findListed(c.id, clip.signal);
        if (entry === 'busy') {
          skip(c, 'busy');
          continue;
        }
        if (!entry) {
          skip(c, 'gone-from-camera');
          continue;
        }
        if (settlesAt(entry) > ctx.now) {
          skip(c, 'still-recording'); // fetched now, it could be cut short
          continue;
        }
        const src = (await obtain(entry, 0, clip.signal)) ?? (await obtain(entry, 1, clip.signal));
        if (src === 'viewer' || src === 'invalid') {
          skip(c, src);
          continue;
        }
        if (!src) throw new Error('the recording could not be kept or streamed');
        try {
          const row = await rec.indexer().addRecording(src.file, { start: entry.start, stream: s.stream });
          counts.done++;
          counts.bytes += row.size;
          inARow = 0;
          items.push({ id: c.id, start: c.start, result: 'ok', clipId: row.id, bytes: row.size, ...(src.streamed ? { streamed: true as const } : {}) });
        } finally {
          quietly('repair_release_failed', src.release); // the pin is held only for the copy
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
        fail(c, errorMessage(err));
        const offline = (err instanceof SearchError && err.code === 'camera_offline') || (err instanceof BaichuanError && err.code === 'offline');
        if (offline) stopped = 'camera_offline';
        else if (err instanceof BaichuanError && err.code === 'refused') stopped = 'refused';
        if (stopped) break;
      } finally {
        ctx.signal.removeEventListener('abort', link);
      }
    }
    if (!stopped && !ctx.signal.aborted && overCap) stopped = 'byte-cap';
    if (!stopped && !ctx.signal.aborted && all.length > list.length) stopped = 'clip-cap';
    ctx.progress({ phase: 'repair', done: items.length, total: list.length });
    const message = `${counts.done} of ${counts.requested} fetched (${mb(counts.bytes)}), ${counts.failed} failed, ${counts.skipped} skipped${stopped ? `; stopped: ${STOP_TEXT[stopped]}` : ''}`;
    return { counts, top: failures, items, message, stopped };
  };

  return { run, ready };
}
