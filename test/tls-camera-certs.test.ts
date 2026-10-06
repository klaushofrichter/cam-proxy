import { existsSync, mkdtempSync, readdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { siteCa, type SiteCa } from '../src/tls/ca';
import { CameraCerts, type CameraCertsDeps, type CertCamera } from '../src/tls/camera-certs';
import { issueLeaf, type Leaf } from '../src/tls/leaf';
import type { PushResult } from '../src/tls/push';
import type { Served } from '../src/tls/served';

let ca: SiteCa;
let other: SiteCa;
beforeAll(async () => {
  ca = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-ccerts-ca-')), { site: 'garage', cameraSubnet: '192.168.60.0/24', proxyAddresses: ['192.168.1.230'] });
  other = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-ccerts-ca2-')), { site: 'garage', cameraSubnet: '192.168.60.0/24', proxyAddresses: ['192.168.1.230'] });
}, 60_000);

// A certificate nothing vouches for (a factory one, or an impostor's).
const foreign = (name: string): Served => ({ fingerprint: `SHA256:${name}`, pem: `not a certificate: ${name}` });
const servedOf = (l: Leaf): Served => ({ fingerprint: l.fingerprint, pem: l.certPem });

function setup(o: { cameras?: CertCamera[]; refuse?: boolean; fail?: boolean; dir?: string; served?: Map<string, Served | null>; deps?: Partial<CameraCertsDeps> } = {}) {
  let now = Date.UTC(2026, 9, 20, 10, 0); // 10:00 camera time (localHour = UTC hour here)
  const served = o.served ?? new Map<string, Served | null>([['cam3', foreign('FACTORY3')], ['cam4', foreign('FACTORY4')]]);
  const open = new Set<string>();
  const pushes: string[] = [];
  const issued: Leaf[] = [];
  const trust: string[] = [];
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'camproxy-ccerts-'));
  let cameras = o.cameras ?? [{ id: 'cam3', address: '192.168.60.13', protocol: 'https' as const }];
  let mode = { refuse: !!o.refuse, fail: !!o.fail };
  const certs: CameraCerts = new CameraCerts({
    dir,
    ca: () => ca, site: () => 'garage', enabled: () => true,
    cameras: () => cameras,
    served: async (id) => served.get(id) ?? null,
    push: async (id: string, issue: () => Promise<Leaf>): Promise<PushResult> => {
      pushes.push(id);
      const s = served.get(id) ?? null;
      if (mode.fail) return { outcome: 'failed', served: s?.fingerprint ?? null, servedPem: s?.pem ?? null, detail: 'ImportCertificate failed (rspCode -4)', tookMs: 1 };
      const a = await issue();
      issued.push(a);
      if (mode.refuse) {
        issued.push(await issue()); // the retry: a fresh key
        return { outcome: 'refused', served: s?.fingerprint ?? null, servedPem: s?.pem ?? null, tookMs: 1 };
      }
      served.set(id, servedOf(a));
      return { outcome: 'pushed', served: a.fingerprint, servedPem: a.certPem, leaf: a, tookMs: 1 };
    },
    openEvent: (id) => open.has(id),
    localHour: (t) => new Date(t).getUTCHours(),
    onTrust: (id) => trust.push(`${id}:${certs.state(id).mode}`),
    now: () => now,
    ...o.deps,
  });
  return {
    certs, pushes, issued, trust, open, served, dir,
    at: (ms: number) => (now = ms), now: () => now,
    setCameras: (c: CertCamera[]) => (cameras = c),
    setMode: (m: { refuse?: boolean; fail?: boolean }) => (mode = { refuse: !!m.refuse, fail: !!m.fail }),
  };
}
const dayAt = (t: number, days: number, hour: number, min = 0) => {
  const d = new Date(t + days * 86400_000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, min);
};

describe('camera certificates (spec §10.1.3)', () => {
  it('a new camera gets its leaf and a push at the next tick (Ruling P5-5); then site-ca', async () => {
    const { certs, pushes } = setup();
    await certs.tick();
    expect(pushes).toEqual(['cam3']);
    expect(certs.state('cam3')).toMatchObject({ mode: 'site-ca', servername: 'cam3.garage.internal', fingerprint: certs.leaf('cam3')!.fingerprint, lastPush: { outcome: 'pushed' }, problem: null });
    await certs.tick();
    expect(pushes).toEqual(['cam3']); // served = the leaf: nothing to do
  }, 60_000);

  it('never during an open event', async () => {
    const { certs, pushes, open } = setup();
    open.add('cam3');
    await certs.tick();
    expect(pushes).toEqual([]);
    open.delete('cam3');
    await certs.tick();
    expect(pushes).toEqual(['cam3']);
  }, 60_000);

  it('renewal: a new leaf 30 days before expiry, pushed at 04:00 camera time only', async () => {
    const { certs, pushes, at } = setup();
    await certs.tick();
    const first = certs.leaf('cam3')!;
    at(dayAt(first.notAfter, -20, 10));
    await certs.tick();
    expect(pushes).toEqual(['cam3']); // renewal due, but not at 10:00
    at(dayAt(first.notAfter, -19, 4, 5));
    await certs.tick();
    expect(pushes).toEqual(['cam3', 'cam3']);
    expect(certs.leaf('cam3')!.fingerprint).not.toBe(first.fingerprint);
    expect(certs.state('cam3').mode).toBe('site-ca');
  }, 60_000);

  it('a renewal blocked by an event at 04:00 goes out when the event ends, not a day later (Review Focus 1)', async () => {
    const { certs, pushes, at, open } = setup();
    await certs.tick();
    const notAfter = certs.leaf('cam3')!.notAfter;
    open.add('cam3');
    at(dayAt(notAfter, -20, 4, 5));
    await certs.tick();
    expect(pushes).toEqual(['cam3']);
    open.delete('cam3');
    at(dayAt(notAfter, -20, 5, 30));
    await certs.tick();
    expect(pushes).toEqual(['cam3', 'cam3']);
  }, 60_000);

  it('the next camera in line goes first while one has an open event (Review Focus 1)', async () => {
    const { certs, pushes, open } = setup({ cameras: [
      { id: 'cam3', address: '192.168.60.13', protocol: 'https' },
      { id: 'cam4', address: '192.168.60.14', protocol: 'https' },
    ] });
    open.add('cam3');
    await certs.tick();
    expect(pushes).toEqual(['cam4']);
  }, 60_000);

  it('a first push refused: pinned to the served certificate; the next try waits for 04:00 (Ruling P5-6)', async () => {
    const { certs, pushes, served } = setup({ refuse: true });
    await certs.tick();
    expect(certs.state('cam3')).toMatchObject({ mode: 'pinned', fingerprint: 'SHA256:FACTORY3', lastPush: { outcome: 'refused' } });
    expect(certs.pin('cam3')).toEqual(foreign('FACTORY3'));
    // Another certificate shows up: the pin stays what the proxy pinned (never re-pinned silently).
    served.set('cam3', foreign('OTHER'));
    await certs.tick();
    expect(pushes).toEqual(['cam3']);
    expect(certs.state('cam3').fingerprint).toBe('SHA256:FACTORY3');
    expect(certs.pin('cam3')!.fingerprint).toBe('SHA256:FACTORY3');
  }, 60_000);

  it('a key that went into a refused push is never stored or reused (security review #178)', async () => {
    const { certs, issued, dir } = setup({ refuse: true });
    await certs.tick();
    expect(issued).toHaveLength(2);
    expect(certs.leaf('cam3')).toBeNull();
    expect(existsSync(join(dir, 'cameras', 'cam3.key'))).toBe(false);
  }, 60_000);

  it('http: none; tlsName: public; an address outside the CA: none with the problem', async () => {
    const { certs, pushes } = setup({ cameras: [
      { id: 'cam3', address: '192.168.60.13', protocol: 'http' },
      { id: 'cam4', address: '192.168.60.14', protocol: 'https', tlsName: 'cam4.example.org' },
      { id: 'cam5', address: '192.168.61.15', protocol: 'https' },
    ] });
    await certs.tick();
    expect(pushes).toEqual([]);
    expect(certs.state('cam3').mode).toBe('none');
    expect(certs.state('cam4')).toMatchObject({ mode: 'public', servername: 'cam4.example.org' });
    expect(certs.state('cam5')).toMatchObject({ mode: 'none', problem: '192.168.61.15 is outside the site CA: rotate the CA (tls-ca-rotate)' });
  }, 60_000);

  it('an unreachable camera is not pushed to', async () => {
    const { certs, pushes, served } = setup();
    served.set('cam3', null);
    await certs.tick();
    expect(pushes).toEqual([]);
  }, 60_000);

  it('a failed first push: retried after an hour, the mode unchanged (no pin from a failure)', async () => {
    const { certs, pushes, at, now } = setup({ fail: true });
    await certs.tick();
    expect(certs.state('cam3')).toMatchObject({ mode: 'none', lastPush: { outcome: 'failed' }, problem: 'push failed: ImportCertificate failed (rspCode -4)' });
    at(now() + 10 * 60_000);
    await certs.tick();
    expect(pushes).toEqual(['cam3']);
    at(now() + 60 * 60_000);
    await certs.tick();
    expect(pushes).toEqual(['cam3', 'cam3']);
  }, 60_000);

  it('a new camera address: a new leaf, pushed (the session starts verified: the old leaf is ours)', async () => {
    const { certs, pushes, setCameras } = setup();
    await certs.tick();
    const first = certs.leaf('cam3')!;
    setCameras([{ id: 'cam3', address: '192.168.60.23', protocol: 'https' }]);
    await certs.tick();
    expect(certs.leaf('cam3')!.ips).toEqual(['192.168.60.23']);
    expect(certs.leaf('cam3')!.fingerprint).not.toBe(first.fingerprint);
    expect(pushes).toEqual(['cam3', 'cam3']);
  }, 60_000);

  describe('a camera that served our leaf (security review #178)', () => {
    it('serves something else (an impostor, or a reset): no automatic push; a problem; the CA stays its only trust; Push now pushes', async () => {
      const { certs, pushes, served, trust, at, now } = setup();
      await certs.tick();
      served.set('cam3', foreign('EVIL'));
      for (const h of [1, 25, 49]) {
        at(now() + h * 3600_000); // also through 04:00 windows
        await certs.tick();
      }
      expect(pushes).toEqual(['cam3']);
      expect(certs.state('cam3')).toMatchObject({ mode: 'site-ca', problem: 'cam3 serves an unexpected certificate (SHA256:EVIL): check the camera, then Push now' });
      expect(trust).toEqual(['cam3:site-ca']);
      expect((await certs.pushNow('cam3')).outcome).toBe('pushed');
      expect(certs.state('cam3')).toMatchObject({ mode: 'site-ca', problem: null });
    }, 60_000);

    it('an automatic renewal refused: stays site-ca (never pinned automatically), with the problem', async () => {
      const { certs, at, setMode, trust } = setup();
      await certs.tick();
      setMode({ refuse: true });
      at(dayAt(certs.leaf('cam3')!.notAfter, -20, 4, 5));
      await certs.tick();
      expect(certs.state('cam3')).toMatchObject({ mode: 'site-ca', lastPush: { outcome: 'refused' } });
      expect(certs.pin('cam3')).toBeNull();
      expect(trust).toEqual(['cam3:site-ca']);
    }, 60_000);

    it('Push now refused: pinned (the admin decided), to what the proxy pins itself', async () => {
      const { certs, served, setMode } = setup();
      await certs.tick();
      served.set('cam3', foreign('RESET'));
      setMode({ refuse: true });
      const r = await certs.pushNow('cam3');
      expect(r.outcome).toBe('refused');
      expect(certs.state('cam3')).toMatchObject({ mode: 'pinned', fingerprint: 'SHA256:RESET' });
      expect(certs.pin('cam3')).toEqual(foreign('RESET'));
    }, 60_000);
  });

  it('the state survives a restart: mode, pin and whether the camera served our leaf (no unverified window)', async () => {
    const a = setup({ cameras: [{ id: 'cam3', address: '192.168.60.13', protocol: 'https' }, { id: 'cam4', address: '192.168.60.14', protocol: 'https' }] });
    a.served.set('cam4', foreign('FACTORY4'));
    await a.certs.tick(); // both pushed
    a.setMode({ refuse: true });
    a.served.set('cam4', foreign('RESET4'));
    await a.certs.pushNow('cam4'); // pinned by the admin
    const b = setup({ dir: a.dir, served: a.served, cameras: [{ id: 'cam3', address: '192.168.60.13', protocol: 'https' }, { id: 'cam4', address: '192.168.60.14', protocol: 'https' }] });
    expect(b.certs.state('cam3')).toMatchObject({ mode: 'site-ca', servername: 'cam3.garage.internal', lastPush: { outcome: 'pushed' } });
    expect(b.certs.state('cam4')).toMatchObject({ mode: 'pinned', fingerprint: 'SHA256:RESET4' });
    expect(b.certs.pin('cam4')).toEqual(foreign('RESET4'));
    // Still a camera that served our leaf: a mismatch is not pushed to automatically after the restart.
    b.served.set('cam3', foreign('EVIL'));
    await b.certs.tick();
    expect(b.pushes).toEqual([]);
    expect(statSync(join(a.dir, 'cameras', 'cam3.key')).mode & 0o777).toBe(0o600);
  }, 60_000);

  it('a restored site-ca state needs a leaf of the current CA (after a rotation: none)', async () => {
    const a = setup();
    await a.certs.tick();
    const b = setup({ dir: a.dir, served: a.served, deps: { ca: () => other } });
    expect(b.certs.state('cam3').mode).toBe('none');
  }, 60_000);

  it('Push now: never during an open event, and says why; not for a camera without a site-CA certificate', async () => {
    const { certs, pushes, open } = setup({ cameras: [
      { id: 'cam3', address: '192.168.60.13', protocol: 'https' },
      { id: 'cam4', address: '192.168.60.14', protocol: 'http' },
    ] });
    open.add('cam3');
    expect(await certs.pushNow('cam3')).toMatchObject({ outcome: 'failed', detail: 'an event is open: try again when it has ended' });
    expect(await certs.pushNow('cam4')).toMatchObject({ outcome: 'failed', detail: 'cam4 has no site-CA certificate (http)' });
    expect(pushes).toEqual([]);
    open.delete('cam3');
    expect((await certs.pushNow('cam3')).outcome).toBe('pushed');
  }, 60_000);

  it('Push now after a refusal tries again at once (Ruling P5-6)', async () => {
    const { certs, pushes } = setup({ refuse: true });
    await certs.tick();
    await certs.pushNow('cam3');
    expect(pushes).toEqual(['cam3', 'cam3']);
  }, 60_000);

  it('onTrust on every change of a camera mode', async () => {
    const { certs, trust } = setup();
    await certs.tick();
    expect(trust).toEqual(['cam3:site-ca']);
    await certs.tick();
    expect(trust).toEqual(['cam3:site-ca']);
  }, 60_000);

  it("a new CA: cameras serving the previous CA's leaf stay trusted (both CAs) and are pushed automatically", async () => {
    const a = setup();
    await a.certs.tick();
    const old = a.certs.leaf('cam3')!;
    let current = ca;
    const b = setup({ dir: a.dir, served: a.served, deps: { ca: () => current } });
    expect(b.certs.state('cam3').mode).toBe('site-ca');
    current = other;
    b.certs.reset('t1', ca.certPem);
    expect(readdirSync(join(a.dir, 'cameras')).filter((f) => f.endsWith('.old-t1'))).toHaveLength(2);
    expect(b.certs.state('cam3').mode).toBe('site-ca'); // the old leaf still verifies (previous CA)
    expect(b.certs.trustedCas()).toEqual([other.certPem, ca.certPem]);
    await b.certs.tick();
    expect(b.pushes).toEqual(['cam3']);
    expect(b.certs.leaf('cam3')!.fingerprint).not.toBe(old.fingerprint);
    await b.certs.tick();
    expect(b.certs.trustedCas()).toEqual([other.certPem]); // every camera on the new CA: the old one dropped
  }, 60_000);
});
