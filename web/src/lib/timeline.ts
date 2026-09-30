// The Timeline's minute view (Klaus, 2026-09-30): it opens under its hour,
// steps ◀ ▶ within that hour only, and marks the seconds of its events.

export interface TimelineEvent {
  id: number;
  kind: string;
  start: number;
  end: number | null; // null: still open
}

// The neighbouring minute of the same hour that has previews, or null at the
// hour's first or last one (no crossing into another hour).
export function stepMinute(hour: { minute: number }[], current: number, dir: -1 | 1): number | null {
  const i = hour.findIndex((m) => m.minute === current);
  if (i < 0) return null;
  return hour[i + dir]?.minute ?? null;
}

// The events that overlap a minute, by start. An open event runs to `now`.
export function eventsInMinute(m: { minute: number }, events: TimelineEvent[], now: number): TimelineEvent[] {
  return events
    .filter((e) => e.start < m.minute + 60_000 && (e.end ?? now) >= m.minute)
    .sort((a, b) => a.start - b.start || a.id - b.id);
}

const PRIORITY = ['person', 'vehicle', 'pet', 'motion'];
const rank = (k: string) => {
  const i = PRIORITY.indexOf(k);
  return i < 0 ? PRIORITY.length : i;
};

// For each tile of the minute, the kind of the event covering it (person
// before vehicle, pet, motion), or null.
export function secondKinds(m: { minute: number; intervalS: number; present: boolean[] }, events: TimelineEvent[], now: number): (string | null)[] {
  const list = eventsInMinute(m, events, now);
  return m.present.map((_, i) => {
    const from = m.minute + i * m.intervalS * 1000;
    const to = from + m.intervalS * 1000 - 1;
    let best: string | null = null;
    for (const e of list) {
      if (e.start <= to && (e.end ?? now) >= from && (best === null || rank(e.kind) < rank(best))) best = e.kind;
    }
    return best;
  });
}
