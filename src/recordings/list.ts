// src/recordings/list.ts
// The SD recordings, from the camera's HTTP Search (spec "How the list is
// made"): one Search per camera-local day, one at a time per camera (an
// overlapping Search fails with -54 or comes back empty), each (day, stream)
// kept 30 s; the month's days kept 5 minutes.
// A Search finds the recordings that start on its day (measured), so one that
// starts before midnight and runs into the next day is only in the day
// before's Search: a day's list and a window's list also read the day before
// (#99). Once that day is over (by 5 minutes) and none of its recordings is
// still being written, its midnight tail is final and kept 15 minutes.
import { CameraError } from '../camera/client';
import { Semaphore } from '../camera/semaphore';
import type { TimeInfo } from '../camera/time';
import { SAFE_PATH } from '../camera/baichuan/vod';
import { localDate, localDays, parseSdName, recordingTimes, stillRecording, type Kind, type Stream } from './names';

export interface RecordingEntry { id: string; path: string; start: number; end: number; stream: Stream; size: number; kinds: Kind[] }

export class SearchError extends Error {
  constructor(
    readonly code: 'camera_offline' | 'search_failed' | 'busy',
    message: string,
  ) {
    super(message);
    this.name = 'SearchError';
  }
}

const DAY_TTL = 30_000;
const MONTH_TTL = 300_000;
const TAIL_TTL = 15 * 60_000; // an SD format, an overwrite or a reboot elsewhere makes it stale
// A day is final only this long after its midnight: a clip named a moment
// before midnight (pre-record, clock skew) can be listed a little later.
const FINAL_AFTER_MS = 5 * 60_000;
// Searches waiting behind the running one (#99): past this, a new Search is
// refused at once (busy) instead of queueing without bound. Same-day
// requests share one Search and don't count. A cold 48-hour window is 4
// Searches, one after the other.
export const MAX_WAITING_SEARCHES = 8;

// The recording runs past its day's midnight (end before start in its name;
// end 000000 too, which recordingTimes puts at midnight).
const crossesMidnight = (e: RecordingEntry): boolean => {
  const n = parseSdName(e.id);
  return n !== null && n.end < n.start;
};

export const dayBefore = (date: string): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

// Messages from CameraError never carry URLs or tokens.
const toSearchError = (err: unknown, fallback: string): SearchError =>
  err instanceof CameraError && err.code === 'camera_offline' ? new SearchError('camera_offline', err.message) : new SearchError('search_failed', err instanceof CameraError ? err.message : fallback);

export class RecordingList {
  private readonly gate = new Semaphore(1);
  private readonly days = new Map<string, { at: number; entries: RecordingEntry[] }>();
  private readonly dayRuns = new Map<string, Promise<RecordingEntry[]>>();
  private readonly months = new Map<string, { at: number; days: number[] }>();
  private readonly monthRuns = new Map<string, Promise<number[]>>();
  private readonly tails = new Map<string, { at: number; entries: RecordingEntry[] }>();
  // clear() bumps it: a Search in flight then is neither cached nor joined (#99).
  private epoch = 0;
  private pending = 0; // Searches running or waiting for the gate

  constructor(
    private readonly d: {
      search: (param: object) => Promise<unknown>;
      timeInfo: () => Promise<TimeInfo>;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private async time(): Promise<TimeInfo> {
    try {
      return await this.d.timeInfo();
    } catch (err) {
      throw toSearchError(err, 'the camera time is unknown');
    }
  }

  // One Search, never two at once; -54 (busy) retried once after 1 s.
  private search(param: object): Promise<unknown> {
    if (this.pending > MAX_WAITING_SEARCHES) return Promise.reject(new SearchError('busy', 'too many recording Searches waiting; try again shortly'));
    this.pending++;
    return this.gate.run(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.d.search(param);
        } catch (err) {
          if (attempt === 0 && err instanceof CameraError && err.rspCode === -54) {
            await (this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(1000);
            continue;
          }
          throw toSearchError(err, 'Search failed');
        }
      }
    }).finally(() => this.pending--);
  }

  // fresh: a new Search, never the cache nor one already running (it may
  // have started before what the caller needs to know about).
  day(date: string, stream: Stream, fresh = false): Promise<RecordingEntry[]> {
    const key = `${date}|${stream}`;
    if (!fresh) {
      const hit = this.days.get(key);
      if (hit && this.now() - hit.at < DAY_TTL) return Promise.resolve(hit.entries);
      const running = this.dayRuns.get(key);
      if (running) return running;
    }
    const epoch = this.epoch;
    const work: Promise<RecordingEntry[]> = (async () => {
      const [year, mon, day] = date.split('-').map(Number);
      const v = (await this.search({
        Search: { channel: 0, onlyStatus: 0, streamType: stream, StartTime: { year, mon, day, hour: 0, min: 0, sec: 0 }, EndTime: { year, mon, day, hour: 23, min: 59, sec: 59 } },
      })) as { SearchResult?: { File?: { name?: unknown }[] } } | undefined;
      const t = await this.time();
      const out: RecordingEntry[] = [];
      let open = false; // a recording of this day is still being written
      for (const f of v?.SearchResult?.File ?? []) {
        if (typeof f?.name !== 'string' || !SAFE_PATH.test(f.name)) continue;
        const n = parseSdName(f.name);
        if (!n || n.date !== date || n.stream !== stream) continue;
        if (stillRecording(n)) {
          open = true;
          continue;
        }
        out.push({ id: n.id, path: f.name, ...recordingTimes(n, t), stream, size: n.size, kinds: n.kinds });
      }
      out.sort((a, b) => a.start - b.start);
      if (epoch === this.epoch) {
        const at = this.now();
        this.days.set(key, { at, entries: out });
        if (!open && localDate(at - FINAL_AFTER_MS, t) > date) this.tails.set(key, { at, entries: out.filter(crossesMidnight) });
      }
      return out;
    })().finally(() => {
      if (this.dayRuns.get(key) === work) this.dayRuns.delete(key);
    });
    this.dayRuns.set(key, work);
    return work;
  }

  // The recordings of `date` that run past its midnight: kept 15 minutes once
  // the day is final, else from the day's own (30 s) list.
  private async tail(date: string, stream: Stream): Promise<RecordingEntry[]> {
    const hit = this.tails.get(`${date}|${stream}`);
    if (hit && this.now() - hit.at < TAIL_TTL) return hit.entries;
    return (await this.day(date, stream)).filter(crossesMidnight);
  }

  // Recordings that overlap [from, to], by start; every day of the range or none.
  async range(from: number, to: number, stream: Stream): Promise<RecordingEntry[]> {
    const t = await this.time();
    const byId = new Map<string, RecordingEntry>();
    const days = localDays(from, to, t);
    const keep = (e: RecordingEntry) => {
      if (e.start <= to && e.end >= from) byId.set(e.id, e);
    };
    for (const date of days) for (const e of await this.day(date, stream)) keep(e);
    for (const e of await this.tail(dayBefore(days[0]), stream)) keep(e);
    return [...byId.values()].sort((a, b) => a.start - b.start);
  }

  // One camera-local day (YYYY-MM-DD): its recordings, and the one from the
  // day before that runs past midnight into it.
  async date(date: string, stream: Stream): Promise<RecordingEntry[]> {
    const own = await this.day(date, stream);
    const before = await this.tail(dayBefore(date), stream);
    return [...before, ...own].sort((a, b) => a.start - b.start);
  }

  async find(id: string): Promise<RecordingEntry | undefined> {
    const n = parseSdName(id);
    if (!n || n.id !== id) return undefined;
    return (await this.day(n.date, n.stream)).find((e) => e.id === id);
  }

  async stillListed(e: RecordingEntry): Promise<boolean> {
    const n = parseSdName(e.id);
    if (!n) return false;
    return (await this.day(n.date, n.stream, true)).some((x) => x.id === e.id);
  }

  monthDays(month: string): Promise<number[]> {
    const hit = this.months.get(month);
    if (hit && this.now() - hit.at < MONTH_TTL) return Promise.resolve(hit.days);
    const running = this.monthRuns.get(month);
    if (running) return running;
    const epoch = this.epoch;
    const work: Promise<number[]> = (async () => {
      const [year, mon] = month.split('-').map(Number);
      const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
      const v = (await this.search({
        Search: { channel: 0, onlyStatus: 1, streamType: 'main', StartTime: { year, mon, day: 1, hour: 0, min: 0, sec: 0 }, EndTime: { year, mon, day: last, hour: 23, min: 59, sec: 59 } },
      })) as { SearchResult?: { Status?: { year?: unknown; mon?: unknown; table?: unknown }[] } } | undefined;
      const days = new Set<number>();
      for (const s of v?.SearchResult?.Status ?? []) {
        if (Number(s?.year) !== year || Number(s?.mon) !== mon || typeof s?.table !== 'string') continue;
        [...s.table].forEach((c, i) => {
          if (c === '1' && i < last) days.add(i + 1);
        });
      }
      const out = [...days].sort((a, b) => a - b);
      if (epoch === this.epoch) this.months.set(month, { at: this.now(), days: out });
      return out;
    })().finally(() => {
      if (this.monthRuns.get(month) === work) this.monthRuns.delete(month);
    });
    this.monthRuns.set(month, work);
    return work;
  }

  // The camera restarted (or changed): nothing cached or in flight is used again.
  clear(): void {
    this.epoch++;
    this.days.clear();
    this.months.clear();
    this.dayRuns.clear();
    this.monthRuns.clear();
    this.tails.clear();
  }
}
