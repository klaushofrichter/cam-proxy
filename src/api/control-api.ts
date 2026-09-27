import express, { type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Catalog } from '../catalog/db';
import type { CameraState } from '../camera/status';
import type { Config } from '../config/defaults';
import { applyOverrides, ConfigError, needsRestart, removeOverride, type Loaded } from '../config/load';
import { leafPaths } from '../config/schema';
import type { FtpTarget } from '../clips/camera-ftp';
import type { IntakeState } from '../events/intake';
import { logBuffer, logger } from '../log';
import type { Storage } from '../storage';
import type { StreamLog } from '../stream/log';
import { tokenMatches } from './auth';
import { eventsStored } from './metrics';
import { readCookie, SESSION_COOKIE, SESSION_MS, type createSessionSigner } from './session';

export interface ControlDeps {
  loaded: () => Loaded;
  setLoaded: (l: Loaded) => void; // applies live settings
  running: () => Config; // what the components run with
  catalog: Catalog;
  log: StreamLog;
  camera: () => CameraState;
  checkCamera: () => Promise<CameraState>;
  intake: () => IntakeState;
  resubscribe: () => void;
  restart: () => Promise<void>;
  cameraFtp: {
    target: () => FtpTarget;
    setup: (t: FtpTarget) => Promise<unknown>;
    test: (t: FtpTarget) => Promise<{ ok: boolean; rspCode: number }>;
    off: () => Promise<unknown>;
  };
  storage: Storage;
  sseClients: () => number;
  stream: () => { enabled: boolean; up: boolean; go2rtcUp: boolean; lastFrameTs: number | null };
  sessions: ReturnType<typeof createSessionSigner>;
  version: string;
}

const get = (o: unknown, path: string) => path.split('.').reduce<unknown>((x, k) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);

// The effective configuration for the UI: value (what runs), source, restart
// flag, and the next value for restart settings changed but not yet applied.
export function configView(loaded: Loaded, running: Config) {
  return Object.fromEntries(
    leafPaths().map((p) => {
      const restart = needsRestart(p);
      const value = get(running, p);
      const next = get(loaded.config, p);
      const pending = restart && JSON.stringify(value) !== JSON.stringify(next);
      return [p, { value, source: loaded.sources[p], restart, pending, ...(pending ? { next } : {}) }];
    }),
  );
}

// A camera call from an action: its answer, or 502 with the camera's error.
async function cameraCall(res: Response, f: () => Promise<unknown>): Promise<void> {
  try {
    res.json(await f());
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'camera_action_failed');
    res.status(502).json({ error: 'camera_error', detail: (err as Error).message });
  }
}

export function sessionRoutes(d: { adminToken: () => string; sessions: ReturnType<typeof createSessionSigner> }): express.Router {
  const r = express.Router();
  const flags = (req: express.Request) => `HttpOnly; SameSite=Strict; Path=/${req.secure ? '; Secure' : ''}`;
  r.post('/login', rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: false, legacyHeaders: false, message: { error: 'too_many_attempts' } }), (req, res) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || !tokenMatches(token, [d.adminToken()])) return void res.status(401).json({ error: 'unauthorized' });
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${d.sessions.issue()}; Max-Age=${SESSION_MS / 1000}; ${flags(req)}`);
    res.status(204).end();
  });
  r.get('/session', (req, res) => void res.json({ loggedIn: d.sessions.verify(readCookie(req.get('cookie'), SESSION_COOKIE)) }));
  r.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; ${flags(req)}`);
    res.status(204).end();
  });
  return r;
}

// The control API (spec §11); admin access is checked by the caller.
export function controlApi(d: ControlDeps): express.Router {
  const r = express.Router();
  const invalid = (res: Response, err: unknown) => {
    if (err instanceof ConfigError) return void res.status(400).json({ error: 'invalid', detail: err.message });
    throw err;
  };

  r.get('/status', (_req, res) => {
    res.json({
      version: d.version,
      camera: d.camera(),
      intake: d.intake(),
      sse: { clients: d.sseClients() },
      stream: d.stream(),
      retention: { lastRun: d.storage.lastRun(), totals: d.storage.totals() },
      storage: { paused: d.storage.paused() },
    });
  });

  r.get('/stats', (_req, res) => {
    const u = d.storage.usage();
    res.json({
      disk: { catalog: u.catalog, stills: u.stills, previews: u.previews, clips: u.clips, free: u.free, size: u.size },
      events: { stored: eventsStored(d.catalog) },
      stream: { rows: d.log.count(), lastId: d.log.lastId() },
      sse: { clients: d.sseClients() },
      storage: { budget: u.budget, used: u.used, daysUntilFull: u.daysUntilFull, paused: d.storage.paused() },
    });
  });

  r.get('/config', (_req, res) => void res.json(configView(d.loaded(), d.running())));
  r.put('/config', (req, res) => {
    try {
      d.setLoaded(applyOverrides(d.loaded(), req.body ?? {}));
    } catch (err) {
      return invalid(res, err);
    }
    res.json(configView(d.loaded(), d.running()));
  });
  r.delete('/config/:path', (req, res) => {
    try {
      d.setLoaded(removeOverride(d.loaded(), req.params.path));
    } catch (err) {
      return invalid(res, err);
    }
    res.json(configView(d.loaded(), d.running()));
  });

  r.post('/actions/:name', async (req, res) => {
    switch (req.params.name) {
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
        if (!t.server) return void res.status(409).json({ error: 'not_configured', detail: 'ftp.publicHost is not set' });
        if (!t.password) return void res.status(409).json({ error: 'not_configured', detail: 'CAMPROXY_FTP_PASSWORD is not set' });
        return void (await cameraCall(res, async () => (req.params.name === 'camera-ftp-setup' ? { ftp: await d.cameraFtp.setup(t) } : d.cameraFtp.test(t))));
      }
      case 'camera-ftp-off':
        return void (await cameraCall(res, async () => ({ ftp: await d.cameraFtp.off() })));
      case 'restart':
        d.restart().catch((err: Error) => logger.error({ err: err.message }, 'restart_failed'));
        return void res.status(202).end();
      default:
        return void res.status(404).json({ error: 'not_found' });
    }
  });

  r.get('/log', (req, res) => {
    const limit = Number(req.query.limit);
    res.json(logBuffer.recent(Number.isInteger(limit) && limit > 0 ? limit : 100));
  });

  return r;
}
