import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteKeyFile, KeyFileInvalid, KeyFileUnsafe, readKeyFile, writeKeyFile, type AdminKeyFile } from '../src/fleet/keyfile';
import { privateFileHooks, tightenAdminFiles } from '../src/fleet/private-file';

// The cams-admin key file (spec 2026-10-06-cams-admin-phase1-design §9.2):
// mode 600 in a 700 folder, written atomically; a loose file of ours is
// tightened (the cluster's fsGroup makes it 660), another user's is refused.
const KEY: AdminKeyFile = {
  v: 1, url: 'https://cams-admin.example', connectUrl: 'wss://cams-admin.example/proxy/v1/connect', proxyId: 'prx_0123456789ABCDEFGHJK', keyId: 'key_0123456789ABCDEFGHJK',
  privateKey: 'MC4CAQAwBQYDK2VwBCIEIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB', publicKey: 'MCowBQYDK2VwAyEAiojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=',
  serverKeys: ['MCowBQYDK2VwAyEAgTl3Dqh9F19Wo1Rmw0x+zMuNipG07jeiXfYPW4/Js5Q='], account: 'home', enrolledAt: 1791273600000,
};
const fresh = () => join(mkdtempSync(join(tmpdir(), 'camproxy-key-')), 'admin', 'key.json');
const mode = (p: string) => statSync(p).mode & 0o777;

describe('the cams-admin key file', () => {
  afterEach(() => {
    delete privateFileHooks.fstat;
    delete privateFileHooks.fchmod;
    delete privateFileHooks.onTightened;
  });

  it('round trip: written 600 in a 700 folder, read back the same', () => {
    const p = fresh();
    writeKeyFile(p, KEY);
    expect(mode(p)).toBe(0o600);
    expect(mode(join(p, '..'))).toBe(0o700);
    expect(readKeyFile(p)).toEqual(KEY);
  });

  it('ours with 660 (kubelet under fsGroup) or 644 (a restored backup): tightened to 600, folder 700, then used', () => {
    for (const loose of [0o660, 0o644, 0o640]) {
      const p = fresh();
      writeKeyFile(p, KEY);
      chmodSync(p, loose);
      chmodSync(join(p, '..'), 0o770);
      const seen: [string, number][] = [];
      privateFileHooks.onTightened = (f, from) => void seen.push([f, from]);
      expect(readKeyFile(p)).toEqual(KEY);
      expect(mode(p)).toBe(0o600);
      expect(mode(join(p, '..'))).toBe(0o700);
      expect(seen).toEqual([[p, loose]]);
    }
  });

  it('the mode is checked and tightened on the open file, before any byte is read', () => {
    const p = fresh();
    writeKeyFile(p, KEY);
    chmodSync(p, 0o660);
    const calls: string[] = [];
    privateFileHooks.fchmod = (fd, m) => {
      calls.push(`fchmod ${m.toString(8)}`);
      chmodSync(p, m); // as fchmodSync(fd) would; the fd is the one opened
      expect(typeof fd).toBe('number');
    };
    expect(readKeyFile(p)).toEqual(KEY);
    expect(calls).toEqual(['fchmod 600']);
  });

  it('ours, but the chmod does not take: refused, never used', () => {
    const p = fresh();
    writeKeyFile(p, KEY);
    chmodSync(p, 0o660);
    privateFileHooks.fchmod = () => {};
    expect(() => readKeyFile(p)).toThrow(/mode 660.*could not be set to 600/);
    expect(() => readKeyFile(p)).toThrow(KeyFileUnsafe);
  });

  it("another user's file with 640: refused, never chmodded", () => {
    const p = fresh();
    writeKeyFile(p, KEY);
    const real = statSync(p);
    let chmods = 0;
    privateFileHooks.fchmod = () => void chmods++;
    expect(() => readKeyFile(p, { stat: () => ({ mode: 0o100640, uid: real.uid + 1 }) })).toThrow(KeyFileUnsafe);
    expect(() => readKeyFile(p, { stat: () => ({ mode: 0o100640, uid: real.uid + 1 }) })).toThrow(/belongs to another user/);
    expect(chmods).toBe(0);
  });

  it('startup: every admin file of ours tightened, nothing created, another user\'s reported', () => {
    const p = fresh();
    const dir = join(p, '..');
    writeKeyFile(p, KEY);
    for (const n of ['tokens.json', 'policy.json', 'replay.json', 'replay-mark.json', 'commands.json']) writeFileSync(join(dir, n), '{}', { mode: 0o660 });
    for (const n of ['key.json', 'tokens.json', 'policy.json', 'replay.json', 'replay-mark.json', 'commands.json']) chmodSync(join(dir, n), 0o660);
    writeFileSync(join(dir, 'other.txt'), 'x');
    chmodSync(join(dir, 'other.txt'), 0o664);
    chmodSync(dir, 0o2770);
    expect(tightenAdminFiles(dir)).toEqual([]);
    for (const n of ['key.json', 'tokens.json', 'policy.json', 'replay.json', 'replay-mark.json', 'commands.json']) expect(mode(join(dir, n)), n).toBe(0o600);
    expect(mode(join(dir, 'other.txt'))).toBe(0o664); // not ours to judge
    expect(mode(dir) & 0o077).toBe(0);
    const real = statSync(p);
    privateFileHooks.fstat = () => ({ mode: 0o100640, uid: real.uid + 1 });
    expect(tightenAdminFiles(dir).map((r) => r.file)).toContain(p);
    const none = join(mkdtempSync(join(tmpdir(), 'camproxy-key-')), 'admin');
    expect(tightenAdminFiles(none)).toEqual([]);
    expect(existsSync(none)).toBe(false);
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
    expect(() => readKeyFile(p, { stat: () => ({ mode: real.mode, uid: real.uid + 1 }) })).toThrow(/belongs to another user/);
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
    privateFileHooks.fchmod = () => {};
    chmodSync(p, 0o644);
    try {
      readKeyFile(p);
      expect.unreachable();
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
