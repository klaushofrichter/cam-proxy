import { X509Certificate } from 'crypto';
import { copyFileSync, mkdtempSync, readFileSync } from 'fs';
import https from 'https';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { siteCa, type SiteCa } from '../src/tls/ca';
import { nameConstraintsDer } from '../src/tls/der';
import { issueLeaf, issuedBy, leafOf } from '../src/tls/leaf';
import { x509 } from '../src/tls/x509';

// TEST DATA ONLY, never a real CA or camera key: test/fixtures/tls-x509-1.14.3/
// holds a site CA (ca.pem, ca.key as PKCS#8 PEM, as siteCa writes them) and a
// camera leaf (leaf.pem, leaf.key as PKCS#1) generated on 2026-10-13 by this
// repo's src/tls/{ca,leaf,der}.ts with @peculiar/x509 1.14.3: site "fixture",
// cameraSubnet 192.0.2.0/24, proxyAddresses ["198.51.100.10"]; leaf
// cam1.fixture.internal / 192.0.2.21, 3650 days. The fingerprints below were
// computed independently (openssl x509 -fingerprint -sha256).
// The point: a CA created before the @peculiar/x509 2.x upgrade (the one live
// on a host today) still loads, still issues the same kind of leaves, and its
// pin is unchanged.
const FIXTURE = join(__dirname, 'fixtures', 'tls-x509-1.14.3');
const fixture = (f: string) => readFileSync(join(FIXTURE, f), 'utf8');
const CA_FP = 'SHA256:6D1D36F11F7A1B4AF634F93C250004D2A9F95B4F91EBEFB1D862E48772D7CD72';
const LEAF_FP = 'SHA256:CE2FF87BF04B73C997003D0D90B8F052DB0B836F95AA3D46DC66ED3C9AB57382';
const NAME_CONSTRAINTS = '2.5.29.30';

// The extension profile (OID, critical) in order, read from the DER.
const profile = (pem: string) => new x509.X509Certificate(pem).extensions.map((e) => [e.type, e.critical]);

let ca: SiteCa;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-x509compat-'));
  copyFileSync(join(FIXTURE, 'ca.pem'), join(dir, 'ca.pem'));
  copyFileSync(join(FIXTURE, 'ca.key'), join(dir, 'ca.key'));
  ca = await siteCa(dir, { site: 'fixture', cameraSubnet: '192.0.2.0/24', proxyAddresses: ['198.51.100.10'] });
}, 60_000);

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

describe('a site CA and leaf made with @peculiar/x509 1.14.3 (fixture)', () => {
  it('the CA loads unchanged: same PEM, same key, same pin, same constraints', () => {
    expect(ca.certPem).toBe(fixture('ca.pem'));
    expect(ca.keyPem).toBe(fixture('ca.key'));
    expect(ca.fingerprint).toBe(CA_FP);
    expect(ca.covers('192.0.2.21')).toBe(true);
    expect(ca.covers('198.51.100.10')).toBe(true);
    expect(ca.covers('198.51.100.11')).toBe(false);
    expect(ca.coversName('cam1.fixture.internal')).toBe(true);
    expect(ca.coversName('cam1.other.internal')).toBe(false);
  });

  it('the CA keeps its critical name constraints, byte for byte what der.ts builds', () => {
    const ext = new x509.X509Certificate(ca.certPem).getExtension(NAME_CONSTRAINTS);
    expect(ext?.critical).toBe(true);
    const want = nameConstraintsDer({ dns: ['fixture.internal'], ip: [{ address: '192.0.2.0', prefix: 24 }, { address: '198.51.100.10', prefix: 32 }] });
    expect(Buffer.from(ext!.value).equals(want)).toBe(true);
  });

  it('the old leaf reads the same and verifies against the old CA', async () => {
    const leaf = leafOf(fixture('leaf.pem'), fixture('leaf.key'));
    expect(leaf.fingerprint).toBe(LEAF_FP);
    expect(leaf.names).toEqual(['cam1.fixture.internal']);
    expect(leaf.ips).toEqual(['192.0.2.21']);
    expect(issuedBy(leaf, ca)).toBe(true);
    expect(await handshake(leaf, 'cam1.fixture.internal')).toBe('ok');
  });

  it('a leaf issued now from the old CA has the 1.14.3 profile, a PKCS#1 key, and verifies', async () => {
    const leaf = await issueLeaf(ca, { cn: 'cam1.fixture.internal', dns: ['cam1.fixture.internal'], ips: ['192.0.2.21'] });
    expect(profile(leaf.certPem)).toEqual(profile(fixture('leaf.pem')));
    expect(profile(leaf.certPem)).toEqual([
      ['2.5.29.19', true], // basicConstraints CA:FALSE
      ['2.5.29.15', true], // keyUsage
      ['2.5.29.37', false], // extKeyUsage
      ['2.5.29.17', false], // subjectAltName
      ['2.5.29.35', false], // authorityKeyIdentifier
      ['2.5.29.14', false], // subjectKeyIdentifier
    ]);
    const x = new x509.X509Certificate(leaf.certPem);
    expect(x.getExtension(x509.BasicConstraintsExtension)?.ca).toBe(false);
    expect(x.getExtension(x509.KeyUsagesExtension)?.usages).toBe(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment);
    expect(x.getExtension(x509.ExtendedKeyUsageExtension)?.usages).toEqual([x509.ExtendedKeyUsage.serverAuth]);
    const old = new x509.X509Certificate(fixture('leaf.pem'));
    expect(Buffer.from(x.getExtension(x509.AuthorityKeyIdentifierExtension)!.value).equals(Buffer.from(old.getExtension(x509.AuthorityKeyIdentifierExtension)!.value))).toBe(true);
    expect(x.issuer).toBe(old.issuer);
    expect(new X509Certificate(leaf.certPem).subjectAltName).toBe('DNS:cam1.fixture.internal, IP Address:192.0.2.21');
    expect(leaf.keyPem.startsWith('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(issuedBy(leaf, ca)).toBe(true);
    expect(new X509Certificate(leaf.certPem).checkIssued(new X509Certificate(ca.certPem))).toBe(true);
    expect(await handshake(leaf, 'cam1.fixture.internal')).toBe('ok');
  }, 60_000);

  it('fingerprints: SHA256 of the DER, upper-case hex, for old and new certificates alike', async () => {
    const der = (pem: string) => new X509Certificate(pem).fingerprint256.replace(/:/g, '');
    expect(ca.fingerprint).toBe(`SHA256:${der(ca.certPem)}`);
    const leaf = await issueLeaf(ca, { cn: 'proxy.fixture.internal', dns: ['proxy.fixture.internal'], ips: ['198.51.100.10'], keyFormat: 'pkcs8' });
    expect(leaf.fingerprint).toBe(`SHA256:${der(leaf.certPem)}`);
    expect(leaf.fingerprint).toMatch(/^SHA256:[0-9A-F]{64}$/);
  }, 60_000);

  it('a CA created now has the same extension profile as the 1.14.3 one', async () => {
    const fresh = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-x509compat-new-')), { site: 'fixture', cameraSubnet: '192.0.2.0/24', proxyAddresses: ['198.51.100.10'] });
    expect(profile(fresh.certPem)).toEqual(profile(ca.certPem));
    expect(profile(fresh.certPem)).toEqual([
      ['2.5.29.19', true],
      ['2.5.29.15', true],
      [NAME_CONSTRAINTS, true],
      ['2.5.29.14', false],
    ]);
    expect(Buffer.from(new x509.X509Certificate(fresh.certPem).getExtension(NAME_CONSTRAINTS)!.value).equals(Buffer.from(new x509.X509Certificate(ca.certPem).getExtension(NAME_CONSTRAINTS)!.value))).toBe(true);
  }, 60_000);
});
