import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { siteCa, type SiteCa } from '../src/tls/ca';
import { CameraCerts, siteCaLeafCheck } from '../src/tls/camera-certs';
import { issueLeaf, type Leaf } from '../src/tls/leaf';
import type { Served } from '../src/tls/served';
import { otherCertificate } from './helpers/certs';

// Finding 21: Add camera trusts a camera without a fingerprint when it serves
// a leaf of THIS proxy's site CA for its own name (<id>.<site>.internal),
// valid now. Anything else (another CA, self-signed, another name, expired,
// not yet valid, the CA certificate itself) is refused with the reason.
let ca: SiteCa;
let other: SiteCa;
beforeAll(async () => {
  ca = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-sca-trust-')), { site: 'garage', cameraSubnet: '192.168.60.0/24', proxyAddresses: ['192.168.1.230'] });
  other = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-sca-trust2-')), { site: 'garage', cameraSubnet: '192.168.60.0/24', proxyAddresses: ['192.168.1.230'] });
}, 60_000);

const NAME = 'cam6.garage.internal';
const leafFor = (c: SiteCa, o: { name?: string; now?: number; days?: number } = {}) => issueLeaf(c, { cn: o.name ?? NAME, dns: [o.name ?? NAME], ips: ['192.168.60.16'], ...(o.now !== undefined ? { now: () => o.now! } : {}), ...(o.days !== undefined ? { days: o.days } : {}) });
const servedOf = (l: Leaf): Served => ({ fingerprint: l.fingerprint, pem: l.certPem });

describe('siteCaLeafCheck', () => {
  it("a leaf of this CA for the name, valid now: ok with its notAfter", async () => {
    const l = await leafFor(ca);
    expect(siteCaLeafCheck(l.certPem, ca.certPem, NAME, Date.now())).toEqual({ ok: true, notAfter: l.notAfter });
  }, 30_000);

  it('another CA, self-signed, another name, expired, not yet valid, the CA itself: refused with why', async () => {
    const now = Date.now();
    const foreign = await leafFor(other);
    expect(siteCaLeafCheck(foreign.certPem, ca.certPem, NAME, now)).toEqual({ ok: false, reason: "not issued by this proxy's site CA" });
    const self = await otherCertificate();
    expect(siteCaLeafCheck(self.pem, ca.certPem, NAME, now)).toEqual({ ok: false, reason: "not issued by this proxy's site CA" });
    const cam7 = await leafFor(ca, { name: 'cam7.garage.internal' });
    expect(siteCaLeafCheck(cam7.certPem, ca.certPem, NAME, now)).toEqual({ ok: false, reason: `not issued for ${NAME}` });
    const old = await leafFor(ca, { now: now - 10 * 86400_000, days: 2 });
    expect(siteCaLeafCheck(old.certPem, ca.certPem, NAME, now)).toMatchObject({ ok: false, reason: expect.stringMatching(/^expired /) });
    const future = await leafFor(ca, { now: now + 10 * 86400_000 });
    expect(siteCaLeafCheck(future.certPem, ca.certPem, NAME, now)).toMatchObject({ ok: false, reason: expect.stringMatching(/^not valid yet /) });
    expect(siteCaLeafCheck(ca.certPem, ca.certPem, NAME, now)).toEqual({ ok: false, reason: 'a CA certificate, not a camera certificate' });
    expect(siteCaLeafCheck('not a certificate', ca.certPem, NAME, now)).toEqual({ ok: false, reason: 'the certificate could not be read' });
  }, 60_000);
});

function certsFor(o: { site?: string | undefined; caOf?: () => SiteCa | null } = {}) {
  const audits: { action: string; message: string; outcome: string; user?: string; details?: Record<string, unknown> }[] = [];
  const trust: string[] = [];
  const certs: CameraCerts = new CameraCerts({
    dir: mkdtempSync(join(tmpdir(), 'camproxy-sca-certs-')),
    ca: o.caOf ?? (() => ca),
    site: () => ('site' in o ? o.site : 'garage'),
    enabled: () => true,
    cameras: () => [{ id: 'cam6', address: '192.168.60.16', protocol: 'https' }],
    served: async () => null,
    push: async () => ({ outcome: 'failed', served: null, tookMs: 0 }),
    openEvent: () => false,
    localHour: () => 10,
    onTrust: (id) => trust.push(`${id}:${certs.state(id).mode}`),
    audit: { write: (r) => (audits.push(r as (typeof audits)[number]), null) },
  });
  return { certs, audits, trust };
}

describe('CameraCerts.siteCaVerdict and adoptSiteCa', () => {
  it('the verdict names the CA and the servername; adopt makes the camera site-ca, audited once, its client told', async () => {
    const { certs, audits, trust } = certsFor();
    const l = await leafFor(ca);
    expect(certs.siteCaVerdict('cam6', servedOf(l))).toEqual({ ok: true, servername: NAME, ca: ca.certPem, notAfter: l.notAfter });
    const st = certs.adoptSiteCa('cam6', servedOf(l), { user: 'admin', requestedBy: 'token' });
    expect(st).toMatchObject({ mode: 'site-ca', servername: NAME, fingerprint: l.fingerprint, notAfter: l.notAfter, problem: null });
    expect(certs.everServed('cam6')).toBe(true);
    expect(certs.pin('cam6')).toBeNull();
    expect(trust).toEqual(['cam6:site-ca']);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'camera-trust', outcome: 'success', user: 'admin', details: { op: 'site-ca', from: 'none', fingerprint: l.fingerprint, servername: NAME } });
    expect(audits[0].message).toBe(`Camera trust cam6: none → site-ca, trust site-ca: served certificate issued by this proxy's site CA for ${NAME}`);
    expect(JSON.stringify(audits)).not.toContain('PRIVATE KEY');
  }, 30_000);

  it("refused: another CA, the wrong camera's leaf, no tls.site, no CA, a PEM that is not the fingerprint's", async () => {
    const mine = await leafFor(ca);
    expect(certsFor().certs.siteCaVerdict('cam6', servedOf(await leafFor(other)))).toEqual({ ok: false, reason: "not issued by this proxy's site CA" });
    expect(certsFor().certs.siteCaVerdict('cam6', servedOf(await leafFor(ca, { name: 'cam7.garage.internal' })))).toEqual({ ok: false, reason: `not issued for ${NAME}` });
    expect(certsFor({ site: undefined }).certs.siteCaVerdict('cam6', servedOf(mine))).toEqual({ ok: false, reason: 'this proxy has no site CA (tls.site is not set)' });
    expect(certsFor({ caOf: () => null }).certs.siteCaVerdict('cam6', servedOf(mine))).toEqual({ ok: false, reason: 'the site CA is not available' });
    expect(certsFor().certs.siteCaVerdict('cam6', { fingerprint: `SHA256:${'A'.repeat(64)}`, pem: mine.certPem })).toEqual({ ok: false, reason: 'the certificate does not match its fingerprint' });
    const { certs, audits } = certsFor();
    const foreign = servedOf(await leafFor(other));
    expect(() => certs.adoptSiteCa('cam6', foreign, { user: 'admin' })).toThrow(/not issued by this proxy's site CA/);
    expect(certs.state('cam6').mode).toBe('none');
    expect(audits).toEqual([]);
  }, 60_000);
});
