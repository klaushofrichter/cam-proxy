import { sleep as realSleep } from '../async';
import type { Served } from './served';

// push_cert.py's logic inside cam-proxy (spec 2026-10-05-multi-camera-host-design
// §10.1.3), with the measured firmware rules (spec §2): an import over an
// installed custom certificate answers 200 and changes nothing, so an
// installed one is cleared first; the files are server.crt / server.key;
// success only ever by the fingerprint the camera serves. The key never
// reaches a log line or an error message.
//
// The session (security review of #178): bound to the certificate read just
// before it (bind: a pin on its SHA-256, and the site CA as well while the
// camera serves a leaf of it), so nothing goes to another host. After a
// CertificateClear the camera serves its factory certificate, which nothing
// vouches for: the session is bound again to what is served then (trust on
// first use, per attempt). Every attempt imports a fresh key: a key that went
// into a refused or failed import is never sent again.
export type PushOutcome = 'current' | 'pushed' | 'refused' | 'failed';
export interface PushedLeaf { certPem: string; keyPem: string; fingerprint: string; notAfter: number; names: string[]; ips: string[] }
export interface PushResult {
  outcome: PushOutcome;
  served: string | null; // SHA256:… the camera serves at the end
  servedPem?: string | null; // and its certificate (what the proxy pins after a refusal)
  leaf?: PushedLeaf; // the leaf the camera serves now (pushed)
  detail?: string;
  tookMs: number;
}
export interface PushDeps {
  served(): Promise<Served | null>;
  bind(s: Served): void; // the push session verifies exactly this certificate from now on (and logs in again)
  command<T>(cmd: string, param?: object): Promise<T>;
  relogin(): void;
  logout(): Promise<void>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

const part = (pem: string, name: string) => {
  const b = Buffer.from(pem, 'utf8');
  return { size: b.length, name, content: b.toString('base64') };
};

// `current`: the fingerprint of the leaf the camera should serve; served already → 'current', nothing sent.
export async function pushCertificate(d: PushDeps, issue: () => Promise<PushedLeaf>, o: { clearWaitMs?: number; verifyMs?: number; pollMs?: number } = {}, current?: string): Promise<PushResult> {
  const sleep = d.sleep ?? realSleep;
  const now = d.now ?? Date.now;
  const verifyMs = o.verifyMs ?? 90_000;
  const pollMs = o.pollMs ?? 5000;
  const t0 = now();
  const done = (outcome: PushOutcome, s: Served | null, extra: { leaf?: PushedLeaf; detail?: string } = {}): PushResult => ({ outcome, served: s?.fingerprint ?? null, servedPem: s?.pem ?? null, ...extra, tookMs: now() - t0 });
  // Until the camera serves something (its web server restarts), up to the verify time.
  const servedNow = async (): Promise<Served | null> => {
    const until = now() + verifyMs;
    for (;;) {
      const s = await d.served();
      if (s || now() >= until) return s;
      await sleep(pollMs);
    }
  };
  // GetCertificateInfo until the API answers on the bound session, up to the verify time; then the last error.
  const info = async (): Promise<{ CertificateInfo?: { enable?: number } }> => {
    const until = now() + verifyMs;
    for (;;) {
      try {
        return await d.command<{ CertificateInfo?: { enable?: number } }>('GetCertificateInfo');
      } catch (err) {
        d.relogin();
        if (now() >= until) throw err;
        await sleep(pollMs);
      }
    }
  };
  const waitFor = async (fp: string): Promise<Served | null> => {
    const until = now() + verifyMs;
    let last: Served | null = null;
    while (now() < until) {
      await sleep(pollMs);
      last = await d.served(); // null while the web server restarts
      if (last?.fingerprint === fp) return last;
    }
    return last;
  };
  const bindTo = (s: Served) => d.bind(s);
  const once = async (clearFirst: boolean): Promise<{ served: Served | null; leaf: PushedLeaf }> => {
    if (clearFirst) {
      await d.command('CertificateClear');
      await sleep(o.clearWaitMs ?? 10_000);
      const after = await servedNow();
      if (!after) throw new Error('the camera did not come back after CertificateClear');
      bindTo(after); // trust on first use: nothing vouches for the factory certificate
      await info();
    }
    const leaf = await issue(); // a fresh key for every attempt
    await d.command('ImportCertificate', { importCertificate: { crt: part(leaf.certPem, 'server.crt'), key: part(leaf.keyPem, 'server.key') } });
    const served = await waitFor(leaf.fingerprint);
    if (served?.fingerprint === leaf.fingerprint) {
      bindTo(served); // our leaf: the logout goes to the camera that took it
      await info().catch(() => undefined);
    }
    return { served, leaf };
  };
  let last: Served | null = null;
  try {
    const first = await servedNow();
    if (!first) return done('failed', null, { detail: 'the camera does not answer on HTTPS' });
    last = first;
    if (current && first.fingerprint === current) return done('current', first);
    bindTo(first);
    const installed = (await info()).CertificateInfo?.enable === 1;
    let r = await once(installed);
    if (r.served?.fingerprint === r.leaf.fingerprint) return done('pushed', r.served, { leaf: r.leaf });
    r = await once(true); // retry once, with a clear and a fresh key
    if (r.served?.fingerprint === r.leaf.fingerprint) return done('pushed', r.served, { leaf: r.leaf });
    last = r.served ?? (await d.served());
    return done('refused', last, { detail: 'the camera kept serving another certificate' });
  } catch (err) {
    return done('failed', (await d.served().catch(() => null)) ?? last, { detail: (err as Error).message });
  } finally {
    await d.logout().catch(() => undefined);
  }
}
