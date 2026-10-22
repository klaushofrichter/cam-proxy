// Sealed camera passwords (camera-move plan Task 5, S §9.3): ephemeral X25519 +
// HKDF-SHA256 + AES-256-GCM to the target's move key.
import { generateKeyPairSync } from 'crypto';
import { describe, expect, it } from 'vitest';
import { seal, unseal } from '../src/moves/seal';

function pair() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicSpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privatePkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}
const SECRET = Buffer.from('not-a-real-password-é', 'utf8');

describe('seal', () => {
  it('seal/unseal round-trip', () => {
    const k = pair();
    // the contract's targetPublicKey pattern
    expect(k.publicSpki).toMatch(/^MCowBQYDK2VuAyEA[A-Za-z0-9+/]{43}=$/);
    const sealed = seal(k.publicSpki, SECRET);
    const parts = sealed.split('.');
    expect(parts[0]).toBe('v1');
    expect(parts).toHaveLength(4);
    expect(parts[1]).toMatch(/^MCowBQYDK2VuAyEA/);
    expect(Buffer.from(parts[2], 'base64')).toHaveLength(12);
    expect(sealed).not.toContain(SECRET.toString('base64'));
    expect(unseal(k.privatePkcs8, sealed).equals(SECRET)).toBe(true);
    // a fresh ephemeral key per seal
    expect(seal(k.publicSpki, SECRET)).not.toBe(sealed);
  });

  it('unseal with another key fails', () => {
    const k = pair();
    const other = pair();
    expect(() => unseal(other.privatePkcs8, seal(k.publicSpki, SECRET))).toThrow();
  });

  it('tampered ciphertext fails', () => {
    const k = pair();
    const [v, eph, iv, ct] = seal(k.publicSpki, SECRET).split('.');
    const flip = (b64: string, i: number) => {
      const b = Buffer.from(b64, 'base64');
      b[i] ^= 1;
      return b.toString('base64');
    };
    expect(() => unseal(k.privatePkcs8, [v, eph, iv, flip(ct, 0)].join('.'))).toThrow();
    expect(() => unseal(k.privatePkcs8, [v, eph, iv, flip(ct, Buffer.from(ct, 'base64').length - 1)].join('.'))).toThrow(); // the tag
    expect(() => unseal(k.privatePkcs8, [v, eph, flip(iv, 0), ct].join('.'))).toThrow();
    expect(() => unseal(k.privatePkcs8, [v, pair().publicSpki, iv, ct].join('.'))).toThrow();
    expect(() => unseal(k.privatePkcs8, ['v2', eph, iv, ct].join('.'))).toThrow(/sealed/);
    expect(() => unseal(k.privatePkcs8, [v, eph, iv].join('.'))).toThrow(/sealed/);
  });

  it('refuses a public key that is not X25519', () => {
    const ed = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(() => seal(ed, SECRET)).toThrow(/X25519/);
    expect(() => seal('not base64 at all', SECRET)).toThrow();
  });
});
