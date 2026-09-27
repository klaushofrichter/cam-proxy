import type { Catalog } from '../catalog/db';
import { closeEvent, insertEvent, openEvents } from '../catalog/events';
import type { StreamLog } from '../stream/log';

type Source = 'onvif' | 'poll';

// ONVIF topic → event kind. Both motion topics are motion (merged by the
// intake); other topics keep their own name.
export function topicKind(topic: string): string | null {
  const last = topic.slice(topic.lastIndexOf('/') + 1);
  if (!last) return null;
  if (topic.endsWith('CellMotionDetector/Motion') || last === 'MotionAlarm') return 'motion';
  return { PeopleDetect: 'person', VehicleDetect: 'vehicle', DogCatDetect: 'pet' }[last] ?? last;
}

// Turns kind states into events: true opens one, false closes it. Each
// change goes to the catalog and to the stream log.
export class EventTracker {
  private readonly known = new Map<string, boolean>();

  constructor(
    private readonly c: Catalog,
    private readonly log: StreamLog,
    private readonly cam: string,
    private readonly opts: { maxOpenMin: number },
    private readonly now: () => number = Date.now,
  ) {}

  apply(source: Source, kind: string, state: boolean, ts: number, raw?: unknown): void {
    const was = this.known.get(kind) ?? false;
    this.known.set(kind, state);
    const open = openEvents(this.c, this.cam).find((e) => e.kind === kind);
    if (state && !was && !open) {
      const e = insertEvent(this.c, { cam: this.cam, source, kind, start_ts: ts, raw: raw ?? null });
      this.log.append(this.cam, 'camera-event', { eventId: e.id, kind, phase: 'start', ts, source });
    } else if (!state && open) {
      this.close(open.id, kind, Math.max(ts, open.start_ts), 'state', source);
    }
  }

  // The state at (re)subscription: taken as known, never an event of its own.
  // Events still open whose state is now false are closed.
  initialize(states: Record<string, boolean>, ts: number = this.now()): void {
    for (const [kind, state] of Object.entries(states)) this.known.set(kind, state);
    for (const e of openEvents(this.c, this.cam)) {
      if (states[e.kind] === false) this.close(e.id, e.kind, Math.max(ts, e.start_ts), 'state', e.source);
    }
  }

  // Closes events open longer than maxOpenMin.
  sweep(): void {
    const now = this.now();
    for (const e of openEvents(this.c, this.cam)) {
      if (now - e.start_ts > this.opts.maxOpenMin * 60_000) {
        this.known.set(e.kind, false);
        this.close(e.id, e.kind, now, 'timeout', e.source);
      }
    }
  }

  private close(id: number, kind: string, ts: number, reason: 'state' | 'timeout', source: Source): void {
    closeEvent(this.c, id, ts, reason);
    this.log.append(this.cam, 'camera-event', { eventId: id, kind, phase: 'end', ts, source, ...(reason === 'timeout' ? { reason } : {}) });
  }
}
