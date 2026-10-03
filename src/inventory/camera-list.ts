// The SD recordings of an inventory window (spec 2026-10-02-inventory-design
// §4, shared by the clips compare and, in PR 3, the events check): the month
// overview first (which days have recordings), then one Search per day with
// recordings, oldest first, through RecordingList (its one-at-a-time gate and
// its 30 s day cache). A day whose Search fails is `unknown`: its recordings
// are never counted as missing. An offline camera ends the listing
// (SearchError camera_offline); a full Search queue (busy) is tried again.
import { CameraError } from '../camera/client';
import { SearchError, type RecordingEntry, type RecordingList } from '../recordings/list';
import { localDays, type Stream } from '../recordings/names';
import type { TimeInfo } from '../camera/time';

export interface CameraDay { date: string; state: 'listed' | 'unknown'; recordings: RecordingEntry[]; error?: string }
export interface CameraListing {
  days: CameraDay[]; // camera-local dates of the window, oldest first (fewer when cancelled)
  oldestSdDay: string | null; // the oldest day with recordings in the window's months and the month before
  time: TimeInfo;
}
export interface CameraListDeps {
  list: Pick<RecordingList, 'monthDays' | 'day'>;
  timeInfo: () => Promise<TimeInfo>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

// A Search refused because the queue is full is tried this often in all, 1 s apart.
export const BUSY_TRIES = 3;

const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';
const offline = (e: unknown) => e instanceof SearchError && e.code === 'camera_offline';
// A camera that does not answer: CameraError camera_offline, or a socket-level error.
const isNetworkError = (e: unknown) =>
  (e instanceof CameraError && e.code === 'camera_offline') ||
  (e instanceof Error && (/^E(CONN|HOST|NET|TIMEDOUT|PIPE)/.test((e as { code?: string }).code ?? '') || /ECONN|EHOST|ENET|ETIMEDOUT|EPIPE|timed out|fetch failed/i.test(e.message)));
const pad = (n: number) => String(n).padStart(2, '0');
// '2026-10-01' -> '2026-09'; '2026-01-15' -> '2025-12'.
const monthBefore = (date: string): string => {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
};

export async function listCamera(
  d: CameraListDeps,
  o: { from: number; to: number; stream: Stream; signal: AbortSignal; progress?: (done: number, total: number, date: string) => void },
): Promise<CameraListing> {
  let time: TimeInfo;
  try {
    time = await d.timeInfo();
  } catch (err) {
    if (err instanceof SearchError) throw err;
    if (isNetworkError(err)) throw new SearchError('camera_offline', 'the camera time is unknown');
    throw new SearchError('search_failed', err instanceof Error ? err.message : String(err));
  }
  const sleep = d.sleep ?? abortableSleep;
  const dates = localDays(o.from, o.to, time);
  // The month overview: null when its Search failed (then every day is searched).
  // The month before the window is read too, for oldestSdDay only (#111): a
  // window starting on the 1st would otherwise take the 1st as the card's
  // oldest day while the card still holds the previous month.
  const months = new Map<string, Set<number> | null>();
  for (const month of new Set([monthBefore(dates[0]), ...dates.map((x) => x.slice(0, 7))])) {
    if (o.signal.aborted) break;
    try {
      months.set(month, new Set(await d.list.monthDays(month, o.signal)));
    } catch (err) {
      if (offline(err)) throw err;
      months.set(month, null);
    }
  }
  // Null (unknown) when a month before the first one with recordings has no overview.
  let oldestSdDay: string | null = null;
  for (const month of [...months.keys()].sort()) {
    const set = months.get(month);
    if (set === null) break;
    if (!set?.size) continue;
    oldestSdDay = `${month}-${pad(Math.min(...set))}`;
    break;
  }
  const days: CameraDay[] = [];
  for (const [i, date] of dates.entries()) {
    if (o.signal.aborted) break;
    const set = months.get(date.slice(0, 7));
    if (set && !set.has(Number(date.slice(8, 10)))) {
      days.push({ date, state: 'listed', recordings: [] }); // no recordings that day: no Search
    } else {
      const day = await searchDay(d, date, o.stream, o.signal, sleep);
      if (!day) break; // cancelled
      days.push(day);
    }
    o.progress?.(i + 1, dates.length, date);
  }
  return { days, oldestSdDay, time };
}

async function searchDay(d: CameraListDeps, date: string, stream: Stream, signal: AbortSignal, sleep: (ms: number, signal?: AbortSignal) => Promise<void>): Promise<CameraDay | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { date, state: 'listed', recordings: await d.list.day(date, stream, false, signal) };
    } catch (err) {
      if (isAbort(err) || signal.aborted) return null;
      if (offline(err)) throw err;
      if (err instanceof SearchError && err.code === 'busy' && attempt < BUSY_TRIES) {
        await sleep(1000, signal);
        if (signal.aborted) return null;
        continue;
      }
      return { date, state: 'unknown', recordings: [], error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
