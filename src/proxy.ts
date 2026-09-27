import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { openCatalog, type Catalog } from './catalog/db';
import { closeAllOpen } from './catalog/events';
import { ReolinkClient } from './camera/client';
import { splitHost } from './camera/http';
import { StatusPoller } from './camera/status';
import type { Loaded } from './config/load';
import { EventIntake } from './events/intake';
import { EventTracker } from './events/tracker';
import { logger } from './log';
import { StreamLog } from './stream/log';
import { sseHandler } from './stream/sse';
import { bearerAuth, refuseTokenInUrl } from './api/auth';
import { clientApi } from './api/client-api';

export interface Proxy {
  loaded: Loaded;
  app: Express;
  catalog: Catalog;
  log: StreamLog;
  status: StatusPoller;
  intake: EventIntake;
  sse: ReturnType<typeof sseHandler>;
  start(opts?: { port?: number; host?: string }): Promise<{ port: number }>;
  stop(): Promise<void>;
}

export function createProxy(loaded: Loaded): Proxy {
  const cfg = () => loaded.config;
  const c = loaded.config;
  logger.level = c.server.logLevel;

  const catalog = openCatalog(join(c.server.dataDir, 'catalog.sqlite'));
  const log = new StreamLog(catalog);
  // Events a previous run left open end at the last thing it logged.
  const last = catalog.db.prepare('SELECT MAX(ts) AS ts FROM stream_log').get() as { ts: number | null };
  closeAllOpen(catalog, c.camera.id, last.ts ?? Date.now(), 'restart');

  const client = new ReolinkClient({ id: c.camera.id, host: c.camera.host, protocol: c.camera.protocol, tlsServername: c.camera.tlsName, user: c.camera.user, password: loaded.secrets.cameraPassword });
  const status = new StatusPoller(client, c.camera.statusPollS);
  status.on('change', (s) => log.append(c.camera.id, 'camera-status', { online: s.online, reason: s.error ?? null, clockOffsetMs: s.clockOffsetMs ?? null }));

  const tracker = new EventTracker(catalog, log, c.camera.id, { maxOpenMin: c.events.maxOpenMin });
  const intake = new EventIntake({
    client,
    tracker,
    cfg: c.events,
    onvif: { host: splitHost(c.camera.host).hostname, port: c.camera.onvifPort, user: c.camera.user, password: loaded.secrets.cameraPassword },
  });

  const sse = sseHandler(log, c.sse);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.get('/health', (_req, res) => void res.json({ ok: true }));
  app.use('/api', refuseTokenInUrl, bearerAuth(() => loaded.secrets.tokens), clientApi({ config: cfg, catalog, status, sse }));
  app.use((_req, res) => void res.status(404).json({ error: 'not_found' }));
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.status && err.status < 500) return void res.status(err.status).json({ error: err.type === 'entity.too.large' ? 'too_large' : 'bad_request' });
    logger.error({ err: err.message }, 'request_failed');
    res.status(500).json({ error: 'internal' });
  });

  let server: http.Server | undefined;
  return {
    loaded,
    app,
    catalog,
    log,
    status,
    intake,
    sse,
    async start(opts = {}) {
      server = http.createServer(app);
      const s = server;
      const port = await new Promise<number>((resolve, reject) => {
        s.once('error', reject);
        s.listen(opts.port ?? c.server.port, opts.host ?? '0.0.0.0', () => resolve((s.address() as AddressInfo).port));
      });
      status.start();
      intake.start();
      logger.info({ port, camera: c.camera.id }, 'cam_proxy_started');
      return { port };
    },
    async stop() {
      sse.closeAll();
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
}
