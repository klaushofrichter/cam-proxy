// Shared display helpers for the admin UI.

// Days until the storage budget is full: past a year only that, as in the
// storage-daily message (#78); slow growth gives six-figure day counts.
export function daysUntilFullText(days: number | null): string {
  if (days === null) return '—';
  const d = Math.round(days);
  return d > 365 ? 'more than a year' : String(d);
}

export const MB = 1024 ** 2;

// "5 s ago", "2 min ago", "3 h ago"; — when there is no time.
export function agoText(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

export const mbText = (bytes: number): string => `${(bytes / MB).toFixed(1)} MB`;
