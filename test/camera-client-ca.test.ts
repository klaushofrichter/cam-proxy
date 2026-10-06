import { mkdtempSync } from 'fs';
import https from 'https';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { openRequest } from '../src/camera/http';
import { ReolinkClient } from '../src/camera/client';
import { siteCa } from '../src/tls/ca';
import { issueLeaf } from '../src/tls/leaf';

describe('camera requests verified against the site CA (spec §10.4)', () => {
  it('the right CA and name: ok; another CA: refused', async () => {
    const ca = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-cca-')), { site: 'g', cameraSubnet: '127.0.0.0/8', proxyAddresses: ['127.0.0.1'] });
    const other = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-cca2-')), { site: 'g', cameraSubnet: '127.0.0.0/8', proxyAddresses: ['127.0.0.1'] });
    const leaf = await issueLeaf(ca, { cn: 'cam3.g.internal', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });
    const server = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (_q, r) => r.end('{}'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ok = await openRequest({ protocol: 'https', host, tlsServername: 'cam3.g.internal', ca: ca.certPem }, '/', { timeoutMs: 5000 });
      ok.resume();
      expect(ok.statusCode).toBe(200);
      await expect(openRequest({ protocol: 'https', host, tlsServername: 'cam3.g.internal', ca: other.certPem }, '/', { timeoutMs: 5000 })).rejects.toThrow();
      // A CA always means verification, even without a name: by the IP SAN.
      await expect(openRequest({ protocol: 'https', host, ca: other.certPem }, '/', { timeoutMs: 5000 })).rejects.toThrow();
      const byIp = await openRequest({ protocol: 'https', host, ca: ca.certPem }, '/', { timeoutMs: 5000 });
      byIp.resume();
      expect(byIp.statusCode).toBe(200);
      // The client: requests and the certificate probe trust the camera's CA.
      const client = new ReolinkClient({ id: 'cam3', host, protocol: 'https', tlsServername: 'cam3.g.internal', tlsCa: ca.certPem, user: 'u', password: 'p' });
      expect(await client.cameraCertificate()).toMatchObject({ subject: 'cam3.g.internal' });
    } finally {
      server.close();
    }
  }, 120_000);

  it('setTrust: a running client switches to the CA, and back', async () => {
    const ca = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-cca3-')), { site: 'g', cameraSubnet: '127.0.0.0/8', proxyAddresses: ['127.0.0.1'] });
    const other = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-cca4-')), { site: 'g', cameraSubnet: '127.0.0.0/8', proxyAddresses: ['127.0.0.1'] });
    const leaf = await issueLeaf(other, { cn: 'cam3.g.internal', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });
    const server = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (_q, r) => r.end('{}'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const client = new ReolinkClient({ id: 'cam3', host, protocol: 'https', user: 'u', password: 'p' });
      expect(await client.cameraCertificate()).toBeNull(); // unverified client, but the probe verifies: no public CA
      client.setTrust({ ca: other.certPem, servername: 'cam3.g.internal' });
      expect(await client.cameraCertificate()).toMatchObject({ subject: 'cam3.g.internal' });
      client.setTrust({ ca: ca.certPem, servername: 'cam3.g.internal' });
      expect(await client.cameraCertificate()).toBeNull();
      client.setTrust(undefined);
      expect(await client.cameraCertificate()).toBeNull();
    } finally {
      server.close();
    }
  }, 120_000);
});
