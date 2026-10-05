import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { openCatalog, type Catalog } from './catalog/db';
import { adoptLegacyUsage, usageByCamera, clearUnmapped, countAnalysesByStatus, listUnmapped, usageBetween } from './catalog/analyses';
import { countAllClips, countClips } from './catalog/clips';
import { closeAllOpen, countEventsByKind, countRecoveredEvents } from './catalog/events';
import type { StatusPoller } from './camera/status';
import type { EventIntake } from './events/intake';
import { CameraRegistry } from './cameras/registry';
import { CameraWorker, cameraWebUi } from './cameras/worker';
import { cameraConfig, cameraIds } from './config/cameras';
import { restartProcess } from './process-restart';
import type { Config } from './config/defaults';
import { getPath, needsProcessRestart, needsRestart, setPath, type Loaded } from './config/load';
import { leafPaths } from './config/schema';
import { cameraFtpOff, setupCameraFtp, testCameraFtp, type FtpTarget } from './clips/camera-ftp';
import { createClipsSide, type ClipsSide } from './clips/side';
import type { RecordingsSide } from './recordings/side';
import { validId } from './recordings/names';
import { logger, setLogLevel, withoutQuery } from './log';
import { Storage } from './storage';
import { AuditLog, cut, maskPath } from './audit/audit-log';
import { IpCap, RefusalThrottle } from './audit/throttle';
import { activityDaily, DailyAudit, storageMessage } from './audit/daily';
import { InventoryRunner } from './inventory/runner';
import { stillsCheck } from './inventory/stills';
import { clipsCheck } from './inventory/clips';
import { clipsRepair } from './inventory/repair-clips';
import { eventsCheck } from './inventory/events';
import { eventsRepair } from './inventory/repair-events';
import type { StillsSide } from './api/client-api';
import { StreamLog, type StreamMessage } from './stream/log';
import { AnalyticsService, CHECK_USAGE } from './analytics/service';
import { sseHandler } from './stream/sse';
import { clientIp, refuseTokenInUrl, requireAccess, type AccessDeps } from './api/auth';
import { clientApi } from './api/client-api';
import { stillChecksApi } from './api/still-checks-api';
import { auditApi, controlApi, sessionRoutes } from './api/control-api';
import { createMetrics } from './api/metrics';
import { createSessionSigner } from './api/session';
import { createLoginLinks } from './api/login-links';
import { composeApi, hasAudio } from './api/compose-api';
import { createComposer, ffmpegRunner } from './compose/jobs';
import { clockText, defaultFont } from './compose/ffmpeg';
import { HostMonitor, type StatFs } from './health/host';
import { buildHealth, type HealthSummary, type LastInventory } from './health/summary';
import { localApi } from './api/local-api';
import { archiveApi } from './api/archive-api';
import { Archive } from './archive/service';
import { discover } from './camera/discovery';

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
  readonly cameras: CameraRegistry;
  readonly analytics: AnalyticsService;
  storage: Storage;
  readonly audit: AuditLog;
  readonly inventory: InventoryRunner;
  readonly archive: Archive;
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
  // The host figures (spec 2026-10-03-health-summary-design): where /proc and
  // /sys are ('/'; tests and e2e point at a fixture tree), the data volume's
  // statfs, and how often they are read (1 min).
  host?: { root?: string; statfs?: StatFs; everyMs?: number };
  // Find camera's probe (spec 2026-10-04-pi-config-design §3): tests and
  // e2e send it to a fake on 127.0.0.1 instead of the multicast group.
  discovery?: { target?: { address: string; port: number }; timeoutMs?: number };
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
  for (const id of cameraIds(running)) {
    for (const e of closeAllOpen(catalog, id, last.ts ?? Date.now(), 'restart')) {
      log.append(e.cam, 'camera-event', { eventId: e.id, kind: e.kind, phase: 'end', ts: e.end_ts, source: e.source, reason: 'restart' });
    }
  }

  // Vision usage counted before several cameras gets its camera (spec 2026-10-05-multi-camera-host-design §5.1, Ruling P1-7).
  adoptLegacyUsage(catalog, cameraIds(running));
  const sse = sseHandler(log, running.sse);
  // The audit log (spec 2026-10-01-audit-log-design): daily JSON-lines files.
  const audit = new AuditLog({ dir: join(running.server.dataDir, 'audit'), version: VERSION });
  // A recording being read is never deleted (set once the recordings side exists).
  let recordingBusy: (path: string) => boolean = () => false;
  const storage = new Storage({ catalog, log, config: () => running, audit, recordingsBusy: (p) => recordingBusy(p) });
  storage.recount();
  const sessions = createSessionSigner(opts.sessionSecret);
  const links = createLoginLinks();
  // The camera workers (spec 2026-10-05-multi-camera-host-design §3.1), in config order.
  const cams = new CameraRegistry(() => cameraIds(running));
  // A camera's stills; stills may be off (or not built yet), the camera gone: no still, an empty list.
  const stillAt = (cam: string, ts: number) => cams.get(cam)?.readStill(ts) ?? Promise.resolve(undefined);
  const stillsIn = (cam: string, from: number, to: number) => cams.get(cam)?.listStills(from, to) ?? [];
  // Composed clips (spec 2026-09-28): one encoding at a time; abandoned and
  // old jobs are swept every 5 s.
  const font = running.composition?.font ?? defaultFont();
  const composer = createComposer({
    dir: join(running.server.dataDir, 'compositions'),
    runner: ffmpegRunner({ font: font ?? '', clock: clockText, readStill: stillAt, hasAudio, paused: () => storage.paused(), stillsIntervalS: (cam) => cameraConfig(running, cam)?.stills.intervalS ?? running.stills.intervalS }),
  });
  const sweeper = setInterval(() => composer.sweep(), 5000);
  sweeper.unref();


  // What camera-ftp-setup writes for a camera (never logged: it has the password).
  const ftpTargetFor = (id: string) => (): FtpTarget => {
    const c = cameraConfig(running, id)!;
    return { server: running.ftp.publicHost ?? '', port: running.ftp.port, user: c.ftp.user, password: loaded.secrets.ftpPassword ?? '', tls: running.ftp.tls, stream: c.ftp.stream };
  };
  const makeWorker = (id: string, index: number) =>
      new CameraWorker({
        id,
        index,
        running: () => running,
        password: () => loaded.secrets.cameraPassword,
        poeSwitchPassword: () => loaded.secrets.poeSwitchPassword,
        ftpTarget: ftpTargetFor(id),
        catalog,
        log,
        sse,
        storage,
        audit,
        // Each camera's counters under its id (bound late: metrics is made once the workers exist).
        hooks: { onCameraCheck: (c) => metrics.onCameraCheck(id, c), onResubscribe: () => metrics.onResubscribe(id), onStill: (ts) => metrics.onStill(id, ts), onStillMissing: () => metrics.onStillMissing(id), onRecordingDownload: (o) => metrics.onRecordingDownload(id, o) },
        cameraFtpCheckMs: opts.cameraFtpCheckMs,
      });
  cameraIds(running).forEach((id, index) => cams.add(makeWorker(id, index)));
  const metrics = createMetrics({
    storage,
    config: () => running,
    catalog,
    log,
    cameras: () =>
      cams.list().map((w) => ({ id: w.id, up: w.status.state().online, ftpEnabled: w.cam().ftp.enabled ? w.ftpWatch.view().enable : null, clips: w.clipsHealth(), onvifSubscribed: w.intake.state().onvif === 'subscribed', stills: w.stills })),
    sseClients: () => sse.clients(),
    version: VERSION,
    target: TARGET,
  });
  storage.on('run', metrics.onRetention);
  recordingBusy = (p) => cams.list().some((w) => w.recordings.cache.busy(p));
  // The FTP server (host-wide): uploads go to the one camera with FTP on (Ruling P1-2).
  let clips: ReturnType<typeof createClipsSide> | undefined;
  const ftpCamera = () => cams.list().find((w) => w.cam().ftp.enabled);
  const buildClips = () => {
    clips = undefined;
    const w = ftpCamera();
    if (!w) return;
    if (!loaded.secrets.ftpPassword) return void logger.error('ftp_enabled_without_password');
    const indexer = w.makeIndexer(true);
    // Pictures stored before they were paired by time (2026-09-30).
    try {
      indexer.relinkSnapshots();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'snapshots_relink_failed');
    }
    clips = createClipsSide({ config: running, user: w.cam().ftp.user, password: loaded.secrets.ftpPassword, indexer, accept: () => !storage.paused() });
  };
  buildClips();
  const startClips = async () => {
    try {
      await clips?.start();
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'ftp_start_failed');
    }
  };

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
    for (const f of readdirSync(repairTmp)) rmSync(join(repairTmp, f), { force: true, recursive: true });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'inventory_tmp_cleanup_failed');
  }
  const worker = (cam: string) => {
    const w = cams.get(cam);
    if (!w) throw new Error(`camera ${cam} is not configured`);
    return w;
  };
  const camSettings = (cam: string) => {
    const c = cameraConfig(running, cam);
    if (!c) throw new Error(`camera ${cam} is not configured`);
    return c;
  };
  const cameraList = (cam: string) => ({ list: worker(cam).recordings.list, timeInfo: () => worker(cam).client.timeInfo() });
  const eventsDeps = {
    catalog,
    settings: (cam: string) => ({ cam, eventsDays: running.retention.eventsDays, stream: camSettings(cam).ftp.stream, eventMaxOpenMin: running.events.maxOpenMin }),
    camera: cameraList,
  };
  // One runner for every camera; each run names its camera (spec 2026-10-05-multi-camera-host-design §3.1).
  const inventory = new InventoryRunner({
    dir: inventoryDir,
    audit,
    checks: {
      stills: {
        label: 'Stills',
        run: stillsCheck({
          dataDir: running.server.dataDir,
          audit,
          catalog,
          settings: (cam) => ({ cam, intervalS: camSettings(cam).stills.intervalS, stillsDays: running.retention.stillsDays, previewsDays: running.retention.previewsDays, keepHours: running.storage.keepHours.stills, enabled: camSettings(cam).stills.enabled }),
        }),
      },
      clips: {
        label: 'Clips',
        camera: true,
        run: clipsCheck({
          dataDir: running.server.dataDir,
          catalog,
          audit,
          settings: (cam) => ({ cam, clipsDays: running.retention.clipsDays, stream: camSettings(cam).ftp.stream, ftpEnabled: camSettings(cam).ftp.enabled, eventMaxOpenMin: running.events.maxOpenMin }),
          camera: cameraList,
        }),
        repair: clipsRepair({
          catalog,
          settings: (cam) => ({ cam, stream: camSettings(cam).ftp.stream, clipsDays: running.retention.clipsDays, maxGB: running.ftp.maxGB }),
          list: (cam) => worker(cam).recordings.list,
          fetcher: (cam) => worker(cam).recordings.fetcher,
          cache: (cam) => worker(cam).recordings.cache,
          indexer: (cam) => worker(cam).makeIndexer(false),
          tempDir: () => repairTmp,
          paused: () => storage.paused(),
          clipsBytes: () => storage.usage().clips.bytes,
        }),
      },
      // #75: always against the camera (no local-only part); its repair adds
      // recovered events, never sent over SSE or the stream log.
      events: {
        label: 'Events',
        run: eventsCheck(eventsDeps),
        repair: eventsRepair(eventsDeps),
      },
    },
  });

  // External analytics: event stills to the provider, within its limits.
  const timeInfo = () => cams.first().timeInfo();
  const analytics = new AnalyticsService({
    catalog, log, dataDir: running.server.dataDir,
    // Read on use: restart() can change the cameras.
    cams: () => cams.ids(),
    kinds: (cam) => cameraConfig(running, cam)?.analytics.kinds ?? running.analytics.kinds,
    config: () => running,
    secrets: () => ({ googleVisionKey: loaded.secrets.googleVisionKey, googleVisionUrl: loaded.secrets.googleVisionUrl }),
    readStill: stillAt,
    listStills: stillsIn,
    timeInfo,
    audit,
  });
  // The Archive (spec 2026-10-05-archive-design): clips kept apart from
  // retention in <dataDir>/archive, with their own daily cleanup.
  const archive = new Archive({
    dataDir: running.server.dataDir,
    catalog,
    log,
    audit,
    config: () => running,
    disk: () => storage.diskSpace(),
    timeInfo,
    cameraName: (cam) => cams.get(cam)?.name() ?? cam,
    cameraModel: (cam) => cams.get(cam)?.status.state().model ?? null,
    version: VERSION,
    stillsIn,
    readStill: stillAt,
  });

  // Every camera-event start goes to the service (it filters by kind).
  log.on('message', (m: StreamMessage) => {
    if (m.type === 'camera-event' && m.data.phase === 'start') analytics.onEvent({ cam: m.cam, id: Number(m.data.eventId), kind: String(m.data.kind), start_ts: Number(m.data.ts) });
  });

  // The daily audit records at 00:05 camera time: storage now, activity of the previous camera day.
  const daily = new DailyAudit({
    audit,
    timeInfo,
    storage: () => {
      const u = storage.usage();
      const clipRows = countAllClips(catalog);
      return {
        message: storageMessage({ used: u.used, budget: u.budget, stillMinutes: u.stills.files, clipRows, daysUntilFull: u.daysUntilFull }),
        details: { size: u.size, free: u.free, budget: u.budget, used: u.used, daysUntilFull: u.daysUntilFull, kinds: { stills: u.stills, previews: u.previews, clips: u.clips, recordings: u.recordings, catalog: u.catalog, audit: u.audit }, clipRows },
      };
    },
    activity: (day, from, to) => {
      const sum = (rs: Record<string, number>[]) =>
        rs.reduce<Record<string, number>>((a, r) => {
          for (const [k, n] of Object.entries(r)) a[k] = (a[k] ?? 0) + n;
          return a;
        }, {});
      // Every camera's counts, summed (spec 2026-10-05-multi-camera-host-design §5.2).
      const per = cams.ids().map((cam) => ({ cam, events: countEventsByKind(catalog, cam, from, to), recovered: countRecoveredEvents(catalog, cam, from, to), clips: countClips(catalog, cam, from, to), analyses: countAnalysesByStatus(catalog, cam, from, to) }));
      // Usage days are camera days (localDay); month to date as of the reported day.
      const checkCounts = (d: string) => {
        const n = (p: string) => usageBetween(catalog, p, d, d);
        return { calls: n(CHECK_USAGE.calls), reused: n(CHECK_USAGE.reused), refused: n(CHECK_USAGE.refused), failed: n(CHECK_USAGE.failed) };
      };
      const vision = { day: usageBetween(catalog, 'google-vision', day, day), monthToDate: usageBetween(catalog, 'google-vision', `${day.slice(0, 7)}-01`, day), monthlyLimit: running.analytics.googleVision.monthlyLimit };
      const a = activityDaily(day, { events: sum(per.map((p) => p.events)), recovered: per.reduce((n, p) => n + p.recovered, 0), clips: per.reduce((n, p) => n + p.clips, 0), vision, analyses: sum(per.map((p) => p.analyses)), checks: checkCounts(day), sseClients: sse.clients() });
      if (per.length < 2) return a; // one camera: the record as before
      const visionBy = usageByCamera(catalog, 'google-vision', day, day);
      return { ...a, details: { ...a.details, cameras: Object.fromEntries(per.map((p) => [p.cam, { events: p.events, recovered: p.recovered, clips: p.clips, analyses: p.analyses, vision: visionBy[p.cam] ?? 0 }])) } };
    },
  });

  // Copies the loaded settings into `running`, except those `keep` holds back.
  const applySettings = (keep: (path: string) => boolean) => {
    for (const p of leafPaths()) if (!keep(p)) setPath(running as unknown as Record<string, unknown>, p, structuredClone(getPath(loaded.config, p)));
  };
  // New settings from the control API: live ones take effect now.
  const setLoaded = (next: Loaded) => {
    const analyticsBefore = JSON.stringify(loaded.config.analytics);
    const before = new Map(cams.list().map((w) => [w.id, w.cam()]));
    loaded = next;
    applySettings(needsRestart);
    for (const w of cams.list()) w.settingsChanged(before.get(w.id)!);
    sse.setOptions(running.sse);
    setLogLevel(running.server.logLevel);
    // Only a change to the analytics settings lifts a bad_key pause.
    if (JSON.stringify(next.config.analytics) !== analyticsBefore) analytics.settingsChanged();
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
  const ftpStatus = () => ({
    enabled: running.ftp.enabled,
    listening: clips?.side.listening() ?? false,
    port: running.ftp.port,
    tls: running.ftp.tls,
    publicHost: running.ftp.publicHost ?? null,
    passwordSet: !!loaded.secrets.ftpPassword,
    lastUpload: clips?.side.lastUpload() ?? null,
    lastClip: clips?.side.indexer.lastIndexed() ?? null,
    clips: countAllClips(catalog),
    failures: (clips?.side.uploadFailures() ?? 0) + (clips?.side.indexer.failures() ?? 0),
    camera: running.ftp.enabled ? cams.first().ftpWatch.view() : null,
    stalled: cams.first().clipsHealth(),
  });
  const streamStatus = () => cams.first().streamStatus();

  // The health summary (spec 2026-10-03-health-summary-design): the host
  // figures once a minute, the rest as it is now; thresholds read on use.
  const hostMonitor = new HostMonitor({
    paths: { root: opts.host?.root ?? '/' },
    dataDir: () => running.server.dataDir,
    setting: () => running.host.stats,
    statfs: opts.host?.statfs,
    everyMs: opts.host?.everyMs,
  });
  // The newest finished inventory, a check or a repair of any kind.
  const lastInventory = async (): Promise<LastInventory | null> => {
    let last: LastInventory | null = null;
    const [checks, repairs] = await Promise.all([inventory.list(), inventory.listRepairs()]);
    for (const [op, runs] of [['check', checks], ['repair', repairs]] as const) {
      for (const r of Object.values(runs).flat()) {
        if (!last || r.startedAt > last.startedAt) last = { kind: r.kind, op, outcome: r.outcome, startedAt: r.startedAt, message: r.message };
      }
    }
    return last;
  };
  const healthNow = async (): Promise<HealthSummary> => {
    const w = cams.first();
    const ps = w.cam().poeSwitch;
    return buildHealth({
      now: Date.now(),
      version: VERSION,
      startedAt,
      thresholds: { diskPercent: running.health.diskPercent, tempC: running.health.tempC, ftpStalledHours: running.ftp.stalledHours, ...(running.archive.enabled ? { archiveWarnPercent: running.archive.warnPercent } : {}) },
      camera: { id: w.id, name: w.name(), host: w.cam().host, state: w.status.state(), reboot: w.reboot.state()?.phase ?? null, poeSwitch: ps.model === 'none' ? null : { model: ps.model, port: ps.port ?? null } },
      stream: streamStatus(),
      intake: w.intake.state(),
      ftp: ftpStatus(),
      storage: { paused: storage.paused(), lastRun: storage.lastRun() },
      recordingsCache: w.recordings.status().cache,
      sseClients: sse.clients(),
      lastInventory: await lastInventory(),
      reading: hostMonitor.reading(),
      archive: archive.health(),
    });
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
  const IMAGE = /^\/api\/cameras\/[^/]+\/((stills|previews)\/\d{1,15}\.jpg|clips\/\d{1,15}\.(mp4|jpg)|events\/\d{1,15}\/analysis\.jpg|still-checks\/\d{1,12}\.jpg)$|^\/api\/archive\/\d{1,15}\/(video|thumbnail)$/;
  const RECORDING = /^\/api\/cameras\/[^/]+\/recordings\/(Rec[0-9A-Za-z_]+\.mp4)$/;
  const isImage = (req: Request) => {
    if (req.method !== 'GET') return false;
    if (IMAGE.test(req.path)) return true;
    const id = RECORDING.exec(req.path)?.[1];
    return id !== undefined && validId(id) && cams.list().some((w) => w.recordings.cache.has(id));
  };
  // Behind an ingress (issue #29): client addresses from X-Forwarded-For.
  if (running.server.trustProxy) app.set('trust proxy', running.server.trustProxy);
  const limiter = (limit: number, skip: (req: Request) => boolean) => rateLimit({ windowMs: 60_000, limit, skip, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited' } });
  app.use(limiter(1200, isImage));
  // Images: 6000 per minute per camera (a timeline per camera loads its own sprites; spec §6.1, Ruling P1-16).
  app.use(rateLimit({ windowMs: 60_000, limit: () => 6000 * Math.max(1, cams.size), skip: (req) => !isImage(req), standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited' } }));
  app.use(express.json({ limit: '64kb' }));
  // startedAt tells a new process apart (the Maintenance page's restart waits for it).
  app.get('/health', (_req, res) => void res.json({ ok: true, version: VERSION, startedAt }));
  app.get('/metrics', async (_req, res) => {
    res.type(metrics.registry.contentType).send(await metrics.render());
  });
  // Tokens never travel in URLs: checked once per request, before any access
  // check and before the session routes (the login link carries ?code=).
  app.use(['/api', '/control'], refuseTokenInUrl);
  // The health summary for the display on the Pi: loopback callers only, no
  // key; anyone else goes on to the access check as for an unknown route.
  app.use('/api', localApi({ health: healthNow }));
  app.use('/control', sessionRoutes({ adminToken: access.adminToken, sessions, links, audit }));
  app.use('/api', requireAccess('client', access), composeApi({ config: () => running, catalog, composer, cameras: cams, paused: () => storage.paused(), font, audit }));
  app.use('/api', requireAccess('client', access), stillChecksApi({ config: () => running, catalog, cameras: cams, analytics, audit }));
  app.use('/api', requireAccess('client', access), archiveApi({ config: () => running, catalog, archive, composer, cameras: cams }));
  app.use('/api', requireAccess('client', access), clientApi({ config: () => running, catalog, cameras: cams, sse }));
  // The audit log: admins and the audit token, GET (and HEAD) only. The access check is
  // on the route inside the router; other /control paths pass on untouched
  // to the admin-only routes below.
  app.use('/control', auditApi({ audit, guard: requireAccess('audit-read', access), retentionDays: () => running.retention.auditDays }));
  app.use(
    '/control',
    requireAccess('admin', access),
    controlApi({
      loaded: () => loaded,
      setLoaded,
      running: () => running,
      catalog,
      log,
      camera: () => {
        const w = cams.first();
        return { ...w.status.state(), name: w.name(), nameSource: w.nameSource(), webUiUrl: cameraWebUi(w.cam()), reboot: w.reboot.state(), poeSwitch: w.poeSwitch.status() };
      },
      // Writes through to the camera and reads back; the poller (and so the
      // stream message) knows the new name at once.
      cameraName: {
        current: () => cams.first().name(),
        write: (name) => cams.first().writeName(name),
      },
      checkCamera: () => cams.first().status.checkNow(),
      intake: () => cams.first().intake.state(),
      resubscribe: () => cams.first().intake.resubscribe(),
      restart: () => proxy.restart(),
      cameraReboot: (who) => cams.first().reboot.request(who),
      poeSwitch: { notConfigured: () => cams.first().poeSwitch.notConfigured(), read: () => cams.first().poeSwitch.read(), poeOn: () => cams.first().poeSwitch.poeOn(), info: () => cams.first().poeSwitchInfo() },
      cameraPowerCycle: (who) => {
        const w = cams.first();
        return w.reboot.powerCycle(who, { switch: w.poeSwitchInfo(), offSeconds: w.cam().poeSwitch.offSeconds }, (onOff) => w.poeSwitch.cycle(onOff));
      },
      restartProcess: () => {
        processRestart ??= restartProcess({
          stop: () => proxy.stop({ reason: 'restart-requested' }),
          exit: opts.exit ?? ((code) => logger.warn({ code }, 'cam_proxy_exit_not_wired')),
          timeoutMs: opts.restartTimeoutMs,
        });
      },
      ftp: ftpStatus,
      health: healthNow,
      // The camera's answer goes to the FTP check at once (#93).
      cameraFtp: {
        target: () => ftpTargetFor(cams.first().id)(),
        setup: async (t) => {
          const w = cams.first();
          const f = await setupCameraFtp(w.client, t);
          w.ftpWatch.note(f);
          return f;
        },
        test: (t) => testCameraFtp(cams.first().client, t),
        off: async () => {
          const w = cams.first();
          const f = await cameraFtpOff(w.client, ftpTargetFor(w.id)());
          w.ftpWatch.note(f);
          return f;
        },
      },
      storage,
      audit,
      analytics: () => analytics.state(),
      setVisionKey: (key) => analytics.setManualKey(key),
      unmapped: { list: (limit) => listUnmapped(catalog, limit), clear: () => clearUnmapped(catalog) },
      sseClients: () => sse.clients(),
      recordings: () => cams.first().recordings.status(),
      inventory,
      stream: streamStatus,
      sessions,
      links,
      version: VERSION,
      findCamera: () => discover(opts.discovery ?? {}),
      envFile: () => loaded.env.CAMPROXY_ENV_FILE || undefined,
      archive,
      inventoryCamera: () => (cams.size === 1 ? cams.first().id : null),
      cameraId: () => cams.first().id,
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
  // A camera whose id is no longer configured (a changed camera.id) stops
  // for good before the settings change under it; a new id gets a new worker.
  const restartCameraSide = async () => {
    await clips?.stop();
    const nextIds = cameraIds(loaded.config);
    const gone = cams.list().filter((w) => !nextIds.includes(w.id));
    for (const w of gone) {
      await w.stopSwitch();
      await w.stopRecordings();
      await w.stop();
      cams.remove(w.id);
    }
    applySettings(needsProcessRestart);
    const kept = cams.list();
    const added = cameraIds(running).flatMap((id, index) => (cams.get(id) ? [] : [makeWorker(id, index)]));
    for (const w of added) cams.add(w);
    await Promise.all([...kept.map((w) => w.restart()), ...added.map((w) => w.start())]);
    buildClips();
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
      return cams.first().status;
    },
    get intake() {
      return cams.first().intake;
    },
    sse,
    storage,
    audit,
    inventory,
    archive,
    get stills() {
      return cams.first().stills;
    },
    get clips() {
      return clips?.side;
    },
    get recordings() {
      return cams.first().recordings;
    },
    cameras: cams,
    analytics,
    async start(opts = {}) {
      server = http.createServer(app);
      const s = server;
      const port = await new Promise<number>((resolve, reject) => {
        s.once('error', reject);
        s.listen(opts.port ?? running.server.port, opts.host ?? '0.0.0.0', () => resolve((s.address() as AddressInfo).port));
      });
      await Promise.all(cams.list().map((w) => w.start()));
      await startClips();
      hostMonitor.start();
      storage.start();
      archive.start();
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
      audit.write({ action: 'proxy-start', category: ['process'], type: ['start'], outcome: 'success', user: 'system', message: `cam-proxy ${VERSION} started`, details: { config: { camera: cams.first().id, cameras: cams.ids(), stills: running.stills.enabled, ftp: running.ftp.enabled, analytics: running.analytics.googleVision.enabled }, previousStop, uncleanStop } });
      daily.start();
      startedAt = Date.now();
      logger.info({ port, cameras: cams.ids(), version: VERSION }, 'cam_proxy_started');
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
      hostMonitor.stop();
      // First, while everything is still open.
      audit.write({ action: 'proxy-stop', category: ['process'], type: ['end'], outcome: 'success', user: 'system', message: `cam-proxy stopping${opts.reason ? ` (${opts.reason})` : ''}`, details: { reason: opts.reason ?? 'stop' } });
      // Each camera's PoE back on if a power-cycle is in its off time.
      await Promise.all(cams.list().map((w) => w.stopSwitch()));
      await restarting;
      clearInterval(sweeper);
      sse.closeAll();
      storage.stop();
      // Side by side, within a container's stop grace (compose.yaml: 20 s):
      // a running encode ends (up to 3 s), and a Vision call in flight is
      // stored before the catalog closes (up to its 10 s timeout).
      // A recording download is aborted (cmd 9) and the Baichuan session closed (up to 2 s).
      // A running inventory is cancelled ('stop'), saved and audited before the catalog closes.
      // An archive job in flight is cancelled (its staged folder removed) before the catalog closes.
      await Promise.all([composer.stop(), analytics.stop(), archive.stop(), ...cams.list().map((w) => w.stopRecordings()), inventory.stop()]);
      const s = server;
      if (s) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
      await clips?.stop();
      await Promise.all(cams.list().map((w) => w.stop()));
      catalog.close();
  }
  return proxy;
}
