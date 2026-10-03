import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { openCatalog, type Catalog } from './catalog/db';
import { clearUnmapped, countAnalysesByStatus, listUnmapped, usageBetween } from './catalog/analyses';
import { countClips, lastClipReceived } from './catalog/clips';
import { closeAllOpen, countEventsByKind } from './catalog/events';
import { ReolinkClient } from './camera/client';
import { splitHost } from './camera/http';
import { StatusPoller } from './camera/status';
import { CameraReboot } from './camera/reboot';
import { PoeSwitch } from './camera/poe-switch';
import { restartProcess } from './process-restart';
import type { Config } from './config/defaults';
import { needsProcessRestart, needsRestart, type Loaded } from './config/load';
import { leafPaths } from './config/schema';
import { cameraFtpOff, readCameraFtp, setupCameraFtp, testCameraFtp, type FtpTarget } from './clips/camera-ftp';
import { CameraFtpWatch, clipsStalled } from './clips/ftp-health';
import { ClipIndexer } from './clips/indexer';
import { createClipsSide, type ClipsSide } from './clips/side';
import { createRecordingsSide, type RecordingsSide } from './recordings/side';
import { validId } from './recordings/names';
import { EventIntake } from './events/intake';
import { EventTracker } from './events/tracker';
import { logger, setLogLevel, withoutQuery } from './log';
import { Storage } from './storage';
import { AuditLog, cut, maskPath } from './audit/audit-log';
import { IpCap, RefusalThrottle } from './audit/throttle';
import { activityDaily, DailyAudit, storageMessage } from './audit/daily';
import { Go2rtc } from './stills/go2rtc';
import { FrameGrabber, type Frame } from './stills/grabber';
import { InventoryRunner } from './inventory/runner';
import { stillsCheck } from './inventory/stills';
import { clipsCheck } from './inventory/clips';
import { clipsRepair } from './inventory/repair-clips';
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
  readonly recordings: RecordingsSide;
  readonly analytics: AnalyticsService;
  storage: Storage;
  readonly audit: AuditLog;
  readonly inventory: InventoryRunner;
  start(opts?: { port?: number; host?: string }): Promise<{ port: number }>;
  restart(): Promise<void>;
  stop(opts?: { reason?: string }): Promise<void>;
}

export interface ProxyOptions {
  // Ends the process after a restart-proxy action (#71); src/cli.ts passes
  // process.exit. Without it the proxy only stops, so tests and the e2e
  // harness never end their own process.
  exit?: (code: number) => void;
  // The admin session key; random per process unless given (the e2e harness
  // keeps its sessions over a simulated restart).
  sessionSecret?: Buffer;
  restartTimeoutMs?: number; // how long a restart waits for stop() (15 s)
  cameraFtpCheckMs?: number; // how often the camera's FTP settings are read (#93; 5 min)
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

export function createProxy(initial: Loaded, opts: ProxyOptions = {}): Proxy {
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
  // A recording being read is never deleted (set once the recordings side exists).
  let recordingBusy: (path: string) => boolean = () => false;
  const storage = new Storage({ catalog, log, config: () => running, audit, recordingsBusy: (p) => recordingBusy(p) });
  storage.recount();
  const sessions = createSessionSigner(opts.sessionSecret);
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
    cameraFtpEnabled: () => (running.ftp.enabled ? ftpWatch.view().enable : null),
    clipsHealth: () => clipsHealth(),
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
    // The camera's FTP settings as soon as it answers (#93), then every few minutes.
    status.on('change', (s) => {
      if (s.online) void ftpWatch.checkNow();
    });
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
  // What camera-ftp-setup writes for this proxy (never logged: it has the password).
  const ftpTarget = (): FtpTarget => ({ server: running.ftp.publicHost ?? '', port: running.ftp.port, user: running.ftp.user, password: loaded.secrets.ftpPassword ?? '', tls: running.ftp.tls, stream: running.ftp.stream });
  // The camera's FTP upload (#93): read every few minutes while the proxy
  // takes clips and the camera answers; changes go to the audit log.
  const ftpWatch = new CameraFtpWatch({
    read: () => readCameraFtp(client),
    target: ftpTarget,
    audit,
    active: () => running.ftp.enabled && status.state().online,
    clipsBefore: () => lastClipReceived(catalog, running.camera.id) !== null,
    everyMs: opts.cameraFtpCheckMs,
  });
  // No stall warning for a camera never set up, nor before the first read when no clip ever came.
  const ftpNotSetUp = () => {
    const st = ftpWatch.view().state;
    return st === 'not_set_up' || (st === 'unknown' && lastClipReceived(catalog, running.camera.id) === null);
  };
  const clipsHealth = () => (running.ftp.enabled ? clipsStalled(catalog, running.camera.id, Date.now(), running.ftp.stalledHours, { notSetUp: ftpNotSetUp() }) : null);
  buildCameraSide();
  // Recordings on the camera's SD card (spec 2026-10-02-baichuan-recordings-design):
  // listed by HTTP Search, fetched over Baichuan (host from camera.host,
  // camera.baichuanPort read at every connection, the HTTP client's user and
  // password) into the cache.
  const recordings = createRecordingsSide({
    dataDir: running.server.dataDir,
    cam: () => running.camera.id,
    target: () => ({ host: splitHost(running.camera.host).hostname.replace(/^\[(.*)\]$/, '$1'), port: running.camera.baichuanPort, user: running.camera.user, password: loaded.secrets.cameraPassword }),
    capBytes: () => running.recordings.cacheMB * 2 ** 20,
    search: (param) => client.command('Search', param),
    timeInfo: () => client.timeInfo(),
    paused: () => storage.paused(),
    noteWritten: (bytes) => storage.noteWritten('recordings', bytes, 1),
    onDownload: (o) => metrics.onRecordingDownload({ stream: o.stream, result: o.result }),
  });
  recordingBusy = (p) => recordings.cache.busy(p);

  // Inventories (spec 2026-10-02-inventory-design): one run at a time, the
  // results in <dataDir>/inventory, an `inventory` audit record per run (an
  // `inventory-repair` record per repair). The settings are read when a run
  // starts. The clips compare lists the SD card through the recordings side;
  // its repair fetches there at low priority and indexes through its own
  // ClipIndexer (FTP may be off). Recordings the cache can't keep go through
  // <dataDir>/inventory/tmp (the data disk: /tmp is tmpfs on the Pi), emptied
  // here since a crash can leave .part files.
  const inventoryDir = join(running.server.dataDir, 'inventory');
  const repairTmp = join(inventoryDir, 'tmp');
  try {
    mkdirSync(repairTmp, { recursive: true });
    for (const f of readdirSync(repairTmp)) rmSync(join(repairTmp, f), { force: true });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'inventory_tmp_cleanup_failed');
  }
  const inventory = new InventoryRunner({
    dir: inventoryDir,
    audit,
    camera: () => running.camera.id,
    checks: {
      stills: {
        label: 'Stills',
        run: stillsCheck({
          dataDir: running.server.dataDir,
          audit,
          catalog,
          settings: () => ({ cam: running.camera.id, intervalS: running.stills.intervalS, stillsDays: running.retention.stillsDays, previewsDays: running.retention.previewsDays, keepHours: running.storage.keepHours.stills }),
        }),
      },
      clips: {
        label: 'Clips',
        camera: true,
        run: clipsCheck({
          dataDir: running.server.dataDir,
          catalog,
          settings: () => ({ cam: running.camera.id, clipsDays: running.retention.clipsDays, stream: running.ftp.stream, ftpEnabled: running.ftp.enabled, eventMaxOpenMin: running.events.maxOpenMin }),
          camera: { list: recordings.list, timeInfo: () => client.timeInfo() },
        }),
        repair: clipsRepair({
          catalog,
          settings: () => ({ cam: running.camera.id, stream: running.ftp.stream, clipsDays: running.retention.clipsDays, maxGB: running.ftp.maxGB }),
          list: recordings.list,
          fetcher: recordings.fetcher,
          cache: recordings.cache,
          indexer: () => new ClipIndexer({ catalog, log, config: () => running, timeInfo: () => client.timeInfo(), dataDir: running.server.dataDir, cam: running.camera.id, stored: (bytes) => storage.noteWritten('clips', bytes, 1) }),
          tempDir: () => repairTmp,
          paused: () => storage.paused(),
          clipsBytes: () => storage.usage().clips.bytes,
        }),
      },
    },
  });

  // A camera reboot from the control API (#83): the client and the status
  // poller are read on use, since restart() builds them anew.
  // forgetToken runs once a reboot went out, and at a power-cycle's PoE-off
  // (also one whose answer was lost): the Baichuan session dies with the
  // camera, so the recordings side is reset too (a request would otherwise
  // wait for a timeout on the dead socket).
  const reboot = new CameraReboot({
    send: () => client.command('Reboot'),
    forgetToken: () => {
      client.forgetToken();
      recordings.reset();
    },
    serial: () => status.state().serial,
    check: async () => {
      const s = await status.checkNow();
      return { ok: s.error === undefined, serial: s.serial };
    },
    audit,
  });
  // The camera's PoE switch (#85): settings read on every use (they apply at once).
  const poeSwitch = new PoeSwitch({ config: () => running.camera.poeSwitch, password: () => loaded.secrets.poeSwitchPassword });
  // What audit records name: never the password.
  const poeSwitchInfo = () => {
    const c = running.camera.poeSwitch;
    return { model: c.model, host: c.host ?? '', port: c.port ?? 0 };
  };

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

  // The daily audit records at 00:05 camera time: storage now, activity of the previous camera day.
  const daily = new DailyAudit({
    audit,
    timeInfo,
    storage: () => {
      const u = storage.usage();
      const clipRows = Number((catalog.db.prepare('SELECT COUNT(*) AS n FROM clips').get() as { n: number }).n);
      return {
        message: storageMessage({ used: u.used, budget: u.budget, stillMinutes: u.stills.files, clipRows, daysUntilFull: u.daysUntilFull }),
        details: { size: u.size, free: u.free, budget: u.budget, used: u.used, daysUntilFull: u.daysUntilFull, kinds: { stills: u.stills, previews: u.previews, clips: u.clips, recordings: u.recordings, catalog: u.catalog, audit: u.audit }, clipRows },
      };
    },
    activity: (day, from, to) => {
      const cam = running.camera.id;
      // Usage days are camera days (localDay); month to date as of the reported day.
      const vision = { day: usageBetween(catalog, 'google-vision', day, day), monthToDate: usageBetween(catalog, 'google-vision', `${day.slice(0, 7)}-01`, day), monthlyLimit: running.analytics.googleVision.monthlyLimit };
      return activityDaily(day, { events: countEventsByKind(catalog, cam, from, to), clips: countClips(catalog, cam, from, to), vision, analyses: countAnalysesByStatus(catalog, cam, from, to), sseClients: sse.clients() });
    },
  });

  // New settings from the control API: live ones take effect now.
  const setLoaded = (next: Loaded) => {
    const analyticsBefore = JSON.stringify(loaded.config.analytics);
    const baichuanPortBefore = running.camera.baichuanPort;
    loaded = next;
    for (const p of leafPaths()) if (!needsRestart(p)) setPath(running as unknown as Record<string, unknown>, p, structuredClone(getPath(next.config, p)));
    sse.setOptions(running.sse);
    setLogLevel(running.server.logLevel);
    // Only a change to the analytics settings lifts a bad_key pause.
    if (JSON.stringify(next.config.analytics) !== analyticsBefore) analytics.settingsChanged();
    // A new Baichuan port: the next use connects to it.
    if (running.camera.baichuanPort !== baichuanPortBefore) recordings.session.close();
  };

  // An `auth-refused` record per source IP and path per 10 minutes; the
  // refusals in between are counted into the next record.
  // The key is the path with numbers and ids replaced (numbered stills and
  // previews are one key), and at most 60 records per IP per 10 minutes.
  const refusals = new RefusalThrottle();
  const refusalsPerIp = new IpCap(60);
  const access: AccessDeps = {
    tokens: () => loaded.secrets.tokens,
    adminToken: () => loaded.secrets.adminToken,
    auditToken: () => loaded.secrets.auditToken,
    sessionValid: (v: string | undefined) => sessions.verify(v),
    onRefused: (req, info) => {
      const ip = clientIp(req);
      // At most 256 characters in the record, the message and the throttle key.
      const full = maskPath(withoutQuery(req.originalUrl));
      const path = full.length > 256 ? `${cut(full, 256)}…` : full;
      const t = refusals.take(ip, path.replace(/\d{6,}|[0-9a-f]{16,}/gi, ':n'));
      if (!t.record) return;
      const c = refusalsPerIp.take(ip);
      if (!c.record) return;
      t.suppressed += c.suppressed;
      audit.write({ action: 'auth-refused', category: ['authentication'], type: ['denied'], outcome: 'failure', ip, userAgent: req.get('user-agent'), message: `Refused ${req.method} ${path} (${info.reason})`, ecs: { http: { request: { method: req.method } }, url: { path } }, details: { auth: { tokenKind: info.tokenKind, reason: info.reason, ...(t.suppressed ? { suppressed: t.suppressed } : {}) } } });
    },
  };
  const app = express();
  app.disable('x-powered-by');
  let startedAt: number | null = null;
  // Far above real use (the UI, cams, a scraper); stops a flood. SSE is one
  // long request. Still and sprite images have their own, higher limit: a
  // day on the timeline is up to 1440 sprites.
  // Clip and recording files too: a seeking video player sends many range
  // requests. A recording only once it is cached (#99): one not cached costs
  // a camera Search and a download, so it counts in the normal bucket.
  const IMAGE = /^\/api\/cameras\/[^/]+\/((stills|previews)\/\d{1,15}\.jpg|clips\/\d{1,15}\.(mp4|jpg)|events\/\d{1,15}\/analysis\.jpg)$/;
  const RECORDING = /^\/api\/cameras\/[^/]+\/recordings\/(Rec[0-9A-Za-z_]+\.mp4)$/;
  const isImage = (req: Request) => {
    if (req.method !== 'GET') return false;
    if (IMAGE.test(req.path)) return true;
    const id = RECORDING.exec(req.path)?.[1];
    return id !== undefined && validId(id) && recordings.cache.has(id);
  };
  // Behind an ingress (issue #29): client addresses from X-Forwarded-For.
  if (running.server.trustProxy) app.set('trust proxy', running.server.trustProxy);
  app.use(rateLimit({ windowMs: 60_000, limit: 1200, skip: isImage, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited' } }));
  app.use(rateLimit({ windowMs: 60_000, limit: 6000, skip: (req) => !isImage(req), standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited' } }));
  app.use(express.json({ limit: '64kb' }));
  // startedAt tells a new process apart (the Maintenance page's restart waits for it).
  app.get('/health', (_req, res) => void res.json({ ok: true, version: VERSION, startedAt }));
  app.get('/metrics', async (_req, res) => {
    res.type(metrics.registry.contentType).send(await metrics.render());
  });
  // Tokens never travel in URLs: checked once per request, before any access
  // check and before the session routes (the login link carries ?code=).
  app.use(['/api', '/control'], refuseTokenInUrl);
  app.use('/control', sessionRoutes({ adminToken: access.adminToken, sessions, links, audit }));
  app.use('/api', requireAccess('client', access), composeApi({ config: () => running, catalog, composer, stillsIn: (f, t) => stills?.store.listStills(f, t) ?? [], paused: () => storage.paused(), font }));
  app.use('/api', requireAccess('client', access), clientApi({ config: () => running, catalog, status: () => status, sse, stills: () => stills, recordings: () => recordings }));
  // The audit log: admins and the audit token, GET (and HEAD) only. The access check is
  // on the route inside the router; other /control paths pass on untouched
  // to the admin-only routes below.
  app.use('/control', auditApi({ audit, guard: requireAccess('audit-read', access) }));
  app.use(
    '/control',
    requireAccess('admin', access),
    controlApi({
      loaded: () => loaded,
      setLoaded,
      running: () => running,
      catalog,
      log,
      camera: () => ({ ...status.state(), webUiUrl: cameraWebUi(running.camera), reboot: reboot.state(), poeSwitch: poeSwitch.status() }),
      checkCamera: () => status.checkNow(),
      intake: () => intake.state(),
      resubscribe: () => intake.resubscribe(),
      restart: () => proxy.restart(),
      cameraReboot: (who) => reboot.request(who),
      poeSwitch: { notConfigured: () => poeSwitch.notConfigured(), read: () => poeSwitch.read(), poeOn: () => poeSwitch.poeOn(), info: poeSwitchInfo },
      cameraPowerCycle: (who) => {
        return reboot.powerCycle(who, { switch: poeSwitchInfo(), offSeconds: running.camera.poeSwitch.offSeconds }, (onOff) => poeSwitch.cycle(onOff));
      },
      restartProcess: () => {
        processRestart ??= restartProcess({
          stop: () => proxy.stop({ reason: 'restart-requested' }),
          exit: opts.exit ?? ((code) => logger.warn({ code }, 'cam_proxy_exit_not_wired')),
          timeoutMs: opts.restartTimeoutMs,
        });
      },
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
        camera: running.ftp.enabled ? ftpWatch.view() : null,
        stalled: clipsHealth(),
      }),
      // The camera's answer goes to the FTP check at once (#93).
      cameraFtp: {
        target: ftpTarget,
        setup: async (t) => {
          const ftp = await setupCameraFtp(client, t);
          ftpWatch.note(ftp);
          return ftp;
        },
        test: (t) => testCameraFtp(client, t),
        off: async () => {
          const ftp = await cameraFtpOff(client, ftpTarget());
          ftpWatch.note(ftp);
          return ftp;
        },
      },
      storage,
      audit,
      analytics: () => analytics.state(),
      setVisionKey: (key) => analytics.setManualKey(key),
      unmapped: { list: (limit) => listUnmapped(catalog, limit), clear: () => clearUnmapped(catalog) },
      sseClients: () => sse.clients(),
      recordings: () => recordings.status(),
      inventory,
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
    recordings.reset();
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
  let processRestart: Promise<unknown> | undefined;
  let restarting: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
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
    inventory,
    get stills() {
      return stills;
    },
    get clips() {
      return clips?.side;
    },
    recordings,
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
      ftpWatch.start();
      storage.start();
      try {
        analytics.backfillSummaries();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'analytics_backfill_failed');
      }
      analytics.catchUp();
      // The newest start or stop: a start means the last run did not stop cleanly.
      const prev = audit.find((r) => r.event.action === 'proxy-start' || r.event.action === 'proxy-stop', 400);
      const uncleanStop = prev?.event.action === 'proxy-start';
      const previousStop = prev && !uncleanStop ? prev['@timestamp'] : null;
      audit.write({ action: 'proxy-start', category: ['process'], type: ['start'], outcome: 'success', user: 'system', message: `cam-proxy ${VERSION} started`, details: { config: { camera: running.camera.id, stills: running.stills.enabled, ftp: running.ftp.enabled, analytics: running.analytics.googleVision.enabled }, previousStop, uncleanStop } });
      daily.start();
      startedAt = Date.now();
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
    // Idempotent: a second call (two signals) joins the first and writes nothing.
    stop(opts: { reason?: string } = {}) {
      stopPromise ??= doStop(opts);
      return stopPromise;
    },
  };
  async function doStop(opts: { reason?: string }): Promise<void> {
      daily.stop();
      ftpWatch.stop();
      // First, while everything is still open.
      audit.write({ action: 'proxy-stop', category: ['process'], type: ['end'], outcome: 'success', user: 'system', message: `cam-proxy stopping${opts.reason ? ` (${opts.reason})` : ''}`, details: { reason: opts.reason ?? 'stop' } });
      // A power-cycle in its off time turns the camera's PoE on now, not
      // never; bounded, and loud when it could not.
      const { poeLeftOff, sessionMaybeOpen } = await poeSwitch.stop();
      if (poeLeftOff || sessionMaybeOpen) {
        const sw = poeSwitchInfo();
        const parts = [
          ...(poeLeftOff ? [`the camera's PoE may be left OFF on ${sw.host} port ${sw.port}; turn it on in the switch's web UI, or with "Turn camera PoE on" once the proxy is back`] : []),
          ...(sessionMaybeOpen ? ["the proxy's web session on the switch may still be open: the switch's web UI may refuse logins until the switch ends it"] : []),
        ];
        audit.write({ action: 'camera-powercycle', category: ['host'], type: ['end'], outcome: 'failure', user: 'system', message: `cam-proxy stopping: ${parts.join('; ')}`, details: { phase: 'stop', poeLeftOff, sessionMaybeOpen, switch: sw } });
      }
      await restarting;
      reboot.stop();
      clearInterval(sweeper);
      sse.closeAll();
      storage.stop();
      // Side by side, within a container's stop grace (compose.yaml: 20 s):
      // a running encode ends (up to 3 s), and a Vision call in flight is
      // stored before the catalog closes (up to its 10 s timeout).
      // A recording download is aborted (cmd 9) and the Baichuan session closed (up to 2 s).
      // A running inventory is cancelled ('stop'), saved and audited before the catalog closes.
      await Promise.all([composer.stop(), analytics.stop(), recordings.stop(), inventory.stop()]);
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
  }
  return proxy;
}
