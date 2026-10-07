import { CameraError } from './client';
import { logger } from '../log';
import { HOUR } from '../time-units';

// Issue #199: on 2026-10-06 06:14:57 cam1's 30 GB SD card filled and, with
// the recording setting `overwrite` 0, the camera stopped recording to it.
// FTP uploads went on, so nothing looked wrong for 28 h. The proxy reads the
// card (GetHddInfo) and the recording settings (GetRecV20) every few minutes,
// read-only: it never changes them. The health summary decides what is a
// problem (src/health/summary.ts).

// What the camera says about its card and its recording to it.
export interface SdReading {
  present: boolean; // a card in the HddInfo list
  mounted: boolean;
  formatted: boolean;
  capacityMB: number | null; // the card's size
  freeMB: number | null; // GetHddInfo `size` is the FREE space (measured)
  overwrite: boolean | null; // Rec.overwrite: the oldest recordings go when the card is full
  recordingEnabled: boolean | null; // Rec.enable
}

export interface SdView extends SdReading {
  checkedAt: number; // the last successful read
  error: string | null; // why the last read failed
  // The "recording to SD stopped" check: the newest FTP clip when the card was
  // searched (null: not compared), the newest SD recording's end found, and
  // where that search started (null: no search).
  lastClipAt: number | null;
  lastRecordingAt: number | null;
  recordingsFrom: number | null;
}

export const SD_CHECK_MS = 5 * 60_000;
// The newest SD recording is looked for this far back once none is found near the newest clip.
export const SD_STALL_LOOKBACK_MS = 48 * HOUR;
// Recordings are looked for from this long before the newest clip.
const NEAR_CLIP_MS = HOUR;

const flag = (v: unknown): boolean | null => (v === 0 || v === 1 ? v === 1 : null);
const mb = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

// The values of GetHddInfo ({HddInfo: [...]}) and GetRecV20 ({Rec: {...}}).
export function parseSd(hdd: unknown, rec: unknown): SdReading {
  const list = (hdd as { HddInfo?: unknown } | null)?.HddInfo;
  if (!Array.isArray(list)) throw new CameraError('camera_error', 'GetHddInfo returned no HddInfo list');
  const r = (rec as { Rec?: unknown } | null)?.Rec;
  if (!r || typeof r !== 'object') throw new CameraError('camera_error', 'GetRecV20 returned no Rec object');
  const card = list.find((x) => x && typeof x === 'object' && ((x as { number?: unknown }).number ?? 0) === 0) as Record<string, unknown> | undefined;
  const { overwrite, enable } = r as Record<string, unknown>;
  return {
    present: !!card,
    mounted: card?.mount === 1,
    formatted: card?.format === 1,
    capacityMB: mb(card?.capacity),
    freeMB: mb(card?.size),
    overwrite: flag(overwrite),
    recordingEnabled: flag(enable),
  };
}

export async function readCameraSd(client: { command: (cmd: string, param?: object) => Promise<unknown> }): Promise<SdReading> {
  const hdd = await client.command('GetHddInfo', {});
  const rec = await client.command('GetRecV20', { channel: 0 });
  return parseSd(hdd, rec);
}

export class SdWatch {
  private current: SdView | null = null;
  private running: Promise<SdView | null> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(
    private readonly d: {
      read: () => Promise<SdReading>;
      active: () => boolean; // the camera online
      lastClip: () => number | null; // when the newest FTP clip arrived
      recordings: (from: number, to: number) => Promise<{ start: number; end: number }[]>; // the SD recordings overlapping [from, to]
      now?: () => number;
      everyMs?: number;
    },
  ) {
    this.now = d.now ?? Date.now;
  }

  // null until the first successful read.
  view(): SdView | null {
    return this.current ? { ...this.current } : null;
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      void this.checkNow().finally(() => {
        if (this.timer) this.timer = setTimeout(tick, this.d.everyMs ?? SD_CHECK_MS);
      });
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  // One read; concurrent callers share it.
  checkNow(): Promise<SdView | null> {
    this.running ??= this.check().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async check(): Promise<SdView | null> {
    if (!this.d.active()) return this.view();
    let r: SdReading;
    try {
      r = await this.d.read();
    } catch (err) {
      if (this.current) this.current = { ...this.current, error: err instanceof CameraError ? err.code : (err as Error).message };
      return this.view();
    }
    const at = this.now();
    const before = this.current;
    this.current = { ...r, checkedAt: at, error: null, ...(await this.newest(r, at)) };
    if (before?.overwrite !== r.overwrite && r.overwrite === false) logger.warn('camera_sd_overwrite_off');
    return this.view();
  }

  // The newest SD recording near the newest clip, else within SD_STALL_LOOKBACK_MS.
  // Only while the card can record and a clip came within that time; a failed search compares nothing.
  private async newest(r: SdReading, now: number): Promise<Pick<SdView, 'lastClipAt' | 'lastRecordingAt' | 'recordingsFrom'>> {
    const none = { lastClipAt: null, lastRecordingAt: null, recordingsFrom: null };
    const clip = this.d.lastClip();
    if (!r.present || !r.mounted || !r.formatted || r.recordingEnabled === false || clip === null || now - clip > SD_STALL_LOOKBACK_MS) return none;
    const newestEnd = (list: { end: number }[]) => (list.length ? Math.max(...list.map((x) => x.end)) : null);
    try {
      const near = clip - NEAR_CLIP_MS;
      const recent = newestEnd(await this.d.recordings(near, now));
      if (recent !== null) return { lastClipAt: clip, lastRecordingAt: recent, recordingsFrom: near };
      const from = now - SD_STALL_LOOKBACK_MS;
      return { lastClipAt: clip, lastRecordingAt: newestEnd(await this.d.recordings(from, near)), recordingsFrom: from };
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'camera_sd_search_failed');
      return none;
    }
  }
}
