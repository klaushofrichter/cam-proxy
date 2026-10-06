import * as x509 from '@peculiar/x509';
import { createPrivateKey, randomBytes, webcrypto, X509Certificate } from 'crypto';
import { fingerprintOf, RSA, type SiteCa } from './ca';

export interface Leaf { certPem: string; keyPem: string; fingerprint: string; notAfter: number; names: string[]; ips: string[] }
export const RENEW_BEFORE_MS = 30 * 86400_000;
export const renewalDue = (leaf: { notAfter: number }, now: number): boolean => leaf.notAfter - now <= RENEW_BEFORE_MS;

const sans = (x: X509Certificate) => {
  const parts = (x.subjectAltName ?? '').split(', ');
  return { names: parts.filter((p) => p.startsWith('DNS:')).map((p) => p.slice(4)), ips: parts.filter((p) => p.startsWith('IP Address:')).map((p) => p.slice(11)) };
};

export function leafOf(certPem: string, keyPem: string): Leaf {
  const x = new X509Certificate(certPem);
  return { certPem, keyPem, fingerprint: fingerprintOf(certPem), notAfter: Date.parse(x.validTo), ...sans(x) };
}

// A leaf signed directly by the site CA (spec §10.1.2): RSA 2048, 397 days
// (under Apple's 825-day limit), serverAuth, the SANs given.
export async function issueLeaf(ca: SiteCa, o: { cn: string; dns: string[]; ips: string[]; days?: number; keyFormat?: 'pkcs1' | 'pkcs8'; now?: () => number }): Promise<Leaf> {
  const now = (o.now ?? Date.now)();
  const alg = RSA(2048);
  const caKey = await webcrypto.subtle.importKey('pkcs8', createPrivateKey(ca.keyPem).export({ type: 'pkcs8', format: 'der' }), alg, false, ['sign']);
  const caCert = new x509.X509Certificate(ca.certPem);
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const notBefore = new Date(now - 3600_000);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: `01${randomBytes(15).toString('hex')}`, // positive, 128 bits
    subject: `CN=${o.cn}`,
    issuer: caCert.subject,
    notBefore,
    notAfter: new Date(notBefore.getTime() + (o.days ?? 397) * 86400_000),
    signingKey: caKey,
    publicKey: keys.publicKey,
    signingAlgorithm: alg,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([...o.dns.map((value) => ({ type: 'dns' as const, value })), ...o.ips.map((value) => ({ type: 'ip' as const, value }))]),
      await x509.AuthorityKeyIdentifierExtension.create(caCert),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const der = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  // The camera's measured import used an RSA key as cert-manager writes it: PKCS#1 (Ruling P5-4).
  const keyPem = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).export({ type: o.keyFormat ?? 'pkcs1', format: 'pem' }).toString();
  return leafOf(cert.toString('pem') + '\n', keyPem);
}

// Whether a stored leaf is the current CA's (restored files, a rotation: not).
export function issuedBy(leaf: { certPem: string }, ca: { certPem: string }): boolean {
  try {
    return new X509Certificate(leaf.certPem).verify(new X509Certificate(ca.certPem).publicKey);
  } catch {
    return false;
  }
}
