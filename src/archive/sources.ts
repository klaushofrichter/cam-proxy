import { createReadStream, createWriteStream, rmSync, statSync } from 'fs';
import { join } from 'path';
import { PassThrough, Transform } from 'stream';
import { finished, pipeline } from 'stream/promises';
import { crc32 } from 'zlib';
import { abortError, isAbort } from '../async';
import { BaichuanError } from '../camera/baichuan/errors';
import { settled } from '../inventory/repair-clips';
import type { RecordingCache } from '../recordings/cache';
import type { RecordingFetcher } from '../recordings/fetcher';
import type { RecordingEntry } from '../recordings/list';

// Where an archive job's clip comes from (spec 2026-10-05-archive-design
// §2.1, §2.2), and the copy into the job's folder with its CRC-32.

// A failure with a code for the job's `error` (docs/archive.md §2).
export type JobErrorCode = 'insufficient_space' | 'camera_offline' | 'unknown_recording' | 'fetch_failed' | 'source_gone' | 'store_failed' | 'cancelled';
export class ArchiveJobError extends Error {
  constructor(readonly code: JobErrorCode, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

// A file whose copy the job makes, and what to do afterwards (unpin, remove).
export interface Obtained { path: string; release: () => void; crc32?: number }
export type Obtain = (o: { dir: string; signal: AbortSignal; progress: (bytes: number) => void }) => Promise<Obtained>;

// A file that is there (a finished composition, an FTP clip).
export function fileSource(path: string): Obtain {
  return async () => {
    try {
      statSync(path);
    } catch {
      throw new ArchiveJobError('source_gone', 'the file is gone');
    }
    return { path, release: () => undefined };
  };
}

const errorOf = (err: unknown): ArchiveJobError => {
  if (err instanceof ArchiveJobError) return err;
  if (isAbort(err)) return new ArchiveJobError('cancelled', 'cancelled');
  if (err instanceof BaichuanError) {
    if (err.code === 'not_found') return new ArchiveJobError('unknown_recording', 'the camera no longer has the recording');
    if (err.code === 'offline') return new ArchiveJobError('camera_offline', 'the camera is offline');
    return new ArchiveJobError('fetch_failed', `the download failed (${err.code})`);
  }
  if ((err as NodeJS.ErrnoException).code === 'ENOSPC') return new ArchiveJobError('insufficient_space', 'the disk is full');
  return new ArchiveJobError('fetch_failed', 'the download failed');
};

// An SD-card recording: the cache's copy (pinned) when there; else fetched
// over Baichuan at high priority. The job's own file takes the stream when
// no viewer has it (like the clips repair's temp file); when a viewer has
// it, the file is read from the cache afterwards. One more try when the
// fetch was another's that was aborted, or kept nowhere.
export function recordingSource(d: { entry: RecordingEntry; cache: Pick<RecordingCache, 'open' | 'path'>; fetcher: Pick<RecordingFetcher, 'get'> }): Obtain {
  const { entry } = d;
  return async ({ dir, signal, progress }) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cached = d.cache.open(entry.id);
      if (cached) return { path: d.cache.path(entry.id), release: cached };
      if (signal.aborted) throw new ArchiveJobError('cancelled', 'cancelled');
      const part = join(dir, 'fetch.part');
      const file = createWriteStream(part);
      const pt = new PassThrough({ highWaterMark: 1024 * 1024 });
      let bytes = 0;
      let crc = 0;
      pt.on('data', (b: Buffer) => {
        bytes += b.length;
        crc = crc32(b, crc);
        progress(bytes);
      });
      let fileErr: Error | undefined;
      file.on('error', (e) => void (fileErr ??= e));
      pt.pipe(file);
      const drop = () => {
        pt.unpipe(file);
        file.destroy();
        rmSync(part, { force: true });
      };
      try {
        const { fetch, created, waiter } = d.fetcher.get(entry, { priority: 'high', signal });
        fetch.attachWhenRunning(pt, () => undefined);
        try {
          await settled(fetch, signal, { waiter, res: pt });
        } catch (err) {
          if (fileErr) throw errorOf(fileErr);
          if (isAbort(err) && !signal.aborted && !created) {
            drop();
            continue; // another's fetch was aborted: once more
          }
          throw errorOf(signal.aborted ? abortError('cancelled') : err);
        }
        if (fetch.holds(pt)) {
          await finished(file).catch(() => undefined);
          if (fileErr) throw errorOf(fileErr);
          if (bytes !== entry.size || statSync(part).size !== entry.size) throw new ArchiveJobError('fetch_failed', 'the download ended short');
          return { path: part, release: () => rmSync(part, { force: true }), crc32: crc };
        }
        drop();
        if (fetch.kept) {
          const unpin = d.cache.open(entry.id);
          if (unpin) return { path: d.cache.path(entry.id), release: unpin };
        }
      } catch (err) {
        drop();
        throw errorOf(err);
      }
    }
    throw new ArchiveJobError('fetch_failed', 'the recording could not be kept');
  };
}

// Copies `from` to `to`, counting the CRC-32; ENOSPC is insufficient_space.
export async function copyWithCrc(from: string, to: string, signal: AbortSignal, progress: (bytes: number) => void): Promise<{ bytes: number; crc32: number }> {
  let bytes = 0;
  let crc = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      crc = crc32(chunk, crc);
      progress(bytes);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(from), count, createWriteStream(to), { signal });
  } catch (err) {
    rmSync(to, { force: true });
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ArchiveJobError('source_gone', 'the file is gone');
    throw errorOf(err);
  }
  return { bytes, crc32: crc };
}
