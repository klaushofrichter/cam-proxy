// One record per source IP and key (a path, or a fixed name) per window
// (spec: 10 min for auth-refused); the ones in between are counted and
// reported with the next record. At most `cap` keys: at the cap, expired keys
// are pruned, then the oldest are evicted (a Map keeps insertion order, and a
// key is re-inserted when it starts a new window).
export class RefusalThrottle {
  private seen = new Map<string, { at: number; suppressed: number }>();
  constructor(
    private readonly windowMs = 600_000,
    private readonly now: () => number = Date.now,
    private readonly cap = 10_000,
  ) {}

  get size(): number {
    return this.seen.size;
  }

  take(ip: string, key: string): { record: boolean; suppressed: number } {
    const k = `${ip} ${key}`;
    const t = this.now();
    const s = this.seen.get(k);
    if (s && t - s.at < this.windowMs) { s.suppressed++; return { record: false, suppressed: 0 }; }
    this.seen.delete(k);
    if (this.seen.size >= this.cap) {
      for (const [x, v] of this.seen) if (t - v.at >= this.windowMs) this.seen.delete(x);
      for (const x of this.seen.keys()) {
        if (this.seen.size < this.cap) break;
        this.seen.delete(x);
      }
    }
    this.seen.set(k, { at: t, suppressed: 0 });
    return { record: true, suppressed: s?.suppressed ?? 0 };
  }
}

// At most `max` records per source IP per window; the overflow is counted into
// `suppressed` of the first record of the next window. Bounds a client that
// refuses on many different paths.
export class IpCap {
  private seen = new Map<string, { at: number; n: number; suppressed: number }>();
  constructor(
    private readonly max = 60,
    private readonly windowMs = 600_000,
    private readonly now: () => number = Date.now,
    private readonly cap = 10_000,
  ) {}

  take(ip: string): { record: boolean; suppressed: number } {
    const t = this.now();
    const s = this.seen.get(ip);
    if (s && t - s.at < this.windowMs) {
      if (s.n < this.max) { s.n++; return { record: true, suppressed: 0 }; }
      s.suppressed++;
      return { record: false, suppressed: 0 };
    }
    this.seen.delete(ip);
    if (this.seen.size >= this.cap) {
      for (const [x, v] of this.seen) if (t - v.at >= this.windowMs) this.seen.delete(x);
      for (const x of this.seen.keys()) {
        if (this.seen.size < this.cap) break;
        this.seen.delete(x);
      }
    }
    this.seen.set(ip, { at: t, n: 1, suppressed: 0 });
    return { record: true, suppressed: s?.suppressed ?? 0 };
  }
}
