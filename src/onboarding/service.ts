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
import { checkEnvPath, EnvFileError, readEnvValue, writeEnvKey } from '../config/env-file';
import { withoutEnv, type Loaded } from '../config/load';
import { cameraPasswordEnv } from '../config/password-env';
import type { CameraRegistry } from '../cameras/registry';
import { removePasswordLine } from '../moves/leftovers';
import type { CertState, Requester } from '../tls/camera-certs';
import type { Served } from '../tls/served';
import { attemptKey, PASSWORD_WINDOW_MS, type PasswordAttempts } from './attempts';
import { passwordSource, type Credentials } from './credentials';
import { checkLogin } from './login-check';
import { PASSWORD_RULE, validPassword } from './password-rule';
import { FINGERPRINT, probeCamera, probeInput, probeServed, withPort, DEFAULT_PORTS, type ProbeInput } from './probe';
import { applyOverrides, ConfigError, planOverrides, removeOverride, withCameraHost } from '../config/load';
import { CAMERA_HOST_NAMES } from '../config/env';
import { configChanges } from '../config/changes';
import { atCameraLimit } from '../config/profile';
import { cameraIds } from '../config/cameras';
import { CAMERA_ID } from '../config/schema';
import { onboardingStatus, type OnboardingInput, type OnboardingStatus } from './status';
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
  // The certificate the camera serves now (null: nothing answered), and the
  // admin's pin of it (CameraCerts.pinServed; made on first use without a site CA).
  served: (cam: string) => Promise<Served | null>;
  pinServed: (cam: string, s: Served, who: Requester) => CertState;
  // The onboarding status' input from the camera's worker (null: not running here), and the proxy's zone.
  statusInput: (cam: string) => Omit<OnboardingInput, 'served' | 'zone' | 'now'> | null;
  zone: () => string | null;
  // A single-camera proxy (Task 8): whether the move that hid its camera is
  // still open here (a journal record), and the env file CAMERA_HOST goes into.
  moveOpen?: (moveId: string) => boolean;
  envFile: () => string | undefined;
  now?: () => number;
}

export interface AddBody { id?: string; name?: string; host: string; protocol?: 'https' | 'http'; user?: string; password: string; trust?: { fingerprint: string }; ports?: Partial<ProbeInput['ports']> }
// How long an added camera's worker may take to start.
const WORKER_WAIT_MS = 10_000;
// eslint-disable-next-line no-control-regex
const validName = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 64 && !/[\u0000-\u001f\u007f]/.test(v);

// The served certificate is measured at most this often per camera (the heartbeat only reads the cache).
export const SERVED_CACHE_MS = 60_000;

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
  // The fingerprint each https camera served when last measured.
  private readonly servedCache = new Map<string, { at: number; fingerprint: string | null }>();
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

  // POST /control/cameras/:cam/actions/camera-trust-pin (§4.4): pins the
  // certificate the camera serves now, only when it is the one the caller
  // confirmed. From none, or pinned again after the camera's certificate changed.
  async pin(cam: string, fingerprint: unknown, who: Who): Promise<ActionOutcome> {
    if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) return { status: 400, error: 'invalid', detail: 'fingerprint: SHA256: and 64 upper-case hex digits (the one the camera serves)' };
    const c = cameraConfig(this.d.running(), cam);
    if (!c) return { status: 404, error: 'not_found' };
    if (c.protocol !== 'https') return { status: 409, error: 'not_available', detail: 'plain http: the camera has no certificate to pin' };
    if (c.tlsName) return { status: 409, error: 'not_available', detail: `the camera is verified by its public name (tlsName ${c.tlsName})` };
    const mode = this.d.certState(cam)?.mode ?? 'none';
    if (mode === 'site-ca' || mode === 'public') return { status: 409, error: 'not_available', detail: `the camera's trust is ${mode}: clear the trust first (camera-trust-clear)` };
    const served = await this.d.served(cam);
    if (!served) return { status: 503, error: 'camera_offline', detail: 'the camera did not answer on HTTPS' };
    const requester = this.requester(who);
    if (served.fingerprint !== fingerprint) {
      this.d.audit.write({ action: 'camera-trust', category: ['configuration'], type: ['change'], outcome: 'failure', error: 'fingerprint_mismatch', ...whoRecord(who), camera: cam, message: `Camera trust ${cam}: pin refused, the camera serves ${served.fingerprint}, not ${fingerprint}`, details: { op: 'pin', fingerprint, served: served.fingerprint, requestedBy: who.requestedBy, ...cmdOf(who) } });
      return { status: 409, error: 'fingerprint_mismatch', detail: 'the camera serves another certificate than the one confirmed', extra: { served: served.fingerprint } };
    }
    this.servedCache.set(cam, { at: this.now(), fingerprint: served.fingerprint });
    return { status: 200, json: this.d.pinServed(cam, served, requester) };
  }

  // GET /control/onboarding, GET /control/cameras/:cam/onboarding (§4.5): the
  // served certificate of an https camera measured at most once a minute.
  async status(cam?: string): Promise<OnboardingStatus[]> {
    const ids = cam === undefined ? this.d.cameras.ids() : [cam];
    await Promise.all(ids.map((id) => this.measureServed(id)));
    return this.statusNow(cam);
  }

  // The same from the cache only: no camera connection (the heartbeat).
  statusNow(cam?: string): OnboardingStatus[] {
    const ids = cam === undefined ? this.d.cameras.ids() : [cam];
    const zone = this.d.zone();
    const now = this.now();
    return ids.flatMap((id) => {
      const i = this.d.statusInput(id);
      return i ? [onboardingStatus({ ...i, served: i.protocol === 'https' ? (this.servedCache.get(id)?.fingerprint ?? null) : null, zone, now })] : [];
    });
  }

  private async measureServed(id: string): Promise<void> {
    const c = cameraConfig(this.d.running(), id);
    if (!c || c.protocol !== 'https') return void this.servedCache.delete(id);
    const hit = this.servedCache.get(id);
    if (hit && this.now() - hit.at < SERVED_CACHE_MS) return;
    const s = await this.d.served(id);
    this.servedCache.set(id, { at: this.now(), fingerprint: s?.fingerprint ?? null });
  }

  // A pin changes what the status compares with: measured again at the next read.
  forgetServed(id: string): void {
    this.servedCache.delete(id);
  }

  // POST /control/cameras (§4.3; local admin only): the camera is probed with
  // the password (over https only to the confirmed certificate) before
  // anything is stored or written; then the password is stored, the
  // certificate pinned (before the camera's worker logs in), the camera added
  // in overrides.json (live, no restart). The profile's camera count refuses
  // an addition beyond it.
  async add(body: unknown, who: Who): Promise<{ status: 201; onboarding: OnboardingStatus } | Refusal> {
    const b = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const bad = (detail: string): Refusal => ({ status: 400, error: 'invalid', detail });
    if (b.id !== undefined && (typeof b.id !== 'string' || !new RegExp(CAMERA_ID).test(b.id))) return bad('id: a camera id (a-z, 0-9, -; at most 32)');
    if (b.name !== undefined && !validName(b.name)) return bad('name: 1 to 64 characters, no control characters');
    if (!validPassword(b.password)) return bad(PASSWORD_RULE);
    const trust = b.trust as { fingerprint?: unknown } | undefined;
    if (trust !== undefined && (typeof trust !== 'object' || trust === null)) return bad('trust: {fingerprint}');
    const i = probeInput({ host: b.host, ...(b.protocol !== undefined ? { protocol: b.protocol } : {}), ...(b.user !== undefined ? { user: b.user } : {}), password: b.password, ...(trust?.fingerprint !== undefined ? { fingerprint: trust.fingerprint } : {}), ...(b.ports !== undefined ? { ports: b.ports } : {}) });
    if (typeof i === 'string') return bad(i);
    if (i.protocol === 'https' && i.fingerprint === undefined) return bad("trust.fingerprint: required for an https camera (the certificate it serves, from camera-probe)");
    const l = this.d.loaded();
    if (l.legacyCamera) return this.addLegacy(b, i, who);
    if (b.id === undefined) return bad('id: required on a proxy with several cameras');
    return this.addCamera(b.id as string, b.name as string | undefined, i, who);
  }

  // A single-camera proxy (config.json `camera` + CAMERA_HOST, the Pi): the
  // new camera takes the configured camera's id and replaces it only when it
  // has no address or moved away; CAMERA_HOST goes into the env file (backup,
  // atomic), the rest into overrides.json; the camera's side restarts with it.
  private async addLegacy(b: Record<string, unknown>, i: ProbeInput, who: Who): Promise<{ status: 201; onboarding: OnboardingStatus } | Refusal> {
    const l = this.d.loaded();
    const cam = l.order[0];
    const host = OnboardingService.hostOf(i);
    const fail = (r: Refusal, extra: Record<string, unknown> = {}): Refusal => {
      this.auditAdd(who, cam, 'failure', `Camera ${cam} (${host}) not added: ${r.error}`, { host, ...extra }, r.error);
      return r;
    };
    if (b.id !== undefined && b.id !== cam) return fail({ status: 409, error: 'camera_id', detail: `this proxy has one camera, ${cam}` });
    const moved = l.config.cameras[cam]?.moved;
    const configured = cameraConfig(l.config, cam)?.host;
    if (!moved && configured) return fail({ status: 409, error: 'camera_limit', detail: `this proxy has one camera, ${cam}, and it is configured (${configured})` });
    if (moved && (this.d.moveOpen?.(moved) ?? true)) return fail({ status: 409, error: 'move_open', detail: `camera move ${moved} is not over here; cancel or finish it from cams-admin` });
    const line = `CAMERA_HOST=${host}`;
    let envPath: string;
    try {
      envPath = checkEnvPath(this.d.envFile());
    } catch (err) {
      if (!(err instanceof EnvFileError)) throw err;
      return fail({ status: 409, error: 'not_available', detail: `${err.message}: add ${line} to the .env file by hand`, extra: { line } });
    }
    const p = await this.probeForAdd(i, fail);
    if ('error' in p) return p;
    const given = (b.ports ?? {}) as Record<string, unknown>;
    const patch = { cameras: { [cam]: { protocol: i.protocol, user: i.user, ...(typeof b.name === 'string' ? { name: b.name } : {}), ...(given.onvif !== undefined ? { onvifPort: i.ports.onvif } : {}), ...(given.rtsp !== undefined ? { rtspPort: i.ports.rtsp } : {}), ...(given.baichuan !== undefined ? { baichuanPort: i.ports.baichuan } : {}) } } };
    this.d.passwords.set(cam, i.password!);
    let w: { key: string; previous: string | null; backup: string };
    const before = this.d.loaded();
    try {
      planOverrides(before, patch);
      w = writeEnvKey(envPath, CAMERA_HOST_NAMES as unknown as string[], host);
    } catch (err) {
      this.d.passwords.delete(cam);
      if (err instanceof ConfigError) return fail({ status: 400, error: 'invalid', detail: err.message });
      if (err instanceof EnvFileError) return fail({ status: 409, error: 'not_available', detail: `${err.message}: add ${line} to the .env file by hand`, extra: { line } });
      throw err;
    }
    if (p.served) this.d.pinServed(cam, p.served, this.requester(who));
    let next = applyOverrides(before, patch);
    if (moved) next = removeOverride(next, `cameras.${cam}.moved`);
    next = withCameraHost(next, { value: host, name: w.key });
    const wasRunning = !!this.d.cameras.get(cam);
    this.d.setLoaded(next);
    this.auditConfig(who, before, next);
    if (wasRunning) await this.d.restartCamera(cam);
    else await this.waitForWorker(cam);
    this.auditAdd(who, cam, 'success', `Camera ${cam} added (${host}, ${p.model ?? 'unknown model'}): ${w.key} written to .env${p.served ? `, certificate pinned (${p.served.fingerprint})` : ''}`, { host, model: p.model, pinned: p.served?.fingerprint ?? null, envName: w.key, from: w.previous, backup: w.backup });
    const [onboarding] = await this.status(cam);
    return { status: 201, onboarding: onboarding ?? this.placeholder(cam) };
  }

  private auditAdd(who: Who, cam: string, outcome: 'success' | 'failure', message: string, details: Record<string, unknown>, error?: string): void {
    this.d.audit.write({ action: 'camera-add', category: ['configuration'], type: ['creation'], outcome, ...(error ? { error } : {}), ...whoRecord(who), camera: cam, message, details: { ...details, requestedBy: who.requestedBy, ...cmdOf(who) } });
  }

  // The camera's host as configured: the address, with the API port when it is not the protocol's default.
  private static hostOf(i: ProbeInput): string {
    const port = i.ports[i.protocol];
    return port === DEFAULT_PORTS[i.protocol] ? i.host : withPort(i.host, port);
  }

  // Probe with the password (rate-limited); a refusal names the error. Audited by the caller.
  private async probeForAdd(i: ProbeInput, fail: (r: Refusal, extra?: Record<string, unknown>) => Refusal): Promise<{ model: string | null; served: Served | null } | Refusal> {
    const limited = this.attempt(i.host, (r, suppressed) => void fail(r, suppressed ? { suppressed } : {}));
    if (limited) return limited;
    const p = await probeServed(i);
    if ('error' in p) return fail({ status: 409, error: 'fingerprint_mismatch', detail: 'the camera serves another certificate than the one confirmed', extra: { served: p.served } }, { served: p.served });
    if (p.result.login === 'refused') return fail({ status: 422, error: 'camera_refused', detail: 'the camera refused this password' });
    if (p.result.login !== 'ok') return fail({ status: 503, error: 'camera_offline', detail: 'the camera did not answer the login' });
    return { model: p.result.device?.model ?? null, served: p.served };
  }

  private async addCamera(id: string, name: string | undefined, i: ProbeInput, who: Who): Promise<{ status: 201; onboarding: OnboardingStatus } | Refusal> {
    const host = OnboardingService.hostOf(i);
    const fail = (r: Refusal, extra: Record<string, unknown> = {}): Refusal => {
      this.auditAdd(who, id, 'failure', `Camera ${id} (${host}) not added: ${r.error}`, { host, ...extra }, r.error);
      return r;
    };
    const l = this.d.loaded();
    if (cameraIds(l.config).includes(id) || l.order.includes(id)) return fail({ status: 409, error: 'camera_exists', detail: `${id} is configured here already${l.config.cameras[id]?.moved ? ' (moved away; finish or clean up that move first)' : ''}` });
    const running = this.d.running();
    if (atCameraLimit(running)) return fail({ status: 409, error: 'camera_limit', detail: `profile.cameras is ${running.profile.cameras}` });
    const p = await this.probeForAdd(i, fail);
    if ('error' in p) return p;
    const node = { host, protocol: i.protocol, user: i.user, ...(name ? { name } : {}), onvifPort: i.ports.onvif, rtspPort: i.ports.rtsp, baichuanPort: i.ports.baichuan };
    const patch = { cameras: { [id]: node } };
    this.d.passwords.set(id, i.password!);
    let next: Loaded;
    try {
      planOverrides(this.d.loaded(), patch); // checked before anything else is written
      if (p.served) this.d.pinServed(id, p.served, this.requester(who));
      next = applyOverrides(this.d.loaded(), patch);
    } catch (err) {
      this.d.passwords.delete(id);
      if (err instanceof ConfigError) return fail({ status: 400, error: 'invalid', detail: err.message });
      throw err;
    }
    const before = this.d.loaded();
    this.d.setLoaded(next);
    this.auditConfig(who, before, next);
    await this.waitForWorker(id);
    this.auditAdd(who, id, 'success', `Camera ${id} added (${host}, ${p.model ?? 'unknown model'})${p.served ? `, certificate pinned (${p.served.fingerprint})` : ''}`, { host, model: p.model, pinned: p.served?.fingerprint ?? null });
    const [onboarding] = await this.status(id);
    return { status: 201, onboarding: onboarding ?? this.placeholder(id) };
  }

  protected requester(who: Who): Requester {
    return { user: who.user, requestedBy: who.requestedBy, ...(who.ip ? { ip: who.ip } : {}), ...(who.userAgent ? { userAgent: who.userAgent } : {}), ...cmdOf(who) };
  }

  // The config-change record of an override write, as PUT /control/config writes it.
  protected auditConfig(who: Who, before: Loaded, after: Loaded): void {
    const changes = configChanges(before, after).map((c) => ({ key: c.path, from: c.from, to: c.to, ...(c.restart ? { restart: c.restart } : {}) }));
    if (changes.length) this.d.audit.write({ action: 'config-change', category: ['configuration'], type: ['change'], outcome: 'success', ...whoRecord(who), message: `Settings changed: ${changes.map((c) => c.key).join(', ')}`, details: { changes, requestedBy: who.requestedBy } });
  }

  protected async waitForWorker(id: string): Promise<void> {
    const t0 = this.now();
    while (!this.d.cameras.get(id) && this.now() - t0 < WORKER_WAIT_MS) await new Promise((r) => setTimeout(r, 50));
  }

  // A camera whose worker did not start in time: nothing known yet.
  private placeholder(id: string): OnboardingStatus {
    const steps = Object.fromEntries(['reachable', 'login', 'trust', 'capabilities', 'stream', 'events', 'ftp', 'time', 'name', 'poe', 'profile'].map((n) => [n, { ok: null, detail: 'the camera is starting' }])) as OnboardingStatus['steps'];
    return { camera: id, ready: false, checkedAt: this.now(), steps, trust: { mode: 'none', fingerprint: null, served: null }, time: { clockOffsetMs: null, zone: this.d.zone(), cameraStdOffsetMinutes: null, cameraDst: null } };
  }
}
