import express, { type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Catalog } from '../catalog/db';
import type { CameraState } from '../camera/status';
import type { PowerCycleAnswer, RebootAnswer, RebootRequester, RebootState, TooSoon } from '../camera/reboot';
import { PoeSwitchError, type PoeOnResult, type PoeSwitchStatus, type PortReading } from '../camera/poe-switch';
import type { Config } from '../config/defaults';
import { applyOverrides, ConfigError, needsProcessRestart, needsRestart, removeOverride, type Loaded } from '../config/load';
import { leafAt, leafPaths } from '../config/schema';
import { FtpNotConfiguredError, type FtpTarget } from '../clips/camera-ftp';
import type { CameraFtpView, ClipsStall } from '../clips/ftp-health';
import type { IntakeState } from '../events/intake';
import { logBuffer, logger } from '../log';
import type { KeySource, ProviderState } from '../analytics/service';
import { maskKey } from '../analytics/providers';
import type { Storage } from '../storage';
import type { StreamLog } from '../stream/log';
import { AuditQueryError, type AuditLog, type Outcome } from '../audit/audit-log';
import { clientIp, tokenMatches } from './auth';
import { RefusalThrottle } from '../audit/throttle';
import { eventsStored } from './metrics';
import { readCookie, SESSION_COOKIE, SESSION_MS, type createSessionSigner } from './session';
import type { createLoginLinks } from './login-links';
import type { RecordingsStatus } from '../recordings/side';
import { InventoryBusyError, InventoryStoppingError, RUN_ID, type InventoryRunner } from '../inventory/runner';

export interface FtpStatus {
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

export interface ControlDeps {
  loaded: () => Loaded;
  setLoaded: (l: Loaded) => void; // applies live settings
  running: () => Config; // what the components run with
  catalog: Catalog;
  log: StreamLog;
  camera: () => CameraState & { webUiUrl: string | null; reboot: RebootState | null; poeSwitch: PoeSwitchStatus };
  checkCamera: () => Promise<CameraState>;
  intake: () => IntakeState;
  resubscribe: () => void;
  restart: () => Promise<void>; // the camera side
  cameraReboot: (who: RebootRequester) => Promise<RebootAnswer>;
  // The camera's PoE switch (#85): why it can't be used (or null), a read, a power-cycle.
  poeSwitch: { notConfigured: () => string | null; read: () => Promise<PortReading>; poeOn: () => Promise<PoeOnResult>; info: () => { model: string; host: string; port: number } };
  cameraPowerCycle: (who: RebootRequester) => Promise<PowerCycleAnswer>;
  restartProcess: () => void; // stop, then exit 0 (the supervisor starts it again)
  ftp: () => FtpStatus;
  cameraFtp: {
    target: () => FtpTarget;
    setup: (t: FtpTarget) => Promise<unknown>;
    test: (t: FtpTarget) => Promise<{ ok: boolean; rspCode: number }>;
    off: () => Promise<unknown>;
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
}

const get = (o: unknown, path: string) => path.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);

// The effective configuration for the UI: value (what runs), source, restart
// flag, the next value for restart settings changed but not yet applied, and
// the type (integer, boolean or string), for settings without a value.
export function configView(loaded: Loaded, running: Config) {
  return Object.fromEntries(
    leafPaths().map((p) => {
      const restart = needsRestart(p);
      const value = get(running, p);
      const next = get(loaded.config, p);
      const pending = restart && JSON.stringify(value) !== JSON.stringify(next);
      return [p, { value, source: loaded.sources[p], restart, pending, ...(pending ? { next } : {}), type: leafAt(p)?.type }];
    }),
  );
}

// A camera call from an action: its answer, or 502 with the camera's error.
async function cameraCall(res: Response, f: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await f());
  } catch (err) {
    if (err instanceof FtpNotConfiguredError) {
      res.locals.errorCode = 'not_configured';
      res.status(409).json({ error: 'not_configured', detail: err.message });
      return;
    }
    logger.warn({ err: (err as Error).message }, 'camera_action_failed');
    res.locals.errorCode = 'camera_error';
    res.status(502).json({ error: 'camera_error', detail: (err as Error).message });
  }
}

// Sign-ins with the token form per client and 15 minutes (Klaus, 2026-10-01: 40).
export const LOGIN_ATTEMPTS = 40;

export function sessionRoutes(d: { adminToken: () => string; sessions: ReturnType<typeof createSessionSigner>; links: ReturnType<typeof createLoginLinks>; audit: AuditLog }): express.Router {
  const r = express.Router();
  const flags = (req: express.Request) => `HttpOnly; SameSite=Strict; Path=/${req.secure ? '; Secure' : ''}`;
  // A `login` audit record; never the token or the code, only how and why.
  const MESSAGES = {
    'token-form': { ok: 'Admin signed in with the admin token', refused: 'Sign-in with the admin token refused' },
    'login-link': { ok: 'Admin signed in with a one-time link', refused: 'One-time link refused (used or expired)' },
  } as const;
  const rec = (req: express.Request, outcome: Outcome, method: 'token-form' | 'login-link', reason?: string, suppressed = 0) =>
    d.audit.write({
      action: 'login', category: ['authentication'], type: ['start'], outcome,
      ...(outcome === 'success' ? { user: 'admin' } : {}),
      ip: clientIp(req), userAgent: req.get('user-agent'),
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
    if (!d.links.consume(typeof req.query.code === 'string' ? req.query.code : undefined)) {
      rec(req, 'failure', 'login-link', 'link-used-or-expired');
      return void res.redirect(302, '/?link=expired');
    }
    rec(req, 'success', 'login-link');
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${d.sessions.issue()}; Max-Age=${SESSION_MS / 1000}; ${flags(req)}`);
    res.redirect(302, '/');
  });
  r.post('/login', attempts, (req, res) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || !tokenMatches(token, [d.adminToken()])) {
      rec(req, 'failure', 'token-form', 'wrong-token');
      return void res.status(401).json({ error: 'unauthorized' });
    }
    rec(req, 'success', 'token-form');
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${d.sessions.issue()}; Max-Age=${SESSION_MS / 1000}; ${flags(req)}`);
    res.status(204).end();
  });
  r.get('/session', (req, res) => void res.json({ loggedIn: d.sessions.verify(readCookie(req.get('cookie'), SESSION_COOKIE)) }));
  r.post('/logout', (req, res) => {
    const valid = d.sessions.verify(readCookie(req.get('cookie'), SESSION_COOKIE));
    const ip = clientIp(req);
    const base = { action: 'logout', category: ['authentication'], type: ['end'], outcome: 'success' as const, ip, userAgent: req.get('user-agent') };
    if (valid) d.audit.write({ ...base, user: 'admin', message: 'Admin signed out' });
    else {
      const t = anonLogouts.take(ip, 'logout-without-session');
      if (t.record) d.audit.write({ ...base, message: 'Sign-out without a session', details: { auth: { reason: 'no-session', ...(t.suppressed ? { suppressed: t.suppressed } : {}) } } });
    }
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; ${flags(req)}`);
    res.status(204).end();
  });
  return r;
}

// The control API (spec §11); admin access is checked by the caller.
export function controlApi(d: ControlDeps): express.Router {
  const r = express.Router();
  let restartRequested = false; // a restart-proxy request was recorded (the stop follows)
  const invalid = (res: Response, err: unknown) => {
    if (err instanceof ConfigError) return void res.status(400).json({ error: 'invalid', detail: err.message });
    throw err;
  };

  // A one-time sign-in link for a signed-in cams user (admin token only).
  r.post('/login-links', (req, res) => {
    const link = d.links.issue();
    d.audit.write({ action: 'login-link-issued', category: ['authentication'], type: ['creation'], outcome: 'success', user: 'admin', ip: clientIp(req), userAgent: req.get('user-agent'), message: 'One-time sign-in link issued' });
    res.status(201).json(link);
  });

  r.get('/status', (_req, res) => {
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
    });
  });

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
      action: 'secret-override', category: ['configuration'], type: ['change'], outcome: 'success', user: 'admin', ip: clientIp(req), userAgent: req.get('user-agent'),
      message: `Google Vision key set manually (${masked}), ${replaced === 'none' ? 'where no key was set' : `replacing the ${replaced} key`}`,
      details: { secret: 'CAMPROXY_GOOGLE_VISION_KEY', masked, replaced },
    });
    res.json({ keySource: 'manual', keyMasked: masked, replaced });
  });

  r.get('/stats', (_req, res) => {
    const u = d.storage.usage();
    res.json({
      disk: { catalog: u.catalog, audit: u.audit, stills: u.stills, previews: u.previews, clips: u.clips, recordings: u.recordings, free: u.free, size: u.size },
      events: { stored: eventsStored(d.catalog) },
      stream: { rows: d.log.count(), lastId: d.log.lastId() },
      sse: { clients: d.sseClients() },
      storage: { budget: u.budget, used: u.used, daysUntilFull: u.daysUntilFull, paused: d.storage.paused() },
    });
  });

  // Inventories (spec 2026-10-02-inventory-design): the running one and the last runs; one report.
  r.get('/inventory', async (_req, res) => void res.json({ running: d.inventory.running(), runs: await d.inventory.list() }));
  r.get('/inventory/runs/:id', async (req, res) => {
    if (!RUN_ID.test(req.params.id)) return void res.status(400).json({ error: 'invalid', detail: 'not a run id' });
    const run = await d.inventory.get(req.params.id);
    if (!run) return void res.status(404).json({ error: 'not_found' });
    res.json(run);
  });

  r.get('/config', (_req, res) => void res.json(configView(d.loaded(), d.running())));
  // A `config-change` record: the changed leaf settings, old → new. Secret
  // values are redacted by AuditLog by the setting's name. A refused change
  // (400) writes nothing.
  const recordChanges = (req: express.Request, before: Config) => {
    const after = d.loaded().config;
    // `restart`: the change waits for a restart ('restart'), or for a new process ('process').
    const changes = leafPaths()
      .map((p) => ({ key: p, from: get(before, p), to: get(after, p), ...(needsProcessRestart(p) ? { restart: 'process' } : needsRestart(p) ? { restart: 'restart' } : {}) }))
      .filter((c) => JSON.stringify(c.from) !== JSON.stringify(c.to));
    if (changes.length) d.audit.write({ action: 'config-change', category: ['configuration'], type: ['change'], outcome: 'success', user: 'admin', ip: clientIp(req), userAgent: req.get('user-agent'), message: `Settings changed: ${changes.map((c) => c.key).join(', ')}`, details: { changes } });
  };
  r.put('/config', (req, res) => {
    const before = d.loaded().config;
    try {
      d.setLoaded(applyOverrides(d.loaded(), req.body ?? {}));
    } catch (err) {
      return invalid(res, err);
    }
    recordChanges(req, before);
    res.json(configView(d.loaded(), d.running()));
  });
  r.delete('/config/:path', (req, res) => {
    const before = d.loaded().config;
    try {
      d.setLoaded(removeOverride(d.loaded(), req.params.path));
    } catch (err) {
      return invalid(res, err);
    }
    recordChanges(req, before);
    res.json(configView(d.loaded(), d.running()));
  });

  r.post('/actions/:name', async (req, res) => {
    const name = req.params.name;
    const requestedBy = res.locals.access?.viaCookie ? 'session' : 'token';
    // A `control-action` record with the result, once the answer is sent or
    // the client went away ('close' fires in both cases; 'finish' only in the
    // first). Not for the camera reboot and the process restart (their own
    // records, camera-reboot and proxy-restart; an inventory writes `inventory`
    // when it ends) or a retention preview
    // (dryRun changes nothing). The power-cycle has its own records too
    // (camera-powercycle); a read of the switch is a control-action.
    if (name !== 'camera-reboot' && name !== 'camera-powercycle' && name !== 'camera-poe-on' && name !== 'restart-proxy' && name !== 'inventory' && !(name === 'retention-run' && req.body?.dryRun === true)) {
      res.on('close', () => {
        const done = res.writableFinished;
        const ok = done && res.statusCode < 400;
        const result = !done ? 'aborted' : ok ? 'ok' : String((res.locals.errorCode as string | undefined) ?? res.statusCode);
        d.audit.write({ action: 'control-action', category: ['configuration'], type: ['change'], outcome: !done ? 'unknown' : ok ? 'success' : 'failure', user: 'admin', ip: clientIp(req), userAgent: req.get('user-agent'), message: `Control action ${name}: ${result}`, details: { action: name, result, requestedBy } });
      });
    }
    const fail = (status: number, error: string, detail?: string, extra: object = {}) => {
      res.locals.errorCode = error;
      res.status(status).json({ error, ...(detail ? { detail } : {}), ...extra });
    };
    // The reboot and the power-cycle share a cooldown (#83, #85).
    const tooSoon = (a: TooSoon) => {
      res.setHeader('Retry-After', String(a.retryAfterS));
      fail(429, 'too_soon', a.inFlight
        ? `a camera reboot or power-cycle is in progress; try again in ${a.retryAfterS} s`
        : `the camera was rebooted or power-cycled less than 2 minutes ago; try again in ${a.retryAfterS} s`);
    };
    const switchFail = (err: unknown) => {
      if (!(err instanceof PoeSwitchError)) throw err;
      fail(err.code === 'switch_busy' || err.code === 'no_power' ? 409 : 502, err.code, err.message, err.poeOff ? { poeOff: true, turnedOn: err.turnedOn === true } : {});
    };
    switch (name) {
      case 'onvif-resubscribe':
        d.resubscribe();
        return void res.status(202).end();
      case 'camera-test':
        return void res.json(await d.checkCamera());
      case 'retention-run':
        return void res.json(d.storage.run({ dryRun: req.body?.dryRun === true }));
      case 'camera-ftp-setup':
      case 'camera-ftp-test': {
        const t = d.cameraFtp.target();
        if (!t.server) return fail(409, 'not_configured', 'ftp.publicHost is not set');
        if (!t.password) return fail(409, 'not_configured', 'CAMPROXY_FTP_PASSWORD is not set');
        return void (await cameraCall(res, async () => (name === 'camera-ftp-setup' ? { ftp: await d.cameraFtp.setup(t) } : d.cameraFtp.test(t))));
      }
      case 'camera-ftp-off':
        return void (await cameraCall(res, async () => ({ ftp: await d.cameraFtp.off() })));
      // The camera side: reconnect and apply restart settings; the process runs on.
      case 'restart':
        d.restart().catch((err: Error) => logger.error({ err: err.message }, 'restart_failed'));
        return void res.status(202).end();
      // Reboot the camera (#83): 202 {confirmed}, 429 within the cooldown,
      // 502 when the request never reached the camera.
      case 'camera-reboot': {
        const a = await d.cameraReboot({ requestedBy, ip: clientIp(req), userAgent: req.get('user-agent') });
        if (a.status === 202) return void res.status(202).json({ confirmed: a.confirmed });
        if (a.status === 429) return tooSoon(a);
        return fail(502, a.error, a.detail);
      }
      // Power-cycle the camera through its PoE switch (#85): 202 {offAt, onAt,
      // watts} once PoE is back on; 409 not_configured, switch_busy, no_power;
      // 502 switch_auth, switch_unreachable, switch_error; 429 as the reboot.
      case 'camera-powercycle': {
        const why = d.poeSwitch.notConfigured();
        if (why) return fail(409, 'not_configured', why);
        const a = await d.cameraPowerCycle({ requestedBy, ip: clientIp(req), userAgent: req.get('user-agent') });
        if (a.status === 202) return void res.status(202).json({ offAt: a.offAt, onAt: a.onAt, watts: a.watts });
        if (a.status === 429) return tooSoon(a);
        return fail(a.status, a.error, a.detail, a.poeOff ? { poeOff: true, turnedOn: a.turnedOn } : {});
      }
      // Recovery (#85): PoE on for the camera's port if it is off; no power
      // check and no cooldown. The same switch session lock as the rest.
      case 'camera-poe-on': {
        const why = d.poeSwitch.notConfigured();
        if (why) return fail(409, 'not_configured', why);
        const sw = d.poeSwitch.info();
        const where = `${sw.host} port ${sw.port}`;
        const base = { action: 'camera-poe-on', category: ['host'], type: ['change'], user: 'admin', ip: clientIp(req), userAgent: req.get('user-agent') };
        try {
          const r = await d.poeSwitch.poeOn();
          d.audit.write({ ...base, outcome: 'success', message: r.wasOn ? `Camera PoE on (${where}): it was on already` : `Camera PoE turned on (${where})`, details: { switch: sw, wasOn: r.wasOn, requestedBy } });
          return void res.json(r);
        } catch (err) {
          if (err instanceof PoeSwitchError) d.audit.write({ ...base, outcome: 'failure', error: err.code, message: `Camera PoE on (${where}) failed: ${err.message}`, details: { switch: sw, requestedBy, ...(err.poeOff ? { poeStillOff: true } : {}) } });
          return switchFail(err);
        }
      }
      // The camera's port on the switch now (log in, read, log out); never polled.
      case 'poe-switch-read': {
        const why = d.poeSwitch.notConfigured();
        if (why) return fail(409, 'not_configured', why);
        try {
          return void res.json(await d.poeSwitch.read());
        } catch (err) {
          return switchFail(err);
        }
      }
      // Restart the process (#71): answer first, then the normal stop and exit 0.
      case 'restart-proxy':
        // One record per restart: a second request before the stop is the same restart.
        if (!restartRequested) d.audit.write({ action: 'proxy-restart', category: ['process'], type: ['change'], outcome: 'success', user: 'admin', ip: clientIp(req), userAgent: req.get('user-agent'), message: 'Proxy process restart requested through the control API', details: { requestedBy } });
        restartRequested = true;
        res.once('close', () => setImmediate(() => d.restartProcess()));
        return void res.status(202).end();
      // Inventories (spec 2026-10-02-inventory-design): 202 {runId}; the run
      // goes on in the background and writes its own `inventory` record.
      case 'inventory': {
        const kind: unknown = req.body?.kind;
        const kinds = d.inventory.kinds();
        if (typeof kind !== 'string' || !kinds.includes(kind)) return fail(400, 'invalid', `kind is one of: ${kinds.join(', ')}`);
        try {
          const { runId } = d.inventory.start(kind, { requestedBy, ip: clientIp(req), userAgent: req.get('user-agent') });
          return void res.status(202).json({ runId });
        } catch (err) {
          if (err instanceof InventoryStoppingError) return fail(503, 'stopping', err.message);
          if (!(err instanceof InventoryBusyError)) throw err;
          return fail(409, 'inventory_busy', err.message, { runId: err.runId });
        }
      }
      // A control-action record; the run ends with its partial counts.
      case 'inventory-cancel': {
        const runId = d.inventory.cancel('request');
        return void res.json({ cancelled: runId !== null, runId });
      }
      default:
        return fail(404, 'not_found');
    }
  });

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
export function auditApi(d: { audit: AuditLog; guard: express.RequestHandler }): express.Router {
  const r = express.Router();
  r.get('/audit', d.guard, (req, res) => {
    const q = req.query;
    const num = (v: unknown) => (v === undefined ? undefined : /^\d{1,15}$/.test(String(v)) ? Number(v) : NaN);
    const outcome = q.outcome === undefined ? undefined : String(q.outcome);
    if (outcome !== undefined && !['success', 'failure', 'unknown'].includes(outcome)) return void res.status(400).json({ error: 'invalid', detail: 'outcome is success, failure or unknown' });
    const from = num(q.from), to = num(q.to), limit = num(q.limit);
    if ([from, to, limit].some((v) => Number.isNaN(v))) return void res.status(400).json({ error: 'invalid', detail: 'from, to and limit are numbers' });
    try {
      const out = d.audit.list({
        limit, from, to, outcome: outcome as Outcome | undefined,
        before: q.before === undefined ? undefined : String(q.before),
        after: q.after === undefined ? undefined : String(q.after),
        actions: q.action === undefined ? undefined : String(q.action).split(',').map((s) => s.trim()).filter(Boolean),
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
