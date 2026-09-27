import { writable } from 'svelte/store';
import { api } from './api';

export interface Status {
  version: string;
  camera: { online: boolean; since: number; model?: string; firmware?: string; clockOffsetMs?: number; error?: string; webUiUrl?: string | null };
  intake: { onvif: string; since: number; source: string; lastError?: string; resubscribes: number };
  sse: { clients: number };
  stream: { enabled: boolean; up: boolean; go2rtcUp: boolean; lastFrameTs: number | null };
  retention: { lastRun: number | null; totals: Record<string, number> };
  storage: { paused: boolean };
  ftp: { enabled: boolean; listening: boolean; port: number; tls: boolean; publicHost: string | null; passwordSet: boolean; lastUpload: number | null; lastClip: number | null; clips: number; failures: number };
}
export interface Usage { bytes: number; files: number; oldest: number | null; newest: number | null; growthPerDay: number }
export interface Stats {
  disk: { catalog: Usage; stills: Usage; previews: Usage; clips: Usage; free: number; size: number };
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

export async function refresh(): Promise<void> {
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
  timer = setInterval(() => void refresh(), 5000);
  source = new EventSource('/api/stream', { withCredentials: true });
  for (const type of ['camera-event', 'camera-status', 'clip', 'annotation']) {
    source.addEventListener(type, (ev) => {
      const e = ev as MessageEvent;
      feed.update((list) => [{ id: Number(e.lastEventId), type, data: JSON.parse(e.data), at: Date.now() }, ...list].slice(0, 300));
      void refresh();
    });
  }
}

export function disconnect(): void {
  source?.close();
  source = null;
  if (timer) clearInterval(timer);
  timer = null;
}
