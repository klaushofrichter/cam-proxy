import { randomBytes } from 'crypto';

// One-time sign-in links for the admin UI (Klaus, 2026-09-28). cams holds the
// admin token and mints a code server to server; the browser redeems it once
// for a UI session, so a signed-in cams user needn't paste the token. Codes
// live in memory (a restart drops them), expire quickly, and are never logged.
export const LINK_MS = 60_000;
const MAX_CODES = 100;

export function createLoginLinks(ttlMs = LINK_MS) {
  const codes = new Map<string, number>(); // code → expiry; Map keeps insertion order
  return {
    issue(): { code: string; expiresInS: number } {
      const code = randomBytes(24).toString('base64url');
      codes.set(code, Date.now() + ttlMs);
      while (codes.size > MAX_CODES) codes.delete(codes.keys().next().value as string);
      return { code, expiresInS: Math.round(ttlMs / 1000) };
    },
    consume(code: string | undefined): boolean {
      if (typeof code !== 'string') return false;
      const expires = codes.get(code);
      codes.delete(code);
      return expires !== undefined && expires > Date.now();
    },
  };
}
