import { X509Certificate } from 'crypto';
import { generate } from 'selfsigned';
import { sha256Pin } from '../../src/tls/pin';

// A self-signed certificate other than cam-sim's factory one (every sim
// serves the same): a "swapped camera" for trust tests, or one to import into
// a sim (sim.engine.importCertificate) so it serves another certificate.
export async function otherCertificate(cn = 'OTHER'): Promise<{ pem: string; key: string; fingerprint: string }> {
  const p = await generate([{ name: 'commonName', value: cn }], { keySize: 2048 });
  return { pem: p.cert, key: p.private, fingerprint: sha256Pin(new X509Certificate(p.cert).raw) };
}
