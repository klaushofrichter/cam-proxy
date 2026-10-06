import { createHash } from 'crypto';
import { connect } from 'tls';

// The certificate a camera serves, read without validation (spec
// 2026-10-05-multi-camera-host-design §10.1.3): its factory certificate is
// self-signed, and a push is judged only by this fingerprint. Nothing is sent
// on this connection (closed right after the handshake). Every camera API call
// goes through ReolinkClient, verified against the site CA or pinned to the
// certificate read here (security review of #178). The only unvalidated TLS
// connection of the proxy: CodeQL accepts this file alone.
export interface Served { fingerprint: string; pem: string }

export function servedCertificate(host: string, port: number, timeoutMs = 10_000): Promise<Served | null> {
  return new Promise((resolve) => {
    const s = connect({ host, port, rejectUnauthorized: false }, () => {
      const c = s.getPeerX509Certificate();
      s.destroy();
      resolve(c ? { fingerprint: `SHA256:${createHash('sha256').update(c.raw).digest('hex').toUpperCase()}`, pem: c.toString() } : null);
    });
    s.setTimeout(timeoutMs, () => (s.destroy(), resolve(null)));
    s.on('error', () => resolve(null));
  });
}

export const servedFingerprint = async (host: string, port: number, timeoutMs?: number): Promise<string | null> => (await servedCertificate(host, port, timeoutMs))?.fingerprint ?? null;
