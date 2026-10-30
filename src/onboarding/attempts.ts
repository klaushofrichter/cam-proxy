// Password attempts per camera address (spec 2026-10-30-camera-onboarding-design
// §4.1): a script retrying a wrong password must not lock the camera's
// account. Shared by the password API, the probe with a password and the add;
// a refused take never reaches the camera. Keyed by the resolved IPv4 address
// (resolveAttemptKey), so other spellings of one address share the limit.
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { bareHost, splitHost } from '../camera/http';

export const PASSWORD_ATTEMPTS = 5;
export const PASSWORD_WINDOW_MS = 600_000;
// At most this many addresses are tracked. Expired ones make room; with every
// one live, a new address is refused (never a live key evicted: a flood of
// made-up addresses must not reset a real one).
const MAX_KEYS = 1024;

export const attemptKey = (host: string): string => bareHost(splitHost(host).hostname).toLowerCase();

// The address the camera's name or address resolves to (IPv4 first), the
// limit's key; a name that does not resolve keeps its own spelling (nothing
// can be sent to it either).
export async function resolveAttemptKey(host: string): Promise<string> {
  const h = attemptKey(host);
  if (isIP(h)) return h;
  try {
    return (await lookup(h, { family: 4 })).address;
  } catch {
    try {
      return (await lookup(h)).address.toLowerCase();
    } catch {
      return h;
    }
  }
}

export class PasswordAttempts {
  private readonly seen = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now, private readonly maxKeys = MAX_KEYS) {}

  // One attempt at `key` (a resolved address, or an address/name with an optional :port): ok counts it.
  take(key0: string): { ok: true } | { ok: false; retryAfterS: number } {
    const key = attemptKey(key0);
    const t = this.now();
    const live = (x: number) => t - x < PASSWORD_WINDOW_MS;
    const recent = (this.seen.get(key) ?? []).filter(live);
    const retry = (first: number) => Math.max(1, Math.ceil((first + PASSWORD_WINDOW_MS - t) / 1000));
    if (recent.length >= PASSWORD_ATTEMPTS) {
      this.seen.set(key, recent);
      return { ok: false, retryAfterS: retry(recent[0]) };
    }
    if (!this.seen.has(key) && this.seen.size >= this.maxKeys) {
      for (const [k, v] of this.seen) if (!v.some(live)) this.seen.delete(k);
      if (this.seen.size >= this.maxKeys) {
        const oldest = Math.min(...[...this.seen.values()].map((v) => Math.max(...v)));
        return { ok: false, retryAfterS: retry(oldest) };
      }
    }
    recent.push(t);
    this.seen.set(key, recent);
    return { ok: true };
  }
}
