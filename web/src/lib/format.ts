// Shared display helpers for the admin UI.

// Days until the storage budget is full: past a year only that, as in the
// storage-daily message (#78); slow growth gives six-figure day counts.
export function daysUntilFullText(days: number | null): string {
  if (days === null) return '—';
  const d = Math.round(days);
  return d > 365 ? 'more than a year' : String(d);
}
