import { X509Certificate } from 'crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { CaError, fingerprintOf, siteCa } from '../src/tls/ca';

const OPTS = { site: 'garage', cameraSubnet: '192.168.60.0/24', proxyAddresses: ['192.168.1.230', '192.168.60.1'] };

describe('the site CA (spec §10.1.1)', () => {
  it('RSA 3072, 10 years, CN, critical name constraints; key 600, never in the cert file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-ca-'));
    const ca = await siteCa(dir, OPTS);
    const x = new X509Certificate(ca.certPem);
    expect(x.subject).toBe('CN=cam-proxy site CA garage');
    expect(x.ca).toBe(true);
    expect(x.publicKey.asymmetricKeyDetails?.modulusLength).toBe(3072);
    expect(Date.parse(x.validTo) - Date.parse(x.validFrom)).toBeGreaterThan(3650 * 86400_000 - 86400_000);
    expect(statSync(join(dir, 'ca.key')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'ca.pem'), 'utf8')).not.toContain('PRIVATE KEY');
    expect(ca.fingerprint).toMatch(/^SHA256:[0-9A-F]{64}$/);
    expect(ca.fingerprint).toBe(fingerprintOf(ca.certPem));
    expect(ca.covers('192.168.60.13')).toBe(true);
    expect(ca.covers('192.168.1.230')).toBe(true);
    expect(ca.covers('192.168.1.231')).toBe(false);
    expect(ca.coversName('cam3.garage.internal')).toBe(true);
    expect(ca.coversName('evil.example')).toBe(false);
  }, 60_000);

  it('a second start loads the same CA', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-ca-'));
    const a = await siteCa(dir, OPTS);
    const b = await siteCa(dir, OPTS);
    expect(b.fingerprint).toBe(a.fingerprint);
  }, 60_000);

  it("covers() follows the CA's own constraints, not today's settings (Review Focus 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-ca-'));
    await siteCa(dir, OPTS);
    const moved = await siteCa(dir, { ...OPTS, proxyAddresses: ['192.168.1.231', '192.168.60.1'] });
    expect(moved.covers('192.168.1.231')).toBe(false);
    expect(moved.covers('192.168.1.230')).toBe(true);
    const renamed = await siteCa(dir, { ...OPTS, site: 'shed' });
    expect(renamed.coversName('cam3.shed.internal')).toBe(false);
    expect(renamed.coversName('cam3.garage.internal')).toBe(true);
  }, 60_000);

  it('a key that does not belong to the certificate is refused', async () => {
    const a = mkdtempSync(join(tmpdir(), 'camproxy-ca-'));
    const b = mkdtempSync(join(tmpdir(), 'camproxy-ca-'));
    await siteCa(a, OPTS);
    await siteCa(b, OPTS);
    writeFileSync(join(a, 'ca.key'), readFileSync(join(b, 'ca.key')), { mode: 0o600 });
    await expect(siteCa(a, OPTS)).rejects.toThrow(CaError);
  }, 60_000);

  it('a key file readable by others is tightened to 600 on load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-ca-'));
    await siteCa(dir, OPTS);
    chmodSync(join(dir, 'ca.key'), 0o644);
    await siteCa(dir, OPTS);
    expect(statSync(join(dir, 'ca.key')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  }, 60_000);

  it('a CA without its key is not replaced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-ca-'));
    await siteCa(dir, OPTS);
    rmSync(join(dir, 'ca.key'));
    await expect(siteCa(dir, OPTS)).rejects.toThrow(CaError);
    expect(existsSync(join(dir, 'ca.pem'))).toBe(true);
  }, 60_000);
});
