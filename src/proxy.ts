import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { existsSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { openCatalog, type Catalog } from './catalog/db';
import { closeAllOpen } from './catalog/events';
import { ReolinkClient } from './camera/client';
import { splitHost } from './camera/http';
import { StatusPoller } from './camera/status';
import type { Config } from './config/defaults';
import { needsRestart, type Loaded } from './config/load';
import { leafPaths } from './config/schema';
import { EventIntake } from './events/intake';
import { EventTracker } from './events/tracker';
import { logger, setLogLevel } from './log';
import { Storage } from './storage';
import { Go2rtc } from './stills/go2rtc';
import { FrameGrabber, type Frame } from './stills/grabber';
import { MinuteStore, minuteOf } from './stills/store';
import type { StillsSide } from './api/client-api';
import { StreamLog } from './stream/log';
import { sseHandler } from './stream/sse';
import { refuseTokenInUrl, requireAccess } from './api/auth';
import { clientApi } from './api/client-api';
import { controlApi, sessionRoutes } from './api/control-api';
import { createMetrics } from './api/metrics';
import { createSessionSigner } from './api/session';

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
  storage: Storage;
  start(opts?: { port?: number; host?: string }): Promise<{ port: number }>;
  restart(): Promise<void>;
  stop(): Promise<void>;
}

const getPath = (o: unknown, p: string) => p.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);
function setPath(o: Record<string, unknown>, p: string, v: unknown): void {
  const keys = p.split('.');
  let x = o;
  for (const k of keys.slice(0, -1)) x = (x[k] ??= {}) as Record<string, unknown>;
  if (v === undefined) delete x[keys[keys.length - 1]];
  else x[keys[keys.length - 1]] = v;
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
  const storage = new Storage({ catalog, log, config: () => running });
  storage.recount();
  const sessions = createSessionSigner();

  let client: ReolinkClient;
  let status: StatusPoller;
  let intake: EventIntake;
  let lastResubscribes = 0;
  let stills: StillsSide | undefined;
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

  // New settings from the control API: live ones take effect now.
  const setLoaded = (next: Loaded) => {
    loaded = next;
    for (const p of leafPaths()) if (!needsRestart(p)) setPath(running as unknown as Record<string, unknown>, p, structuredClone(getPath(next.config, p)));
    sse.setOptions(running.sse);
    setLogLevel(running.server.logLevel);
  };

  const access = { tokens: () => loaded.secrets.tokens, adminToken: () => loaded.secrets.adminToken, sessionValid: (v: string | undefined) => sessions.verify(v) };
  const app = express();
  app.disable('x-powered-by');
  // Far above real use (the UI, cams, a scraper); stops a flood. SSE is one
  // long request. Still and sprite images have their own, higher limit: a
  // day on the timeline is up to 1440 sprites.
  const IMAGE = /^\/api\/cameras\/[^/]+\/(stills|previews)\/\d{1,15}\.jpg$/;
  const isImage = (req: Request) => req.method === 'GET' && IMAGE.test(req.path);
  app.use(rateLimit({ windowMs: 60_000, limit: 1200, skip: isImage, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited' } }));
  app.use(rateLimit({ windowMs: 60_000, limit: 6000, skip: (req) => !isImage(req), standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited' } }));
  app.use(express.json({ limit: '64kb' }));
  app.get('/health', (_req, res) => void res.json({ ok: true }));
  app.get('/metrics', async (_req, res) => {
    res.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });
  app.use('/control', sessionRoutes({ adminToken: access.adminToken, sessions }));
  app.use('/api', refuseTokenInUrl, requireAccess('client', access), clientApi({ config: () => running, catalog, status: () => status, sse, stills: () => stills }));
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
      camera: () => status.state(),
      checkCamera: () => status.checkNow(),
      intake: () => intake.state(),
      resubscribe: () => intake.resubscribe(),
      restart: () => proxy.restart(),
      storage,
      sseClients: () => sse.clients(),
      stream: () => ({ enabled: !!stills, up: stills?.grabber.up() ?? false, go2rtcUp: stills?.go2rtc.up() ?? false, lastFrameTs: stills?.grabber.lastFrameTs() ?? null }),
      sessions,
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
  // Server port and data folder need a new process.
  const restartCameraSide = async () => {
    await intake.stop();
    status.stop();
    await stopStills();
    await client.logout();
    for (const p of leafPaths()) {
      if (p === 'server.port' || p === 'server.dataDir') continue;
      setPath(running as unknown as Record<string, unknown>, p, structuredClone(getPath(loaded.config, p)));
    }
    buildCameraSide();
    status.start();
    intake.start();
    startStills();
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
    get stills() {
      return stills;
    },
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
      storage.start();
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
    async stop() {
      await restarting;
      sse.closeAll();
      storage.stop();
      const s = server;
      if (s) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
      await intake.stop();
      status.stop();
      await stopStills();
      await client.logout();
      catalog.close();
    },
  };
  return proxy;
}
