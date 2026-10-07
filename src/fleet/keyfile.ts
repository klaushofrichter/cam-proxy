import { rmSync } from 'fs';
import { PrivateFileInvalid, PrivateFileUnsafe, readPrivateJson, writePrivateJson, type Stat } from './private-file';

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

export class KeyFileUnsafe extends PrivateFileUnsafe {}
export class KeyFileInvalid extends PrivateFileInvalid {}

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
  return check(readPrivateJson(path, { ...o, unsafe: KeyFileUnsafe, invalid: KeyFileInvalid }));
}

// Atomic, 600 in a 700 folder (private-file.ts).
export function writeKeyFile(path: string, k: AdminKeyFile): void {
  writePrivateJson(path, check(k));
}

export function deleteKeyFile(path: string): void {
  rmSync(path, { force: true });
}
