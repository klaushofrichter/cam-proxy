// One camera's move lease (spec 2026-10-30-ptz-capabilities-design §5.1): a
// move runs for its duration and is then stopped, unless another move comes
// first and replaces it. A client that goes away therefore leaves the camera
// stopped within 2 s. All of the camera's PTZ commands run one after another,
// so a Stop never overtakes the move it ends (the camera client sends up to
// two requests at once).
import { errorMessage, logger } from '../log';

export interface LeaseDeps {
  stop: () => Promise<void>; // the camera's Stop
  schedule?: (ms: number, fn: () => void) => () => void; // test seam; default setTimeout + unref
  retryMs?: number; // a failed timer Stop is retried once after this (default 250)
}

// The longest a move may run without a new call (spec §5.1).
export const MAX_LEASE_MS = 2000;

const noop = () => undefined;

function defaultSchedule(ms: number, fn: () => void): () => void {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
}

export class MoveLease {
  private chain: Promise<void> = Promise.resolve();
  private cancelTimer: (() => void) | undefined;
  private moving = false;
  // Bumped by every move, stop and then: a late failure or retry of an older
  // one never stops a newer move.
  private gen = 0;
  // A move was sent and no Stop has succeeded since (a failed Stop's retry may
  // still be pending while `moving` is already false).
  private unstopped = false;
  private readonly schedule: (ms: number, fn: () => void) => () => void;
  // The camera's Stop; a success means nothing is moving any more.
  private readonly stopCmd: () => Promise<void>;

  constructor(private readonly d: LeaseDeps) {
    this.schedule = d.schedule ?? defaultSchedule;
    this.stopCmd = async () => {
      await d.stop();
      this.unstopped = false;
    };
  }

  // Commands waiting or running; none: the next one starts at once (in this
  // tick), so a later move can only supersede one that has not started yet.
  private pending = 0;

  private queue(fn: () => Promise<void>): Promise<void> {
    this.pending++;
    const p = this.pending === 1 ? (async () => fn())() : this.chain.then(fn);
    const settled = p.then(noop, noop).then(() => void this.pending--);
    this.chain = settled;
    return p;
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  // Starts (or replaces) a move; it is stopped after durationMs (at most 2 s).
  move(start: () => Promise<void>, durationMs: number): Promise<void> {
    this.clearTimer();
    const gen = ++this.gen;
    this.moving = true;
    // A move superseded while it waited in the queue is dropped: a hold over a
    // slow camera must not pile up moves that run on after it ended.
    const p = this.queue(async () => {
      if (gen !== this.gen) return;
      this.unstopped = true;
      await start();
    });
    this.cancelTimer = this.schedule(Math.min(durationMs, MAX_LEASE_MS), () => {
      this.cancelTimer = undefined;
      if (gen === this.gen) this.timerStop(gen);
    });
    p.catch(() => {
      if (gen !== this.gen) return;
      // The move may have started anyway: one best-effort Stop, and the lease ends.
      this.clearTimer();
      this.moving = false;
      this.queue(this.stopCmd).catch(noop);
    });
    return p;
  }

  private timerStop(gen: number): void {
    this.moving = false;
    this.queue(this.stopCmd).catch(() => {
      if (gen !== this.gen) return;
      this.cancelTimer = this.schedule(this.d.retryMs ?? 250, () => {
        this.cancelTimer = undefined;
        if (gen !== this.gen) return;
        this.queue(this.stopCmd).catch((err) => logger.warn({ err: errorMessage(err) }, 'ptz_stop_failed'));
      });
    });
  }

  // Stops at once (even when no move is known to run).
  stop(): Promise<void> {
    this.clearTimer();
    this.gen++;
    this.moving = false;
    return this.queue(this.stopCmd);
  }

  // Runs cmd after stopping a running move, with no Stop after it (a travel
  // to a position must not be cut short).
  then(cmd: () => Promise<void>): Promise<void> {
    this.clearTimer();
    this.gen++;
    if (this.moving) this.queue(this.stopCmd).catch(noop);
    this.moving = false;
    return this.queue(cmd);
  }

  active(): boolean {
    return this.moving;
  }

  // Whether the camera may still be moving: a move was sent and no Stop has
  // succeeded since (also while a failed Stop waits for its retry).
  needsStop(): boolean {
    return this.moving || this.unstopped;
  }
}
