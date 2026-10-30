// One camera's move lease (spec 2026-10-30-ptz-capabilities-design §5.1): a
// move runs for its duration and is then stopped, unless another move comes
// first and replaces it. A client that goes away therefore leaves the camera
// stopped within 2 s. All of the camera's PTZ commands run one after another,
// so a Stop never overtakes the move it ends (the camera client sends up to
// two requests at once).
//
// Zoom is special: while a zoom runs, the E1 refuses any further zoom, even
// the same direction (-13 "set config failed", measured 2026-10-30). So a
// zoom in the running zoom's direction only extends the lease, and one in the
// other direction sends Stop first. Moves and focus are re-sent every call.
import { errorMessage, logger } from '../log';

export interface LeaseDeps {
  stop: () => Promise<void>; // the camera's Stop
  schedule?: (ms: number, fn: () => void) => () => void; // test seam; default setTimeout + unref
  retryMs?: number; // a failed timer Stop is retried once after this (default 250)
}

// The longest a move may run without a new call (spec §5.1).
export const MAX_LEASE_MS = 2000;

const noop = () => undefined;

// A zoom's direction (any two values: in/out); absent for moves and focus.
export interface MoveOptions { zoom?: string }

function defaultSchedule(ms: number, fn: () => void): () => void {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
}

export class MoveLease {
  private chain: Promise<void> = Promise.resolve();
  private cancelTimer: (() => void) | undefined;
  private moving = false;
  // The zoom the camera runs now under the lease, and the call that started
  // it (a held zoom answers with that call's outcome).
  private zoom: { dir: string; started: Promise<void> } | undefined;
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
  // With opts.zoom: a zoom in the running zoom's direction sends nothing and
  // only re-arms the timer; one in the other direction sends Stop first.
  move(start: () => Promise<void>, durationMs: number, opts: MoveOptions = {}): Promise<void> {
    const running = this.moving ? this.zoom : undefined;
    if (opts.zoom !== undefined && running?.dir === opts.zoom) {
      this.clearTimer();
      this.arm(this.gen, durationMs);
      return running.started;
    }
    this.clearTimer();
    const gen = ++this.gen;
    this.moving = true;
    this.zoom = undefined;
    // The camera refuses a zoom while one runs: end the other direction first.
    if (opts.zoom !== undefined && running) this.queue(this.stopCmd).catch(noop);
    // A move superseded while it waited in the queue is dropped: a hold over a
    // slow camera must not pile up moves that run on after it ended.
    const p = this.queue(async () => {
      if (gen !== this.gen) return;
      this.unstopped = true;
      await start();
    });
    if (opts.zoom !== undefined) this.zoom = { dir: opts.zoom, started: p };
    this.arm(gen, durationMs);
    p.catch(() => {
      if (gen !== this.gen) return;
      // The move may have started anyway: one best-effort Stop, and the lease ends.
      this.clearTimer();
      this.moving = false;
      this.zoom = undefined;
      this.queue(this.stopCmd).catch(noop);
    });
    return p;
  }

  private arm(gen: number, durationMs: number): void {
    this.cancelTimer = this.schedule(Math.min(durationMs, MAX_LEASE_MS), () => {
      this.cancelTimer = undefined;
      if (gen === this.gen) this.timerStop(gen);
    });
  }

  private timerStop(gen: number): void {
    this.moving = false;
    this.zoom = undefined;
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
    this.zoom = undefined;
    return this.queue(this.stopCmd);
  }

  // Runs cmd after stopping a running move, with no Stop after it (a travel
  // to a position must not be cut short).
  then(cmd: () => Promise<void>): Promise<void> {
    this.clearTimer();
    this.gen++;
    if (this.moving) this.queue(this.stopCmd).catch(noop);
    this.moving = false;
    this.zoom = undefined;
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
