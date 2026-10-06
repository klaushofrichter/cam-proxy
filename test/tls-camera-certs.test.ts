import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
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
  const audits: { action: string; message: string; outcome: string; user?: string; details?: Record<string, unknown> }[] = [];
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
        issued.push(await issue()); // the retry: a fresh key, after a clear
        return { outcome: 'refused', served: s?.fingerprint ?? null, servedPem: s?.pem ?? null, clearedTo: s?.fingerprint ?? null, tookMs: 1 };
      }
      served.set(id, servedOf(a));
      return { outcome: 'pushed', served: a.fingerprint, servedPem: a.certPem, leaf: a, tookMs: 1 };
    },
    openEvent: (id) => open.has(id),
    localHour: (t) => new Date(t).getUTCHours(),
    onTrust: (id) => trust.push(`${id}:${certs.state(id).mode}`),
    audit: { write: (r) => (audits.push(r as (typeof audits)[number]), null) },
    now: () => now,
    ...o.deps,
  });
  return {
    certs, pushes, issued, trust, audits, open, served, dir,
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

  describe('security re-review of 4e13ca2', () => {
    it('a pinned camera that serves another certificate: no automatic push, also at 04:00; a problem', async () => {
      const { certs, pushes, served, at, now } = setup({ refuse: true });
      await certs.tick();
      expect(certs.state('cam3').mode).toBe('pinned');
      served.set('cam3', foreign('EVIL'));
      at(dayAt(now(), 1, 4, 5));
      await certs.tick();
      expect(pushes).toEqual(['cam3']);
      expect(certs.state('cam3')).toMatchObject({ mode: 'pinned', fingerprint: 'SHA256:FACTORY3', problem: 'cam3 serves an unexpected certificate (SHA256:EVIL): check the camera, then Push now' });
      // While it serves its pinned certificate, the 04:00 retry goes on.
      served.set('cam3', foreign('FACTORY3'));
      at(dayAt(now(), 1, 4, 5));
      await certs.tick();
      expect(pushes).toEqual(['cam3', 'cam3']);
    }, 60_000);

    it('state.json deleted: a camera with a stored leaf is still one that served our leaf (site-ca; no automatic push to another certificate)', async () => {
      const a = setup();
      await a.certs.tick();
      rmSync(join(a.dir, 'cameras', 'state.json'));
      const b = setup({ dir: a.dir, served: a.served });
      expect(b.certs.state('cam3')).toMatchObject({ mode: 'site-ca', servername: 'cam3.garage.internal' });
      b.served.set('cam3', foreign('EVIL'));
      await b.certs.tick();
      expect(b.pushes).toEqual([]);
    }, 60_000);

    it('only an old leaf left (<id>.crt.old-*): still a camera that served our leaf', async () => {
      const a = setup();
      await a.certs.tick();
      a.certs.reset('t9', null);
      rmSync(join(a.dir, 'cameras', 'state.json'));
      const b = setup({ dir: a.dir, served: new Map([['cam3', foreign('EVIL')]]) });
      await b.certs.tick();
      expect(b.pushes).toEqual([]);
      expect(b.certs.state('cam3').problem).toMatch(/serves an unexpected certificate/);
    }, 60_000);

    it('state.json unreadable or invalid: no automatic pushes at all, a problem; Push now still works', async () => {
      for (const text of ['{not json', JSON.stringify({ cameras: { cam3: { mode: 'weird' } } })]) {
        const dir = mkdtempSync(join(tmpdir(), 'camproxy-ccerts-bad-'));
        const { mkdirSync } = await import('fs');
        mkdirSync(join(dir, 'cameras'), { recursive: true });
        writeFileSync(join(dir, 'cameras', 'state.json'), text);
        const b = setup({ dir });
        await b.certs.tick();
        expect(b.pushes).toEqual([]);
        expect(b.certs.problems()).toEqual(['the camera certificate state (data/tls/cameras/state.json) is unreadable: no automatic pushes; check each camera, then Push now']);
        expect((await b.certs.pushNow('cam3')).outcome).toBe('pushed');
      }
    }, 60_000);

    it('camera certificates switched off, or the address outside the CA: the known trust stays, with a problem', async () => {
      let enabled = true;
      const a = setup({ deps: { enabled: () => enabled } });
      await a.certs.tick();
      enabled = false;
      await a.certs.tick();
      expect(a.certs.state('cam3')).toMatchObject({ mode: 'site-ca', problem: 'camera certificates are off (tls.cameraCerts): cam3 keeps its trust; nothing is pushed' });
      enabled = true;
      a.setCameras([{ id: 'cam3', address: '192.168.61.13', protocol: 'https' }]);
      await a.certs.tick();
      expect(a.certs.state('cam3')).toMatchObject({ mode: 'site-ca', problem: '192.168.61.13 is outside the site CA: rotate the CA (tls-ca-rotate)' });
      expect(a.trust).toEqual(['cam3:site-ca']);
    }, 60_000);

    it('clearTrust (the admin action): the camera back to first use, audited', async () => {
      const a = setup();
      await a.certs.tick();
      a.certs.clearTrust('cam3', { user: 'admin', ip: '10.0.0.5', requestedBy: 'session' });
      expect(a.certs.state('cam3').mode).toBe('none');
      expect(a.certs.leaf('cam3')).toBeNull();
      expect(a.audits.at(-1)).toMatchObject({ action: 'camera-trust', user: 'admin', message: 'Camera trust cleared (cam3): site-ca → none' });
      a.served.set('cam3', foreign('NEWCAM'));
      await a.certs.tick();
      expect(a.pushes).toEqual(['cam3']); // no automatic first push after a clear (third review)
      expect(a.certs.state('cam3').problem).toBe('cam3: its trust was cleared: Push now to push its first certificate');
      await a.certs.pushNow('cam3');
      expect(a.pushes).toEqual(['cam3', 'cam3']);
    }, 60_000);

    it('the previous CA: only for cameras still serving its leaf; dropped after 30 days or by the admin, the laggards named', async () => {
      const a = setup({ cameras: [{ id: 'cam3', address: '192.168.60.13', protocol: 'https' }, { id: 'cam4', address: '192.168.60.14', protocol: 'https' }] });
      await a.certs.tick();
      let current = ca;
      const b = setup({ dir: a.dir, served: a.served, cameras: [{ id: 'cam3', address: '192.168.60.13', protocol: 'https' }, { id: 'cam4', address: '192.168.60.14', protocol: 'https' }], deps: { ca: () => current } });
      current = other;
      b.certs.reset('t1', ca.certPem);
      b.open.add('cam4'); // cam4 lags behind
      await b.certs.tick();
      expect(b.certs.trustedCas('cam3')).toEqual([other.certPem]);
      expect(b.certs.trustedCas('cam4')).toEqual([other.certPem, ca.certPem]);
      expect(b.certs.problems()).toEqual(['cam4 still serves a leaf of the previous CA (trusted until 2026-11-19)']);
      b.at(b.now() + 31 * 86400_000);
      await b.certs.tick();
      expect(b.certs.trustedCas('cam4')).toEqual([other.certPem]);
      expect(b.audits.some((r) => r.message === 'Previous site CA no longer trusted (30 days after the rotation)')).toBe(true);
      const c = setup({ dir: a.dir, served: a.served, deps: { ca: () => other } });
      c.certs.dropPreviousCa({ user: 'admin' });
      expect(c.certs.trustedCas('cam4')).toEqual([other.certPem]);
    }, 60_000);

    it("ours() needs the camera's name in the leaf: a leaf of our CA for another camera is foreign", async () => {
      const a = setup();
      await a.certs.tick();
      const cam9 = await issueLeaf(ca, { cn: 'cam9.garage.internal', dns: ['cam9.garage.internal'], ips: ['192.168.60.13'] });
      a.served.set('cam3', servedOf(cam9));
      await a.certs.tick();
      expect(a.pushes).toEqual(['cam3']);
      expect(a.certs.state('cam3').problem).toMatch(/serves an unexpected certificate/);
    }, 60_000);

    it('mode changes and skipped pushes are audited; Push now names who asked', async () => {
      const a = setup({ refuse: true });
      await a.certs.tick();
      expect(a.audits.find((r) => r.action === 'camera-trust')).toMatchObject({ message: 'Camera trust cam3: none → pinned (SHA256:FACTORY3)' });
      a.open.add('cam3');
      await a.certs.pushNow('cam3', { user: 'admin', ip: '10.0.0.5', requestedBy: 'session' });
      expect(a.audits.at(-1)).toMatchObject({ action: 'camera-cert-push', outcome: 'failure', user: 'admin', message: 'Camera certificate push not done (cam3): an event is open: try again when it has ended', details: { requestedBy: 'session' } });
    }, 60_000);

    it("the camera's factory certificate is recorded when first seen after a clear, and expected after the next clear", async () => {
      const a = setup({ refuse: true });
      await a.certs.tick();
      expect(a.certs.factory('cam3')).toBe('SHA256:FACTORY3');
      let expected: string | undefined;
      const b = setup({ dir: a.dir, served: a.served, deps: { push: async (_id, _issue, o) => ((expected = o?.factory), { outcome: 'failed', served: null, tookMs: 0 }) } });
      await b.certs.pushNow('cam3');
      expect(expected).toBe('SHA256:FACTORY3');
    }, 60_000);
  });

  describe('third security review', () => {
    const two = [{ id: 'cam3', address: '192.168.60.13', protocol: 'https' as const }, { id: 'cam4', address: '192.168.60.14', protocol: 'https' as const }];
    it('an unreadable state blocks automatic pushes per camera: an admin push to cam3 does not unblock cam4 (pinned, its pin lost)', async () => {
      const a = setup({ cameras: two, refuse: true });
      await a.certs.tick(); // both pinned (refused)
      a.setMode({});
      writeFileSync(join(a.dir, 'cameras', 'state.json'), '{broken');
      const b = setup({ dir: a.dir, served: a.served, cameras: two });
      expect((await b.certs.pushNow('cam3')).outcome).toBe('pushed');
      b.served.set('cam4', foreign('EVIL4'));
      b.at(dayAt(b.now(), 1, 4, 5));
      await b.certs.tick();
      expect(b.pushes).toEqual(['cam3']);
      expect(b.certs.state('cam4').problem).toBe('cam4: no automatic push since the certificate state was unreadable: check the camera, then Push now');
      // Also after a restart (the block is kept in the rewritten state).
      const c = setup({ dir: a.dir, served: b.served, cameras: two });
      c.at(dayAt(c.now(), 1, 4, 5));
      await c.certs.tick();
      expect(c.pushes).toEqual([]);
      expect((await c.certs.pushNow('cam4')).outcome).toBe('pushed');
    }, 60_000);

    it('clearTrust also forgets the factory certificate (a replaced camera), audited with the cleared value', async () => {
      const a = setup({ refuse: true });
      await a.certs.tick();
      expect(a.certs.factory('cam3')).toBe('SHA256:FACTORY3');
      a.certs.clearTrust('cam3', { user: 'admin' });
      expect(a.certs.factory('cam3')).toBeNull();
      expect(a.audits.at(-1)).toMatchObject({ action: 'camera-trust', details: { factory: 'SHA256:FACTORY3' } });
    }, 60_000);

    it('everServed: a camera that served our leaf keeps that mark whatever its mode (public, http, an old leaf only)', async () => {
      const a = setup();
      await a.certs.tick();
      expect(a.certs.everServed('cam3')).toBe(true);
      a.setCameras([{ id: 'cam3', address: '192.168.60.13', protocol: 'http' }]);
      await a.certs.tick();
      expect(a.certs.state('cam3').mode).toBe('none');
      expect(a.certs.everServed('cam3')).toBe(true);
      a.certs.clearTrust('cam3', { user: 'admin' });
      expect(a.certs.everServed('cam3')).toBe(false);
    }, 60_000);

    it('the previous CA: dropped (audited) when the clock went back before the rotation, or its time is unknown', async () => {
      const a = setup();
      await a.certs.tick();
      let current = ca;
      const b = setup({ dir: a.dir, served: a.served, deps: { ca: () => current } });
      current = other;
      b.certs.reset('t1', ca.certPem);
      b.open.add('cam3');
      b.at(b.now() - 3600_000);
      await b.certs.tick();
      expect(b.certs.trustedCas('cam3')).toEqual([other.certPem]);
      expect(b.audits.some((r) => r.message === 'Previous site CA no longer trusted (the clock is before the rotation)')).toBe(true);
    }, 60_000);

    it('the previous CA dropped because no camera serves its leaf any more: audited', async () => {
      const a = setup();
      await a.certs.tick();
      let current = ca;
      const b = setup({ dir: a.dir, served: a.served, deps: { ca: () => current } });
      current = other;
      b.certs.reset('t1', ca.certPem);
      await b.certs.tick();
      expect(b.audits.some((r) => r.message === 'Previous site CA no longer trusted (every camera serves a leaf of the new one)')).toBe(true);
    }, 60_000);
  });

  describe('final check', () => {
    it('cleared, then Push now refused: pinned, and no longer blocked (the pin is the admin decision)', async () => {
      const a = setup();
      await a.certs.tick();
      a.certs.clearTrust('cam3', { user: 'admin' });
      a.setMode({ refuse: true });
      a.served.set('cam3', foreign('NEW3'));
      await a.certs.pushNow('cam3');
      expect(a.certs.state('cam3')).toMatchObject({ mode: 'pinned', fingerprint: 'SHA256:NEW3', problem: null });
      a.at(dayAt(a.now(), 1, 4, 5));
      await a.certs.tick(); // the 04:00 retry of a pinned camera serving its pin
      expect(a.certs.state('cam3').problem).toBeNull();
      expect(a.pushes).toEqual(['cam3', 'cam3', 'cam3']);
    }, 60_000);

    it('unreadable state, then Push now refused: pinned and unblocked; once no camera is blocked the state problem clears and a new camera is not blocked', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'camproxy-ccerts-final-'));
      const { mkdirSync } = await import('fs');
      mkdirSync(join(dir, 'cameras'), { recursive: true });
      writeFileSync(join(dir, 'cameras', 'state.json'), '{broken');
      const b = setup({ dir, refuse: true });
      await b.certs.tick();
      expect(b.pushes).toEqual([]);
      await b.certs.pushNow('cam3');
      expect(b.certs.state('cam3')).toMatchObject({ mode: 'pinned', problem: null });
      expect(b.certs.problems()).toEqual([]);
      b.setCameras([{ id: 'cam3', address: '192.168.60.13', protocol: 'https' }, { id: 'cam4', address: '192.168.60.14', protocol: 'https' }]);
      await b.certs.tick();
      expect(b.pushes).toEqual(['cam3', 'cam4']); // cam4 is a first use, not blocked
    }, 60_000);
  });
});
