import type { MoveEvent } from '../moves/types';

// A camera's power-cycle asked for from this proxy's Maintenance page (spec
// 2026-11-07-poe-switches-design, "Asking from a proxy"): cams-admin answers
// with camera.power.cycle.result. Never a force from a proxy.
// askedAt (ms, #364 m5): when it was asked (cams-admin ignores one asked over 5 minutes ago).
export interface PowerCycleRequestEvent { kind: 'camera.power.cycle.request'; camera: string; requestId: string; askedAt: number }
// The event bodies this proxy sends, without proxyId and connId.
export type AdminEvent = MoveEvent | PowerCycleRequestEvent;

// Signed events that are not answers to a command (camera moves, power-cycle requests): sent at
// once while connected, else buffered, the newest MAX kept (oldest dropped,
// logged), and flushed in order after the next welcome. The client adds proxyId
// and connId when it sends; the buffer outlives a client (it belongs to CamsAdmin).
export const OUTBOX_MAX = 256;

export class EventOutbox {
  private q: { e: AdminEvent; valid?: () => boolean }[] = [];
  private dropped = 0;
  constructor(private readonly log: { warn(o: object, m: string): void } = { warn() {} }, private readonly max = OUTBOX_MAX) {}

  // valid: whether the event still means something when it can go out; one
  // that no longer does is dropped at the flush (a power-cycle request the
  // page already gave up on after 5 minutes must not cut a camera's PoE late, #364).
  push(e: AdminEvent, valid?: () => boolean): void {
    this.q.push(valid ? { e, valid } : { e });
    if (this.q.length > this.max) {
      this.q.shift();
      // One line per burst, not one per event: the count so far.
      if (this.dropped++ === 0) this.log.warn({ max: this.max }, 'admin_event_dropped');
    }
  }

  // Sends the oldest first; stops at the first one the socket cannot take.
  flush(send: (e: AdminEvent) => boolean): void {
    if (this.dropped) {
      this.log.warn({ dropped: this.dropped }, 'admin_event_dropped');
      this.dropped = 0;
    }
    while (this.q.length) {
      const { e, valid } = this.q[0];
      if (valid && !valid()) {
        this.q.shift();
        this.log.warn({ kind: e.kind }, 'admin_event_expired');
        continue;
      }
      if (!send(e)) break;
      this.q.shift();
    }
  }

  size(): number {
    return this.q.length;
  }
}
