// Probe a camera before adding it (spec 2026-10-30-camera-onboarding-design
// §4.2): which ports answer, the certificate it serves, and with a password
// its model and capabilities. Read-only on the camera (a TCP connect, a TLS
// handshake, Login, GetDevInfo, GetAbility, Logout); nothing is stored. Over
// https a password goes only to the certificate the caller confirmed.
import { X509Certificate } from 'crypto';
import net from 'net';
import { bareHost, splitHost } from '../camera/http';
import { deriveCapabilities, type Capabilities } from '../camera/capabilities';
import { validCameraHost } from '../config/env';
import { servedCertificate } from '../tls/served';
import { checkLogin } from './login-check';
import { PASSWORD_RULE, validPassword } from './password-rule';

export type PortName = 'http' | 'https' | 'rtsp' | 'onvif' | 'baichuan';
export const PORT_NAMES: readonly PortName[] = ['http', 'https', 'rtsp', 'onvif', 'baichuan'];
export const DEFAULT_PORTS: Record<PortName, number> = { http: 80, https: 443, rtsp: 554, onvif: 8000, baichuan: 9000 };
export const FINGERPRINT = /^SHA256:[0-9A-F]{64}$/;

export interface ProbeInput { host: string; protocol: 'https' | 'http'; user: string; password?: string; fingerprint?: string; ports: Record<PortName, number> }
export interface ProbeCertificate { fingerprint: string; subject: string; issuer: string; notAfter: number; selfSigned: boolean }
export interface ProbeResult {
  host: string;
  ports: Record<PortName, boolean>;
  certificate: ProbeCertificate | null;
  login: 'ok' | 'refused' | 'offline' | 'not_tried';
  device: { model: string; firmware: string; name: string | null } | null;
  capabilities: Capabilities | null;
  tookMs: number;
}

const validPort = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;
export const validUser = (v: unknown): v is string => typeof v === 'string' && /^[\x21-\x7e]{1,32}$/.test(v);

// The probe's body, checked; a string is the 400 detail. `host` is kept bare
// (its :port becomes the protocol's port).
export function probeInput(body: Record<string, unknown>): ProbeInput | string {
  const host: unknown = body.host;
  if (!validCameraHost(host)) return 'host: an address or name, optional :port';
  const protocol = body.protocol ?? 'https';
  if (protocol !== 'https' && protocol !== 'http') return 'protocol: https or http';
  const user = body.user ?? 'admin';
  if (!validUser(user)) return 'user: 1 to 32 printable characters, no spaces';
  if (body.password !== undefined && !validPassword(body.password)) return PASSWORD_RULE;
  if (body.fingerprint !== undefined && (typeof body.fingerprint !== 'string' || !FINGERPRINT.test(body.fingerprint))) return 'fingerprint: SHA256: and 64 upper-case hex digits';
  const ports = { ...DEFAULT_PORTS };
  if (body.ports !== undefined) {
    if (typeof body.ports !== 'object' || body.ports === null || Array.isArray(body.ports)) return 'ports: an object of http, https, rtsp, onvif, baichuan';
    for (const [k, v] of Object.entries(body.ports)) {
      if (!(PORT_NAMES as readonly string[]).includes(k) || !validPort(v)) return `ports.${k.slice(0, 16)}: a port (1 to 65535) of http, https, rtsp, onvif, baichuan`;
      ports[k as PortName] = v;
    }
  }
  const { hostname, port } = splitHost(host);
  if (port !== undefined) ports[protocol] = port;
  return { host: hostname, protocol, user, ...(body.password !== undefined ? { password: body.password as string } : {}), ...(body.fingerprint !== undefined ? { fingerprint: body.fingerprint as string } : {}), ports };
}

// A TCP connect, then closed; nothing is sent.
function portOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const oneLine = (dn: string) => dn.split('\n').filter(Boolean).join(', ');
function certificateOf(pem: string, fingerprint: string): ProbeCertificate {
  const x = new X509Certificate(pem);
  let selfSigned = x.subject === x.issuer;
  try {
    selfSigned = selfSigned && x.verify(x.publicKey);
  } catch {
    // keep the name comparison
  }
  return { fingerprint, subject: oneLine(x.subject), issuer: oneLine(x.issuer), notAfter: Date.parse(x.validTo), selfSigned };
}

// The host joined with a port again (IPv6 in brackets).
export const withPort = (host: string, port: number) => (host.includes(':') ? `[${bareHost(host)}]:${port}` : `${host}:${port}`);

export async function probeCamera(i: ProbeInput, o: { connectTimeoutMs?: number; tlsTimeoutMs?: number } = {}): Promise<ProbeResult | { error: 'fingerprint_mismatch'; served: string | null }> {
  const t0 = Date.now();
  const bare = bareHost(i.host);
  const open = await Promise.all(PORT_NAMES.map((n) => portOpen(bare, i.ports[n], o.connectTimeoutMs ?? 1500)));
  const ports = Object.fromEntries(PORT_NAMES.map((n, k) => [n, open[k]])) as Record<PortName, boolean>;
  const served = i.protocol === 'https' && ports.https ? await servedCertificate(bare, i.ports.https, o.tlsTimeoutMs ?? 3000) : null;
  const certificate = served ? certificateOf(served.pem, served.fingerprint) : null;
  const result: ProbeResult = { host: i.host, ports, certificate, login: 'not_tried', device: null, capabilities: null, tookMs: 0 };
  if (i.password !== undefined) {
    if (i.protocol === 'https' && (!served || served.fingerprint !== i.fingerprint)) return { error: 'fingerprint_mismatch', served: served?.fingerprint ?? null };
    const r = await checkLogin({ id: 'probe', host: withPort(i.host, i.ports[i.protocol]), protocol: i.protocol, user: i.user, password: i.password, ...(served ? { trust: { ca: served.pem, fingerprint: served.fingerprint } } : {}) });
    result.login = r.outcome === 'ok' ? 'ok' : r.outcome === 'refused' ? 'refused' : 'offline';
    if (r.outcome === 'ok') {
      result.device = r.device ?? null;
      result.capabilities = deriveCapabilities(r.ability);
    }
  }
  result.tookMs = Date.now() - t0;
  return result;
}
