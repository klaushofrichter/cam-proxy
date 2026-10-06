import { mkdtempSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
import { siteCa, type SiteCa } from '../src/tls/ca';
import { CameraCerts, type CertCamera } from '../src/tls/camera-certs';
import type { Leaf } from '../src/tls/leaf';
import type { PushResult } from '../src/tls/push';

let ca: SiteCa;
beforeAll(async () => {
  ca = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-ccerts-ca-')), { site: 'garage', cameraSubnet: '192.168.60.0/24', proxyAddresses: ['192.168.1.230'] });
}, 60_000);

function setup(o: { cameras?: CertCamera[]; refuse?: boolean; fail?: boolean } = {}) {
  let now = Date.UTC(2026, 9, 20, 10, 0); // 10:00 camera time (localHour = UTC hour here)
  const served = new Map<string, string | null>([['cam3', 'SHA256:FACTORY3'], ['cam4', 'SHA256:FACTORY4']]);
  const open = new Set<string>();
  const pushes: string[] = [];
  const trust: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-ccerts-'));
  let cameras = o.cameras ?? [{ id: 'cam3', address: '192.168.60.13', protocol: 'https' as const }];
  const certs = new CameraCerts({
    dir,
    ca: () => ca, site: () => 'garage', enabled: () => true,
    cameras: () => cameras,
    served: async (id) => served.get(id) ?? null,
    push: async (id: string, leaf: Leaf): Promise<PushResult> => {
      pushes.push(id);
      if (o.refuse) return { outcome: 'refused', served: served.get(id) ?? null, tookMs: 1 };
      if (o.fail) return { outcome: 'failed', served: served.get(id) ?? null, detail: 'ImportCertificate failed (rspCode -4)', tookMs: 1 };
      served.set(id, leaf.fingerprint);
      return { outcome: 'pushed', served: leaf.fingerprint, tookMs: 1 };
    },
    openEvent: (id) => open.has(id),
    localHour: (t) => new Date(t).getUTCHours(),
    onTrust: (id) => trust.push(`${id}:${certs.state(id).mode}`),
    now: () => now,
  });
  return { certs, pushes, trust, open, served, dir, at: (ms: number) => (now = ms), now: () => now, setCameras: (c: CertCamera[]) => (cameras = c) };
}

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
    const d = new Date(first.notAfter - 20 * 86400_000);
    at(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10, 0));
    await certs.tick();
    expect(pushes).toEqual(['cam3']); // renewal due, but not at 10:00
    at(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 4, 5));
    await certs.tick();
    expect(pushes).toEqual(['cam3', 'cam3']);
    expect(certs.leaf('cam3')!.fingerprint).not.toBe(first.fingerprint);
  }, 60_000);

  it('refused: pinned with the served fingerprint; the next try waits for 04:00 (Ruling P5-6)', async () => {
    const { certs, pushes } = setup({ refuse: true });
    await certs.tick();
    expect(certs.state('cam3')).toMatchObject({ mode: 'pinned', fingerprint: 'SHA256:FACTORY3', lastPush: { outcome: 'refused' } });
    await certs.tick();
    expect(pushes).toEqual(['cam3']);
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

  it('the next camera in line goes first while one has an open event (Review Focus 1)', async () => {
    const { certs, pushes, open } = setup({ cameras: [
      { id: 'cam3', address: '192.168.60.13', protocol: 'https' },
      { id: 'cam4', address: '192.168.60.14', protocol: 'https' },
    ] });
    open.add('cam3');
    await certs.tick();
    expect(pushes).toEqual(['cam4']);
  }, 60_000);

  it('a renewal blocked by an event at 04:00 goes out when the event ends, not a day later', async () => {
    const { certs, pushes, at, open } = setup();
    await certs.tick();
    const d = new Date(certs.leaf('cam3')!.notAfter - 20 * 86400_000);
    open.add('cam3');
    at(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 4, 5));
    await certs.tick();
    expect(pushes).toEqual(['cam3']);
    open.delete('cam3');
    at(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 5, 30));
    await certs.tick();
    expect(pushes).toEqual(['cam3', 'cam3']);
  }, 60_000);

  it('an unreachable camera is not pushed to', async () => {
    const { certs, pushes, served } = setup();
    served.set('cam3', null);
    await certs.tick();
    expect(pushes).toEqual([]);
  }, 60_000);

  it('a failed push is retried after an hour, not every tick', async () => {
    const { certs, pushes, at, now } = setup({ fail: true });
    await certs.tick();
    expect(certs.state('cam3')).toMatchObject({ mode: 'pinned', lastPush: { outcome: 'failed' }, problem: 'push failed: ImportCertificate failed (rspCode -4)' });
    at(now() + 10 * 60_000);
    await certs.tick();
    expect(pushes).toEqual(['cam3']);
    at(now() + 60 * 60_000);
    await certs.tick();
    expect(pushes).toEqual(['cam3', 'cam3']);
  }, 60_000);

  it('a new camera address: a new leaf for it', async () => {
    const { certs, pushes, setCameras } = setup();
    await certs.tick();
    const first = certs.leaf('cam3')!;
    setCameras([{ id: 'cam3', address: '192.168.60.23', protocol: 'https' }]);
    await certs.tick();
    expect(certs.leaf('cam3')!.ips).toEqual(['192.168.60.23']);
    expect(certs.leaf('cam3')!.fingerprint).not.toBe(first.fingerprint);
    expect(pushes).toEqual(['cam3', 'cam3']);
  }, 60_000);

  it('leaf keys are 600; the state survives a restart', async () => {
    const { certs, dir, served } = setup({ refuse: true });
    await certs.tick();
    expect(statSync(join(dir, 'cameras', 'cam3.key')).mode & 0o777).toBe(0o600);
    const again = new CameraCerts({ dir, ca: () => ca, site: () => 'garage', enabled: () => true, cameras: () => [{ id: 'cam3', address: '192.168.60.13', protocol: 'https' }], served: async (id) => served.get(id) ?? null, push: async () => ({ outcome: 'refused', served: null, tookMs: 0 }), openEvent: () => false, localHour: () => 10, now: () => Date.UTC(2026, 9, 20, 10, 10) });
    expect(again.state('cam3').lastPush).toMatchObject({ outcome: 'refused' });
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

  it("onTrust on every change of a camera's mode (its client follows: CA or not)", async () => {
    const { certs, trust, served, at, now } = setup();
    await certs.tick();
    expect(trust).toEqual(['cam3:site-ca']);
    await certs.tick();
    expect(trust).toEqual(['cam3:site-ca']); // no change, no call
    served.set('cam3', 'SHA256:RESET'); // the camera was reset: its factory certificate again
    at(now() + 3600_000);
    await certs.tick(); // pushed again: still site-ca
    expect(trust).toEqual(['cam3:site-ca']);
  }, 60_000);

  it('reset (a new CA): every camera drops the CA until its new leaf is served', async () => {
    const { certs, trust, pushes } = setup();
    await certs.tick();
    certs.reset();
    expect(certs.state('cam3').mode).toBe('none');
    expect(trust).toEqual(['cam3:site-ca', 'cam3:none']);
    await certs.tick();
    expect(pushes).toEqual(['cam3', 'cam3']); // a new leaf: pushed again
    expect(trust).toEqual(['cam3:site-ca', 'cam3:none', 'cam3:site-ca']);
  }, 60_000);
});
