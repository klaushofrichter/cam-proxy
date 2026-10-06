import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ReolinkClient } from '../src/camera/client';
import { siteCa, type SiteCa } from '../src/tls/ca';
import { issueLeaf, type Leaf } from '../src/tls/leaf';
import { pushCertificate } from '../src/tls/push';
import { servedCertificate, type Served } from '../src/tls/served';
import { startSim } from './helpers/sim';

let ca: SiteCa;
beforeAll(async () => {
  ca = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-push-')), { site: 'g', cameraSubnet: '127.0.0.0/16', proxyAddresses: ['127.0.0.1'] });
}, 60_000);
const sims: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of sims.splice(0)) await s.close();
});

const O = { clearWaitMs: 10, verifyMs: 5000, pollMs: 50 };
const issue = () => issueLeaf(ca, { cn: 'cam3.g.internal', dns: ['cam3.g.internal'], ips: ['127.0.0.1'] });

// The push session as the proxy builds it: pinned to what was read just before.
async function camera(o: { ignoreImport?: boolean } = {}) {
  const sim = await startSim(o);
  sims.push(sim);
  const host = `127.0.0.1:${sim.ports.https}`;
  const client = new ReolinkClient({ id: 'cam3', host, protocol: 'https', user: 'proxy', password: sim.password });
  const calls: { cmd: string; param?: object }[] = [];
  const binds: string[] = [];
  const deps = {
    served: () => servedCertificate('127.0.0.1', sim.ports.https),
    bind: (s: Served) => (binds.push(s.fingerprint), client.setTrust({ ca: s.pem, fingerprint: s.fingerprint }), client.forgetToken()),
    command: <T>(cmd: string, p?: object) => (calls.push({ cmd, param: p }), client.command<T>(cmd, p)),
    relogin: () => client.forgetToken(),
    logout: () => client.logout(),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50))),
  };
  return { sim, deps, calls, binds, client };
}
const issued = () => {
  const leaves: Leaf[] = [];
  return { leaves, issue: async () => { const l = await issue(); leaves.push(l); return l; } };
};

describe('camera certificate push (spec §10.1.3)', () => {
  it('pushes, judged by the served fingerprint; with the current leaf served: current', async () => {
    const { deps } = await camera();
    const i = issued();
    const r = await pushCertificate(deps, i.issue, O);
    expect(r).toMatchObject({ outcome: 'pushed', served: i.leaves[0].fingerprint, leaf: i.leaves[0] });
    expect((await pushCertificate(deps, i.issue, O, i.leaves[0].fingerprint)).outcome).toBe('current');
    expect(i.leaves).toHaveLength(1);
  }, 60_000);

  it('over an installed certificate: cleared first (the firmware ignores an import over one)', async () => {
    const { deps } = await camera();
    await pushCertificate(deps, issued().issue, O);
    const i = issued();
    expect(await pushCertificate(deps, i.issue, O)).toMatchObject({ outcome: 'pushed', served: i.leaves[0].fingerprint });
  }, 60_000);

  it('refusal: one retry with a clear and a fresh key, then refused with the served (factory) certificate', async () => {
    const { deps, calls } = await camera({ ignoreImport: true });
    const factory = (await deps.served())!;
    const i = issued();
    const r = await pushCertificate(deps, i.issue, { ...O, verifyMs: 300 });
    expect(r).toMatchObject({ outcome: 'refused', served: factory.fingerprint, servedPem: factory.pem });
    const imports = calls.filter((c) => c.cmd === 'ImportCertificate');
    expect(imports).toHaveLength(2);
    expect(calls.filter((c) => c.cmd === 'CertificateClear')).toHaveLength(1);
    // A key that went into a refused import is never sent again (security review #178).
    expect(i.leaves).toHaveLength(2);
    expect(i.leaves[0].keyPem).not.toBe(i.leaves[1].keyPem);
    const keyOf = (c: { param?: object }) => (c.param as { importCertificate: { key: { content: string } } }).importCertificate.key.content;
    expect(keyOf(imports[0])).not.toBe(keyOf(imports[1]));
  }, 60_000);

  it('the session is bound to the certificate read just before: another one, and nothing is sent', async () => {
    const { deps, calls } = await camera();
    const other = await issue();
    const r = await pushCertificate({ ...deps, served: async () => ({ fingerprint: other.fingerprint, pem: other.certPem }) }, issued().issue, { ...O, verifyMs: 300 });
    expect(r.outcome).toBe('failed');
    expect(calls.map((c) => c.cmd)).not.toContain('ImportCertificate');
  }, 60_000);

  it('after a clear: bound again to what the camera serves then (trust on first use, per attempt)', async () => {
    const { deps, binds } = await camera();
    await pushCertificate(deps, issued().issue, O);
    binds.length = 0;
    const i = issued();
    await pushCertificate(deps, i.issue, O);
    // Before: the installed leaf; after the clear: the factory one; after the import: the new leaf.
    expect(binds).toHaveLength(3);
    expect(binds[2]).toBe(i.leaves[0].fingerprint);
  }, 60_000);

  it("a camera whose web server is still restarting: the first call is tried again, not a failed push", async () => {
    const { sim, deps } = await camera();
    const i = issued();
    sim.sim.engine.clearCertificate(); // the API answers again after cam-sim's 200 ms restart
    expect(await pushCertificate(deps, i.issue, O)).toMatchObject({ outcome: 'pushed', served: i.leaves[0].fingerprint });
  }, 60_000);

  it('a camera that never answers: failed', async () => {
    const { sim, deps } = await camera();
    sim.sim.engine.faults.set({ name: 'offline' });
    const r = await pushCertificate(deps, issued().issue, { ...O, verifyMs: 300 });
    expect(r.outcome).toBe('failed');
    expect(r.detail).not.toMatch(/PRIVATE|BEGIN/);
  }, 60_000);
});
