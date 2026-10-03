// src/recordings/side.ts
// The recordings side (spec 2026-10-02-baichuan-recordings-design): the
// list (HTTP Search), the cache, the fetcher and the Baichuan session, plus
// the status line and one info log line per download. One per camera: the
// list's Search semaphore and the fetcher's one-download rule are per instance.
import { join } from 'path';
import type { Writable } from 'stream';
import { BaichuanSession, type BaichuanTarget, type SessionOptions } from '../camera/baichuan/session';
import { download, type DownloadOptions } from '../camera/baichuan/vod';
import type { TimeInfo } from '../camera/time';
import { within } from '../async';
import { logger } from '../log';
import { RecordingCache } from './cache';
import { RecordingFetcher, type FetchOutcome, type Priority } from './fetcher';
import { RecordingList } from './list';
import type { Stream } from './names';

export interface RecordingsStatus {
  last: { at: number; result: string; stream: Stream; bytes: number; ms: number; priority: Priority } | null;
  cache: { bytes: number; files: number; capBytes: number };
}

export interface RecordingsSide {
  list: RecordingList;
  cache: RecordingCache;
  fetcher: RecordingFetcher;
  session: BaichuanSession;
  paused(): boolean;
  status(): RecordingsStatus;
  reset(): void; // the camera side restarted: a new session, fresh lists
  stop(): Promise<void>;
}

export interface RecordingsDeps {
  dataDir: string;
  cam: () => string;
  target: () => BaichuanTarget;
  capBytes: () => number;
  search: (param: object) => Promise<unknown>;
  timeInfo: () => Promise<TimeInfo>;
  paused: () => boolean;
  noteWritten: (bytes: number) => void;
  onDownload?: (o: FetchOutcome) => void;
  session?: SessionOptions;
  vod?: DownloadOptions;
  stopWaitMs?: number; // how long stop() waits for a running download to end (2 s)
}

export function createRecordingsSide(d: RecordingsDeps): RecordingsSide {
  const session = new BaichuanSession(d.target, d.session);
  const dirOf = () => join(d.dataDir, 'recordings', d.cam());
  const cache = new RecordingCache({ dir: dirOf, capBytes: d.capBytes });
  cache.init(); // leftover .part files from the last run go
  let readyDir = dirOf();
  const list = new RecordingList({ search: d.search, timeInfo: d.timeInfo });
  let last: RecordingsStatus['last'] = null;
  const fetcher = new RecordingFetcher({
    cache,
    download: (path: string, size: number, out: Writable) => download(session, path, size, out, d.vod),
    stillListed: (e) => list.stillListed(e),
    paused: d.paused,
    noteWritten: d.noteWritten,
    onDone: (o) => {
      last = { at: o.at, result: o.result, stream: o.stream, bytes: o.bytes, ms: o.ms, priority: o.priority };
      logger.info({ camera: d.cam(), id: o.id, stream: o.stream, bytes: o.bytes, ms: o.ms, result: o.result, priority: o.priority }, 'recording_download');
      d.onDownload?.(o);
    },
  });
  return {
    list,
    cache,
    fetcher,
    session,
    paused: d.paused,
    status: () => ({ last, cache: { ...cache.usage(), capBytes: d.capBytes() } }),
    reset: () => {
      session.close();
      list.clear();
      // A new camera.id is a new folder: made ready like the first at start
      // (#99). The same folder is left alone: a download may be writing a .part.
      if (dirOf() !== readyDir) {
        cache.init();
        readyDir = dirOf();
      }
    },
    // Queued fetches fail, a running download is aborted: with a session its
    // abort sends cmd 9 before the close. A connect or login in flight is
    // given up at once (close during connect). Bounded by stopWaitMs.
    stop: async () => {
      const ended = fetcher.stop();
      if (!session.connected()) session.close();
      await within(ended, d.stopWaitMs ?? 2_000);
      session.close();
    },
  };
}
