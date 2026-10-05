import type { CameraBlock } from './cameras';
import { writable } from 'svelte/store';
import { api } from './api';
import type { UiProviderState } from './analytics';
import type { CameraReboot, PoeSwitchStatus } from './maintenance';
import type { RecordingsStatus } from './recordings';
import type { CameraFtp, ClipsStall } from './ftp';
import type { UiHealth } from './health';
import type { UiArchive } from './archive';

export interface Status {
  version: string;
  camera: { name?: string; nameSource?: 'camera' | 'config'; online: boolean; since: number; model?: string; firmware?: string; clockOffsetMs?: number; error?: string; webUiUrl?: string | null; reboot?: CameraReboot | null; poeSwitch?: PoeSwitchStatus };
  intake: { onvif: string; since: number; source: string; lastError?: string; resubscribes: number };
  sse: { clients: number };
  stream: { enabled: boolean; up: boolean; go2rtcUp: boolean; lastFrameTs: number | null };
  retention: { lastRun: number | null; totals: Record<string, number> };
  storage: { paused: boolean };
  analytics?: UiProviderState[];
  analyticsUnmapped?: { mid: string; name: string; count: number; lastSeen: number }[];
  ftp: { enabled: boolean; listening: boolean; port: number; tls: boolean; publicHost: string | null; passwordSet: boolean; lastUpload: number | null; lastClip: number | null; clips: number; failures: number; camera?: CameraFtp | null; stalled?: ClipsStall | null };
  recordings?: RecordingsStatus;
  health?: UiHealth; // the health summary (spec 2026-10-03-health-summary-design)
  archive?: UiArchive; // spec 2026-10-05-archive-design §6
  cameras?: CameraBlock[]; // every camera, config order (spec 2026-10-05-multi-camera-host-design §6.3); absent from an older proxy
}
export interface Usage { bytes: number; files: number; oldest: number | null; newest: number | null; growthPerDay: number }
export interface Stats {
  disk: { catalog: Usage; audit: Usage; stills: Usage; previews: Usage; clips: Usage; recordings?: Usage; free: number; size: number };
  events: { stored: Record<string, number> };
  stream: { rows: number; lastId: number };
  sse: { clients: number };
  storage: { budget: number; used: number; daysUntilFull: number | null; paused: boolean };
}
export interface FeedItem { id: number; type: string; data: Record<string, unknown>; at: number }

export const status = writable<Status | null>(null);
export const stats = writable<Stats | null>(null);
// The live stream (newest first, capped), from /api/stream with the session
// cookie. EventSource resumes with Last-Event-ID by itself after a drop.
export const feed = writable<FeedItem[]>([]);

// When the status last arrived, for the top bar's "updated … ago".
export const updatedAt = writable<number | null>(null);
// The top bar's Refresh: pages reload their own data when this changes.
export const refreshTick = writable(0);

export function refreshNow(): void {
  void refresh();
  refreshTick.update((n) => n + 1);
}

// One status+stats fetch at a time: a refresh asked for while one runs (a
// burst of stream events) is one more fetch after it, shared by all who asked.
let inflight: Promise<void> | null = null;
let again: Promise<void> | null = null;
export function refresh(): Promise<void> {
  if (inflight) {
    again ??= inflight.then(() => {
      again = null;
      return refresh();
    });
    return again;
  }
  inflight = load().finally(() => (inflight = null));
  return inflight;
}

async function load(): Promise<void> {
  try {
    const [s, st] = await Promise.all([api<Status>('GET', '/control/status'), api<Stats>('GET', '/control/stats')]);
    status.set(s);
    stats.set(st);
    updatedAt.set(Date.now());
  } catch {
    // a 401 flips loggedIn; anything else keeps the last values
  }
}

let source: EventSource | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export function connect(): void {
  if (source) return;
  void refresh();
  // A hidden tab skips the timer and catches up when it is shown again.
  timer = setInterval(() => document.visibilityState !== 'hidden' && void refresh(), 5000);
  document.addEventListener('visibilitychange', onVisible);
  source = new EventSource('/api/stream', { withCredentials: true });
  for (const type of ['camera-event', 'camera-status', 'clip', 'annotation', 'analysis', 'camera', 'archive']) {
    source.addEventListener(type, (ev) => {
      const e = ev as MessageEvent;
      feed.update((list) => [{ id: Number(e.lastEventId), type, data: JSON.parse(e.data), at: Date.now() }, ...list].slice(0, 300));
      void refresh();
    });
  }
}

function onVisible(): void {
  if (document.visibilityState === 'visible') void refresh();
}

export function disconnect(): void {
  document.removeEventListener('visibilitychange', onVisible);
  source?.close();
  source = null;
  if (timer) clearInterval(timer);
  timer = null;
}
