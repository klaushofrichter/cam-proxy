// web/src/lib/recordings.ts
// The Status page's "Recordings (SD card)" card (spec: the last Baichuan
// result and when; the cache fill).
export interface RecordingsLast { at: number; result: string; stream: 'main' | 'sub'; bytes: number; ms: number }
export interface RecordingsStatus { last: RecordingsLast | null; cache: { bytes: number; files: number; capBytes: number } }

const MB = 1024 ** 2;

function agoText(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

export function recordingsLastText(last: RecordingsLast | null, now = Date.now()): string {
  if (!last) return '—';
  const head = `${last.result}, ${agoText(last.at, now)}`;
  return last.result === 'ok' ? `${head} (${last.stream}, ${(last.bytes / MB).toFixed(1)} MB in ${(last.ms / 1000).toFixed(1)} s)` : head;
}

// Grey before the first download (nothing is broken) and for a recording the
// camera had already overwritten (not_found); red for real failures.
export function recordingsClass(last: RecordingsLast | null): '' | 'ok' | 'bad' {
  if (!last || last.result === 'not_found') return '';
  return last.result === 'ok' ? 'ok' : 'bad';
}

export function cacheFillText(c: RecordingsStatus['cache']): string {
  return `${Math.round(c.bytes / MB)} MB of ${Math.round(c.capBytes / MB)} MB`;
}
