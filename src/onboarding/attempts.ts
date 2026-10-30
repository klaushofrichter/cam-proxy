// Password attempts per camera address (spec 2026-10-30-camera-onboarding-design
// §4.1): a script retrying a wrong password must not lock the camera's
// account. Shared by the password API, the probe with a password and the add;
// a refused take never reaches the camera.
import { bareHost, splitHost } from '../camera/http';

export const PASSWORD_ATTEMPTS = 5;
export const PASSWORD_WINDOW_MS = 600_000;
// At most this many addresses are tracked; the oldest goes first (a flood of made-up addresses can't grow it).
const MAX_KEYS = 1024;

export const attemptKey = (host: string): string => bareHost(splitHost(host).hostname).toLowerCase();

export class PasswordAttempts {
  private readonly seen = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  // One attempt at `host` (address or name, optional :port): ok counts it.
  take(host: string): { ok: true } | { ok: false; retryAfterS: number } {
    const key = attemptKey(host);
    const t = this.now();
    const recent = (this.seen.get(key) ?? []).filter((x) => t - x < PASSWORD_WINDOW_MS);
    if (recent.length >= PASSWORD_ATTEMPTS) {
      this.seen.set(key, recent);
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((recent[0] + PASSWORD_WINDOW_MS - t) / 1000)) };
    }
    recent.push(t);
    this.seen.delete(key);
    this.seen.set(key, recent);
    if (this.seen.size > MAX_KEYS) this.seen.delete(this.seen.keys().next().value!);
    return { ok: true };
  }
}
