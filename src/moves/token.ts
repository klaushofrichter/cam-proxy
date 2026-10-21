import { createHash, timingSafeEqual } from 'crypto';

// The move token is stored as the contract's `sha256:<hex>` (never in clear on
// the source); a presented token is compared in constant time.
export const hashMoveToken = (plain: string): string => `sha256:${createHash('sha256').update(plain, 'utf8').digest('hex')}`;

export function moveTokenMatches(presented: string, stored: string): boolean {
  if (!/^sha256:[0-9a-f]{64}$/.test(stored)) return false;
  const a = Buffer.from(hashMoveToken(presented));
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}
