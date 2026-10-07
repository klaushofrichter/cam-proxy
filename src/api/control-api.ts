import express, { type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Catalog } from '../catalog/db';
import type { CameraState } from '../camera/status';
import { CameraError } from '../camera/client';
import { CameraNameRefused } from '../camera/name';
import { cameraNameProblem } from '../camera/name-rules';
import type { PowerCycleAnswer, RebootAnswer, RebootRequester, RebootState, TooSoon } from '../camera/reboot';
import { PoeSwitchError, type PoeOnResult, type PoeSwitchStatus, type PortReading } from '../camera/poe-switch';
import type { Config } from '../config/defaults';
import { configChanges } from '../config/changes';
import { configView } from '../config/view';
import { applyOverrides, ConfigError, removeAllOverrides, removeOverride, type Loaded } from '../config/load';
import { cameraConfig, cameraIds } from '../config/cameras';
import { FtpNotConfiguredError, type FtpTarget } from '../clips/camera-ftp';
import type { CameraFtpView, ClipsStall } from '../clips/ftp-health';
import type { IntakeState } from '../events/intake';
import { logBuffer, logger } from '../log';
import type { KeySource, ProviderState } from '../analytics/service';
import { maskKey } from '../analytics/providers';
import type { Storage } from '../storage';
import type { StreamLog } from '../stream/log';
import { AuditQueryError, type AuditLog, type Outcome } from '../audit/audit-log';
import { actorOf, clientIp, tokenMatches, type AccessInfo } from './auth';
import { cameraParam, RESTART_RETRY_S } from './camera-param';
import type { CameraRegistry } from '../cameras/registry';
import { RefusalThrottle } from '../audit/throttle';
import { isAuditAction } from '../audit/actions';
import { DAY, dayStart } from '../time-units';
import { eventsStored, eventsStoredByCamera } from './metrics';
import { readCookie, SESSION_COOKIE, SESSION_MS, type createSessionSigner, type SessionInfo, type SessionOrigin } from './session';
import type { createLoginLinks } from './login-links';
import type { RecordingsStatus } from '../recordings/side';
import type { HealthSummary } from '../health/summary';
import type { FoundDevice } from '../camera/discovery';
import { splitHost } from '../camera/http';
import { checkEnvPath, EnvFileError, writeEnvKey } from '../config/env-file';
import { CAMERA_HOST_NAMES, validCameraHost } from '../config/env';
import { InventoryBusyError, InventoryStoppingError, RepairRefusedError, RUN_ID, type InventoryRunner } from '../inventory/runner';
import type { Archive } from '../archive/service';
import { RotateBusyError, type CertState, type Requester, type TlsView } from '../tls/camera-certs';
import type { PushResult } from '../tls/push';
import { OWN_AUDIT, performAction, type ActionOutcome } from './actions';
import type { NtpOutcome } from '../cameras/ntp';

interface FtpStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  tls: boolean;
  publicHost: string | null;
  passwordSet: boolean;
  lastUpload: number | null;
  lastClip: number | null;
  clips: number;
  failures: number;
  // #93: the camera's FTP upload as last read, and whether clips stopped
  // arriving; null while FTP is off in the proxy.
  camera: CameraFtpView | null;
  stalled: ClipsStall | null;
}

// One camera's status, as /control/status gives the first camera's (spec 2026-10-05-multi-camera-host-design §6.3).
export interface CameraStatusBlock {
  id: string;
  camera: ReturnType<ControlDeps['camera']>;
  intake: IntakeState;
  stream: ReturnType<ControlDeps['stream']>;
  ftp: FtpStatus;
  recordings: RecordingsStatus;
  source: 'config' | 'added'; // config.json, or added in the Settings page (overrides.json)
}

export interface ControlDeps {
  loaded: () => Loaded;
  setLoaded: (l: Loaded) => void; // applies live settings
  running: () => Config; // what the components run with
  catalog: Catalog;
  log: StreamLog;
  // `name`: the camera's name (configured camera.name until first read, nameSource 'config').
  camera: () => CameraState & { name: string; nameSource: 'camera' | 'config'; webUiUrl: string | null; reboot: RebootState | null; poeSwitch: PoeSwitchStatus };
  // The camera's name (camera-name design): `write` validates, writes, reads back.
  // Camera functions take the camera they act on (spec 2026-10-05-multi-camera-host-design §6.3).
  cameraName: { current: (cam: string) => string; write: (cam: string, name: string) => Promise<string> };
  checkCamera: (cam: string) => Promise<CameraState>;
  intake: () => IntakeState;
  resubscribe: (cam: string) => void;
  restart: () => Promise<void>; // every camera side, with the pending restart settings
  restartCamera: (cam: string) => Promise<void>; // one camera's side (its client, poller, events, stills)
  cameraReboot: (who: RebootRequester, cam: string) => Promise<RebootAnswer>;
  // The camera's PoE switch (#85): why it can't be used (or null), a read, a power-cycle.
  poeSwitch: { notConfigured: (cam: string) => string | null; read: (cam: string) => Promise<PortReading>; poeOn: (cam: string) => Promise<PoeOnResult>; info: (cam: string) => { model: string; host: string; port: number } };
  cameraPowerCycle: (who: RebootRequester, cam: string) => Promise<PowerCycleAnswer>;
  restartProcess: () => void; // stop, then exit 0 (the supervisor starts it again)
  ftp: () => FtpStatus;
  health: () => Promise<HealthSummary>; // spec 2026-10-03-health-summary-design: the Health and Pi cards
  cameraFtp: {
    target: (cam: string) => FtpTarget;
    setup: (cam: string, t: FtpTarget) => Promise<unknown>;
    test: (cam: string, t: FtpTarget) => Promise<{ ok: boolean; rspCode: number }>;
    off: (cam: string) => Promise<unknown>;
  };
  storage: Storage;
  audit: AuditLog;
  analytics: () => ProviderState[];
  setVisionKey: (key: string) => KeySource; // in memory only; answers what it replaced
  unmapped: { list(limit?: number): { mid: string; name: string; count: number; lastSeen: number }[]; clear(): number };
  sseClients: () => number;
  stream: () => { enabled: boolean; up: boolean; go2rtcUp: boolean; lastFrameTs: number | null };
  inventory: InventoryRunner; // spec 2026-10-02-inventory-design: one run at a time
  recordings: () => RecordingsStatus; // SD recordings over Baichuan: the last download, the cache
  sessions: ReturnType<typeof createSessionSigner>;
  links: ReturnType<typeof createLoginLinks>;
  version: string;
  // Find camera (spec 2026-10-04-pi-config-design §3, §4): an ONVIF
  // WS-Discovery probe, and the .env file "Use this address" writes
  // (CAMPROXY_ENV_FILE; undefined when not set).
  findCamera: () => Promise<{ devices: FoundDevice[]; tookMs: number }>;
  envFile: () => string | undefined;
  // The Archive (spec 2026-10-05-archive-design): the Status card, Clear the Archive.
  archive: Pick<Archive, 'status' | 'clear'>;
  // The first camera (the only one on a one-camera proxy).
  cameraId: () => string;
  // The site CA (spec 2026-10-05-multi-camera-host-design §10.4): the Certificates
  // card, "Push now", and a new CA. rotate() is null without tls.site.
  // The camera's NTP server → ntp.server now (spec §14.2); null without ntp.server.
  cameraNtp: (cam: string) => Promise<NtpOutcome | null>;
  tls: {
    view: () => TlsView;
    pushNow: (cam: string, who: Requester) => Promise<PushResult>;
    rotate: () => Promise<{ from: string | null; to: string }> | null;
    clearTrust: (cam: string, who: Requester) => CertState | null; // null: no camera trust kept here
    dropPrevious: (who: Requester) => boolean; // false: no previous CA
  };
  // Every camera's status block, config order; the number of cameras (spec 2026-10-05-multi-camera-host-design §6.3).
  cameras: CameraRegistry;
  cameraStatus: () => CameraStatusBlock[];
  cameraCount: () => number;
}

// Who sent a request, for its audit record.
const who = (req: express.Request) => ({ ip: clientIp(req), userAgent: req.get('user-agent') });
// The audit user of an admin request (after requireAccess): 'admin', or the
// managed token's label (migration P2).
const actor = (req: express.Request) => actorOf(req.res?.locals.access as AccessInfo | undefined);

// Sign-ins with the token form per client and 15 minutes (Klaus, 2026-10-01: 40).
export const LOGIN_ATTEMPTS = 40;
const MANAGED_RENAMES_PER_MIN = 6;

export function sessionRoutes(d: { adminToken: () => string; sessions: ReturnType<typeof createSessionSigner>; links: ReturnType<typeof createLoginLinks>; audit: AuditLog; managedAdminLive?: (tokenId: string) => { label: string } | null }): express.Router {
  const r = express.Router();
  const flags = (req: express.Request) => `HttpOnly; SameSite=Strict; Path=/${req.secure ? '; Secure' : ''}`;
  const startSession = (req: express.Request, res: Response, info: SessionInfo) => res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${info.origin === 'local' ? d.sessions.issue('local') : d.sessions.issue('managed', info.tokenId)}; Max-Age=${SESSION_MS / 1000}; ${flags(req)}`);
  // A managed session or link lives only as long as its token (blocked, removed, retired: gone).
  const live = (info: SessionInfo | null): SessionInfo | null => (!info ? null : info.origin === 'local' || d.managedAdminLive?.(info.tokenId) ? info : null);
  const sessionOf = (req: express.Request) => live(d.sessions.verify(readCookie(req.get('cookie'), SESSION_COOKIE)));
  // A `login` audit record; never the token or the code, only how and why.
  const MESSAGES = {
    'token-form': { ok: 'Admin signed in with the admin token', refused: 'Sign-in with the admin token refused' },
    'login-link': { ok: 'Admin signed in with a one-time link', refused: 'One-time link refused (used or expired)' },
  } as const;
  const rec = (req: express.Request, outcome: Outcome, method: 'token-form' | 'login-link', reason?: string, suppressed = 0, origin: SessionOrigin = 'local') =>
    d.audit.write({
      action: 'login', category: ['authentication'], type: ['start'], outcome,
      ...(outcome === 'success' ? { user: origin === 'local' ? 'admin' : 'managed-admin' } : {}),
      ...who(req),
      message: reason === 'rate-limited' ? 'Sign-in refused: too many attempts' : MESSAGES[method][outcome === 'success' ? 'ok' : 'refused'],
      details: { auth: { method, ...(reason ? { reason } : {}), ...(suppressed ? { suppressed } : {}) } },
    });
  // express-rate-limit calls the handler for every request over the limit:
  // one `rate-limited` record per IP per limiter window, the rest counted.
  const LIMIT_MS = 15 * 60_000;
  const limited = new RefusalThrottle(LIMIT_MS);
  const recLimited = (req: express.Request, method: 'token-form' | 'login-link') => {
    const t = limited.take(clientIp(req), method === 'token-form' ? 'login-rate-limited' : 'login-link-rate-limited');
    if (t.record) rec(req, 'failure', method, 'rate-limited', t.suppressed);
  };
  // A logout without a valid session changes nothing: one record per IP per 10 min.
  const anonLogouts = new RefusalThrottle();
  const attempts = rateLimit({
    windowMs: LIMIT_MS, limit: LOGIN_ATTEMPTS, standardHeaders: false, legacyHeaders: false,
    handler: (req, res) => {
      recLimited(req, 'token-form');
      res.status(429).json({ error: 'too_many_attempts' });
    },
  });
  // A one-time link from cams (POST /control/login-links): a UI session, then
  // the UI. A used or expired code lands on the token login instead.
  // Its own limit (a 192-bit code can't be guessed; this only bounds work),
  // so link attempts never lock out the token login, and a limited browser
  // lands on that login instead of a bare JSON error (review, 2026-09-28).
  const linkAttempts = rateLimit({
    windowMs: LIMIT_MS, limit: 200, standardHeaders: false, legacyHeaders: false,
    handler: (req, res) => {
      recLimited(req, 'login-link');
      res.redirect(302, '/?link=expired');
    },
  });
  r.get('/login-link', linkAttempts, (req, res) => {
    const info = live(d.links.consume(typeof req.query.code === 'string' ? req.query.code : undefined));
    if (!info) {
      rec(req, 'failure', 'login-link', 'link-used-or-expired');
      return void res.redirect(302, '/?link=expired');
    }
    rec(req, 'success', 'login-link', undefined, 0, info.origin);
    startSession(req, res, info);
    res.redirect(302, '/');
  });
  r.post('/login', attempts, (req, res) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || !tokenMatches(token, [d.adminToken()])) {
      rec(req, 'failure', 'token-form', 'wrong-token');
      return void res.status(401).json({ error: 'unauthorized' });
    }
    rec(req, 'success', 'token-form');
    startSession(req, res, { origin: 'local' });
    res.status(204).end();
  });
  r.get('/session', (req, res) => void res.json({ loggedIn: !!sessionOf(req) }));
  r.post('/logout', (req, res) => {
    const valid = sessionOf(req);
    const base = { action: 'logout', category: ['authentication'], type: ['end'], outcome: 'success' as const, ...who(req) };
    if (valid) d.audit.write({ ...base, user: valid.origin === 'local' ? 'admin' : 'managed-admin', message: 'Admin signed out' });
    else {
      const t = anonLogouts.take(base.ip, 'logout-without-session');
      if (t.record) d.audit.write({ ...base, message: 'Sign-out without a session', details: { auth: { reason: 'no-session', ...(t.suppressed ? { suppressed: t.suppressed } : {}) } } });
    }
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; ${flags(req)}`);
    res.status(204).end();
  });
  return r;
}

// The camera actions (spec 2026-10-05-multi-camera-host-design §6.3): their
// control-action record names the camera; on a proxy with several cameras
// they need a camera (the routes of phase 2). The host actions work as before.
export const CAMERA_ACTIONS = new Set(['camera-test', 'onvif-resubscribe', 'camera-ftp-setup', 'camera-ftp-test', 'camera-ftp-off', 'restart', 'camera-reboot', 'camera-powercycle', 'camera-poe-on', 'poe-switch-read', 'inventory', 'inventory-repair', 'inventory-cancel', 'camera-cert-push', 'camera-ntp-set', 'camera-trust-clear']);

// What a camera action answers on a proxy with several cameras (spec §6.3; the camera routes are phase 2).
const cameraRequired = (path: string) => `several cameras: name the camera, ${path} (or ?cam=<id>); GET /control/cameras lists them`;


// Find camera and Use this address together, per client and minute: a probe
// is 3 s of multicast, a write a backup.
export const FIND_CAMERA_PER_MINUTE = 6;
// tls-ca-rotate, tls-ca-drop-previous and camera-trust-clear together, per client and minute.
export const TRUST_ACTIONS_PER_MINUTE = 6;

// Whether "Use this address" can write the .env file, and why not.
// The control API (spec §11); admin access is checked by the caller.
export function controlApi(d: ControlDeps): express.Router {
  const r = express.Router();
  // :cam → its worker, 404 or 503 while it restarts (spec §3.3, §6.1).
  r.param('cam', cameraParam(d.cameras, 'admin'));
  let restartRequested = false; // a restart-proxy request was recorded (the stop follows)
  const invalid = (res: Response, err: unknown) => {
    if (err instanceof ConfigError && err.message.startsWith('not_a_setting:')) return void res.status(400).json({ error: 'not_a_setting', detail: err.message.slice('not_a_setting:'.length).trim() });
    if (err instanceof ConfigError) return void res.status(400).json({ error: 'invalid', detail: err.message });
    throw err;
  };

  // A one-time sign-in link for a signed-in cams user (admin token only).
  r.post('/login-links', (req, res) => {
    // The link keeps the minting rights' origin (R2-3): a managed admin token
    // can't mint a link to a local session.
    const a = res.locals.access as AccessInfo | undefined;
    const link = a?.origin === 'local' ? d.links.issue('local') : d.links.issue('managed', a?.tokenId);
    d.audit.write({ action: 'login-link-issued', category: ['authentication'], type: ['creation'], outcome: 'success', user: actor(req), ...who(req), message: 'One-time sign-in link issued' });
    res.status(201).json(link);
  });

  r.get('/status', async (_req, res) => {
    const health = await d.health();
    res.json({
      version: d.version,
      camera: d.camera(),
      intake: d.intake(),
      sse: { clients: d.sseClients() },
      stream: d.stream(),
      retention: { lastRun: d.storage.lastRun(), totals: d.storage.totals() },
      storage: { paused: d.storage.paused() },
      ftp: d.ftp(),
      recordings: d.recordings(),
      analytics: d.analytics(),
      analyticsUnmapped: d.unmapped.list(20),
      health,
      archive: d.archive.status(),
      cameras: d.cameraStatus(),
    });
  });

  // Every camera's status block (spec §6.3); one camera's.
  r.get('/cameras', (_req, res) => void res.json(d.cameraStatus()));
  r.get('/cameras/:cam/status', (req, res) => {
    const b = d.cameraStatus().find((x) => x.id === req.params.cam);
    if (!b) return void res.status(404).json({ error: 'not_found' });
    res.json(b);
  });

  // The camera's name (camera-name design): stored on the camera only.
  // 200 {name} as read back; 400 invalid_name {reason} by the rules (the
  // camera is not asked, nothing is audited) or refused by the camera; 503
  // camera_offline; 502 camera_error. A `camera-name` record once the camera
  // was asked. The stream message follows from the poller.
  // The camera of a camera route (:cam, already resolved), or ?cam=, or the
  // only camera; null with several and none named. Answers 404/503 itself
  // for an unknown/restarting ?cam= (undefined then).
  const targetCamera = (req: express.Request, res: Response): string | null | undefined => {
    if (typeof req.params.cam === 'string') return req.params.cam;
    const q = req.query.cam;
    if (typeof q === 'string' && q) {
      const w = d.cameras.get(q);
      if (!w) return void res.status(404).json({ error: 'not_found' }), undefined;
      if (w.phase() === 'restarting') {
        res.setHeader('Retry-After', String(RESTART_RETRY_S));
        return void res.status(503).json({ error: 'camera_restarting' }), undefined;
      }
      return w.id;
    }
    return d.cameraCount() === 1 ? d.cameraId() : null;
  };

  const renames = new Map<string, number[]>();
  const putName = async (req: express.Request, res: Response) => {
    const cam = targetCamera(req, res);
    if (cam === undefined) return;
    if (cam === null) return void res.status(400).json({ error: 'camera_required', detail: cameraRequired('PUT /control/cameras/<id>/name') });
    const name: unknown = req.body?.name;
    const problem = cameraNameProblem(name);
    if (problem) return void res.status(400).json({ error: 'invalid_name', reason: problem });
    // Managed admin rights (cams-admin's token): at most 6 renames a minute per
    // camera; each one is a SetDevName on the real camera.
    if ((res.locals.access as AccessInfo | undefined)?.origin === 'managed') {
      const t = Date.now();
      const w = (renames.get(cam) ?? []).filter((x) => t - x < 60_000);
      if (w.length >= MANAGED_RENAMES_PER_MIN) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((w[0] + 60_000 - t) / 1000))));
        return void res.status(429).json({ error: 'rate_limited' });
      }
      w.push(t);
      renames.set(cam, w);
    }
    const to = name as string;
    const from = d.cameraName.current(cam);
    const requestedBy = res.locals.access?.viaCookie ? 'session' : 'token';
    const base = { action: 'camera-name', category: ['configuration'], type: ['change'], user: actor(req), ...who(req), camera: cam };
    try {
      const read = await d.cameraName.write(cam, to);
      d.audit.write({ ...base, outcome: 'success', message: read === from ? `Camera name set: "${read}" (unchanged)` : `Camera name changed: "${from}" → "${read}"`, details: { from, to: read, ...(read !== to ? { requested: to } : {}), requestedBy } });
      res.json({ name: read });
    } catch (err) {
      const reason = err instanceof CameraNameRefused ? err.reason : err instanceof CameraError ? err.code : 'camera_error';
      d.audit.write({ ...base, outcome: 'failure', error: reason, message: `Camera name change "${from}" → "${to}" failed: ${reason}`, details: { from, requested: to, requestedBy } });
      if (err instanceof CameraNameRefused) return void res.status(400).json({ error: 'invalid_name', reason: err.reason });
      if (err instanceof CameraError && err.code === 'camera_offline') return void res.status(503).json({ error: 'camera_offline' });
      logger.warn({ err: (err as Error).message }, 'camera_name_write_failed');
      res.status(502).json({ error: err instanceof CameraError ? err.code : 'camera_error' });
    }
  };
  r.put('/camera/name', putName);
  r.put('/cameras/:cam/name', putName);

  r.get('/analytics', (_req, res) => void res.json(d.analytics()));
  r.get('/analytics/unmapped', (_req, res) => void res.json(d.unmapped.list()));
  r.delete('/analytics/unmapped', (_req, res) => void res.json({ cleared: d.unmapped.clear() }));

  // The Google Vision key set at runtime (issue #70): in memory only, never
  // written, logged or returned; the audit record has the masked key. A
  // refused key (400) writes nothing and is never echoed.
  r.put('/secrets/google-vision-key', (req, res) => {
    const key: unknown = req.body?.key;
    if (typeof key !== 'string' || !/^[\x21-\x7e]{20,200}$/.test(key)) return void res.status(400).json({ error: 'invalid', detail: 'key: 20 to 200 printable ASCII characters, no spaces' });
    const replaced = d.setVisionKey(key);
    const masked = maskKey(key)!;
    d.audit.write({
      action: 'secret-override', category: ['configuration'], type: ['change'], outcome: 'success', user: actor(req), ...who(req),
      message: `Google Vision key set manually (${masked}), ${replaced === 'none' ? 'where no key was set' : `replacing the ${replaced} key`}`,
      details: { secret: 'CAMPROXY_GOOGLE_VISION_KEY', masked, replaced },
    });
    res.json({ keySource: 'manual', keyMasked: masked, replaced });
  });

  r.get('/stats', (_req, res) => {
    const u = d.storage.usage();
    res.json({
      disk: { catalog: u.catalog, audit: u.audit, stills: u.stills, previews: u.previews, clips: u.clips, recordings: u.recordings, free: u.free, size: u.size },
      events: { stored: eventsStored(d.catalog), byCamera: eventsStoredByCamera(d.catalog) },
      stream: { rows: d.log.count(), lastId: d.log.lastId() },
      sse: { clients: d.sseClients() },
      storage: { budget: u.budget, used: u.used, daysUntilFull: u.daysUntilFull, paused: d.storage.paused() },
      // Each camera's part of the disk (spec 2026-10-05-multi-camera-host-design §8.1).
      cameras: d.storage.usageByCamera(),
    });
  });

  // Inventories (spec 2026-10-02-inventory-design): the running one and the last runs; one report.
  r.get('/inventory', async (_req, res) => void res.json({ running: d.inventory.running(), runs: await d.inventory.list(), repairs: await d.inventory.listRepairs() }));
  r.get('/inventory/runs/:id', async (req, res) => {
    if (!RUN_ID.test(req.params.id)) return void res.status(400).json({ error: 'invalid', detail: 'not a run id' });
    const run = await d.inventory.get(req.params.id);
    if (!run) return void res.status(404).json({ error: 'not_found' });
    res.json(run);
  });

  r.get('/config', (_req, res) => void res.json(configView(d.loaded(), d.running())));
  r.get('/tls', (_req, res) => void res.json(d.tls.view()));
  // A `config-change` record: the changed leaf settings, old → new. Secret
  // values are redacted by AuditLog by the setting's name. A refused change
  // (400) writes nothing.
  const recordChanges = (req: express.Request, before: Loaded, all = false) => {
    // `restart`: the change waits for a restart ('restart'), or for a new process ('process').
    const changes = configChanges(before, d.loaded()).map((c) => ({ key: c.path, from: c.from, to: c.to, ...(c.restart ? { restart: c.restart } : {}) }));
    if (changes.length) d.audit.write({ action: 'config-change', category: ['configuration'], type: ['change'], outcome: 'success', user: actor(req), ...who(req), message: `${all ? 'Settings reset to defaults' : 'Settings changed'}: ${changes.map((c) => c.key).join(', ')}`, details: { changes, ...(all ? { reset: 'all' } : {}) } });
  };
  r.put('/config', (req, res) => {
    const before = d.loaded();
    try {
      d.setLoaded(applyOverrides(d.loaded(), req.body ?? {}));
    } catch (err) {
      return invalid(res, err);
    }
    recordChanges(req, before);
    res.json(configView(d.loaded(), d.running()));
  });
  // "Reset to defaults" (the Settings page): every override at once, one record.
  r.delete('/config', (req, res) => {
    const before = d.loaded();
    try {
      d.setLoaded(removeAllOverrides(d.loaded()));
    } catch (err) {
      return invalid(res, err);
    }
    recordChanges(req, before, true);
    res.json(configView(d.loaded(), d.running()));
  });
  r.delete('/config/:path', (req, res) => {
    const before = d.loaded();
    try {
      d.setLoaded(removeOverride(d.loaded(), req.params.path));
    } catch (err) {
      return invalid(res, err);
    }
    recordChanges(req, before);
    res.json(configView(d.loaded(), d.running()));
  });

  // Find camera and Use this address share a rate limit (the other actions have none).
  const findLimit = rateLimit({ windowMs: 60_000, limit: FIND_CAMERA_PER_MINUTE, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited' } });
  // The site CA's trust actions (rotate, drop the previous CA, clear a camera): their own limit.
  const trustLimit = rateLimit({ windowMs: 60_000, limit: TRUST_ACTIONS_PER_MINUTE, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited' } });
  const TRUST = new Set(['tls-ca-rotate', 'tls-ca-drop-previous', 'camera-trust-clear']);
  const actionLimit: express.RequestHandler = (req, res, next) =>
    req.params.name === 'find-camera' || req.params.name === 'camera-address' ? findLimit(req, res, next) : TRUST.has(String(req.params.name)) ? trustLimit(req, res, next) : next();

  // An action's outcome as the HTTP answer.
  const send = (res: Response, o: ActionOutcome) => {
    if (o.retryAfterS !== undefined) res.setHeader('Retry-After', String(o.retryAfterS));
    if ('error' in o) {
      res.locals.errorCode = o.error;
      return void res.status(o.status).json({ error: o.error, ...(o.detail ? { detail: o.detail } : {}), ...(o.extra ?? {}) });
    }
    return o.json === undefined ? void res.status(o.status).end() : void res.status(o.status).json(o.json);
  };
  const action = async (req: express.Request, res: Response) => {
    const name = String(req.params.name);
    const routed = typeof req.params.cam === 'string';
    // Host actions have no camera route.
    if (routed && !CAMERA_ACTIONS.has(name)) return void res.status(404).json({ error: 'not_found' });
    const target = CAMERA_ACTIONS.has(name) ? targetCamera(req, res) : null;
    if (target === undefined) return;
    const requestedBy = res.locals.access?.viaCookie ? 'session' : 'token';
    // A `control-action` record with the result, once the answer is sent or
    // the client went away ('close' fires in both cases; 'finish' only in the
    // first). Not for the camera reboot and the process restart (their own
    // records, camera-reboot and proxy-restart; an inventory writes `inventory`
    // when it ends, a repair `inventory-repair`) or a retention preview
    // (dryRun changes nothing). The power-cycle has its own records too
    // (camera-powercycle); a read of the switch is a control-action.
    if (!OWN_AUDIT.has(name) && !(name === 'retention-run' && req.body?.dryRun === true)) {
      res.on('close', () => {
        const done = res.writableFinished;
        const ok = done && res.statusCode < 400;
        const result = !done ? 'aborted' : ok ? 'ok' : String((res.locals.errorCode as string | undefined) ?? res.statusCode);
        d.audit.write({ action: 'control-action', category: ['configuration'], type: ['change'], outcome: !done ? 'unknown' : ok ? 'success' : 'failure', user: actor(req), ...who(req), message: `Control action ${name}: ${result}`, details: { action: name, result, requestedBy }, ...(target ? { camera: target } : {}) });
      });
    }
    const fail = (status: number, error: string, detail?: string) => send(res, { status, error, ...(detail ? { detail } : {}) });
    // `restart` without a camera is the host-wide restart: every camera side,
    // every pending setting (as on one camera; live test of #173).
    if (name === 'restart' && target === null) {
      d.restart().catch((err: Error) => logger.error({ err: err.message }, 'restart_failed'));
      return void res.status(202).end();
    }
    // Several cameras: a camera action names its camera (Ruling P1-12; the routes are phase 2).
    if (CAMERA_ACTIONS.has(name) && target === null) {
      // Actions with their own records are audited here; the others by the close handler above. No camera: none was named.
      if (OWN_AUDIT.has(name)) d.audit.write({ action: 'control-action', category: ['configuration'], type: ['change'], outcome: 'failure', user: actor(req), ...who(req), message: `Control action ${name}: camera_required`, details: { action: name, result: 'camera_required', requestedBy } });
      return fail(400, 'camera_required', cameraRequired(`POST /control/cameras/<id>/actions/${name}`));
    }
    // The process restart (#71): answer first, then the normal stop and exit 0. Never in the core.
    if (name === 'restart-proxy') {
      // One record per restart: a second request before the stop is the same restart.
      if (!restartRequested) d.audit.write({ action: 'proxy-restart', category: ['process'], type: ['change'], outcome: 'success', user: actor(req), ...who(req), message: 'Proxy process restart requested through the control API', details: { requestedBy } });
      restartRequested = true;
      res.once('close', () => setImmediate(() => d.restartProcess()));
      return void res.status(202).end();
    }
    // `restart` on the old route without a camera named: every camera side and the settings.
    if (name === 'restart' && !routed && typeof req.query.cam !== 'string') {
      d.restart().catch((err: Error) => logger.error({ err: err.message }, 'restart_failed'));
      return void res.status(202).end();
    }
    send(res, await performAction(d, name, target, typeof req.body === 'object' && req.body !== null ? req.body : {}, { user: actor(req), requestedBy, ...who(req) }));
  };
  r.post('/actions/:name', actionLimit, action);
  r.post('/cameras/:cam/actions/:name', actionLimit, action);

  r.get('/log', (req, res) => {
    const limit = Number(req.query.limit);
    res.json(logBuffer.recent(Number.isInteger(limit) && limit > 0 ? limit : 100));
  });

  return r;
}

// GET /control/audit (spec 2026-10-01-audit-log-design): ECS JSON lines,
// newest first with ?before, oldest first with ?after. Mounted on /control
// before the admin-only routes. `guard` (requireAccess('audit-read')) sits on
// the handler's own route, so every path Express routes here (any case, a
// trailing slash) is checked; other /control paths and methods pass on
// untouched to the admin-only routes.
export function auditApi(d: { audit: AuditLog; guard: express.RequestHandler; retentionDays: () => number; now?: () => number }): express.Router {
  const r = express.Router();
  // The records the retention keeps (the Audit page's line): the day files
  // from the retention run's cutoff day on, the same rule it deletes by.
  r.get('/audit/summary', d.guard, (_req, res) => {
    const days = d.retentionDays();
    const from = new Date(dayStart((d.now ?? Date.now)() - days * DAY)).toISOString().slice(0, 10);
    res.set('Cache-Control', 'no-store').json({ retentionDays: days, records: d.audit.count(from) });
  });
  r.get('/audit', d.guard, (req, res) => {
    const q = req.query;
    const num = (v: unknown) => (v === undefined ? undefined : /^\d{1,15}$/.test(String(v)) ? Number(v) : NaN);
    const outcome = q.outcome === undefined ? undefined : String(q.outcome);
    if (outcome !== undefined && !['success', 'failure', 'unknown'].includes(outcome)) return void res.status(400).json({ error: 'invalid', detail: 'outcome is success, failure or unknown' });
    const from = num(q.from), to = num(q.to), limit = num(q.limit);
    if ([from, to, limit].some((v) => Number.isNaN(v))) return void res.status(400).json({ error: 'invalid', detail: 'from, to and limit are numbers' });
    const actions = q.action === undefined ? undefined : String(q.action).split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = actions?.find((a) => !isAuditAction(a));
    if (unknown !== undefined) return void res.status(400).json({ error: 'invalid', detail: `unknown action: ${unknown.slice(0, 40)}` });
    try {
      const out = d.audit.list({
        limit, from, to, outcome: outcome as Outcome | undefined,
        before: q.before === undefined ? undefined : String(q.before),
        after: q.after === undefined ? undefined : String(q.after),
        actions,
      });
      res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Has-More': String(out.hasMore), 'Cache-Control': 'no-store' });
      if (out.next) res.set('X-Next-Cursor', out.next);
      res.send(out.records.map((x) => JSON.stringify(x)).join('\n') + (out.records.length ? '\n' : ''));
    } catch (err) {
      if (err instanceof AuditQueryError) return void res.status(400).json({ error: 'invalid', detail: err.message });
      throw err;
    }
  });
  return r;
}
