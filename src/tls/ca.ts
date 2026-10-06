import * as x509 from '@peculiar/x509';
import { createHash, createPrivateKey, createPublicKey, randomBytes, webcrypto, X509Certificate } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { nameConstraintsDer, parseNameConstraints } from './der';

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export const RSA = (bits: number) => ({ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: bits }) as const;
const YEAR = 365 * 86400_000;
const NAME_CONSTRAINTS = '2.5.29.30';

export class CaError extends Error {}
export interface SiteCa {
  certPem: string;
  keyPem: string;
  fingerprint: string;
  notAfter: number;
  covers(ip: string): boolean;
  coversName(name: string): boolean;
}

// The pin cams compares: SHA256: + the upper-case hex SHA-256 of the DER (Ruling P5-8).
export function fingerprintOf(pem: string): string {
  return `SHA256:${createHash('sha256').update(new X509Certificate(pem).raw).digest('hex').toUpperCase()}`;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const ipInt = (ip: string): number | null => {
  const m = IPV4.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.some((x) => x > 255) ? null : parts.reduce((n, x) => n * 256 + x, 0);
};
const cidr = (s: string) => {
  const [ip, p] = s.split('/');
  return { address: ip, prefix: Number(p ?? 32) };
};
const within = (ip: string, r: { address: string; prefix: number }): boolean => {
  const a = ipInt(ip);
  const b = ipInt(r.address);
  if (a === null || b === null) return false;
  const m = r.prefix === 0 ? 0 : (0xffffffff << (32 - r.prefix)) >>> 0;
  return ((a & m) >>> 0) === ((b & m) >>> 0);
};

// A secret file: written beside its target with O_EXCL (never through a
// planted file or symlink), mode 600, then renamed into place.
export function writeSecret(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function pemOfPkcs8(der: ArrayBuffer): string {
  return createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' }).toString();
}

// The host's own CA (spec 2026-10-05-multi-camera-host-design §10.1.1):
// created once, then loaded. The key never leaves <dir>/ca.key (600). A
// ca.pem without its key (or a key that isn't its own) is never replaced:
// cams pins the CA, and a silent new one would break every pin (Review Focus 3).
// What the CA covers is read from its own name constraints, not from today's
// settings: an address the settings gained later is not covered (Ruling P5-3).
export async function siteCa(dir: string, o: { site: string; cameraSubnet: string; proxyAddresses: string[]; now?: () => number }): Promise<SiteCa> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const pemFile = join(dir, 'ca.pem');
  const keyFile = join(dir, 'ca.key');
  if (existsSync(pemFile) || existsSync(keyFile)) {
    if (!existsSync(pemFile) || !existsSync(keyFile)) {
      throw new CaError(`${existsSync(pemFile) ? 'ca.key' : 'ca.pem'} is missing in ${dir}: restore it from the backup, or rotate the CA (tls-ca-rotate; cams needs the new pin)`);
    }
  } else {
    const now = (o.now ?? Date.now)();
    const alg = RSA(3072);
    const ranges = [cidr(o.cameraSubnet), ...o.proxyAddresses.map((a) => ({ address: a.trim(), prefix: 32 }))];
    const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: `01${randomBytes(15).toString('hex')}`, // positive, 128 bits
      name: `CN=cam-proxy site CA ${o.site}`,
      notBefore: new Date(now - 3600_000),
      notAfter: new Date(now + 10 * YEAR),
      keys,
      signingAlgorithm: alg,
      extensions: [
        new x509.BasicConstraintsExtension(true, 0, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        // Ruling P5-1: the DNS constraint in RFC 5280 form, <site>.internal.
        new x509.Extension(NAME_CONSTRAINTS, true, nameConstraintsDer({ dns: [`${o.site}.internal`], ip: ranges })),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    writeSecret(keyFile, pemOfPkcs8(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)));
    const tmp = `${pemFile}.tmp-${process.pid}`;
    writeFileSync(tmp, cert.toString('pem') + '\n', { mode: 0o644 });
    renameSync(tmp, pemFile);
  }
  chmodSync(keyFile, 0o600);
  const certPem = readFileSync(pemFile, 'utf8');
  const keyPem = readFileSync(keyFile, 'utf8');
  let x: X509Certificate;
  try {
    x = new X509Certificate(certPem);
    const own = createPublicKey(createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' });
    if (!own.equals(x.publicKey.export({ type: 'spki', format: 'der' }))) throw new CaError('x');
  } catch {
    // Never the key's content or a parser message about it in the error.
    throw new CaError(`ca.key in ${dir} does not belong to ca.pem (or one of them is unreadable): restore both from the backup, or rotate the CA`);
  }
  const ext = new x509.X509Certificate(certPem).getExtension(NAME_CONSTRAINTS);
  if (!ext) throw new CaError(`ca.pem in ${dir} has no name constraints: rotate the CA`);
  const nc = parseNameConstraints(Buffer.from(ext.value));
  return {
    certPem,
    keyPem,
    fingerprint: fingerprintOf(certPem),
    notAfter: Date.parse(x.validTo),
    covers: (ip) => nc.ip.some((r) => within(ip, r)),
    coversName: (name) => nc.dns.some((d) => name === d || name.endsWith(`.${d}`)),
  };
}
