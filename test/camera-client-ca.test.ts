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

  it('a pinned camera: only the certificate with that SHA-256 is accepted, before any request byte (security review #178)', async () => {
    const ca = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-cca5-')), { site: 'g', cameraSubnet: '127.0.0.0/16', proxyAddresses: ['127.0.0.1'] });
    const a = await issueLeaf(ca, { cn: 'x', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });
    const b = await issueLeaf(ca, { cn: 'x', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });
    let requests = 0;
    const server = https.createServer({ cert: a.certPem, key: a.keyPem }, (_q, r) => (requests++, r.end('{}')));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // The served certificate itself as the trust anchor, and its fingerprint.
      const ok = await openRequest({ protocol: 'https', host, ca: a.certPem, pin: a.fingerprint }, '/', { timeoutMs: 5000 });
      ok.resume();
      expect(ok.statusCode).toBe(200);
      await expect(openRequest({ protocol: 'https', host, ca: a.certPem, pin: b.fingerprint }, '/', { timeoutMs: 5000 })).rejects.toThrow();
      // The site CA with a name and a binding to the leaf read just before: another leaf of the same CA is refused.
      await expect(openRequest({ protocol: 'https', host, ca: ca.certPem, tlsServername: 'cam3.g.internal', pin: b.fingerprint }, '/', { timeoutMs: 5000 })).rejects.toThrow();
      expect(requests).toBe(1);
      const client = new ReolinkClient({ id: 'cam3', host, protocol: 'https', user: 'u', password: 'p' });
      client.setTrust({ ca: b.certPem, fingerprint: b.fingerprint });
      expect(await client.cameraCertificate()).toBeNull();
      client.setTrust({ ca: a.certPem, fingerprint: a.fingerprint });
      expect(await client.cameraCertificate()).not.toBeNull();
      expect(client.trusted()).toBe(true);
      client.setTrust(undefined);
      expect(client.trusted()).toBe(false);
    } finally {
      server.close();
    }
  }, 120_000);

  it('a trust that refuses: nothing is sent at all (a camera whose known trust is not available)', async () => {
    let requests = 0;
    const server = https.createServer({}, () => requests++);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const client = new ReolinkClient({ id: 'cam3', host, protocol: 'https', user: 'u', password: 'p' });
      client.setTrust({ refuse: 'no CA and no stored leaf' });
      await expect(client.command('GetDevInfo')).rejects.toThrow('no trusted certificate for this camera: no CA and no stored leaf');
      expect(await client.cameraCertificate()).toBeNull();
      expect(client.trusted()).toBe(true);
      expect(requests).toBe(0);
    } finally {
      server.close();
    }
  });
});
