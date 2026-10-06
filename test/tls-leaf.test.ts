import { X509Certificate } from 'crypto';
import { mkdtempSync } from 'fs';
import https from 'https';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { siteCa, type SiteCa } from '../src/tls/ca';
import { issueLeaf, renewalDue } from '../src/tls/leaf';

let ca: SiteCa;
beforeAll(async () => {
  ca = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-leaf-')), { site: 'garage', cameraSubnet: '127.0.0.0/8', proxyAddresses: ['192.168.1.230'] });
}, 60_000);

// A TLS server with the leaf; a client that trusts only the CA (as cams will).
async function handshake(leaf: { certPem: string; keyPem: string }, servername: string): Promise<string> {
  const server = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (_req, res) => res.end('ok'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    return await new Promise<string>((resolve) => {
      https.get({ host: '127.0.0.1', port, servername, ca: ca.certPem, path: '/' }, (res) => {
        res.resume();
        resolve('ok');
      }).on('error', (e) => resolve(e.message));
    });
  } finally {
    server.close();
  }
}

describe('leaves (spec §10.1.2)', () => {
  it('a camera leaf: RSA 2048, 397 days, SANs, verifies against the CA by name and by IP', async () => {
    const leaf = await issueLeaf(ca, { cn: 'cam3.garage.internal', dns: ['cam3.garage.internal'], ips: ['127.0.0.1'] });
    const x = new X509Certificate(leaf.certPem);
    expect(x.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(Math.round((Date.parse(x.validTo) - Date.parse(x.validFrom)) / 86400_000)).toBe(397);
    expect(x.subjectAltName).toBe('DNS:cam3.garage.internal, IP Address:127.0.0.1');
    expect(x.verify(new X509Certificate(ca.certPem).publicKey)).toBe(true);
    expect(await handshake(leaf, 'cam3.garage.internal')).toBe('ok');
  }, 60_000);

  it('camera keys are PKCS#1 (Ruling P5-4)', async () => {
    const leaf = await issueLeaf(ca, { cn: 'cam4.garage.internal', dns: ['cam4.garage.internal'], ips: ['127.0.0.1'] });
    expect(leaf.keyPem.startsWith('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
  }, 60_000);

  it("Node enforces the CA's name constraints: a name or an address outside is refused", async () => {
    const evil = await issueLeaf(ca, { cn: 'evil.example', dns: ['evil.example'], ips: ['127.0.0.1'] });
    expect(await handshake(evil, 'evil.example')).toMatch(/permitted|constraint/i);
    const far = await issueLeaf(ca, { cn: 'cam9.garage.internal', dns: ['cam9.garage.internal'], ips: ['10.9.9.9'] });
    expect(await handshake(far, 'cam9.garage.internal')).toMatch(/permitted|constraint/i);
  }, 60_000);

  it('renewal 30 days before expiry', () => {
    const notAfter = Date.UTC(2027, 10, 5);
    expect(renewalDue({ notAfter }, notAfter - 31 * 86400_000)).toBe(false);
    expect(renewalDue({ notAfter }, notAfter - 30 * 86400_000)).toBe(true);
  });
});
