import { connect } from 'tls';
import { sha256Pin } from './pin';

// The certificate a camera serves, read without validation (spec
// 2026-10-05-multi-camera-host-design §10.1.3): its factory certificate is
// self-signed, and a push is judged only by this fingerprint. Nothing is sent
// on this connection (closed right after the handshake). Every camera API call
// goes through ReolinkClient, verified against the site CA or pinned to the
// certificate read here (security review of #178). The only unvalidated TLS
// connection of the proxy: CodeQL accepts this file alone.
export interface Served { fingerprint: string; pem: string }

// `servername`: the SNI name to ask for (a moving camera's source proxy, whose
// served leaf the target pins for its one GET of /tls/ca.pem, evaluate.ts).
export function servedCertificate(host: string, port: number, timeoutMs = 10_000, servername?: string): Promise<Served | null> {
  return new Promise((resolve) => {
    const s = connect({ host, port, rejectUnauthorized: false, ...(servername ? { servername } : {}) }, () => {
      const c = s.getPeerX509Certificate();
      s.destroy();
      resolve(c ? { fingerprint: sha256Pin(c.raw), pem: c.toString() } : null);
    });
    s.setTimeout(timeoutMs, () => (s.destroy(), resolve(null)));
    s.on('error', () => resolve(null));
  });
}

export const servedFingerprint = async (host: string, port: number, timeoutMs?: number): Promise<string | null> => (await servedCertificate(host, port, timeoutMs))?.fingerprint ?? null;
