import { randomBytes } from 'crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'fs';
import { dirname, join } from 'path';

// The cams-admin key file (spec 2026-10-06-cams-admin-phase1-design §9.2):
// <dataDir>/admin/key.json, mode 600 in a 700 folder, written atomically.
// Refused when group- or world-readable or owned by another user (the rule
// cams applies to proxy-tls.json). Never printed, logged, served or put in a
// download. Error messages name the file, never its content.
export interface AdminKeyFile {
  v: 1;
  url: string;
  connectUrl: string;
  proxyId: string;
  keyId: string;
  privateKey: string; // base64 PKCS#8 DER (Ed25519)
  publicKey: string; // base64 SPKI DER
  serverKeys: string[]; // cams-admin's public keys, pinned at enrollment
  account: string;
  enrolledAt: number;
}

export class KeyFileUnsafe extends Error {}
export class KeyFileInvalid extends Error {}

type Stat = (p: string) => { mode: number; uid: number };

const STRINGS = ['url', 'connectUrl', 'proxyId', 'keyId', 'privateKey', 'publicKey', 'account'] as const;

function check(k: unknown): AdminKeyFile {
  const o = k as Record<string, unknown>;
  if (typeof o !== 'object' || o === null || Array.isArray(o) || o.v !== 1) throw new KeyFileInvalid('the cams-admin key file is not version 1');
  for (const f of STRINGS) if (typeof o[f] !== 'string' || !(o[f] as string).length) throw new KeyFileInvalid(`the cams-admin key file has no ${f}`);
  if (!Array.isArray(o.serverKeys) || !o.serverKeys.length || !o.serverKeys.every((s) => typeof s === 'string')) throw new KeyFileInvalid('the cams-admin key file has no server keys');
  if (typeof o.enrolledAt !== 'number') throw new KeyFileInvalid('the cams-admin key file has no enrolledAt');
  return { v: 1, url: o.url as string, connectUrl: o.connectUrl as string, proxyId: o.proxyId as string, keyId: o.keyId as string, privateKey: o.privateKey as string, publicKey: o.publicKey as string, serverKeys: [...(o.serverKeys as string[])], account: o.account as string, enrolledAt: o.enrolledAt };
}

// Throws KeyFileUnsafe / KeyFileInvalid (and the fs error when it is missing).
export function readKeyFile(path: string, o: { stat?: Stat; uid?: number } = {}): AdminKeyFile {
  const st = (o.stat ?? statSync)(path);
  const uid = o.uid ?? process.getuid?.();
  if (st.mode & 0o077) throw new KeyFileUnsafe(`${path} can be read by others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it or enroll again`);
  if (uid !== undefined && st.uid !== uid) throw new KeyFileUnsafe(`${path} belongs to another user (uid ${st.uid})`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new KeyFileInvalid(`${path} is not valid JSON`);
  }
  return check(parsed);
}

// Folder 700, file 600, a random temp name, fsync, rename: a crash leaves the
// old file or the new one, never half of one; a failure removes the temp file.
export function writeKeyFile(path: string, k: AdminKeyFile): void {
  const text = `${JSON.stringify(check(k), null, 2)}\n`;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = join(dir, `.key-${randomBytes(8).toString('hex')}.tmp`);
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function deleteKeyFile(path: string): void {
  rmSync(path, { force: true });
}
