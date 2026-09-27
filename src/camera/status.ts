import { EventEmitter } from 'events';
import { CameraError, type ReolinkClient } from './client';

export interface CameraState {
  online: boolean;
  since: number; // when `online` last changed (ms)
  model?: string;
  firmware?: string;
  clockOffsetMs?: number; // camera clock minus proxy clock
  error?: string; // why the last check failed (never contains credentials)
}

interface GetTime {
  Time?: { year: number; mon: number; day: number; hour: number; min: number; sec: number; timeZone?: number };
  Dst?: { enable?: number; offset?: number };
}

// Camera clock minus ours. The camera gives local wall time, its zone
// (seconds west of UTC) and whether it observes DST; we don't know whether
// DST is in effect right now, so take the reading closest to our clock.
export function clockOffset(t: GetTime, now: number): number | undefined {
  const x = t.Time;
  if (!x) return undefined;
  const wall = Date.UTC(x.year, x.mon - 1, x.day, x.hour, x.min, x.sec);
  const std = wall + (x.timeZone ?? 0) * 1000;
  const candidates = [std];
  if (t.Dst?.enable === 1) candidates.push(std - (t.Dst.offset ?? 1) * 3600_000);
  return candidates.map((c) => c - now).reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
}

// Checks the camera every `intervalS`. Two failures in a row mean offline, one
// success means online; 'change' fires only when `online` flips.
export class StatusPoller extends EventEmitter {
  private current: CameraState;
  private failures = 0;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<CameraState> | undefined;

  constructor(
    private readonly client: ReolinkClient,
    private readonly intervalS: number,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.current = { online: false, since: this.now() };
  }

  state(): CameraState {
    return { ...this.current };
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      void this.checkNow().finally(() => {
        if (this.timer) this.timer = setTimeout(tick, this.intervalS * 1000);
      });
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // One check; concurrent callers share it.
  checkNow(): Promise<CameraState> {
    this.running ??= this.check().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  // Emits 'check' ({ok, ms, error?}) after every check, for metrics.
  private async check(): Promise<CameraState> {
    const t0 = this.now();
    try {
      const status = await this.client.status();
      const time = await this.client.command<GetTime>('GetTime');
      this.failures = 0;
      this.set({ online: true, model: status.model, firmware: status.firmware, clockOffsetMs: clockOffset(time, this.now()), error: undefined });
      this.emit('check', { ok: true, ms: this.now() - t0 });
    } catch (err) {
      this.failures++;
      const error = err instanceof CameraError ? err.code : 'camera_error';
      if (this.failures >= 2 || !this.current.online) this.set({ ...this.current, online: false, error });
      else this.current = { ...this.current, error };
      this.emit('check', { ok: false, ms: this.now() - t0, error });
    }
    return this.state();
  }

  private set(next: Omit<CameraState, 'since'>): void {
    const flipped = next.online !== this.current.online;
    const since = flipped ? this.now() : this.current.since;
    this.current = { ...next, since };
    if (flipped) this.emit('change', this.state());
  }
}
