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

export const GB = 1024 ** 3;
// A size in the largest fitting unit: "1.5 GB", "12.0 MB", "3.2 kB", "512 B".
export function sizeText(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${Math.round(bytes)} B`;
}

export const pad2 = (n: number): string => String(n).padStart(2, '0');
// The browser's local date, YYYY-MM-DD (today by default), and time, HH:MM.
export const localDate = (ts = Date.now()): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
export const localHhmm = (ts: number): string => {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
