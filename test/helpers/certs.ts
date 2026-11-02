import { randomBytes, webcrypto, X509Certificate } from 'crypto';
import { pemOfPkcs8, RSA } from '../../src/tls/ca';
import { sha256Pin } from '../../src/tls/pin';
import { x509 } from '../../src/tls/x509';

// A self-signed certificate other than cam-sim's factory one (every sim
// serves the same): a "swapped camera" for trust tests, or one to import into
// a sim (sim.engine.importCertificate) so it serves another certificate.
export async function otherCertificate(cn = 'OTHER'): Promise<{ pem: string; key: string; fingerprint: string }> {
  const alg = RSA(2048);
  const keys = await webcrypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: `01${randomBytes(15).toString('hex')}`,
    name: `CN=${cn}`,
    notBefore: new Date(now - 3600_000),
    notAfter: new Date(now + 365 * 24 * 3600_000),
    keys,
    signingAlgorithm: alg,
  });
  const pem = cert.toString('pem');
  return { pem, key: pemOfPkcs8(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)), fingerprint: sha256Pin(new X509Certificate(pem).raw) };
}
