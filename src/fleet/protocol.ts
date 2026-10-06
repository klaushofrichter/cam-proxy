import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as nodeSign, verify as nodeVerify } from 'crypto';
import { isIP } from 'net';

// The cams-admin proxy protocol v1 (cams-admin contract/v1, spec
// 2026-10-06-cams-admin-phase1-design §8): Ed25519 with Node's crypto, the
// signed strings, enrollment codes, envelopes. No dependency.

// Crockford base32 (no I, L, O, U).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_TAG = 'CAE1';

// Case-insensitive, ignores dashes and spaces; Crockford's O→0, I/L→1.
export function normaliseCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!s.startsWith(CODE_TAG)) return null;
  const body = s.slice(CODE_TAG.length);
  if (!new RegExp(`^[${CROCKFORD}]{20}$`).test(body)) return null;
  return `${CODE_TAG}-${body.match(/.{4}/g)!.join('-')}`;
}

// The signed strings (§8.2, §8.3; contract/v1/vectors.json).
export const signedText = {
  enroll: (code: string, publicKey: string) => `cams-admin enroll v1\n${code}\n${publicKey}`,
  challenge: (connId: string, nonce: string, serverTime: number) => `cams-admin/v1 challenge\n${connId}\n${nonce}\n${serverTime}`,
  hello: (connId: string, nonce: string, proxyId: string, keyId: string, ts: number) => `cams-admin/v1 hello\n${connId}\n${nonce}\n${proxyId}\n${keyId}\n${ts}`,
};

// Keys travel as base64: public SPKI DER (44 bytes), private PKCS#8 DER.
export function generateKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') };
}

export function sign(privateKeyB64: string, text: string): string {
  const k = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  if (k.asymmetricKeyType !== 'ed25519') throw new Error('private key: not ed25519');
  return nodeSign(null, Buffer.from(text, 'utf8'), k).toString('base64');
}

// False for anything that is not a valid signature by this key (never throws).
export function verify(publicKeyB64: string, text: string, sig: unknown): boolean {
  if (typeof sig !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sig)) return false;
  try {
    const der = Buffer.from(publicKeyB64, 'base64');
    if (der.length !== 44) return false;
    const k = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (k.asymmetricKeyType !== 'ed25519') return false;
    return nodeVerify(null, Buffer.from(text, 'utf8'), k, Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
}

// What cams-admin shows for a key: SHA256: + upper-case hex of the SPKI DER.
export const fingerprint = (publicKeyB64: string): string => `SHA256:${createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').toUpperCase()}`;

// A ULID-shaped id: 10 time characters (ms) and 16 random.
export function ulid(now: number): string {
  let t = Math.max(0, Math.floor(now));
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const r = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[r[i] & 31];
  return time + rand;
}

// The enrollment request (§8.2): the proof shows the sender holds the key.
export function enrollRequest(o: { code: string; privateKey: string; publicKey: string; version: string; cameraIds: string[] }): { v: 1; code: string; publicKey: string; proof: string; proxy: { version: string; cameraIds: string[] } } {
  const code = normaliseCode(o.code);
  if (!code) throw new Error('not an enrollment code');
  return { v: 1, code, publicKey: o.publicKey, proof: sign(o.privateKey, signedText.enroll(code, o.publicKey)), proxy: { version: o.version.slice(0, 64), cameraIds: o.cameraIds.slice(0, 64).map((c) => c.slice(0, 64)) } };
}

export interface Envelope { v: 1; type: string; id: string; seq: number; ts: number; re?: string; body: Record<string, unknown>; sig?: string }

export function buildEnvelope(type: string, seq: number, body: Record<string, unknown>, o: { now: number; re?: string; sig?: string }): Envelope {
  return { v: 1, type, id: ulid(o.now), seq, ts: Math.max(0, Math.floor(o.now)), ...(o.re ? { re: o.re } : {}), body, ...(o.sig ? { sig: o.sig } : {}) };
}

// What cams-admin sent: the envelope's shape is checked; unknown fields are
// ignored (§8.1). Throws on anything else.
export function parseEnvelope(data: string): Envelope {
  const m = JSON.parse(data) as Record<string, unknown>;
  if (typeof m !== 'object' || m === null || Array.isArray(m)) throw new Error('not an object');
  if (m.v !== 1) throw new Error(`envelope version ${String(m.v)}`);
  if (typeof m.type !== 'string' || typeof m.id !== 'string' || !Number.isInteger(m.seq) || (m.seq as number) < 1 || typeof m.ts !== 'number') throw new Error('envelope fields');
  if (typeof m.body !== 'object' || m.body === null || Array.isArray(m.body)) throw new Error('envelope body');
  if (m.re !== undefined && typeof m.re !== 'string') throw new Error('envelope re');
  return m as unknown as Envelope;
}

// Without trailing slashes, in linear time (a /\/+$/ regex backtracks on many slashes).
export function trimSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

// Spec §8.9: https/wss, or http/ws only for loopback and *.svc.cluster.local.
// null when fine, else why not (no credentials in the URL either).
export function adminUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not a URL';
  }
  if (u.username || u.password) return 'must not hold a user or password';
  if (u.protocol === 'https:' || u.protocol === 'wss:') return null;
  if (u.protocol !== 'http:' && u.protocol !== 'ws:') return 'must be https://';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if (loopback || host.endsWith('.svc.cluster.local')) return null;
  return 'must be https:// (plain http only for loopback and *.svc.cluster.local)';
}
