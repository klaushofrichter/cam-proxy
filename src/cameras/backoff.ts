// Restart delays of a camera worker (spec 2026-10-05-multi-camera-host-design
// §3.3): 5 s doubling to 5 min, back to 5 s once the camera was healthy for
// 10 minutes.
export class Backoff {
  private n = 0;
  private readonly first: number;
  private readonly max: number;
  private readonly healthyMs: number;

  constructor(o: { firstMs?: number; maxMs?: number; healthyMs?: number } = {}) {
    this.first = o.firstMs ?? 5000;
    this.max = o.maxMs ?? 300_000;
    this.healthyMs = o.healthyMs ?? 600_000;
  }

  next(): number {
    const ms = Math.min(this.max, this.first * 2 ** this.n);
    if (ms < this.max) this.n++;
    return ms;
  }

  healthy(sinceMs: number, now: number): void {
    if (now - sinceMs >= this.healthyMs) this.reset();
  }

  reset(): void {
    this.n = 0;
  }
}
