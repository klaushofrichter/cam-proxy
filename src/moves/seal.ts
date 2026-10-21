import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'crypto';

// The camera password travels from source to target sealed to the target's
// per-move X25519 key (S §9.3): an ephemeral X25519 key, HKDF-SHA256 over the
// shared secret (salt: the ephemeral and the recipient's SPKI, info
// `cam-proxy move v1`), AES-256-GCM. Format: `v1.<ephemeralSpki>.<iv>.<ciphertext+tag>`,
// each part base64 (SPKI DER, 12-byte IV, 16-byte tag at the end). Anyone may
// seal; only the holder of the private key can open. Error messages never
// contain key material or plaintext.
const INFO = Buffer.from('cam-proxy move v1', 'utf8');
const IV = 12;
const TAG = 16;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

const spki = (k: KeyObject): Buffer => k.export({ format: 'der', type: 'spki' });

function x25519Public(b64: string): KeyObject {
  if (!B64.test(b64)) throw new Error('not an X25519 public key');
  let k: KeyObject;
  try {
    k = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new Error('not an X25519 public key');
  }
  if (k.asymmetricKeyType !== 'x25519') throw new Error('not an X25519 public key');
  return k;
}

function derive(privateKey: KeyObject, publicKey: KeyObject, ephemeral: Buffer, recipient: Buffer): Buffer {
  const shared = diffieHellman({ privateKey, publicKey });
  // A low-order public key gives an all-zero secret: refuse it.
  if (shared.every((b) => b === 0)) throw new Error('sealed blob is not valid');
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), INFO, 32));
}

export function seal(publicSpkiB64: string, plaintext: Buffer): string {
  const recipient = x25519Public(publicSpkiB64);
  const eph = generateKeyPairSync('x25519');
  const ephSpki = spki(eph.publicKey);
  const key = derive(eph.privateKey, recipient, ephSpki, spki(recipient));
  const iv = randomBytes(IV);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
  key.fill(0);
  return ['v1', ephSpki.toString('base64'), iv.toString('base64'), body.toString('base64')].join('.');
}

export function unseal(privatePkcs8B64: string, sealed: string): Buffer {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || !parts.slice(1).every((p) => B64.test(p))) throw new Error('sealed blob is not valid');
  const ephemeral = x25519Public(parts[1]);
  const iv = Buffer.from(parts[2], 'base64');
  const body = Buffer.from(parts[3], 'base64');
  if (iv.length !== IV || body.length < TAG) throw new Error('sealed blob is not valid');
  const privateKey = createPrivateKey({ key: Buffer.from(privatePkcs8B64, 'base64'), format: 'der', type: 'pkcs8' });
  if (privateKey.asymmetricKeyType !== 'x25519') throw new Error('not an X25519 private key');
  const key = derive(privateKey, ephemeral, spki(ephemeral), spki(createPublicKey(privateKey)));
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAuthTag(body.subarray(body.length - TAG));
    return Buffer.concat([d.update(body.subarray(0, body.length - TAG)), d.final()]);
  } catch {
    throw new Error('sealed blob is not valid');
  } finally {
    key.fill(0);
  }
}
