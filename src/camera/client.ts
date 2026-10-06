import { randomBytes } from 'crypto';
import { isIP } from 'net';
import { connect as tlsConnect } from 'tls';
import { IncomingMessage } from 'node:http';
import { logger } from '../log';
import { type TimeInfo, timeInfoFromGetTime } from './time';

// The camera as the client needs it.
export interface CameraConfig {
  id: string;
  host: string; // address or name, optional :port
  protocol: 'https' | 'http';
  tlsServername?: string; // verify the camera's certificate against this name
  tlsCa?: string; // ...and against this CA only (the site CA); without it, the public CAs
  user: string;
  password: string;
}
import { bareHost, CameraTarget, openRequest, readBody, requestWasWritten, ResponseTooLargeError, splitHost } from './http';
import { Semaphore } from './semaphore';

export type CameraErrorCode = 'camera_offline' | 'camera_auth_failed' | 'camera_error';

// Messages are for logs only and never contain URLs, tokens or passwords;
// clients see just the code.
export class CameraError extends Error {
  // `requestSent`: the request reached the camera before the failure (the
  // connection dropped after it was written), so the camera may have acted.
  constructor(
    readonly code: CameraErrorCode,
    message: string,
    readonly requestSent = false,
    readonly rspCode?: number, // the camera's error code, when it answered
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

interface CameraStatus {
  model: string;
  firmware: string;
  serial?: string; // changes on every reboot (cams docs/reolink-api.md)
  name?: string; // the camera's name (GetDevName and the OSD text are the same value)
}

interface ReolinkReply {
  code: number;
  value?: Record<string, unknown>;
  error?: { rspCode?: number; detail?: string };
}

const AUTH_RSP_CODES = new Set([-6]); // "please login first": token unknown or expired
const TOKEN_RENEW_MARGIN_MS = 60_000;
const LOGIN_BACKOFF_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 10_000;

// TLS certificate failures (bad cert, hostname mismatch, self-signed, ...)
// are a security signal, not a reachability one: surfacing them as
// camera_offline would make an operator retry forever instead of fixing the
// certificate or tlsServername.
function isTlsCertError(code: string): boolean {
  // UNABLE_TO_VERIFY_LEAF_SIGNATURE is a certificate-verification failure
  // too, but its code contains neither "ERR_TLS_" nor "CERT" - catch it via
  // "SIGNATURE" as well. (SELF_SIGNED_CERT_IN_CHAIN and other *_CERT_*
  // codes already match the CERT check above.)
  return code.startsWith('ERR_TLS_') || code.includes('CERT') || code.includes('SIGNATURE');
}

export function classifyNetworkError(err: unknown, requestSent = requestWasWritten(err)): CameraError {
  const name = err instanceof Error ? err.name : 'Error';
  const code = (err as { code?: string }).code ?? name;
  if (isTlsCertError(code)) {
    return new CameraError('camera_error', `TLS certificate check failed (${code})`);
  }
  return new CameraError('camera_offline', `camera unreachable (${code})`, requestSent);
}

export class ReolinkClient {
  private token: { value: string; expiresAt: number } | null = null;
  private time: { value: TimeInfo; at: number } | null = null;
  private loginInFlight: Promise<string> | null = null;
  private lastLoginFailure = Number.NEGATIVE_INFINITY;
  private readonly gate: Semaphore;
  private readonly timeoutMs: number;
  private target: CameraTarget;
  // The site CA's trust, once the camera serves its leaf (setTrust).
  private trust: { ca: string; servername: string } | undefined;

  constructor(
    private readonly cam: CameraConfig,
    // `tlsCa` is a test seam: extra trusted CA certificates for cameraCertificate().
    private readonly opts: { timeoutMs?: number; maxConcurrent?: number; now?: () => number; tlsCa?: string | Buffer } = {},
  ) {
    this.gate = new Semaphore(opts.maxConcurrent ?? 2);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.target = { protocol: cam.protocol, host: cam.host, tlsServername: cam.tlsServername, ...(cam.tlsCa ? { ca: cam.tlsCa } : {}) };
    if (cam.tlsCa && cam.tlsServername) this.trust = { ca: cam.tlsCa, servername: cam.tlsServername };
    if (cam.protocol === 'https' && !cam.tlsServername && !cam.tlsCa) {
      logger.warn({ cameraId: cam.id }, 'camera TLS certificate is not verified (no tlsServername configured)');
    }
  }

  // Verify the camera against the site CA by this name from the next request
  // on (spec 2026-10-05-multi-camera-host-design §10.4), or, with undefined,
  // as configured again (the camera stopped serving its leaf). Requests in
  // flight finish on their connection.
  setTrust(t: { ca: string; servername: string } | undefined): void {
    this.trust = t;
    this.target = t ? { protocol: this.cam.protocol, host: this.cam.host, tlsServername: t.servername, ca: t.ca } : { protocol: this.cam.protocol, host: this.cam.host, tlsServername: this.cam.tlsServername };
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async post(cmd: string, param: object, token?: string): Promise<ReolinkReply> {
    const path = `/cgi-bin/api.cgi?cmd=${encodeURIComponent(cmd)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    const body = JSON.stringify([{ cmd, action: 0, param }]);
    return this.gate.run(async () => {
      let res: IncomingMessage;
      try {
        res = await openRequest(this.target, path, { method: 'POST', body, timeoutMs: this.timeoutMs });
      } catch (err) {
        throw classifyNetworkError(err);
      }
      if (res.statusCode === 503) {
        res.resume();
        throw new CameraError('camera_offline', `${cmd}: camera unavailable (HTTP 503)`);
      }
      if (res.statusCode !== 200) {
        res.resume();
        throw new CameraError('camera_error', `${cmd}: HTTP ${res.statusCode}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse((await readBody(res)).toString('utf8'));
      } catch (err) {
        if (err instanceof SyntaxError) throw new CameraError('camera_error', `${cmd}: response is not JSON`);
        if (err instanceof ResponseTooLargeError) throw new CameraError('camera_error', `${cmd}: response too large`);
        throw classifyNetworkError(err, true); // dropped mid-reply: the request was sent
      }
      const first = Array.isArray(parsed) ? (parsed[0] as ReolinkReply | undefined) : undefined;
      if (!first || typeof first.code !== 'number') throw new CameraError('camera_error', `${cmd}: unexpected response`);
      return first;
    });
  }

  private async login(): Promise<string> {
    const reply = await this.post('Login', {
      User: { Version: '0', userName: this.cam.user, password: this.cam.password },
    });
    const token = (reply.value?.Token ?? {}) as { name?: string; leaseTime?: number };
    if (reply.code !== 0 || !token.name) {
      this.lastLoginFailure = this.now();
      throw new CameraError('camera_auth_failed', `login rejected (rspCode ${reply.error?.rspCode ?? 'unknown'})`);
    }
    this.token = { value: token.name, expiresAt: this.now() + (token.leaseTime ?? 3600) * 1000 };
    return token.name;
  }

  // Only clear the cached token if it's still the one we used: a reply that
  // arrives after a newer token was already fetched (e.g. by a concurrent
  // request) must not wipe out that fresh token.
  private clearTokenIfCurrent(usedToken: string): void {
    if (this.token?.value === usedToken) this.token = null;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_RENEW_MARGIN_MS > this.now()) return this.token.value;
    if (this.loginInFlight) return this.loginInFlight;
    if (this.now() - this.lastLoginFailure < LOGIN_BACKOFF_MS) {
      throw new CameraError('camera_auth_failed', 'login recently rejected; backing off');
    }
    this.loginInFlight = this.login().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  // getToken for a request: a failed login never sent the request, whatever
  // happened to the Login (requestSent is cleared).
  private async tokenForRequest(): Promise<string> {
    try {
      return await this.getToken();
    } catch (err) {
      if (err instanceof CameraError && err.requestSent) throw new CameraError(err.code, err.message);
      throw err;
    }
  }

  async command<T>(cmd: string, param: object = {}): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.tokenForRequest();
      const reply = await this.post(cmd, param, token);
      if (reply.code === 0) return reply.value as T;
      if (attempt === 0 && AUTH_RSP_CODES.has(reply.error?.rspCode ?? 0)) {
        this.clearTokenIfCurrent(token);
        continue;
      }
      throw new CameraError('camera_error', `${cmd} failed (rspCode ${reply.error?.rspCode ?? 'unknown'})`, false, reply.error?.rspCode);
    }
    throw new CameraError('camera_auth_failed', `${cmd}: session rejected after re-login`);
  }

  // The certificate the camera presents (subject, issuer, expiry). The camera's
  // GetCertificateInfo only says whether a custom one is installed.
  async cameraCertificate(): Promise<{ subject: string; issuer: string; validTo: string } | null> {
    if (this.cam.protocol !== 'https') return null;
    // Same host parsing as requests (bracketed IPv6 included). This only
    // reads the certificate for display: nothing is sent, and it runs outside
    // the API gate because it opens no camera session. The certificate is
    // verified against tlsServername like every other request: an invalid or
    // expired one shows as "not available" here, and expiry is alerted on
    // separately (Grafana, cam1-cert-push).
    const { hostname, port } = splitHost(this.cam.host);
    const host = bareHost(hostname);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: { subject: string; issuer: string; validTo: string } | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(v);
      };
      const socket = tlsConnect({ host, port: port ?? 443, servername: this.trust?.servername ?? this.cam.tlsServername ?? (isIP(host) ? undefined : host), ca: this.trust?.ca ?? this.opts.tlsCa }, () => {
        const c = socket.getPeerCertificate();
        const t = c?.valid_to ? Date.parse(c.valid_to) : NaN;
        // A throw here would be an uncaught exception in a socket listener.
        if (!c || Number.isNaN(t)) return finish(null);
        finish({ subject: String(c.subject?.CN ?? ''), issuer: String(c.issuer?.O ?? c.issuer?.CN ?? ''), validTo: new Date(t).toISOString() });
      });
      // The socket's idle timeout doesn't cover a stalled handshake: an
      // explicit deadline does.
      const timer = setTimeout(() => finish(null), this.timeoutMs);
      socket.on('error', () => finish(null));
    });
  }

  async status(): Promise<CameraStatus> {
    const value = await this.command<{ DevInfo?: { model?: string; firmVer?: string; serial?: string; name?: unknown } }>('GetDevInfo');
    const d = value.DevInfo;
    return { model: d?.model ?? 'unknown', firmware: d?.firmVer ?? 'unknown', ...(d?.serial ? { serial: d.serial } : {}), ...(typeof d?.name === 'string' && d.name ? { name: d.name } : {}) };
  }

  // Real firmware limits concurrent sessions and never gets a Logout when we
  // drop a token, so we only clear it when the response actually says the
  // token is bad: a 403, a 401 (Download answers a bad token with 401
  // text/html), or a 200 whose body is a rspCode -6 reply. Real firmware
  // (RLC-1224A v3.2.0.6011) sends that body for Snap as text/html, not
  // application/json, so the content type is deliberately ignored. A
  // connection error never clears the token here - the camera may just be
  // briefly unreachable - and any other unexpected response is reported
  // as-is, without spending a second login on a problem re-login can't fix.
  private async isAuthRejection(res: IncomingMessage): Promise<boolean> {
    if (res.statusCode === 401 || res.statusCode === 403) {
      res.resume();
      return true;
    }
    if (res.statusCode !== 200) {
      res.resume();
      return false;
    }
    let body: Buffer;
    try {
      // readBody() destroys the response itself if it exceeds the limit.
      body = await readBody(res, 64 * 1024);
    } catch {
      res.destroy();
      return false;
    }
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      const rspCode = Array.isArray(parsed) ? (parsed[0] as ReolinkReply | undefined)?.error?.rspCode : undefined;
      return AUTH_RSP_CODES.has(rspCode ?? 0);
    } catch {
      return false;
    }
  }

  // One Snap attempt with an already-acquired token: open, check the
  // response and read the body, all inside the concurrency gate (a snapshot
  // download is a real load on the camera, not a quick JSON round trip).
  // getToken() must NOT be called from in here: it can call login(), which
  // itself needs a gate slot via post(), and a slot this attempt is already
  // holding can't be re-acquired - that deadlocked permanently.
  private async snapshotAttempt(token: string): Promise<{ ok: true; body: Buffer } | { ok: false }> {
    return this.gate.run(async () => {
      const path = `/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=${randomBytes(6).toString('hex')}&token=${encodeURIComponent(token)}`;
      let res: IncomingMessage;
      try {
        res = await openRequest(this.target, path, { timeoutMs: this.timeoutMs });
      } catch (err) {
        throw classifyNetworkError(err);
      }
      const contentType = String(res.headers['content-type'] ?? '');
      if (res.statusCode === 200 && /^image\/jpeg/.test(contentType)) {
        try {
          return { ok: true, body: await readBody(res, 8 * 1024 * 1024) };
        } catch (err) {
          if (err instanceof ResponseTooLargeError) throw new CameraError('camera_error', 'snapshot too large');
          throw classifyNetworkError(err);
        }
      }
      if (res.statusCode === 503) {
        res.resume();
        throw new CameraError('camera_offline', 'camera unavailable (HTTP 503)');
      }
      if (await this.isAuthRejection(res)) return { ok: false };
      throw new CameraError('camera_error', `unexpected response (HTTP ${res.statusCode})`);
    });
  }

  async snapshot(): Promise<Buffer> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.tokenForRequest();
      const outcome = await this.snapshotAttempt(token);
      if (outcome.ok) return outcome.body;
      this.clearTokenIfCurrent(token);
      if (attempt === 0) continue;
      throw new CameraError('camera_auth_failed', 'token rejected after re-login');
    }
    throw new CameraError('camera_auth_failed', 'token rejected after re-login');
  }

  // Drops the cached token without a Logout: after a camera reboot every
  // token is invalid, so the next command logs in again.
  forgetToken(): void {
    this.token = null;
  }

  // Ends the camera session (the camera allows only a few), best effort.
  async logout(): Promise<void> {
    const t = this.token;
    if (!t) return;
    this.token = null;
    await this.post('Logout', {}, t.value).catch(() => undefined);
  }

  async timeInfo(): Promise<TimeInfo> {
    if (this.time && this.now() - this.time.at < 3600_000) return this.time.value;
    let value: TimeInfo;
    try {
      value = timeInfoFromGetTime(await this.command<unknown>('GetTime'));
    } catch (err) {
      // The zone rarely changes: an older answer beats losing a clip.
      if (this.time) return this.time.value;
      throw err;
    }
    this.time = { value, at: this.now() };
    return value;
  }
}
