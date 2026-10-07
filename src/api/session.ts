import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

// Admin UI sessions (from cam-sim): `v2.<expiresMs>.<l|m~tok_…>.<hmac>`, signed with
// a per-process secret, so a restart signs everyone out and the cookie never
// carries the token. `l`/`m`: signed in with local admin rights (the admin
// token, or a link it minted) or managed ones (a cams-admin-managed admin
// token, or a link it minted); only local sessions widen the command policy
// (migration P2, Ruling R2-3).
export const SESSION_COOKIE = 'camproxy_session';
export const SESSION_MS = 12 * 3600_000;
export type SessionOrigin = 'local' | 'managed';
export type SessionInfo = { origin: 'local' } | { origin: 'managed'; tokenId: string };

export function createSessionSigner(secret: Buffer = randomBytes(32), ttlMs = SESSION_MS) {
  const mac = (payload: string) => createHmac('sha256', secret).update(payload).digest('hex');
  return {
    // A managed session names the managed admin token that started it: it
    // ends when that token is blocked, removed or retired (checked per request).
    issue(origin: SessionOrigin, tokenId?: string): string {
      const o = origin === 'local' ? 'l' : `m~${tokenId ?? ''}`;
      const payload = `v2.${Date.now() + ttlMs}.${o}`;
      return `${payload}.${mac(payload)}`;
    },
    verify(value: string | undefined): SessionInfo | null {
      const m = /^(v2\.(\d{1,15})\.(l|m~tok_[0-9A-HJKMNP-TV-Z]{20}))\.([0-9a-f]{64})$/.exec(value ?? '');
      if (!m) return null;
      const want = Buffer.from(mac(m[1]), 'hex');
      const got = Buffer.from(m[4], 'hex');
      if (want.length !== got.length || !timingSafeEqual(want, got) || Number(m[2]) <= Date.now()) return null;
      return m[3] === 'l' ? { origin: 'local' } : { origin: 'managed', tokenId: m[3].slice(2) };
    },
  };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
