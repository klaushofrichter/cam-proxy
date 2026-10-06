import { createHash } from 'crypto';
import { connect } from 'tls';
import { sleep as realSleep } from '../async';

// push_cert.py's logic inside cam-proxy (spec 2026-10-05-multi-camera-host-design
// §10.1.3), with the measured firmware rules (spec §2): an import over an
// installed custom certificate answers 200 and changes nothing, so an
// installed one is cleared first; the files are server.crt / server.key;
// success only ever by the fingerprint the camera serves. The key never
// reaches a log line or an error message.
export type PushOutcome = 'current' | 'pushed' | 'refused' | 'failed';
export interface PushResult { outcome: PushOutcome; served: string | null; detail?: string; tookMs: number }
export interface PushDeps {
  served(): Promise<string | null>;
  command<T>(cmd: string, param?: object): Promise<T>;
  relogin(): void;
  logout(): Promise<void>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export function servedFingerprint(host: string, port: number, timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    const s = connect({ host, port, rejectUnauthorized: false }, () => {
      const raw = s.getPeerCertificate()?.raw;
      s.destroy();
      resolve(raw ? `SHA256:${createHash('sha256').update(raw).digest('hex').toUpperCase()}` : null);
    });
    s.setTimeout(timeoutMs, () => (s.destroy(), resolve(null)));
    s.on('error', () => resolve(null));
  });
}

const part = (pem: string, name: string) => {
  const b = Buffer.from(pem, 'utf8');
  return { size: b.length, name, content: b.toString('base64') };
};

export async function pushCertificate(d: PushDeps, leaf: { certPem: string; keyPem: string; fingerprint: string }, o: { clearWaitMs?: number; verifyMs?: number; pollMs?: number } = {}): Promise<PushResult> {
  const sleep = d.sleep ?? realSleep;
  const now = d.now ?? Date.now;
  const t0 = now();
  const done = (outcome: PushOutcome, served: string | null, detail?: string): PushResult => ({ outcome, served, ...(detail ? { detail } : {}), tookMs: now() - t0 });
  const waitFor = async (): Promise<string | null> => {
    const until = now() + (o.verifyMs ?? 90_000);
    let last: string | null = null;
    while (now() < until) {
      await sleep(o.pollMs ?? 5000);
      last = await d.served(); // null while the web server restarts
      if (last === leaf.fingerprint) return last;
    }
    return last;
  };
  // After a clear, until the camera's API answers again (a new login after its
  // web server restarted), or the verify time is up: then the import tries anyway.
  const back = async (): Promise<void> => {
    const until = now() + (o.verifyMs ?? 90_000);
    for (;;) {
      try {
        await d.command('GetCertificateInfo');
        return;
      } catch {
        d.relogin();
        if (now() >= until) return;
        await sleep(o.pollMs ?? 5000);
      }
    }
  };
  const once = async (clearFirst: boolean): Promise<string | null> => {
    if (clearFirst) {
      await d.command('CertificateClear');
      d.relogin(); // the web server restarts: a new session after the wait
      await sleep(o.clearWaitMs ?? 10_000);
      await back();
    }
    await d.command('ImportCertificate', { importCertificate: { crt: part(leaf.certPem, 'server.crt'), key: part(leaf.keyPem, 'server.key') } });
    d.relogin();
    const served = await waitFor();
    // The new certificate shows before the API is back: wait for it, so the
    // logout reaches the camera and the next request finds it answering.
    if (served === leaf.fingerprint) await back();
    return served;
  };
  try {
    const before = await d.served();
    if (before === leaf.fingerprint) return done('current', before);
    const info = await d.command<{ CertificateInfo?: { enable?: number } }>('GetCertificateInfo');
    const installed = info.CertificateInfo?.enable === 1;
    let served = await once(installed);
    if (served === leaf.fingerprint) return done('pushed', served);
    served = await once(true); // retry once, with a clear
    if (served === leaf.fingerprint) return done('pushed', served);
    return done('refused', served ?? (await d.served()), 'the camera kept serving another certificate');
  } catch (err) {
    return done('failed', await d.served().catch(() => null), (err as Error).message);
  } finally {
    await d.logout().catch(() => undefined);
  }
}
