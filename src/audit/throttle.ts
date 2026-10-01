// One auth-refused record per source IP and path per window (spec: 10 min);
// the refusals in between are counted and reported with the next record.
export class RefusalThrottle {
  private seen = new Map<string, { at: number; suppressed: number }>();
  constructor(private readonly windowMs = 600_000, private readonly now: () => number = Date.now) {}
  take(ip: string, path: string): { record: boolean; suppressed: number } {
    const k = `${ip} ${path}`;
    const t = this.now();
    const s = this.seen.get(k);
    if (s && t - s.at < this.windowMs) { s.suppressed++; return { record: false, suppressed: 0 }; }
    this.seen.set(k, { at: t, suppressed: 0 });
    if (this.seen.size > 10_000) for (const [key, v] of this.seen) if (t - v.at >= this.windowMs) this.seen.delete(key);
    return { record: true, suppressed: s?.suppressed ?? 0 };
  }
}
