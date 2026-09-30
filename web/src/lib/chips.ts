// A clip's event chips (Klaus, 2026-09-30): each kind once, with a count when
// the clip covers several ("motion ×3"), AI kinds first. The camera extends a
// recording while events keep coming, so one clip often covers several.
const ORDER = ['person', 'vehicle', 'pet', 'motion'];

export function clipChips(eventIds: number[], kinds: Record<number, string>): string[] {
  const counts = new Map<string, number>();
  for (const id of eventIds) {
    const k = kinds[id] ?? 'event';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const rank = (k: string) => {
    const i = ORDER.indexOf(k);
    return i < 0 ? ORDER.length : i;
  };
  return [...counts]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
}
