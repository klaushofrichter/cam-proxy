import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { deleteKeyFile, KeyFileInvalid, KeyFileUnsafe, readKeyFile, writeKeyFile, type AdminKeyFile } from '../src/fleet/keyfile';

// The cams-admin key file (spec 2026-10-06-cams-admin-phase1-design §9.2):
// mode 600 in a 700 folder, written atomically, refused when others can read it.
const KEY: AdminKeyFile = {
  v: 1, url: 'https://cams-admin.example', connectUrl: 'wss://cams-admin.example/proxy/v1/connect', proxyId: 'prx_0123456789ABCDEFGHJK', keyId: 'key_0123456789ABCDEFGHJK',
  privateKey: 'MC4CAQAwBQYDK2VwBCIEIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB', publicKey: 'MCowBQYDK2VwAyEAiojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=',
  serverKeys: ['MCowBQYDK2VwAyEAgTl3Dqh9F19Wo1Rmw0x+zMuNipG07jeiXfYPW4/Js5Q='], account: 'home', enrolledAt: 1791273600000,
};
const fresh = () => join(mkdtempSync(join(tmpdir(), 'camproxy-key-')), 'admin', 'key.json');
const mode = (p: string) => statSync(p).mode & 0o777;

describe('the cams-admin key file', () => {
  it('round trip: written 600 in a 700 folder, read back the same', () => {
    const p = fresh();
    writeKeyFile(p, KEY);
    expect(mode(p)).toBe(0o600);
    expect(mode(join(p, '..'))).toBe(0o700);
    expect(readKeyFile(p)).toEqual(KEY);
  });

  it('a file others can read (a restored backup with 644) is refused', () => {
    const p = fresh();
    writeKeyFile(p, KEY);
    chmodSync(p, 0o644);
    expect(() => readKeyFile(p)).toThrow(KeyFileUnsafe);
    chmodSync(p, 0o640);
    expect(() => readKeyFile(p)).toThrow(KeyFileUnsafe);
  });

  it('a folder 755 is tightened to 700 on write', () => {
    const p = fresh();
    mkdirSync(join(p, '..'), { recursive: true, mode: 0o755 });
    chmodSync(join(p, '..'), 0o755);
    writeKeyFile(p, KEY);
    expect(mode(join(p, '..'))).toBe(0o700);
  });

  it('a file owned by another user is refused', () => {
    const p = fresh();
    writeKeyFile(p, KEY);
    const real = statSync(p);
    expect(() => readKeyFile(p, { stat: () => ({ mode: real.mode, uid: real.uid + 1 }) })).toThrow(KeyFileUnsafe);
  });

  it('partial or wrong JSON is invalid, never used', () => {
    const p = fresh();
    writeKeyFile(p, KEY);
    writeFileSync(p, '{"v":1,"url":', { mode: 0o600 });
    expect(() => readKeyFile(p)).toThrow(KeyFileInvalid);
    writeFileSync(p, JSON.stringify({ ...KEY, privateKey: 7 }), { mode: 0o600 });
    expect(() => readKeyFile(p)).toThrow(KeyFileInvalid);
    writeFileSync(p, JSON.stringify({ ...KEY, v: 2 }), { mode: 0o600 });
    expect(() => readKeyFile(p)).toThrow(KeyFileInvalid);
  });

  it('the error messages never hold the key material', () => {
    const p = fresh();
    writeKeyFile(p, KEY);
    chmodSync(p, 0o644);
    try {
      readKeyFile(p);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(KEY.privateKey);
    }
  });

  it('a failed write leaves no temp file and the old key file untouched', () => {
    const p = fresh();
    // The rename fails: key.json is a folder with a file in it.
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'keep'), 'x');
    expect(() => writeKeyFile(p, KEY)).toThrow();
    expect(readdirSync(join(p, '..'))).toEqual(['key.json']);
    // A JSON error happens before any file is made.
    const q = fresh();
    writeKeyFile(q, KEY);
    const bad = { ...KEY } as AdminKeyFile;
    (bad as unknown as { enrolledAt: bigint }).enrolledAt = 1n; // JSON.stringify throws on a BigInt
    expect(() => writeKeyFile(q, bad)).toThrow();
    expect(readdirSync(join(q, '..'))).toEqual(['key.json']);
    expect(readKeyFile(q)).toEqual(KEY);
  });

  it('delete removes it; a missing file is no error', () => {
    const p = fresh();
    writeKeyFile(p, KEY);
    deleteKeyFile(p);
    expect(existsSync(p)).toBe(false);
    expect(() => deleteKeyFile(p)).not.toThrow();
  });
});
