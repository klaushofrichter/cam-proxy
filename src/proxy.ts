import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { existsSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { openCatalog, type Catalog } from './catalog/db';
import { clearUnmapped, listUnmapped } from './catalog/analyses';
import { closeAllOpen } from './catalog/events';
import { ReolinkClient } from './camera/client';
import { splitHost } from './camera/http';
import { StatusPoller } from './camera/status';
import type { Config } from './config/defaults';
import { needsProcessRestart, needsRestart, type Loaded } from './config/load';
import { leafPaths } from './config/schema';
import { cameraFtpOff, setupCameraFtp, testCameraFtp } from './clips/camera-ftp';
import { ClipIndexer } from './clips/indexer';
import { createClipsSide, type ClipsSide } from './clips/side';
import { EventIntake } from './events/intake';
import { EventTracker } from './events/tracker';
import { logger, setLogLevel, withoutQuery } from './log';
import { Storage } from './storage';
import { AuditLog } from './audit/audit-log';
import { RefusalThrottle } from './audit/throttle';
import { Go2rtc } from './stills/go2rtc';
import { FrameGrabber, type Frame } from './stills/grabber';
import { MinuteStore, minuteOf } from './stills/store';
import type { StillsSide } from './api/client-api';
import { StreamLog, type StreamMessage } from './stream/log';
import { AnalyticsService } from './analytics/service';
import { refreshingTimeInfo } from './analytics/time-info';
import { sseHandler } from './stream/sse';
import { clientIp, refuseTokenInUrl, requireAccess, type AccessDeps } from './api/auth';
import { clientApi } from './api/client-api';
import { auditApi, controlApi, sessionRoutes } from './api/control-api';
import { createMetrics } from './api/metrics';
import { createSessionSigner } from './api/session';
import { createLoginLinks } from './api/login-links';
import { composeApi, hasAudio } from './api/compose-api';
import { createComposer, ffmpegRunner } from './compose/jobs';
import { clockText, defaultFont } from './compose/ffmpeg';

export const VERSION = process.env.CAMPROXY_VERSION ?? 'dev';

// The built admin UI: dist/web next to the compiled server (dist/src → dist/web),
// or, running from source, the repository's dist/web. The source web/ folder
// (with vite.config.mts) is never served.
function findWebDir(): string | undefined {
  for (const dir of [process.env.CAMPROXY_WEB_DIR, join(__dirname, '..', 'web'), join(__dirname, '..', 'dist', 'web')]) {
    if (dir && existsSync(join(dir, 'index.html')) && !existsSync(join(dir, 'vite.config.mts'))) return dir;
  }
  return undefined;
}
export const TARGET = process.env.CAMPROXY_TARGET ?? 'dev';

export interface Proxy {
  readonly loaded: Loaded;
  readonly running: Config;
  app: Express;
  catalog: Catalog;
  log: StreamLog;
  readonly status: StatusPoller;
  readonly intake: EventIntake;
  sse: ReturnType<typeof sseHandler>;
  readonly stills: StillsSide | undefined;
  readonly clips: ClipsSide | undefined;
  readonly analytics: AnalyticsService;
  storage: Storage;
  readonly audit: AuditLog;
  start(opts?: { port?: number; host?: string }): Promise<{ port: number }>;
  restart(): Promise<void>;
  stop(opts?: { reason?: string }): Promise<void>;
}

const getPath = (o: unknown, p: string) => p.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);
function setPath(o: Record<string, unknown>, p: string, v: unknown): void {
  const keys = p.split('.');
  let x = o;
  for (const k of keys.slice(0, -1)) x = (x[k] ??= {}) as Record<string, unknown>;
  if (v === undefined) delete x[keys[keys.length - 1]];
  else x[keys[keys.length - 1]] = v;
}

// The camera's own web page for the admin UI: camera.webUiUrl, none for no
// link, or https://<host without its port>/.
export function cameraWebUi(c: Config['camera']): string | null {
  if (c.webUiUrl === 'none') return null;
  if (c.webUiUrl) return c.webUiUrl;
  const { hostname } = splitHost(c.host);
  return hostname ? `https://${hostname}/` : null;
}

export function createProxy(initial: Loaded): Proxy {
  let loaded = initial;
  // The configuration the components run with: live settings are copied in
  // at once, restart settings on restart().
  const running: Config = structuredClone(loaded.config);
  setLogLevel(running.server.logLevel);

  const catalog = openCatalog(join(running.server.dataDir, 'catalog.sqlite'));
  const log = new StreamLog(catalog);
  // Events a previous run left open end at the last thing it logged.
  const last = catalog.db.prepare('SELECT MAX(ts) AS ts FROM stream_log').get() as { ts: number | null };
  // Stream clients saw them start, so they get the end too.
  for (const e of closeAllOpen(catalog, running.camera.id, last.ts ?? Date.now(), 'restart')) {
    log.append(e.cam, 'camera-event', { eventId: e.id, kind: e.kind, phase: 'end', ts: e.end_ts, source: e.source, reason: 'restart' });
  }

  const sse = sseHandler(log, running.sse);
  // The audit log (spec 2026-10-01-audit-log-design): daily JSON-lines files.
  const audit = new AuditLog({ dir: join(running.server.dataDir, 'audit'), version: VERSION, camera: () => running.camera.id });
  const storage = new Storage({ catalog, log, config: () => running, audit });
  storage.recount();
  const sessions = createSessionSigner();
  const links = createLoginLinks();
  // Composed clips (spec 2026-09-28): one encoding at a time; abandoned and
  // old jobs are swept every 5 s.
  const font = running.composition?.font ?? defaultFont();
  const composer = createComposer({
    dir: join(running.server.dataDir, 'compositions'),
    runner: ffmpegRunner({ font: font ?? '', clock: clockText, readStill: (ts) => stills?.store.readStill(ts) ?? Promise.resolve(undefined), hasAudio, paused: () => storage.paused(), stillsIntervalS: () => running.stills.intervalS }),
  });
  const sweeper = setInterval(() => composer.sweep(), 5000);
  sweeper.unref();

  let client!: ReolinkClient;
  let status: StatusPoller;
  let intake: EventIntake;
  let lastResubscribes = 0;
  let stills: StillsSide | undefined;
  let clips: ReturnType<typeof createClipsSide> | undefined;
  const metrics = createMetrics({
    stills: () => stills,
    storage,
    config: () => running,
    catalog,
    log,
    cameraUp: () => status.state().online,
    onvifSubscribed: () => intake.state().onvif === 'subscribed',
    sseClients: () => sse.clients(),
    version: VERSION,
    target: TARGET,
  });
  storage.on('run', metrics.onRetention);

  // The camera side: client, status poller, event tracker and intake. Built
  // again by restart() with the current settings.
  const buildCameraSide = () => {
    const c = running.camera;
    client = new ReolinkClient({ id: c.id, host: c.host, protocol: c.protocol, tlsServername: c.tlsName, user: c.user, password: loaded.secrets.cameraPassword });
    status = new StatusPoller(client, c.statusPollS);
    status.on('change', (s) => log.append(c.id, 'camera-status', { online: s.online, reason: s.error ?? null, clockOffsetMs: s.clockOffsetMs ?? null }));
    status.on('check', metrics.onCameraCheck);
    const tracker = new EventTracker(catalog, log, c.id, running.events);
    intake = new EventIntake({ client, tracker, cfg: running.events, onvif: { host: splitHost(c.host).hostname, port: c.onvifPort, user: c.user, password: loaded.secrets.cameraPassword } });
    lastResubscribes = 0;
    intake.on('state', (st) => {
      for (; lastResubscribes < st.resubscribes; lastResubscribes++) metrics.onResubscribe();
    });
    // Stills: go2rtc holds the camera connection, one ffmpeg makes stills and
    // tiles, the store writes a pack and a sprite per minute.
    stills = undefined;
    if (running.stills.enabled) {
      const s = running.stills;
      const go2rtc = new Go2rtc({ binary: running.go2rtc.binary, rtspPort: running.go2rtc.rtspPort, apiPort: running.go2rtc.apiPort, cam: c.id,
        source: { host: splitHost(c.host).hostname, port: c.rtspPort, user: c.user, password: loaded.secrets.cameraPassword } });
      const grabber = new FrameGrabber({ input: go2rtc.streamUrl(s.stream), intervalS: s.intervalS, size: s.size, tileSize: running.previews.tileSize, quality: s.quality, tileQuality: running.previews.quality });
      const store = new MinuteStore({ dataDir: running.server.dataDir, cam: c.id, intervalS: s.intervalS, still: { size: s.size, quality: s.quality }, tile: { size: running.previews.tileSize, grid: running.previews.grid, quality: running.previews.quality } });
      store.on('written', (w: { kind: 'stills' | 'previews'; bytes: number; files: number }) => storage.noteWritten(w.kind, w.bytes, w.files));
      grabber.on('frame', (f: Frame) => {
        if (storage.paused()) return metrics.onStillMissing(); // the disk is full: no writing
        store.add(f);
        metrics.onStill(f.ts);
        const minute = minuteOf(f.ts);
        const base = `/api/cameras/${encodeURIComponent(c.id)}`;
        sse.live(c.id, 'still', { ts: f.ts, url: `${base}/stills/${f.ts}.jpg`, sprite: `${base}/previews/${minute}.jpg`, tile: Math.floor((f.ts - minute) / (s.intervalS * 1000)) });
      });
      // Stream up and down reach stream clients as camera-status (spec §8).
      grabber.on('state', (st: { up: boolean }) => {
        const cs = status.state();
        log.append(c.id, 'camera-status', { online: cs.online, stream: st.up ? 'up' : 'down', reason: st.up ? null : 'no_frames', clockOffsetMs: cs.clockOffsetMs ?? null });
      });
      stills = { go2rtc, grabber, store };
    }
    // Clips: the camera uploads each recording by FTP(S) (needs the FTP password).
    clips = undefined;
    if (running.ftp.enabled) {
      if (!loaded.secrets.ftpPassword) logger.error('ftp_enabled_without_password');
      else {
        const cam = c.id;
        const indexer = new ClipIndexer({ catalog, log, config: () => running, timeInfo: () => client.timeInfo(), dataDir: running.server.dataDir, cam, stored: (bytes) => storage.noteWritten('clips', bytes, 1) });
        // Pictures stored before they were paired by time (2026-09-30).
        try {
          indexer.relinkSnapshots();
        } catch (err) {
          logger.warn({ err: (err as Error).message }, 'snapshots_relink_failed');
        }
        clips = createClipsSide({ config: running, password: loaded.secrets.ftpPassword, indexer, accept: () => !storage.paused() });
      }
    }
  };
  const startClips = async () => {
    try {
      await clips?.start();
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'ftp_start_failed');
    }
  };
  // go2rtc takes a moment to start; the grabber starts only if its side is
  // still the current one (a restart or stop may come in between).
  let stillsStarting: Promise<void> | undefined;
  const startStills = () => {
    const s = stills;
    if (!s) return;
    stillsStarting = s.go2rtc.start().then(
      () => {
        if (stills === s && !stopping) s.grabber.start();
      },
      (err: Error) => logger.error({ err: err.message }, 'go2rtc_start_failed'),
    );
  };
  let stopping = false;
  const stopStills = async () => {
    const s = stills;
    if (!s) return;
    stopping = true;
    await stillsStarting;
    stopping = false;
    await s.grabber.stop();
    await s.go2rtc.stop();
    await s.store.flush();
  };
  buildCameraSide();

  // External analytics: event stills to the provider, within its limits.
  const timeInfo = refreshingTimeInfo(() => client.timeInfo());
  const analytics = new AnalyticsService({
    catalog, log, dataDir: running.server.dataDir,
    // Read on use: restart() can change camera.id.
    get cam() {
      return running.camera.id;
    },
    config: () => running,
    secrets: () => ({ googleVisionKey: loaded.secrets.googleVisionKey, googleVisionUrl: loaded.secrets.googleVisionUrl }),
    readStill: (ts) => stills?.store.readStill(ts) ?? Promise.resolve(undefined),
    listStills: (from, to) => stills?.store.listStills(from, to) ?? [],
    timeInfo,
  });
  // Every camera-event start goes to the service (it filters by kind).
  log.on('message', (m: StreamMessage) => {
    if (m.type === 'camera-event' && m.data.phase === 'start') analytics.onEvent({ id: Number(m.data.eventId), kind: String(m.data.kind), start_ts: Number(m.data.ts) });
  });

  // New settings from the control API: live ones take effect now.
  const setLoaded = (next: Loaded) => {
    const analyticsBefore = JSON.stringify(loaded.config.analytics);
    loaded = next;
    for (const p of leafPaths()) if (!needsRestart(p)) setPath(running as unknown as Record<string, unknown>, p, structuredClone(getPath(next.config, p)));
    sse.setOptions(running.sse);
    setLogLevel(running.server.logLevel);
    // Only a change to the analytics settings lifts a bad_key pause.
    if (JSON.stringify(next.config.analytics) !== analyticsBefore) analytics.settingsChanged();
  };

  // An `auth-refused` record per source IP and path per 10 minutes; the
  // refusals in between are counted into the next record.
  const refusals = new RefusalThrottle();
  const access: AccessDeps = {
    tokens: () => loaded.secrets.tokens,
    adminToken: () => loaded.secrets.adminToken,
    auditToken: () => loaded.secrets.auditToken,
    sessionValid: (v: string | undefined) => sessions.verify(v),
    onRefused: (req, info) => {
      const ip = clientIp(req);
      // At most 256 characters in the record, the message and the throttle key.
      const full = withoutQuery(req.originalUrl);
      const path = full.length > 256 ? `${full.slice(0, 256)}…` : full;
      const t = refusals.take(ip, path);
      if (!t.record) return;
      audit.write({ action: 'auth-refused', category: ['authentication'], type: ['denied'], outcome: 'failure', ip, userAgent: req.get('user-agent'), message: `Refused ${req.method} ${path} (${info.reason})`, ecs: { http: { request: { method: req.method } }, url: { path } }, details: { auth: { tokenKind: info.tokenKind, reason: info.reason, ...(t.suppressed ? { suppressed: t.suppressed } : {}) } } });
    },
  };
  const app = express();
  app.disable('x-powered-by');
  // Far above real use (the UI, cams, a scraper); stops a flood. SSE is one
  // long request. Still and sprite images have their own, higher limit: a
  // day on the timeline is up to 1440 sprites.
  // Clip files too: a seeking video player sends many range requests.
  const IMAGE = /^\/api\/cameras\/[^/]+\/((stills|previews)\/\d{1,15}\.jpg|clips\/\d{1,15}\.(mp4|jpg)|events\/\d{1,15}\/analysis\.jpg)$/;
  const isImage = (req: Request) => req.method === 'GET' && IMAGE.test(req.path);
  // Behind an ingress (issue #29): client addresses from X-Forwarded-For.
  if (running.server.trustProxy) app.set('trust proxy', running.server.trustProxy);
  app.use(rateLimit({ windowMs: 60_000, limit: 1200, skip: isImage, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited' } }));
  app.use(rateLimit({ windowMs: 60_000, limit: 6000, skip: (req) => !isImage(req), standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited' } }));
  app.use(express.json({ limit: '64kb' }));
  app.get('/health', (_req, res) => void res.json({ ok: true, version: VERSION }));
  app.get('/metrics', async (_req, res) => {
    res.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });
  app.use('/control', sessionRoutes({ adminToken: access.adminToken, sessions, links, audit }));
  app.use('/api', refuseTokenInUrl, requireAccess('client', access), composeApi({ config: () => running, catalog, composer, stillsIn: (f, t) => stills?.store.listStills(f, t) ?? [], paused: () => storage.paused(), font }));
  app.use('/api', refuseTokenInUrl, requireAccess('client', access), clientApi({ config: () => running, catalog, status: () => status, sse, stills: () => stills }));
  // The audit log: admins and the audit token, GET only. The access check is
  // on the route inside the router; other /control paths pass on untouched
  // to the admin-only routes below.
  app.use('/control', refuseTokenInUrl, auditApi({ audit, guard: requireAccess('audit-read', access) }));
  app.use(
    '/control',
    refuseTokenInUrl,
    requireAccess('admin', access),
    controlApi({
      loaded: () => loaded,
      setLoaded,
      running: () => running,
      catalog,
      log,
      camera: () => ({ ...status.state(), webUiUrl: cameraWebUi(running.camera) }),
      checkCamera: () => status.checkNow(),
      intake: () => intake.state(),
      resubscribe: () => intake.resubscribe(),
      restart: () => proxy.restart(),
      ftp: () => ({
        enabled: running.ftp.enabled,
        listening: clips?.side.listening() ?? false,
        port: running.ftp.port,
        tls: running.ftp.tls,
        publicHost: running.ftp.publicHost ?? null,
        passwordSet: !!loaded.secrets.ftpPassword,
        lastUpload: clips?.side.lastUpload() ?? null,
        lastClip: clips?.side.indexer.lastIndexed() ?? null,
        clips: (catalog.db.prepare('SELECT COUNT(*) AS n FROM clips').get() as { n: number }).n,
        failures: (clips?.side.uploadFailures() ?? 0) + (clips?.side.indexer.failures() ?? 0),
      }),
      cameraFtp: {
        target: () => ({ server: running.ftp.publicHost ?? '', port: running.ftp.port, user: running.ftp.user, password: loaded.secrets.ftpPassword ?? '', tls: running.ftp.tls, stream: running.ftp.stream }),
        setup: (t) => setupCameraFtp(client, t),
        test: (t) => testCameraFtp(client, t),
        off: () => cameraFtpOff(client),
      },
      storage,
      audit,
      analytics: () => analytics.state(),
      unmapped: { list: (limit) => listUnmapped(catalog, limit), clear: () => clearUnmapped(catalog) },
      sseClients: () => sse.clients(),
      stream: () => ({ enabled: !!stills, up: stills?.grabber.up() ?? false, go2rtcUp: stills?.go2rtc.up() ?? false, lastFrameTs: stills?.grabber.lastFrameTs() ?? null }),
      sessions,
      links,
      version: VERSION,
    }),
  );
  // The admin UI. The files are public; every API call needs a session.
  const webDir = findWebDir();
  if (!webDir) logger.warn('admin_ui_not_built');
  else {
    // A missing asset is a 404, not the app page (stale chunks after an upgrade).
    app.use('/assets', express.static(join(webDir, 'assets'), { immutable: true, maxAge: '1y', index: false, fallthrough: false }));
    // Top-level files of the build (favicon.svg).
    app.get('/favicon.svg', (_req, res) => void res.sendFile(join(webDir, 'favicon.svg'), { maxAge: '1d' }));
    app.get(/^\/(?!api\/|control\/|health$|metrics$).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      // The UI has restart and retention buttons: never inside another page's frame.
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      res.sendFile(join(webDir, 'index.html'));
    });
  }
  app.use((_req, res) => void res.status(404).json({ error: 'not_found' }));
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.status === 404) return void res.status(404).json({ error: 'not_found' });
    if (err.type === 'entity.parse.failed') return void res.status(400).json({ error: 'invalid', detail: 'body is not JSON' });
    if (err.status && err.status < 500) return void res.status(err.status).json({ error: err.type === 'entity.too.large' ? 'too_large' : 'bad_request' });
    logger.error({ err: err.message }, 'request_failed');
    res.status(500).json({ error: 'internal' });
  });

  // Applies pending restart settings to the camera side (camera, events).
  // Settings read at process start (port, data folder, trust proxy, font) need a new process.
  const restartCameraSide = async () => {
    await intake.stop();
    status.stop();
    await stopStills();
    await clips?.stop();
    await client.logout();
    for (const p of leafPaths()) {
      if (needsProcessRestart(p)) continue;
      setPath(running as unknown as Record<string, unknown>, p, structuredClone(getPath(loaded.config, p)));
    }
    buildCameraSide();
    status.start();
    intake.start();
    startStills();
    await startClips();
    logger.info('cam_proxy_restarted');
  };

  let server: http.Server | undefined;
  let restarting: Promise<void> | undefined;
  const proxy: Proxy = {
    get loaded() {
      return loaded;
    },
    running,
    app,
    catalog,
    log,
    get status() {
      return status;
    },
    get intake() {
      return intake;
    },
    sse,
    storage,
    audit,
    get stills() {
      return stills;
    },
    get clips() {
      return clips?.side;
    },
    analytics,
    async start(opts = {}) {
      server = http.createServer(app);
      const s = server;
      const port = await new Promise<number>((resolve, reject) => {
        s.once('error', reject);
        s.listen(opts.port ?? running.server.port, opts.host ?? '0.0.0.0', () => resolve((s.address() as AddressInfo).port));
      });
      status.start();
      intake.start();
      startStills();
      await startClips();
      storage.start();
      try {
        analytics.backfillSummaries();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'analytics_backfill_failed');
      }
      analytics.catchUp();
      const prevStop = audit.find((r) => r.event.action === 'proxy-stop', 400);
      audit.write({ action: 'proxy-start', category: ['process'], type: ['start'], outcome: 'success', user: 'system', message: `cam-proxy ${VERSION} started`, details: { config: { camera: running.camera.id, stills: running.stills.enabled, ftp: running.ftp.enabled, analytics: running.analytics.googleVision.enabled }, previousStop: prevStop?.['@timestamp'] ?? null } });
      logger.info({ port, camera: running.camera.id, version: VERSION }, 'cam_proxy_started');
      return { port };
    },
    // One at a time: a second call while one runs joins it.
    restart() {
      restarting ??= (async () => {
        try {
          await restartCameraSide();
        } finally {
          restarting = undefined;
        }
      })();
      return restarting;
    },
    async stop(opts: { reason?: string } = {}) {
      // First, while everything is still open.
      audit.write({ action: 'proxy-stop', category: ['process'], type: ['end'], outcome: 'success', user: 'system', message: `cam-proxy stopping${opts.reason ? ` (${opts.reason})` : ''}`, details: { reason: opts.reason ?? 'stop' } });
      await restarting;
      clearInterval(sweeper);
      sse.closeAll();
      storage.stop();
      // Side by side, within a container's stop grace (compose.yaml: 20 s):
      // a running encode ends (up to 3 s), and a Vision call in flight is
      // stored before the catalog closes (up to its 10 s timeout).
      await Promise.all([composer.stop(), analytics.stop()]);
      const s = server;
      if (s) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
      await intake.stop();
      status.stop();
      await stopStills();
      await clips?.stop();
      await client.logout();
      catalog.close();
    },
  };
  return proxy;
}
