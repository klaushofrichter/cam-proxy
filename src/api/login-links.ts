import { randomBytes } from 'crypto';
import type { SessionOrigin } from './session';

// One-time sign-in links for the admin UI (Klaus, 2026-09-28). cams holds the
// admin token and mints a code server to server; the browser redeems it once
// for a UI session, so a signed-in cams user needn't paste the token. Codes
// live in memory (a restart drops them), expire quickly, and are never logged.
// A code keeps the origin of the rights that minted it (migration P2, R2-3):
// a link minted with a managed admin token gives a managed session.
const LINK_MS = 60_000;
const MAX_CODES = 100;

export function createLoginLinks(ttlMs = LINK_MS) {
  const codes = new Map<string, { expires: number; origin: SessionOrigin }>(); // Map keeps insertion order
  return {
    issue(origin: SessionOrigin): { code: string; expiresInS: number } {
      const code = randomBytes(24).toString('base64url');
      codes.set(code, { expires: Date.now() + ttlMs, origin });
      while (codes.size > MAX_CODES) codes.delete(codes.keys().next().value as string);
      return { code, expiresInS: Math.round(ttlMs / 1000) };
    },
    consume(code: string | undefined): SessionOrigin | null {
      if (typeof code !== 'string') return null;
      const c = codes.get(code);
      codes.delete(code);
      return c !== undefined && c.expires > Date.now() ? c.origin : null;
    },
  };
}
