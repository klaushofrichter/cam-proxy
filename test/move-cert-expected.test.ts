// The certificate guard during a camera move (camera-move plan P8, Task 7):
// `expected` is one leaf fingerprint the camera may serve without being
// "unexpected"; the camera's trust accepts exactly that leaf, nothing else.
// Documentation addresses (RFC 5737) only.
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { setLogLevel } from '../src/log';
import { siteCa, type SiteCa } from '../src/tls/ca';
import { CameraCerts } from '../src/tls/camera-certs';
import { issueLeaf, type Leaf } from '../src/tls/leaf';
import type { PushResult } from '../src/tls/push';
import type { Served } from '../src/tls/served';

let ca: SiteCa;
let target: SiteCa;
let targetLeaf: Leaf;
let otherTargetLeaf: Leaf;
beforeAll(async () => {
  setLogLevel('silent');
  ca = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-exp-ca-')), { site: 'garage', cameraSubnet: '192.0.2.0/24', proxyAddresses: ['198.51.100.1'] });
  target = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-exp-ca2-')), { site: 'shed', cameraSubnet: '192.0.2.0/24', proxyAddresses: ['198.51.100.2'] });
  targetLeaf = await issueLeaf(target, { cn: 'cam3.shed.internal', dns: ['cam3.shed.internal'], ips: ['192.0.2.13'] });
  otherTargetLeaf = await issueLeaf(target, { cn: 'cam3.shed.internal', dns: ['cam3.shed.internal'], ips: ['192.0.2.13'] });
}, 60_000);

const foreign = (name: string): Served => ({ fingerprint: `SHA256:${name}`, pem: `not a certificate: ${name}` });
const servedOf = (l: Leaf): Served => ({ fingerprint: l.fingerprint, pem: l.certPem });

function setup(dir = mkdtempSync(join(tmpdir(), 'camproxy-exp-'))) {
  const served = new Map<string, Served | null>([['cam3', foreign('FACTORY3')]]);
  const pushes: string[] = [];
  const trust: string[] = [];
  const audits: { action: string; message: string; details?: Record<string, unknown> }[] = [];
  const certs: CameraCerts = new CameraCerts({
    dir,
    ca: () => ca, site: () => 'garage', enabled: () => true,
    cameras: () => [{ id: 'cam3', address: '192.0.2.13', protocol: 'https' }],
    served: async (id) => served.get(id) ?? null,
    push: async (id, issue): Promise<PushResult> => {
      pushes.push(id);
      const a = await issue();
      served.set(id, servedOf(a));
      return { outcome: 'pushed', served: a.fingerprint, servedPem: a.certPem, leaf: a, tookMs: 1 };
    },
    openEvent: () => false,
    localHour: () => 10,
    onTrust: (id) => trust.push(id),
    audit: { write: (r) => (audits.push(r as (typeof audits)[number]), null) },
    now: () => Date.UTC(2026, 9, 21, 10, 0),
  });
  return { certs, served, pushes, trust, audits, dir };
}

describe('Extra.expected (P8)', () => {
  it("go stores the expected leaf and the camera's cert check accepts it: no push, no problem, the trust pins exactly that leaf", async () => {
    const { certs, served, pushes, trust } = setup();
    await certs.tick();
    expect(certs.state('cam3').mode).toBe('site-ca');
    const ours = certs.leaf('cam3')!.fingerprint;
    certs.setExpected('cam3', targetLeaf.fingerprint);
    expect(certs.expected('cam3')).toBe(targetLeaf.fingerprint);
    // Not served yet: no expected trust, the normal one stays.
    expect(certs.expectedTrust('cam3')).toBeNull();
    // The target pushed its leaf.
    served.set('cam3', servedOf(targetLeaf));
    const before = trust.length;
    await certs.tick();
    expect(pushes).toEqual(['cam3']); // only the first push, none for the expected leaf
    expect(certs.state('cam3')).toMatchObject({ mode: 'site-ca', fingerprint: ours, problem: null });
    expect(certs.expectedTrust('cam3')).toEqual({ fingerprint: targetLeaf.fingerprint, pem: targetLeaf.certPem });
    expect(trust.length).toBeGreaterThan(before);
  }, 60_000);

  it('an unrelated cert is still unexpected (another leaf of the same target CA, a factory certificate)', async () => {
    const { certs, served, pushes } = setup();
    await certs.tick();
    certs.setExpected('cam3', targetLeaf.fingerprint);
    for (const s of [servedOf(otherTargetLeaf), foreign('IMPOSTOR')]) {
      served.set('cam3', s);
      await certs.tick();
      expect(certs.state('cam3').problem).toBe(`cam3 serves an unexpected certificate (${s.fingerprint}): check the camera, then Push now`);
      expect(certs.expectedTrust('cam3')).toBeNull();
    }
    expect(pushes).toEqual(['cam3']);
  }, 60_000);

  it('a served PEM that is not the expected leaf is not taken, even when the fingerprint claims it', async () => {
    const { certs, served } = setup();
    await certs.tick();
    certs.setExpected('cam3', targetLeaf.fingerprint);
    served.set('cam3', { fingerprint: targetLeaf.fingerprint, pem: otherTargetLeaf.certPem });
    await certs.checkExpected();
    expect(certs.expectedTrust('cam3')).toBeNull();
    await certs.tick();
    expect(certs.expectedTrust('cam3')).toBeNull();
  }, 60_000);

  it('follows what the camera serves: back on our leaf, the normal trust again', async () => {
    const { certs, served, trust } = setup();
    await certs.tick();
    const ours = servedOf(certs.leaf('cam3')!);
    certs.setExpected('cam3', targetLeaf.fingerprint);
    served.set('cam3', servedOf(targetLeaf));
    await certs.checkExpected();
    expect(certs.expectedTrust('cam3')).not.toBeNull();
    served.set('cam3', ours);
    const n = trust.length;
    await certs.checkExpected();
    expect(certs.expectedTrust('cam3')).toBeNull();
    expect(trust.length).toBe(n + 1);
    // Unreachable: what was seen last stays.
    served.set('cam3', servedOf(targetLeaf));
    await certs.checkExpected();
    served.set('cam3', null);
    await certs.checkExpected();
    expect(certs.expectedTrust('cam3')).not.toBeNull();
  }, 60_000);

  it('survives a restart (state.json), and is cleared with null: back to the normal trust, audited', async () => {
    const a = setup();
    await a.certs.tick();
    a.certs.setExpected('cam3', targetLeaf.fingerprint);
    a.served.set('cam3', servedOf(targetLeaf));
    await a.certs.checkExpected();
    const stored = JSON.parse(readFileSync(join(a.dir, 'cameras', 'state.json'), 'utf8')).cameras.cam3;
    expect(stored).toMatchObject({ expected: targetLeaf.fingerprint, expectedServing: true });
    expect(JSON.stringify(stored)).not.toContain('PRIVATE');
    const b = setup(a.dir);
    expect(b.certs.expected('cam3')).toBe(targetLeaf.fingerprint);
    expect(b.certs.expectedTrust('cam3')).toEqual({ fingerprint: targetLeaf.fingerprint, pem: targetLeaf.certPem });
    b.certs.setExpected('cam3', null);
    expect(b.certs.expected('cam3')).toBeNull();
    expect(b.certs.expectedTrust('cam3')).toBeNull();
    expect(b.trust).toContain('cam3');
    // Then the target's leaf is unexpected again.
    b.served.set('cam3', servedOf(targetLeaf));
    await b.certs.tick();
    expect(b.certs.state('cam3').problem).toBe(`cam3 serves an unexpected certificate (${targetLeaf.fingerprint}): check the camera, then Push now`);
    const msgs = [...a.audits, ...b.audits].filter((r) => r.action === 'camera-trust').map((r) => r.message);
    expect(msgs).toEqual(expect.arrayContaining([`Camera trust cam3: expects the leaf ${targetLeaf.fingerprint} (camera move)`, 'Camera trust cam3: no expected leaf any more (camera move)']));
  }, 60_000);

  it('a stored expected PEM that does not hash to the expected fingerprint is dropped at restart', async () => {
    const a = setup();
    await a.certs.tick();
    a.certs.setExpected('cam3', targetLeaf.fingerprint);
    a.served.set('cam3', servedOf(targetLeaf));
    await a.certs.checkExpected();
    const file = join(a.dir, 'cameras', 'state.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.cameras.cam3.expectedPem = otherTargetLeaf.certPem;
    (await import('fs')).writeFileSync(file, JSON.stringify(raw));
    const b = setup(a.dir);
    expect(b.certs.expected('cam3')).toBe(targetLeaf.fingerprint);
    expect(b.certs.expectedTrust('cam3')).toBeNull();
  }, 60_000);

  it('Push now still pushes while the camera serves the expected leaf (the source taking its camera back, Task 10)', async () => {
    const { certs, served, pushes } = setup();
    await certs.tick();
    certs.setExpected('cam3', targetLeaf.fingerprint);
    served.set('cam3', servedOf(targetLeaf));
    const r = await certs.pushNow('cam3', { user: 'admin' });
    expect(r.outcome).toBe('pushed');
    expect(pushes).toEqual(['cam3', 'cam3']);
  }, 60_000);

  it('only a fingerprint: anything else is refused', () => {
    const { certs } = setup();
    expect(() => certs.setExpected('cam3', 'abc')).toThrow();
    expect(certs.expected('cam3')).toBeNull();
  });
});
