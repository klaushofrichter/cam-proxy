import { createHash } from 'crypto';

// The pin format cams and cams-admin compare: SHA256: + the upper-case hex
// SHA-256 of the DER (Ruling P5-8).
export const sha256Pin = (der: Buffer): string => `SHA256:${createHash('sha256').update(der).digest('hex').toUpperCase()}`;
