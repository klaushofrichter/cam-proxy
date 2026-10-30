// Camera onboarding on this proxy (spec 2026-10-30-camera-onboarding-design
// §4): the password API, and (later tasks) the probe, the trust pin, the
// onboarding status, adding and removing a camera. A camera password is never
// logged, audited, returned or put in an error message; it is stored only in
// data/admin/camera-passwords.json, and only after the camera accepted it.
import { readFileSync } from 'fs';
import type { ActionWho } from '../api/actions';
import type { AuditLog } from '../audit/audit-log';
import { RefusalThrottle } from '../audit/throttle';
import type { CameraTrust } from '../camera/client';
import type { CameraPasswordStore } from '../config/camera-passwords';
import { cameraConfig } from '../config/cameras';
import type { Config } from '../config/defaults';
import { readEnvValue } from '../config/env-file';
import { withoutEnv, type Loaded } from '../config/load';
import { cameraPasswordEnv } from '../config/password-env';
import type { CameraRegistry } from '../cameras/registry';
import { removePasswordLine } from '../moves/leftovers';
import type { CertState } from '../tls/camera-certs';
import { attemptKey, PASSWORD_WINDOW_MS, type PasswordAttempts } from './attempts';
import { passwordSource, type Credentials } from './credentials';
import { checkLogin } from './login-check';
import { PASSWORD_RULE, validPassword } from './password-rule';
import { probeCamera, probeInput } from './probe';
import type { ActionOutcome } from '../api/actions';

export type Who = ActionWho;

export interface OnboardingDeps {
  loaded: () => Loaded;
  setLoaded: (l: Loaded) => void;
  running: () => Config;
  cameras: CameraRegistry;
  restartCamera: (cam: string) => Promise<void>;
  passwords: CameraPasswordStore;
  trustFor: (cam: string) => CameraTrust | undefined;
  certState: (cam: string) => CertState | null;
  audit: Pick<AuditLog, 'write'>;
  attempts: PasswordAttempts;
  now?: () => number;
}

export type Refusal = { status: number; error: string; detail?: string; retryAfterS?: number; extra?: Record<string, unknown> };


const whoRecord = (who: Who) => ({ user: who.user, ...(who.ip ? { ip: who.ip } : {}), ...(who.userAgent ? { userAgent: who.userAgent } : {}) });
const cmdOf = (who: Who) => ({ ...(who.cmdId ? { cmdId: who.cmdId } : {}), ...(who.actor ? { actor: who.actor } : {}) });

// Whether the env file this proxy manages (read at start) sets `key`.
function envFileSets(l: Loaded, key: string): boolean {
  if (!l.envFile?.read) return false;
  try {
    return readEnvValue(readFileSync(l.envFile.path, 'utf8'), key) !== undefined;
  } catch {
    return false;
  }
}

export class OnboardingService {
  // A rate-limited refusal: one record per address and window.
  private readonly limited = new RefusalThrottle(PASSWORD_WINDOW_MS);
  constructor(readonly d: OnboardingDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  // The rate limit for a password sent to `host`; a refusal audited at most once per address and window.
  private attempt(host: string, record: (r: Refusal, suppressed: number) => void): Refusal | null {
    const t = this.d.attempts.take(host);
    if (t.ok) return null;
    const r: Refusal = { status: 429, error: 'too_many_attempts', detail: `at most 5 password attempts per camera address in 10 minutes; try again in ${t.retryAfterS} s`, retryAfterS: t.retryAfterS };
    const th = this.limited.take(attemptKey(host), 'password');
    if (th.record) record(r, th.suppressed);
    return r;
  }

  // PUT /control/cameras/:cam/password (§4.1): checked with the camera first,
  // stored only when it accepts; the camera's own env line removed when this
  // proxy manages the file, refused (409 env_password) when it can't.
  async savePassword(cam: string, password: unknown, who: Who): Promise<{ status: 200; credentials: Credentials } | Refusal> {
    if (!validPassword(password)) return { status: 400, error: 'invalid', detail: PASSWORD_RULE };
    const l = this.d.loaded();
    const c = cameraConfig(this.d.running(), cam);
    if (!c) return { status: 404, error: 'not_found' };
    const base = { action: 'camera-password', category: ['configuration'], type: ['change'], ...whoRecord(who), camera: cam };
    const fail = (r: Refusal, extra: Record<string, unknown> = {}): Refusal => {
      this.d.audit.write({ ...base, outcome: 'failure', error: r.error, message: `Camera password for ${cam} not saved: ${r.error}`, details: { requestedBy: who.requestedBy, ...cmdOf(who), ...extra } });
      return r;
    };
    const own = cameraPasswordEnv(cam);
    const src = passwordSource(l, cam);
    let removeLine = false;
    if (src.ownEnv) {
      if (src.envName === own && envFileSets(l, own)) removeLine = true;
      else return fail({ status: 409, error: 'env_password', detail: `${src.envName} sets this camera's password (compose's environment or a _FILE secret): remove it there first, then save again` });
    }
    if (c.protocol === 'https' && !c.tlsName && (this.d.certState(cam)?.mode ?? 'none') === 'none') {
      return fail({ status: 409, error: 'not_trusted', detail: "the camera's certificate is not trusted: pin it first (camera-trust-pin)" });
    }
    const limited = this.attempt(c.host, (r, suppressed) => void fail(r, suppressed ? { suppressed } : {}));
    if (limited) return limited;
    const r = await checkLogin({ id: cam, host: c.host, protocol: c.protocol, user: c.user, password, trust: this.d.trustFor(cam), ...(c.tlsName ? { tlsName: c.tlsName } : {}) });
    if (r.outcome === 'refused') return fail({ status: 422, error: 'camera_refused', detail: 'the camera refused this password' });
    if (r.outcome !== 'ok') return fail({ status: 503, error: 'camera_offline', detail: 'the camera did not answer the login' });
    this.d.passwords.set(cam, password);
    if (removeLine) {
      const e = removePasswordLine(l, cam);
      if (e.outcome === 'failed') {
        this.d.passwords.delete(cam);
        return fail({ status: 409, error: 'env_password', detail: `${own} is set in ${l.envFile!.path}, which could not be written (${e.code}): remove the line there first` });
      }
    }
    this.d.setLoaded(withoutEnv(l, removeLine ? [own] : []));
    await this.d.restartCamera(cam);
    this.d.audit.write({ ...base, outcome: 'success', message: `Camera password for ${cam} saved on this proxy (checked with the camera)${removeLine ? `; ${own} removed from the env file` : ''}`, details: { ...(removeLine ? { envLine: 'removed' } : {}), requestedBy: who.requestedBy, ...cmdOf(who) } });
    return { status: 200, credentials: { source: 'store', authOk: true, checkedAt: this.now() } };
  }

  // POST /control/actions/camera-probe (§4.2): local only, read-only on the
  // camera; the password (optional) only for the login, dropped after it.
  async probe(body: Record<string, unknown>, who: Who): Promise<ActionOutcome> {
    const i = probeInput(body);
    if (typeof i === 'string') return { status: 400, error: 'invalid', detail: i };
    if (i.password !== undefined && i.protocol === 'https' && i.fingerprint === undefined) return { status: 400, error: 'invalid', detail: 'fingerprint: required with a password over https' };
    const base = { action: 'camera-probe', category: ['configuration'], type: ['access'], ...whoRecord(who) };
    const rec = (outcome: 'success' | 'failure', details: Record<string, unknown>, error?: string) =>
      this.d.audit.write({ ...base, outcome, ...(error ? { error } : {}), message: `Camera probe of ${i.host}: ${error ?? (details.login === 'ok' ? `model ${String(details.model)}` : `login ${String(details.login)}`)}`, details: { host: i.host, ...details, requestedBy: who.requestedBy, ...cmdOf(who) } });
    if (i.password !== undefined) {
      const limited = this.attempt(i.host, (r, suppressed) => rec('failure', { login: 'not_tried', ...(suppressed ? { suppressed } : {}) }, r.error));
      if (limited) return limited;
    }
    const r = await probeCamera(i);
    if ('error' in r) {
      rec('failure', { login: 'not_tried', served: r.served }, 'fingerprint_mismatch');
      return { status: 409, error: 'fingerprint_mismatch', detail: 'the camera serves another certificate than the one confirmed: probe again without the password and check it', extra: { served: r.served } };
    }
    rec(r.login === 'refused' || r.login === 'offline' ? 'failure' : 'success', { login: r.login, model: r.device?.model ?? null, ports: r.ports, ...(r.certificate ? { fingerprint: r.certificate.fingerprint } : {}) }, r.login === 'refused' ? 'camera_refused' : r.login === 'offline' ? 'camera_offline' : undefined);
    return { status: 200, json: r };
  }
}
