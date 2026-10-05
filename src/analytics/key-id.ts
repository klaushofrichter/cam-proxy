import { createHash } from 'crypto';

// Which API key a usage row was counted against (spec 2026-10-05-multi-camera-host-design §5.1):
// the first 12 hex digits of its SHA-256. Never the key, never reversible to it.
export function keyId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}
