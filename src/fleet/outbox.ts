import type { MoveEvent } from '../moves/types';

// Signed events that are not answers to a command (camera moves): sent at
// once while connected, else buffered, the newest MAX kept (oldest dropped,
// logged), and flushed in order after the next welcome. The client adds proxyId
// and connId when it sends; the buffer outlives a client (it belongs to CamsAdmin).
export const OUTBOX_MAX = 256;

export class EventOutbox {
  private q: MoveEvent[] = [];
  private dropped = 0;
  constructor(private readonly log: { warn(o: object, m: string): void } = { warn() {} }, private readonly max = OUTBOX_MAX) {}

  push(e: MoveEvent): void {
    this.q.push(e);
    if (this.q.length > this.max) {
      this.q.shift();
      // One line per burst, not one per event: the count so far.
      if (this.dropped++ === 0) this.log.warn({ max: this.max }, 'admin_event_dropped');
    }
  }

  // Sends the oldest first; stops at the first one the socket cannot take.
  flush(send: (e: MoveEvent) => boolean): void {
    if (this.dropped) {
      this.log.warn({ dropped: this.dropped }, 'admin_event_dropped');
      this.dropped = 0;
    }
    while (this.q.length && send(this.q[0])) this.q.shift();
  }

  size(): number {
    return this.q.length;
  }
}
