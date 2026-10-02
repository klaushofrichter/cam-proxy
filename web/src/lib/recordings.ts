// web/src/lib/recordings.ts
// The Status page's "Recordings (SD card)" card (spec: the last Baichuan
// result and when; the cache fill).
import { agoText, MB, mbText } from './format';

export interface RecordingsLast { at: number; result: string; stream: 'main' | 'sub'; bytes: number; ms: number }
export interface RecordingsStatus { last: RecordingsLast | null; cache: { bytes: number; files: number; capBytes: number } }

const WORDS: Record<string, string> = { offline: 'offline', auth: 'login rejected', refused: 'refused', not_found: 'not found', timeout: 'timed out', protocol: 'protocol error' };
export const resultWord = (r: string): string => WORDS[r] ?? r;

export function recordingsLastText(last: RecordingsLast | null, now = Date.now()): string {
  if (!last) return '—';
  const head = `${resultWord(last.result)}, ${agoText(last.at, now)}`;
  return last.result === 'ok' ? `${head} (${last.stream}, ${mbText(last.bytes)} in ${(last.ms / 1000).toFixed(1)} s)` : head;
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
