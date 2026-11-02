// web/src/lib/recordings.ts
// The Status page's "Recordings (SD card)" card (spec: the last Baichuan
// result and when; the cache fill).
import { agoText, MB, mbText } from './format';

// priority low: an inventory repair's download, not a viewer's (#111).
export interface RecordingsLast { at: number; result: string; stream: 'main' | 'sub'; bytes: number; ms: number; priority?: 'high' | 'low' }
// Which way downloads go (src/recordings/download-path.ts): Baichuan, or HTTP
// Download for a camera that refuses Baichuan (the E1 Outdoor Pro).
export interface DownloadPathStatus {
  path: 'baichuan' | 'http';
  since: number | null;
  baichuanRefusal: { at: number; status: number | null; detail: string } | null;
  retryBaichuanAt: number | null;
}
// download: absent from a proxy older than the HTTP fallback.
export interface RecordingsStatus { last: RecordingsLast | null; cache: { bytes: number; files: number; capBytes: number }; download?: DownloadPathStatus }

const WORDS: Record<string, string> = { offline: 'offline', auth: 'login rejected', refused: 'refused', not_found: 'not found', timeout: 'timed out', protocol: 'protocol error' };
export const resultWord = (r: string): string => WORDS[r] ?? r;

export function recordingsLastText(last: RecordingsLast | null, now = Date.now()): string {
  if (!last) return '—';
  const head = `${resultWord(last.result)}, ${agoText(last.at, now)}`;
  const repair = last.priority === 'low';
  if (last.result === 'ok') return `${head} (${last.stream}, ${mbText(last.bytes)} in ${(last.ms / 1000).toFixed(1)} s${repair ? '; inventory repair' : ''})`;
  return repair ? `${head} (inventory repair)` : head;
}

// Grey before the first download (nothing is broken) and for a recording the
// camera had already overwritten (not_found). Amber for timeout/offline:
// downloads are on demand, so one transient failure would stay red until the
// next play. Red for auth, refused and protocol.
export function recordingsClass(last: RecordingsLast | null): '' | 'ok' | 'warn' | 'bad' {
  if (!last || last.result === 'not_found') return '';
  if (last.result === 'ok') return 'ok';
  return last.result === 'timeout' || last.result === 'offline' ? 'warn' : 'bad';
}

export function cacheFillText(c: RecordingsStatus['cache']): string {
  const used = c.files > 0 && c.bytes < MB ? '<1' : String(Math.round(c.bytes / MB));
  return `${used} MB of ${Math.round(c.capBytes / MB)} MB`;
}

// The "Download path" row: the path, and in the title the camera's Baichuan
// refusal (on HTTP: and when Baichuan is tried again).
export function downloadPathText(d: DownloadPathStatus | undefined, now = Date.now()): { text: string; title: string | undefined } {
  if (!d) return { text: '—', title: undefined };
  const r = d.baichuanRefusal;
  if (d.path === 'baichuan') return { text: 'Baichuan', title: r ? `last refused ${agoText(r.at, now)}: ${r.detail}` : undefined };
  const retry = d.retryBaichuanAt === null ? '' : `; tried again in ${Math.max(0, Math.round((d.retryBaichuanAt - now) / 3600_000))} h`;
  return { text: 'HTTP (the camera refuses Baichuan)', title: r ? `Baichuan refused: ${r.detail}${retry}` : undefined };
}
