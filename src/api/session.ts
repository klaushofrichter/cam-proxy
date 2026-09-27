import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

// Admin UI sessions (from cam-sim): `v1.<expiresMs>.<hmac>`, signed with a
// per-process secret, so a restart signs everyone out and the cookie never
// carries the token.
export const SESSION_COOKIE = 'camproxy_session';
export const SESSION_MS = 12 * 3600_000;

export function createSessionSigner(secret: Buffer = randomBytes(32), ttlMs = SESSION_MS) {
  const mac = (payload: string) => createHmac('sha256', secret).update(payload).digest('hex');
  return {
    issue(): string {
      const payload = `v1.${Date.now() + ttlMs}`;
      return `${payload}.${mac(payload)}`;
    },
    verify(value: string | undefined): boolean {
      const m = /^(v1\.(\d{1,15}))\.([0-9a-f]{64})$/.exec(value ?? '');
      if (!m) return false;
      const want = Buffer.from(mac(m[1]), 'hex');
      const got = Buffer.from(m[3], 'hex');
      return want.length === got.length && timingSafeEqual(want, got) && Number(m[2]) > Date.now();
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
