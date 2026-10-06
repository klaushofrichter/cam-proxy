// Read-only measurements on a camera of the multi-camera host (spec
// 2026-10-05-multi-camera-host-design §15): GetDevInfo, GetNtp,
// GetCertificateInfo and the certificate it serves. --set-ntp writes the
// whole Ntp object with only `server` (and enable) changed, re-reads it, and
// logs out (CLAUDE.md: whole-object Sets only). Never on cam1.
import { createHash, X509Certificate } from 'crypto';
import { readFileSync } from 'fs';
import { connect } from 'tls';
import { ReolinkClient } from '../src/camera/client';
import { bareHost, splitHost } from '../src/camera/http';
import { setLogLevel } from '../src/log';

export interface Measure {
  devInfo: { model: string; firmware: string } | { error: string };
  ntp: Record<string, unknown> | { error: string };
  certificateInfo: Record<string, unknown> | { error: string };
  served: { fingerprint: string; subject: string; issuer: string; validTo: string } | null;
  setNtp?: { before: unknown; after: unknown } | { error: string };
}

const CAMERA_NET = /^192\.168\.60\.\d{1,3}$/;
const err = (e: unknown) => ({ error: (e as Error).message });

// The certificate the camera serves, read without validation (a factory
// certificate is self-signed): nothing is sent, the socket closes after the
// handshake. Accepted in .github/codeql-accepted.tsv.
function served(host: string, port: number): Promise<Measure['served']> {
  return new Promise((resolve) => {
    const s = connect({ host, port, rejectUnauthorized: false, servername: undefined }, () => {
      const raw = s.getPeerCertificate(true)?.raw;
      s.destroy();
      if (!raw) return resolve(null);
      const x = new X509Certificate(raw);
      resolve({ fingerprint: createHash('sha256').update(raw).digest('hex').toUpperCase(), subject: x.subject, issuer: x.issuer, validTo: x.validTo });
    });
    s.setTimeout(10_000, () => (s.destroy(), resolve(null)));
    s.on('error', () => resolve(null));
  });
}

export async function measureCamera(o: { host: string; protocol: 'https' | 'http'; user: string; password: string; setNtp?: string; allowAnyHost?: boolean }): Promise<Measure> {
  const { hostname, port } = splitHost(o.host);
  const ip = bareHost(hostname);
  if (!o.allowAnyHost && !CAMERA_NET.test(ip)) throw new Error(`${ip} is not on the camera network 192.168.60.0/24 (cam1 is never measured); --allow-any-host to override`);
  const c = new ReolinkClient({ id: 'measure', host: o.host, protocol: o.protocol, user: o.user, password: o.password });
  const m: Measure = { devInfo: { error: 'not read' }, ntp: { error: 'not read' }, certificateInfo: { error: 'not read' }, served: null };
  try {
    try {
      const s = await c.status();
      m.devInfo = { model: s.model, firmware: s.firmware };
    } catch (e) {
      m.devInfo = err(e);
    }
    try {
      m.ntp = await c.command<Record<string, unknown>>('GetNtp');
    } catch (e) {
      m.ntp = err(e);
    }
    try {
      m.certificateInfo = await c.command<Record<string, unknown>>('GetCertificateInfo');
    } catch (e) {
      m.certificateInfo = err(e);
    }
    if (o.setNtp) {
      try {
        const before = (m.ntp as { Ntp?: Record<string, unknown> }).Ntp;
        if (!before) throw new Error('GetNtp gave no Ntp object: nothing written');
        await c.command('SetNtp', { Ntp: { ...before, enable: 1, server: o.setNtp } });
        const after = (await c.command<{ Ntp?: unknown }>('GetNtp')).Ntp;
        m.setNtp = { before, after };
      } catch (e) {
        m.setNtp = err(e);
      }
    }
  } finally {
    await c.logout().catch(() => undefined);
  }
  if (o.protocol === 'https') m.served = await served(ip, port ?? 443);
  return m;
}

if (require.main === module) {
  // stdout is the JSON result only (the client warns about an unverified
  // certificate on every https camera).
  setLogLevel('error');
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const password = process.env.CAMPROXY_CAMERA_PASSWORD_FILE ? readFileSync(process.env.CAMPROXY_CAMERA_PASSWORD_FILE, 'utf8').trim() : process.env.CAMPROXY_CAMERA_PASSWORD;
  const host = opt('host');
  if (!host || !password) {
    process.stderr.write('usage: CAMPROXY_CAMERA_PASSWORD=… npx tsx scripts/measure-camera.ts --host <ip> [--protocol https|http] [--user proxy] [--set-ntp <server>] [--allow-any-host]\n');
    process.exit(2);
  }
  measureCamera({ host, protocol: (opt('protocol') as 'https' | 'http') ?? 'https', user: opt('user') ?? 'proxy', password, setNtp: opt('set-ntp'), allowAnyHost: args.includes('--allow-any-host') })
    .then((m) => process.stdout.write(`${JSON.stringify(m, null, 2)}\n`))
    .catch((e: Error) => {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    });
}
