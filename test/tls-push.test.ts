import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ReolinkClient } from '../src/camera/client';
import { siteCa, type SiteCa } from '../src/tls/ca';
import { issueLeaf } from '../src/tls/leaf';
import { pushCertificate, servedFingerprint } from '../src/tls/push';
import { startSim } from './helpers/sim';

let ca: SiteCa;
beforeAll(async () => {
  ca = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-push-')), { site: 'g', cameraSubnet: '127.0.0.0/8', proxyAddresses: ['127.0.0.1'] });
}, 60_000);
const sims: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.close();
});

async function camera(o: { ignoreImport?: boolean } = {}) {
  const sim = await startSim(o);
  sims.push(sim);
  const host = `127.0.0.1:${sim.ports.https}`;
  const client = new ReolinkClient({ id: 'cam3', host, protocol: 'https', user: 'proxy', password: sim.password });
  const deps = {
    served: () => servedFingerprint('127.0.0.1', sim.ports.https),
    command: <T>(cmd: string, p?: object) => client.command<T>(cmd, p),
    relogin: () => client.forgetToken(),
    logout: () => client.logout(),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50))),
  };
  return { sim, deps };
}

describe('camera certificate push (spec §10.1.3)', () => {
  it('pushes, judged by the served fingerprint; a second run is current', async () => {
    const { deps } = await camera();
    const leaf = await issueLeaf(ca, { cn: 'cam3.g.internal', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });
    const r = await pushCertificate(deps, leaf, { clearWaitMs: 10, verifyMs: 5000, pollMs: 50 });
    expect(r).toMatchObject({ outcome: 'pushed', served: leaf.fingerprint });
    expect((await pushCertificate(deps, leaf, { clearWaitMs: 10, verifyMs: 5000, pollMs: 50 })).outcome).toBe('current');
  }, 60_000);

  it('over an installed certificate: cleared first (the firmware ignores an import over one)', async () => {
    const { deps } = await camera();
    const a = await issueLeaf(ca, { cn: 'cam3.g.internal', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });
    const b = await issueLeaf(ca, { cn: 'cam3.g.internal', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });
    await pushCertificate(deps, a, { clearWaitMs: 10, verifyMs: 5000, pollMs: 50 });
    const rb = await pushCertificate(deps, b, { clearWaitMs: 10, verifyMs: 5000, pollMs: 50 });
    expect(rb).toMatchObject({ outcome: 'pushed', served: b.fingerprint });
  }, 60_000);

  it('refusal: one retry, then refused with the served (factory) fingerprint', async () => {
    const { deps } = await camera({ ignoreImport: true });
    const factory = await deps.served();
    const leaf = await issueLeaf(ca, { cn: 'cam3.g.internal', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });
    const calls: string[] = [];
    const counted = { ...deps, command: <T>(cmd: string, p?: object) => (calls.push(cmd), deps.command<T>(cmd, p)) };
    const r = await pushCertificate(counted, leaf, { clearWaitMs: 10, verifyMs: 300, pollMs: 50 });
    expect(r).toMatchObject({ outcome: 'refused', served: factory });
    expect(calls.filter((c) => c === 'ImportCertificate')).toHaveLength(2);
    expect(calls.filter((c) => c === 'CertificateClear')).toHaveLength(1);
  }, 60_000);

  it("a camera whose web server is still restarting: the first call is tried again, not a failed push", async () => {
    const { sim, deps } = await camera();
    const leaf = await issueLeaf(ca, { cn: 'cam3.g.internal', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });
    sim.sim.engine.clearCertificate(); // the API answers again after cam-sim's 200 ms restart
    expect(await pushCertificate(deps, leaf, { clearWaitMs: 10, verifyMs: 5000, pollMs: 50 })).toMatchObject({ outcome: 'pushed', served: leaf.fingerprint });
  }, 60_000);

  it('a camera that never answers its API: failed once the verify time is up', async () => {
    const { sim, deps } = await camera();
    const leaf = await issueLeaf(ca, { cn: 'cam3.g.internal', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });
    sim.sim.engine.faults.set({ name: 'offline' });
    const r = await pushCertificate(deps, leaf, { clearWaitMs: 10, verifyMs: 300, pollMs: 50 });
    expect(r.outcome).toBe('failed');
    expect(r.detail).not.toMatch(/PRIVATE|BEGIN/);
  }, 60_000);
});
