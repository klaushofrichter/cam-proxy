import express, { type Express, type NextFunction, type Request, type Response } from 'express';
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
import { Retention } from './retention';
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
  retention: Retention;
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
  closeAllOpen(catalog, running.camera.id, last.ts ?? Date.now(), 'restart');

  const sse = sseHandler(log, running.sse);
  const retention = new Retention({ catalog, log, config: () => running });
  const sessions = createSessionSigner();

  let status: StatusPoller;
  let intake: EventIntake;
  let lastResubscribes = 0;
  const metrics = createMetrics({
    config: () => running,
    catalog,
    log,
    cameraUp: () => status.state().online,
    onvifSubscribed: () => intake.state().onvif === 'subscribed',
    sseClients: () => sse.clients(),
    version: VERSION,
    target: TARGET,
  });
  retention.on('run', metrics.onRetention);

  // The camera side: client, status poller, event tracker and intake. Built
  // again by restart() with the current settings.
  const buildCameraSide = () => {
    const c = running.camera;
    const client = new ReolinkClient({ id: c.id, host: c.host, protocol: c.protocol, tlsServername: c.tlsName, user: c.user, password: loaded.secrets.cameraPassword });
    status = new StatusPoller(client, c.statusPollS);
    status.on('change', (s) => log.append(c.id, 'camera-status', { online: s.online, reason: s.error ?? null, clockOffsetMs: s.clockOffsetMs ?? null }));
    status.on('check', metrics.onCameraCheck);
    const tracker = new EventTracker(catalog, log, c.id, running.events);
    intake = new EventIntake({ client, tracker, cfg: running.events, onvif: { host: splitHost(c.host).hostname, port: c.onvifPort, user: c.user, password: loaded.secrets.cameraPassword } });
    lastResubscribes = 0;
    intake.on('state', (st) => {
      for (; lastResubscribes < st.resubscribes; lastResubscribes++) metrics.onResubscribe();
    });
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
  app.use(express.json({ limit: '64kb' }));
  app.get('/health', (_req, res) => void res.json({ ok: true }));
  app.get('/metrics', async (_req, res) => {
    res.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });
  app.use('/control', sessionRoutes({ adminToken: access.adminToken, sessions }));
  app.use('/api', refuseTokenInUrl, requireAccess('client', access), clientApi({ config: () => running, catalog, status: () => status, sse }));
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
      retention,
      sseClients: () => sse.clients(),
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

  let server: http.Server | undefined;
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
    retention,
    async start(opts = {}) {
      server = http.createServer(app);
      const s = server;
      const port = await new Promise<number>((resolve, reject) => {
        s.once('error', reject);
        s.listen(opts.port ?? running.server.port, opts.host ?? '0.0.0.0', () => resolve((s.address() as AddressInfo).port));
      });
      status.start();
      intake.start();
      retention.start();
      logger.info({ port, camera: running.camera.id, version: VERSION }, 'cam_proxy_started');
      return { port };
    },
    // Applies pending restart settings to the camera side (camera, events).
    // Server port and data folder need a new process.
    async restart() {
      await intake.stop();
      status.stop();
      for (const p of leafPaths()) {
        if (p === 'server.port' || p === 'server.dataDir') continue;
        setPath(running as unknown as Record<string, unknown>, p, structuredClone(getPath(loaded.config, p)));
      }
      buildCameraSide();
      status.start();
      intake.start();
      logger.info('cam_proxy_restarted');
    },
    async stop() {
      sse.closeAll();
      retention.stop();
      const s = server;
      if (s) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
      await intake.stop();
      status.stop();
      catalog.close();
    },
  };
  return proxy;
}
