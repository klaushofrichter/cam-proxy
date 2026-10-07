import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import https from 'https';
import type { AddressInfo } from 'net';
import { join } from 'path';
import { createHash } from 'crypto';
import { openCatalog, type Catalog } from './catalog/db';
import { adoptLegacyUsage, usageByCamera, clearUnmapped, countAnalysesByStatus, listUnmapped, usageBetween } from './catalog/analyses';
import { countAllClips, countClips } from './catalog/clips';
import { closeAllOpen, countEventsByKind, countRecoveredEvents, openEvents } from './catalog/events';
import { bareHost, splitHost } from './camera/http';
import { ReolinkClient } from './camera/client';
import { localOffsetMinutes } from './analytics/local-day';
import { tlsApi } from './api/tls-api';
import { CaError, siteCa, writeSecret, type SiteCa } from './tls/ca';
import { CameraCerts, RotateBusyError, type TlsView } from './tls/camera-certs';
import { issuedBy, issueLeaf, leafOf, renewalDue, type Leaf } from './tls/leaf';
import { pushCertificate } from './tls/push';
import { servedCertificate, type Served } from './tls/served';
import type { CameraTrust } from './camera/client';
import type { StatusPoller } from './camera/status';
import type { EventIntake } from './events/intake';
import { CameraRegistry } from './cameras/registry';
import { CameraWorker, cameraWebUi } from './cameras/worker';
import { cameraConfig, cameraIds } from './config/cameras';
import { cameraPassword } from './config/secrets';
import { reapOrphanGo2rtc } from './stills/orphans';
import { Go2rtc } from './stills/go2rtc';
import { latestApi } from './api/latest-api';
import { CachePool } from './recordings/pool';
import { PoeSwitch } from './camera/poe-switch';
import { restartProcess } from './process-restart';
import type { Config } from './config/defaults';
import { applyOverrides, configRevision, getPath, needsProcessRestart, needsRestart, removeOverride, setPath, settingPaths, type Loaded } from './config/load';
import { cameraFtpOff, setupCameraFtp, testCameraFtp, type FtpTarget } from './clips/camera-ftp';
import { createClipsSide, ftpUsers, type ClipsSide } from './clips/side';
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
import { auditApi, controlApi, sessionRoutes, type ControlDeps } from './api/control-api';
import type { ActionDeps } from './api/actions';
import { createMetrics } from './api/metrics';
import { createSessionSigner } from './api/session';
import { createLoginLinks } from './api/login-links';
import { TokenStore } from './fleet/token-store';
import { CommandPolicy } from './fleet/policy';
import { Journal } from './fleet/journal';
import { OverridesBackups } from './fleet/backups';
import { configHandlers, type ConfigCommandDeps } from './fleet/config-commands';
import { cameraHandlers } from './fleet/camera-commands';
import { CommandRunner, type Handler } from './fleet/commands';
import { ReplayGuard } from './fleet/replay';
import { privateFileHooks, tightenAdminFiles } from './fleet/private-file';
import { composeApi, hasAudio } from './api/compose-api';
import { createComposer, ffmpegRunner } from './compose/jobs';
import { clockText, defaultFont } from './compose/ffmpeg';
import { HostMonitor, type StatFs } from './health/host';
import { buildHealth, type CameraHealthInput, type HealthSummary, type LastInventory } from './health/summary';
import { localApi } from './api/local-api';
import { archiveApi } from './api/archive-api';
import { Archive } from './archive/service';
import { discover } from './camera/discovery';
import { CamsAdmin } from './fleet/service';
import { camsAdminApi } from './api/cams-admin-api';
import type { Timing } from './fleet/client';
import { CONFIG_SCHEMA } from './config/schema';

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
  // The camera certificates of the site CA (spec §10.1.3); undefined without tls.site (the Pi). Test seam: tick().
  readonly certs: CameraCerts | undefined;
  // cams-admin (spec 2026-10-06-cams-admin-phase1-design §9): off unless camsAdmin.url is set.
  readonly camsAdmin: CamsAdmin;
  // The control actions' dependencies (performAction; the route and cams-admin's camera.action share them).
  readonly actions: ActionDeps;
  go2rtcPid(): number | undefined;
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
  // The certificate push's waits (10 s after a clear, up to 90 s for the new
  // certificate, polled every 5 s); tests shorten them against cam-sim.
  tlsPush?: { clearWaitMs?: number; verifyMs?: number; pollMs?: number };
  // The cams-admin client's waits (tests shorten them).
  camsAdmin?: { timing?: Partial<Timing>; replaySlackMs?: number; recheckMs?: number };
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
    concurrent: () => running.composition.concurrent,
    runner: ffmpegRunner({ font: font ?? '', clock: clockText, readStill: stillAt, hasAudio, paused: () => storage.paused(), stillsIntervalS: (cam) => cameraConfig(running, cam)?.stills.intervalS ?? running.stills.intervalS }),
  });
  const sweeper = setInterval(() => composer.sweep(), 5000);
  sweeper.unref();

  // The site CA (spec 2026-10-05-multi-camera-host-design §10): only with
  // tls.site (the Pi has none and runs exactly as before). Loaded in start()
  // (RSA generation is async); a CA that can't be loaded leaves the proxy on
  // HTTP with the problem in the health item (Review Focus 3).
  const tlsDir = join(running.server.dataDir, 'tls');
  let ca: SiteCa | null = null;
  let caProblem: string | null = null;
  let proxyLeaf: Leaf | null = null;
  let httpsServer: https.Server | undefined;
  let certs: CameraCerts | undefined;
  let proxyLeafTimer: NodeJS.Timeout | undefined;
  let caPemOnly: string | null = null; // ca.pem when the CA can't be loaded with its key
  const proxyAddresses = () => (running.tls.proxyAddresses ?? '').split(',').filter(Boolean);
  const proxyName = () => `proxy.${running.tls.site}.internal`;
  const outside = (what: string) => `${what} is outside the site CA: rotate the CA (tls-ca-rotate)`;
  // What the CA doesn't cover of the proxy's own names (Review Focus 2): named, never a silent bad leaf.
  const tlsProblems = (): string[] => [
    ...(caProblem ? [caProblem] : []),
    ...(!running.tls.site && certs ? ['tls.site is not set: the cameras keep their site-CA trust (camera-trust-clear drops it)'] : []),
    ...(certs ? certs.problems() : []),
    ...(ca ? [...proxyAddresses().filter((a) => !ca!.covers(a)), ...(ca.coversName(proxyName()) ? [] : [proxyName()])].map(outside) : []),
    // A camera's own (an address outside the CA, a failed push), named.
    ...(certs ? cams.ids().flatMap((id) => { const p = certs!.state(id).problem; return p ? [p.startsWith(`${id} `) || p.startsWith(`${id}:`) ? p : `${id}: ${p}`] : []; }) : []),
  ];
  // The proxy's own leaf: <dataDir>/tls/proxy.crt|key, issued anew when
  // missing, from another CA, for other addresses, or due for renewal.
  const ensureProxyLeaf = async (c: SiteCa): Promise<Leaf | null> => {
    const name = proxyName();
    if (!c.coversName(name)) return null;
    const ips = proxyAddresses().filter((a) => c.covers(a));
    const crt = join(tlsDir, 'proxy.crt');
    const key = join(tlsDir, 'proxy.key');
    let l: Leaf | null = null;
    try {
      if (existsSync(crt) && existsSync(key)) l = leafOf(readFileSync(crt, 'utf8'), readFileSync(key, 'utf8'));
    } catch {
      l = null;
    }
    const same = l && issuedBy(l, c) && !renewalDue(l, Date.now()) && l.names.join() === name && [...l.ips].sort().join() === [...ips].sort().join();
    if (l && same) return l;
    l = await issueLeaf(c, { cn: name, dns: [name], ips, keyFormat: 'pkcs8' });
    writeSecret(key, l.keyPem);
    writeFileSync(crt, l.certPem, { mode: 0o644 });
    logger.info({ fingerprint: l.fingerprint, notAfter: new Date(l.notAfter).toISOString() }, 'proxy_certificate_issued');
    return l;
  };
  const renewProxyLeaf = async (): Promise<void> => {
    if (!ca) return;
    const before = proxyLeaf?.fingerprint;
    proxyLeaf = await ensureProxyLeaf(ca);
    if (proxyLeaf && proxyLeaf.fingerprint !== before) httpsServer?.setSecureContext({ cert: proxyLeaf.certPem, key: proxyLeaf.keyPem });
  };
  const servedOf = (id: string) => {
    const c = cameraConfig(running, id);
    if (!c) return Promise.resolve(null);
    const { hostname, port } = splitHost(c.host);
    return servedCertificate(bareHost(hostname), port ?? 443);
  };
  // A camera's trust for its client (security review of #178): site-ca → the
  // CAs (current, and the previous one after a rotation) by its .internal
  // name; pinned → the one certificate the proxy pinned; else none (a camera
  // never seen serving anything of ours, as before P5).
  const tlsFor = (id: string): CameraTrust | undefined => {
    const st = certs?.state(id);
    if (st?.mode === 'site-ca') {
      // Never unverified: the CAs, else the camera's stored leaf as a pin, else nothing at all.
      const cas = certs!.trustedCas(id);
      if (cas.length && st.servername) return { ca: cas.join('\n'), servername: st.servername };
      const leaf = certs!.leaf(id);
      if (leaf) return { ca: leaf.certPem, fingerprint: leaf.fingerprint };
      return { refuse: 'its site-CA trust is not available (no CA certificate and no stored leaf)' };
    }
    const pin = certs?.pin(id);
    if (pin) return { ca: pin.pem, fingerprint: pin.fingerprint };
    // A camera that once served our leaf, now neither site-ca nor pinned (protocol switched, state lost): refused, never unverified.
    if (certs?.everServed(id)) return { refuse: 'it served a site-CA leaf before: Push now, or camera-trust-clear' };
    return undefined;
  };
  const makeCerts = () =>
    new CameraCerts({
      dir: tlsDir,
      ca: () => ca,
      caPem: () => caPemOnly,
      site: () => running.tls.site,
      enabled: () => running.tls.cameraCerts,
      cameras: () =>
        cams.list().flatMap((w) => {
          const c = w.cam();
          const address = bareHost(splitHost(c.host).hostname);
          return address ? [{ id: w.id, address, protocol: c.protocol, ...(c.tlsName ? { tlsName: c.tlsName } : {}) }] : [];
        }),
      served: servedOf,
      // The push's own session, not the worker's (the camera serves its factory
      // certificate between the clear and the import). Bound to the
      // certificate read just before every step (security review of #178): a
      // leaf of ours → the CAs, its name and its fingerprint; anything else →
      // pinned to exactly that certificate (trust on first use, per attempt).
      push: (id, issue, po) => {
        const c = cameraConfig(running, id)!;
        const name = `${id}.${running.tls.site}.internal`;
        const client = new ReolinkClient({ id, host: c.host, protocol: c.protocol, user: c.user, password: cameraPassword(loaded.secrets, id) });
        const bind = (sv: Served) => {
          const cas = certs!.trustedCas();
          const oursNow = cas.some((p) => issuedBy({ certPem: sv.pem }, { certPem: p }));
          client.setTrust(oursNow ? { ca: cas.join('\n'), servername: name, fingerprint: sv.fingerprint } : { ca: sv.pem, fingerprint: sv.fingerprint });
          client.forgetToken();
        };
        return pushCertificate({ served: () => servedOf(id), bind, command: (cmd, p) => client.command(cmd, p), relogin: () => client.forgetToken(), logout: () => client.logout() }, issue, { ...opts.tlsPush, ...po });
      },
      openEvent: (id) => openEvents(catalog, id).length > 0,
      localHour: (t, id) => new Date(t + localOffsetMinutes(t, cams.get(id)?.timeInfo()) * 60_000).getUTCHours(),
      onTrust: (id) => cams.get(id)?.applyTrust(),
      audit,
      onPush: (id, outcome) => metrics.onCertPush(id, outcome),
    });
  // Camera trust left from a site CA (tls.site unset later): kept, never dropped to unverified.
  const hasCameraTrust = () => existsSync(join(tlsDir, 'cameras', 'state.json')) || (existsSync(join(tlsDir, 'cameras')) && readdirSync(join(tlsDir, 'cameras')).some((f) => /\.crt(\.old-.*)?$/.test(f)));
  const startSiteCa = async (): Promise<void> => {
    const site = running.tls.site;
    if (!site) {
      if (!hasCameraTrust()) return; // the Pi: nothing
      if (existsSync(join(tlsDir, 'ca.pem'))) caPemOnly = readFileSync(join(tlsDir, 'ca.pem'), 'utf8');
      certs = makeCerts(); // trust only: no scheduler, no pushes
      for (const w of cams.list()) w.applyTrust();
      return;
    }
    try {
      ca = await siteCa(tlsDir, { site, cameraSubnet: running.tls.cameraSubnet!, proxyAddresses: proxyAddresses() });
      caProblem = null;
      proxyLeaf = await ensureProxyLeaf(ca);
    } catch (err) {
      ca = null;
      caProblem = err instanceof CaError ? err.message : `the site CA could not be loaded: ${(err as Error).message}`;
      logger.error({ err: caProblem }, 'site_ca_unavailable');
      // The cameras keep their trust: ca.pem alone (it verifies, it can't issue), else their stored leaves.
      try {
        if (existsSync(join(tlsDir, 'ca.pem'))) caPemOnly = readFileSync(join(tlsDir, 'ca.pem'), 'utf8');
      } catch {
        caPemOnly = null;
      }
    }
    certs ??= makeCerts();
    // The known trust before any worker logs in (no unverified window at start).
    for (const w of cams.list()) w.applyTrust();
    certs.start();
    proxyLeafTimer = setInterval(() => void renewProxyLeaf().catch((err: Error) => logger.warn({ err: err.message }, 'proxy_certificate_renewal_failed')), 86400_000);
    proxyLeafTimer.unref();
  };
  // tls-ca-rotate (Ruling P5-3): the old files kept as *.old-<time>, a new CA,
  // a new proxy leaf, every camera pushed again (from the next tick on).
  let rotating = false;
  const rotateCa = async (): Promise<{ from: string | null; to: string }> => {
    // One at a time: the files move and a new key is made (a second request is refused, not queued).
    if (rotating) throw new RotateBusyError('a CA rotation is running');
    rotating = true;
    try {
      return await rotateNow();
    } catch (err) {
      if (!ca) caProblem = `the site CA rotation failed: ${(err as Error).message}`;
      throw err;
    } finally {
      rotating = false;
    }
  };
  const rotateNow = async (): Promise<{ from: string | null; to: string }> => {
    const site = running.tls.site!;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const from = ca?.fingerprint ?? null;
    const previous = ca?.certPem ?? null;
    for (const f of ['ca.pem', 'ca.key', 'proxy.crt', 'proxy.key']) if (existsSync(join(tlsDir, f))) renameSync(join(tlsDir, f), join(tlsDir, `${f}.old-${stamp}`));
    ca = null;
    ca = await siteCa(tlsDir, { site, cameraSubnet: running.tls.cameraSubnet!, proxyAddresses: proxyAddresses() });
    caProblem = null;
    // The cameras keep the previous CA's trust until each serves a new leaf (pushed automatically).
    certs?.reset(stamp, previous);
    proxyLeaf = await ensureProxyLeaf(ca);
    if (proxyLeaf) httpsServer?.setSecureContext({ cert: proxyLeaf.certPem, key: proxyLeaf.keyPem });
    if (!certs) {
      certs = makeCerts();
      certs.start();
    }
    void certs.tick();
    logger.warn({ from, to: ca.fingerprint }, 'site_ca_rotated');
    return { from, to: ca.fingerprint };
  };
  const tlsView = (): TlsView => ({
    site: running.tls.site ?? null,
    caFingerprint: ca?.fingerprint ?? null,
    caNotAfter: ca?.notAfter ?? null,
    proxy: proxyLeaf ? { servername: proxyName(), fingerprint: proxyLeaf.fingerprint, notAfter: proxyLeaf.notAfter } : null,
    cameras: running.tls.site || certs ? cams.list().map((w) => ({ id: w.id, ...(certs?.state(w.id) ?? { mode: 'none' as const, servername: null, fingerprint: null, notAfter: null, lastPush: null, problem: null }) })) : [],
    problems: running.tls.site || certs ? tlsProblems() : [],
  });


  // What camera-ftp-setup writes for a camera (never logged: it has the password).
  const ftpTargetFor = (id: string) => (): FtpTarget => {
    const c = cameraConfig(running, id)!;
    return { server: running.ftp.publicHost ?? '', port: running.ftp.port, user: c.ftp.user, password: loaded.secrets.ftpPassword ?? '', tls: running.ftp.tls, stream: c.ftp.stream };
  };
  // One go2rtc for every camera with stills (spec 2026-10-05-multi-camera-host-design
  // §8.5), none while stills are off everywhere. Made anew on a restart that
  // changed its settings (go2rtc.*) or turned stills on for the first camera.
  const go2rtcSettings = () => JSON.stringify({ binary: running.go2rtc.binary, rtspPort: running.go2rtc.rtspPort, apiPort: running.go2rtc.apiPort });
  const makeGo2rtc = () =>
    cameraIds(running).some((id) => cameraConfig(running, id)!.stills.enabled)
      ? new Go2rtc({ binary: running.go2rtc.binary, rtspPort: running.go2rtc.rtspPort, apiPort: running.go2rtc.apiPort, sources: () => cams.list().filter((w) => w.cam().stills.enabled).map((w) => w.source()) })
      : undefined;
  let go2rtc = makeGo2rtc();
  let go2rtcMadeWith = go2rtcSettings();
  // Started in the background: each camera's grabber waits until it is up.
  const startGo2rtc = () => void go2rtc?.start().catch((err: Error) => logger.error({ err: err.message }, 'go2rtc_start_failed'));
  // One PoE controller for the host (spec 2026-10-05-multi-camera-host-design §8.4):
  // one switch session at a time, in arrival order; each camera has its port.
  const poe = new PoeSwitch({ config: () => running.poeSwitch, password: () => loaded.secrets.poeSwitchPassword });
  // One recordings cache for every camera (spec §8.3): one LRU, capped by recordings.cacheMB.
  const cachePool = new CachePool(() => running.recordings.cacheMB * 2 ** 20);
  const makeWorker = (id: string) =>
      new CameraWorker({
        id,
        running: () => running,
        go2rtc: () => go2rtc,
        cachePool,
        password: () => cameraPassword(loaded.secrets, id),
        poe,
        ftpTarget: ftpTargetFor(id),
        ftpPassword: () => loaded.secrets.ftpPassword,
        catalog,
        log,
        sse,
        storage,
        audit,
        // Each camera's counters under its id (bound late: metrics is made once the workers exist).
        hooks: { onCameraCheck: (c) => metrics.onCameraCheck(id, c), onResubscribe: () => metrics.onResubscribe(id), onStill: (ts) => metrics.onStill(id, ts), onStillMissing: () => metrics.onStillMissing(id), onRecordingDownload: (o) => metrics.onRecordingDownload(id, o) },
        cameraFtpCheckMs: opts.cameraFtpCheckMs,
        tls: tlsFor,
      });
  cameraIds(running).forEach((id) => cams.add(makeWorker(id)));
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
    // Defined further down; read on a scrape only. Absent while off (the Pi).
    camsAdmin: () => (running.camsAdmin.url ? camsAdmin.view().state : null),
    certs: () => [
      ...(proxyLeaf ? [{ cam: 'proxy', notAfter: proxyLeaf.notAfter }] : []),
      ...(certs ? cams.ids().flatMap((id) => { const st = certs!.state(id); return st.mode === 'site-ca' ? [{ cam: id, notAfter: st.notAfter }] : []; }) : []),
    ],
  });
  storage.on('run', metrics.onRetention);
  recordingBusy = (p) => cams.list().some((w) => w.recordings.cache.busy(p));
  // The FTP server (host-wide, spec 2026-10-05-multi-camera-host-design §7):
  // one for every camera with FTP on, a user each; a login from another
  // address than the camera's is refused and audited (throttled per address and user).
  let clips: ReturnType<typeof createClipsSide> | undefined;
  const ftpRefusals = new RefusalThrottle();
  const buildClips = () => {
    clips = undefined;
    if (!cams.list().some((w) => w.cam().ftp.enabled)) return;
    if (!loaded.secrets.ftpPassword) return void logger.error('ftp_enabled_without_password');
    clips = createClipsSide({
      config: running,
      password: loaded.secrets.ftpPassword,
      users: () => ftpUsers(running),
      indexer: (cam) => cams.get(cam)?.ftpIndexer(),
      accept: () => !storage.paused(),
      tls: () => (proxyLeaf ? { cert: proxyLeaf.certPem, key: proxyLeaf.keyPem } : undefined),
      onRefused: (r) => {
        const t = ftpRefusals.take(r.ip, r.user);
        if (!t.record) return;
        const cam = ftpUsers(running).get(r.user)?.cam;
        audit.write({ action: 'ftp-login-refused', category: ['authentication'], type: ['denied'], outcome: 'failure', ip: r.ip, ...(cam ? { camera: cam } : {}), message: `FTP login as ${r.user} from ${r.ip} refused: the camera is at ${r.expected}`, details: { user: r.user, expected: r.expected, ...(t.suppressed ? { suppressed: t.suppressed } : {}) } });
      },
    });
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
    for (const p of settingPaths(loaded.config)) if (!keep(p)) setPath(running as unknown as Record<string, unknown>, p, structuredClone(getPath(loaded.config, p)));
  };
  // New settings from the control API: live ones take effect now.
  const setLoaded = (next: Loaded) => {
    const analyticsBefore = JSON.stringify(loaded.config.analytics);
    const before = new Map(cams.list().map((w) => [w.id, w.cam()]));
    loaded = next;
    // Cameras added or removed in the overrides run or stop at once (spec
    // 2026-10-05-multi-camera-host-design §6.3): a new camera's settings are
    // copied in whole, although camera settings otherwise wait for a restart.
    const was = cameraIds(running);
    const now = cameraIds(next.config);
    for (const id of now.filter((x) => !was.includes(x))) running.cameras[id] = structuredClone(next.config.cameras[id]);
    if (JSON.stringify(was) !== JSON.stringify(now)) {
      running.cameraOrder = [...now];
      void reconcile();
    }
    applySettings(needsRestart);
    for (const w of cams.list()) {
      const b = before.get(w.id);
      if (b) w.settingsChanged(b);
    }
    sse.setOptions(running.sse);
    setLogLevel(running.server.logLevel);
    // Only a change to the analytics settings lifts a bad_key pause.
    if (JSON.stringify(next.config.analytics) !== analyticsBefore) analytics.settingsChanged();
    void camsAdmin.apply();
  };

  // An `auth-refused` record per source IP and path per 10 minutes; the
  // refusals in between are counted into the next record.
  // The key is the path with numbers and ids replaced (numbered stills and
  // previews are one key), and at most 60 records per IP per 10 minutes.
  const refusals = new RefusalThrottle();
  const refusalsPerIp = new IpCap(60);
  // data/admin: our files tightened to 600 (folder 700) before anything reads
  // them; in the cluster the pod's fsGroup makes them 660 on every start.
  // Each read tightens again; a file of another user is refused (logged once here).
  privateFileHooks.onTightened = (file, from) => logger.info({ file, from: from.toString(8) }, 'admin_file_tightened');
  for (const r of tightenAdminFiles(join(loaded.config.server.dataDir, 'admin'))) logger.warn({ file: r.file, err: r.reason }, 'admin_file_refused');
  // cams-admin-managed token hashes (migration P2, M §10.2): read whenever
  // data/admin/tokens.json exists (R2-7); nothing is created when it doesn't.
  const tokenStore = new TokenStore({
    file: join(loaded.config.server.dataDir, 'admin', 'tokens.json'),
    localDigests: () => [loaded.secrets.adminToken, ...loaded.secrets.tokens, ...(loaded.secrets.auditToken ? [loaded.secrets.auditToken] : [])].map((x) => createHash('sha256').update(x).digest()),
  });
  const access: AccessDeps = {
    managed: (b) => tokenStore.match(b),
    managedAdminLive: (id) => tokenStore.liveAdmin(id),
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
  // One camera's FTP status: the server's figures for this camera's user;
  // the clip count of every camera while there is one (the Pi's number as
  // before), else this camera's.
  const ftpStatusOf = (w: CameraWorker) => {
    const mine = clips !== undefined && w.cam().ftp.enabled;
    const ix = w.ftpIndexer();
    return {
      enabled: w.cam().ftp.enabled,
      listening: mine ? clips!.side.listening() : false,
      port: running.ftp.port,
      tls: running.ftp.tls,
      publicHost: running.ftp.publicHost ?? null,
      passwordSet: !!loaded.secrets.ftpPassword,
      lastUpload: mine ? clips!.side.lastUpload(w.id) : null,
      lastClip: mine ? (ix?.lastIndexed() ?? null) : null,
      clips: cams.size === 1 ? countAllClips(catalog) : countAllClips(catalog, w.id),
      failures: mine ? clips!.side.uploadFailures(w.id) + (ix?.failures() ?? 0) : 0,
      camera: w.cam().ftp.enabled ? w.ftpWatch.view() : null,
      stalled: w.clipsHealth(),
    };
  };
  const ftpStatus = () => ftpStatusOf(cams.first());
  const streamStatus = () => cams.first().streamStatus();
  // One camera's block for the control API (spec 2026-10-05-multi-camera-host-design §6.3).
  const cameraStatusBlock = (w: CameraWorker) => ({
    id: w.id,
    camera: { ...w.status.state(), name: w.name(), nameSource: w.nameSource(), webUiUrl: cameraWebUi(w.cam()), reboot: w.reboot.state(), poeSwitch: w.poeSwitch.status() },
    intake: w.intake.state(),
    stream: w.streamStatus(),
    ftp: ftpStatusOf(w),
    recordings: w.recordings.status(),
    // Where the camera is defined: config.json, or added in the Settings page (overrides.json).
    source: loaded.addedCameras.includes(w.id) ? ('added' as const) : ('config' as const),
  });

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
  // One camera's part of the health summary (spec 2026-10-05-multi-camera-host-design §6.5).
  const cameraHealthInput = (w: CameraWorker): CameraHealthInput => {
    const ps = w.cam().poeSwitch;
    return {
      camera: { id: w.id, name: w.name(), host: w.cam().host, state: w.status.state(), reboot: w.reboot.state()?.phase ?? null, poeSwitch: ps.model === 'none' ? null : { model: ps.model, port: ps.port ?? null } },
      stream: w.streamStatus(),
      intake: w.intake.state(),
      ftp: ftpStatusOf(w),
    };
  };
  const healthNow = async (): Promise<HealthSummary> => {
    const [first, ...others] = cams.list().map(cameraHealthInput);
    // The host's one recordings cache (spec 2026-10-05-multi-camera-host-design §8.3).
    const recordingsCache = cachePool.usage();
    return buildHealth({
      now: Date.now(),
      version: VERSION,
      startedAt,
      thresholds: { diskPercent: running.health.diskPercent, tempC: running.health.tempC, ftpStalledHours: running.ftp.stalledHours, ...(running.archive.enabled ? { archiveWarnPercent: running.archive.warnPercent } : {}) },
      ...first,
      others,
      storage: { paused: storage.paused(), lastRun: storage.lastRun() },
      recordingsCache,
      sseClients: sse.clients(),
      lastInventory: await lastInventory(),
      reading: hostMonitor.reading(),
      archive: archive.health(),
      // The site CA (spec §10.5): only with tls.site (the Pi has no item).
      certificates: running.tls.site || certs ? { proxy: proxyLeaf ? { notAfter: proxyLeaf.notAfter } : null, cameras: cams.ids().map((id) => ({ id, state: certs?.state(id) ?? { mode: 'none' as const, servername: null, fingerprint: null, notAfter: null, lastPush: null, problem: null } })), problems: tlsProblems() } : null,
    });
  };

  // Commands from cams-admin (migration P2): the policy (config.json's base,
  // data/admin/policy.json, the env kill switch), the journal and the runner.
  // Nothing is read or written until a command arrives or the card asks.
  const commandPolicy = new CommandPolicy({ base: () => loaded.commandPolicyBase, file: join(loaded.config.server.dataDir, 'admin', 'policy.json'), env: () => loaded.envLayer, log: logger });
  const journal = new Journal(join(loaded.config.server.dataDir, 'admin', 'commands.json'), Date.now, logger);
  const replayGuard = new ReplayGuard({ file: join(loaded.config.server.dataDir, 'admin', 'replay.json'), log: logger, slackMs: opts.camsAdmin?.replaySlackMs });
  // The P3 handlers join once the control API's dependencies exist (below).
  const commandHandlers: Record<string, Handler> = {};
  const commandRunner = new CommandRunner({
    handlers: commandHandlers,
    replay: replayGuard,
    proxyId: () => camsAdmin.keyInfo()?.proxyId ?? '',
    serverKeys: () => camsAdmin.keyInfo()?.serverKeys ?? [],
    policy: commandPolicy, journal, tokens: tokenStore, audit, log: logger,
  });
  // Overrides backups per cams-admin settings write (plan P3 R3-5): data/admin/overrides.bak-*.json.
  const overridesBackups = new OverridesBackups(join(loaded.config.server.dataDir, 'admin'), Date.now, logger);
  const configCommandDeps: ConfigCommandDeps = { loaded: () => loaded, setLoaded: (l) => setLoaded(l), running: () => running, backups: overridesBackups, audit };
  let envOffLogged = false;

  let startedAt: number | null = null;
  // cams-admin (spec 2026-10-06-cams-admin-phase1-design §9): a leaf; it
  // reads the summary GET /api/local/health serves, at most once per heartbeat.
  // The heartbeat's P2 fields (only sent with camsAdmin.url: the client runs only then).
  const commandsInfo = () => {
    const status = commandRunner.status();
    if (!status.enabled && !envOffLogged) {
      envOffLogged = true;
      logger.info({ name: 'CAMPROXY_ADMIN_COMMANDS' }, 'admin_commands_env_off');
    }
    return { commands: status, tokens: tokenStore.counts(), configRevision: configRevision(loaded) };
  };
  const camsAdmin = new CamsAdmin({
    settings: () => running.camsAdmin,
    dataDir: () => running.server.dataDir,
    version: VERSION,
    cameraIds: () => cams.ids(),
    health: healthNow,
    proxyInfo: () => ({
      startedAt,
      uptimeS: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null,
      configSchema: CONFIG_SCHEMA,
      tls: running.tls.site && ca ? { site: running.tls.site, caFingerprint: [ca.fingerprint] } : null,
      publicUrl: running.server.publicUrl ?? null,
      ...commandsInfo(),
    }),
    commands: () => commandRunner,
    replay: replayGuard,
    // What changes ok, problemCount or a camera's online flag, read cheaply (an early heartbeat).
    // A local settings edit too (R3-12): cams-admin re-reads within seconds.
    changeKey: () => `${storage.paused() ? 1 : 0}|${cams.list().map((w) => `${w.id}:${w.status.state().online ? 1 : 0}${w.streamStatus().up ? 1 : 0}:${w.intake.state().onvif}`).join(',')}|${configRevision(loaded)}`,
    log: logger,
    timing: opts.camsAdmin?.timing,
    recheckMs: opts.camsAdmin?.recheckMs,
    setUrl: async (url) => {
      const next = url ? applyOverrides(loaded, { camsAdmin: { url } }) : loaded.sources['camsAdmin.url'] === 'override' ? removeOverride(loaded, 'camsAdmin.url') : loaded;
      if (next !== loaded) setLoaded(next);
    },
  });

  const app = express();
  app.disable('x-powered-by');
  // Far above real use (the UI, cams, a scraper); stops a flood. SSE is one
  // long request. Still and sprite images have their own, higher limit: a
  // day on the timeline is up to 1440 sprites.
  // Clip and recording files too: a seeking video player sends many range
  // requests. A recording only once it is cached (#99): one not cached costs
  // a camera Search and a download, so it counts in the normal bucket.
  // The latest still and tile (spec 2026-10-05-multi-camera-host-design §6.4) too: an overview grid polls them.
  const IMAGE = /^\/api\/cameras\/[^/]+\/((stills|previews)\/(\d{1,15}|latest)\.jpg|clips\/\d{1,15}\.(mp4|jpg)|events\/\d{1,15}\/analysis\.jpg|still-checks\/\d{1,12}\.jpg)$|^\/api\/archive\/\d{1,15}\/(video|thumbnail)$|^\/api\/stills\/latest$/;
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
  // The site CA's certificate: public, before the token checks and the admin UI's catch-all.
  app.use('/tls', tlsApi({ ca: () => ca }));
  app.use(['/api', '/control'], refuseTokenInUrl);
  // The health summary for the display on the Pi: loopback callers only, no
  // key; anyone else goes on to the access check as for an unknown route.
  app.use('/api', localApi({ health: healthNow }));
  app.use('/control', sessionRoutes({ adminToken: access.adminToken, sessions, links, audit, managedAdminLive: access.managedAdminLive }));
  // Before clientApi: its /cameras/:cam/stills/:file would take latest.jpg.
  app.use('/api', requireAccess('client', access), latestApi({ cameras: cams }));
  app.use('/api', requireAccess('client', access), composeApi({ config: () => running, catalog, composer, cameras: cams, paused: () => storage.paused(), font, audit }));
  app.use('/api', requireAccess('client', access), stillChecksApi({ config: () => running, catalog, cameras: cams, analytics, audit }));
  app.use('/api', requireAccess('client', access), archiveApi({ config: () => running, catalog, archive, composer, cameras: cams }));
  app.use('/api', requireAccess('client', access), clientApi({ config: () => running, catalog, cameras: cams, sse, tls: (id) => certs?.state(id) }));
  // The audit log: admins and the audit token, GET (and HEAD) only. The access check is
  // on the route inside the router; other /control paths pass on untouched
  // to the admin-only routes below.
  app.use('/control', auditApi({ audit, guard: requireAccess('audit-read', access), retentionDays: () => running.retention.auditDays }));
  // The cams-admin card (spec 2026-10-06-cams-admin-phase1-design §9.2).
  app.use('/control', requireAccess('admin', access), camsAdminApi({ camsAdmin, audit, commands: { policy: commandPolicy, tokens: tokenStore, runner: commandRunner, config: configCommandDeps } }));
  const controlDeps: ControlDeps = {
    changeMarks: () => overridesBackups.byPath(),
    loaded: () => loaded,
    setLoaded,
    running: () => running,
    catalog,
    log,
    camera: () => cameraStatusBlock(cams.first()).camera,
    cameras: cams,
    cameraStatus: () => cams.list().map(cameraStatusBlock),
    cameraCount: () => cams.size,
    // Writes through to the camera and reads back; the poller (and so the
    // stream message) knows the new name at once.
    // The camera functions get the camera the request names (resolved by the router).
    cameraName: {
      current: (cam) => worker(cam).name(),
      write: (cam, name) => worker(cam).writeName(name),
    },
    checkCamera: (cam) => worker(cam).status.checkNow(),
    intake: () => cams.first().intake.state(),
    resubscribe: (cam) => worker(cam).intake.resubscribe(),
    restart: () => proxy.restart(),
    // One camera's restart applies its own pending settings (cameras.<id>.*), nothing host-wide.
    restartCamera: (cam) => {
      const prefix = `cameras.${cam}.`;
      for (const p of settingPaths(loaded.config)) if (p.startsWith(prefix) && needsRestart(p)) setPath(running as unknown as Record<string, unknown>, p, structuredClone(getPath(loaded.config, p)));
      return worker(cam).restart();
    },
    cameraReboot: (who, cam) => worker(cam).reboot.request(who),
    poeSwitch: { notConfigured: (cam) => worker(cam).poeSwitch.notConfigured(), read: (cam) => worker(cam).poeSwitch.read(), poeOn: (cam) => worker(cam).poeSwitch.poeOn(), info: (cam) => worker(cam).poeSwitchInfo() },
    cameraPowerCycle: (who, cam) => {
      const w = worker(cam);
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
      target: (cam) => ftpTargetFor(cam)(),
      setup: async (cam, t) => {
        const w = worker(cam);
        const f = await setupCameraFtp(w.client, t);
        w.ftpWatch.note(f);
        return f;
      },
      test: (cam, t) => testCameraFtp(worker(cam).client, t),
      off: async (cam) => {
        const w = worker(cam);
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
    cameraId: () => cams.first().id,
    cameraNtp: (cam) => worker(cam).syncNtp(true),
    tls: {
      view: tlsView,
      pushNow: (cam, who) => (certs && running.tls.site ? certs.pushNow(cam, who) : Promise.resolve({ outcome: 'failed' as const, served: null, detail: running.tls.site ? (caProblem ?? 'the site CA is not ready') : 'no site CA: tls.site is not set', tookMs: 0 })),
      rotate: () => (running.tls.site ? rotateCa() : null),
      clearTrust: (cam, who) => certs?.clearTrust(cam, who) ?? null,
      dropPrevious: (who) => certs?.dropPreviousCa(who) ?? false,
    },
  };
  app.use('/control', requireAccess('admin', access), controlApi(controlDeps));
  // cams-admin's P3 commands (plan P3 Task 10): each off unless allowed locally.
  Object.assign(
    commandHandlers,
    configHandlers(configCommandDeps),
    cameraHandlers({ actions: controlDeps, cameraIds: () => cams.ids(), cameraName: controlDeps.cameraName, audit, restartProcess: () => controlDeps.restartProcess() }),
  );
  // The admin UI. The files are public; every API call needs a session.
  const webDir = findWebDir();
  if (!webDir) logger.warn('admin_ui_not_built');
  else {
    // A missing asset is a 404, not the app page (stale chunks after an upgrade).
    app.use('/assets', express.static(join(webDir, 'assets'), { immutable: true, maxAge: '1y', index: false, fallthrough: false }));
    // Top-level files of the build (favicon.svg).
    app.get('/favicon.svg', (_req, res) => void res.sendFile(join(webDir, 'favicon.svg'), { maxAge: '1d' }));
    app.get(/^\/(?!api\/|control\/|tls\/|health$|metrics$).*/, (_req, res) => {
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

  // The workers follow the configured cameras (spec §6.3), one change at a
  // time: a removed camera's worker stops and its go2rtc streams go (its
  // files stay, Ruling P2-6); an added camera gets a worker, its streams in
  // the running go2rtc (never a go2rtc restart) and FTP when it has it on.
  let reconciling: Promise<void> = Promise.resolve();
  const reconcile = (): Promise<void> =>
    (reconciling = reconciling.then(async () => {
      if (stopPromise) return;
      const want = cameraIds(running);
      for (const w of cams.all().filter((x) => !want.includes(x.id))) {
        cams.remove(w.id);
        await w.stopRecordings();
        await w.stop();
        await go2rtc?.removeStream(w.id).catch((err: Error) => logger.warn({ cameraId: w.id, err: err.message }, 'go2rtc_remove_failed'));
        if (!cameraIds(running).includes(w.id)) delete running.cameras[w.id];
        logger.info({ cameraId: w.id }, 'camera_removed');
      }
      for (const id of want.filter((x) => !cams.get(x))) {
        if (!go2rtc && cameraConfig(running, id)?.stills.enabled) {
          go2rtc = makeGo2rtc();
          go2rtcMadeWith = go2rtcSettings();
          startGo2rtc();
        }
        const w = makeWorker(id);
        cams.add(w);
        if (w.cam().stills.enabled) await go2rtc?.setStream(w.source()).catch((err: Error) => logger.warn({ cameraId: id, err: err.message }, 'go2rtc_add_failed'));
        await w.start();
        logger.info({ cameraId: id }, 'camera_added');
      }
      // The first camera with FTP on: the server starts now.
      if (!clips && cams.list().some((w) => w.cam().ftp.enabled)) {
        buildClips();
        await startClips();
      }
    }).catch((err: Error) => logger.error({ err: err.message }, 'camera_reconcile_failed')));

  // Applies pending restart settings to the camera side (camera, events).
  // Settings read at process start (port, data folder, trust proxy, font) need a new process.
  // A camera whose id is no longer configured (a changed camera.id) stops
  // for good before the settings change under it; a new id gets a new worker.
  const restartCameraSide = async () => {
    await clips?.stop();
    const nextIds = cameraIds(loaded.config);
    const gone = cams.list().filter((w) => !nextIds.includes(w.id));
    for (const w of gone) {
      await w.stopRecordings();
      await w.stop();
      cams.remove(w.id);
      await go2rtc?.removeStream(w.id);
    }
    applySettings(needsProcessRestart);
    const kept = cams.list();
    const added = cameraIds(running).flatMap((id) => (cams.get(id) ? [] : [makeWorker(id)]));
    for (const w of added) cams.add(w);
    // go2rtc's own settings changed, or stills went on or off everywhere: a new one.
    if (go2rtcSettings() !== go2rtcMadeWith || !go2rtc !== !makeGo2rtc()) {
      await go2rtc?.stop();
      go2rtc = makeGo2rtc();
      go2rtcMadeWith = go2rtcSettings();
      startGo2rtc();
    } else {
      for (const w of added) if (w.cam().stills.enabled) await go2rtc?.setStream(w.source()).catch((err: Error) => logger.warn({ cameraId: w.id, err: err.message }, 'go2rtc_add_failed'));
    }
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
    get certs() {
      return certs;
    },
    camsAdmin,
    actions: controlDeps,
    // Test seam: the host go2rtc's process id (adding a camera never restarts it).
    go2rtcPid: () => go2rtc?.pid(),
    async start(opts = {}) {
      await startSiteCa();
      server = http.createServer(app);
      const s = server;
      const port = await new Promise<number>((resolve, reject) => {
        s.once('error', reject);
        s.listen(opts.port ?? running.server.port, opts.host ?? '0.0.0.0', () => resolve((s.address() as AddressInfo).port));
      });
      // HTTPS with the proxy's leaf (spec §10.4); the HTTP listener stays.
      if (running.server.tls.port && proxyLeaf) {
        const hs = https.createServer({ cert: proxyLeaf.certPem, key: proxyLeaf.keyPem, minVersion: 'TLSv1.2' }, app);
        httpsServer = hs;
        await new Promise<void>((resolve, reject) => {
          hs.once('error', reject);
          hs.listen(running.server.tls.port, opts.host ?? '0.0.0.0', () => resolve());
        });
        logger.info({ port: running.server.tls.port, servername: proxyName() }, 'https_listening');
      } else if (running.server.tls.port) {
        logger.error({ port: running.server.tls.port }, 'https_not_started_no_certificate');
      }
      // go2rtc an earlier process left behind (killed hard) would hold the ports.
      if (cams.list().some((w) => w.cam().stills.enabled)) await reapOrphanGo2rtc();
      startGo2rtc();
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
      // Only with camsAdmin.url (the Pi: nothing until enrolled).
      void camsAdmin.apply();
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
      await reconciling;
      // First, while everything is still open.
      audit.write({ action: 'proxy-stop', category: ['process'], type: ['end'], outcome: 'success', user: 'system', message: `cam-proxy stopping${opts.reason ? ` (${opts.reason})` : ''}`, details: { reason: opts.reason ?? 'stop' } });
      // Each camera's PoE back on if a power-cycle is in its off time; one
      // record per camera the proxy may leave dark (spec §8.4).
      const { portsLeftOff, sessionMaybeOpen } = await poe.stop();
      const swInfo = { model: running.poeSwitch.model, host: running.poeSwitch.host ?? '' };
      for (const port of portsLeftOff) {
        const w = cams.list().find((x) => x.cam().poeSwitch.port === port);
        const parts = [
          `the camera's PoE may be left OFF on ${swInfo.host} port ${port}; turn it on in the switch's web UI, or with "Turn camera PoE on" once the proxy is back`,
          ...(sessionMaybeOpen ? ["the proxy's web session on the switch may still be open: the switch's web UI may refuse logins until the switch ends it"] : []),
        ];
        audit.write({ action: 'camera-powercycle', category: ['host'], type: ['end'], outcome: 'failure', user: 'system', ...(w ? { camera: w.id } : {}), message: `cam-proxy stopping: ${parts.join('; ')}`, details: { phase: 'stop', poeLeftOff: true, sessionMaybeOpen, switch: { ...swInfo, port } } });
      }
      if (sessionMaybeOpen && !portsLeftOff.length) {
        audit.write({ action: 'camera-powercycle', category: ['host'], type: ['end'], outcome: 'failure', user: 'system', message: "cam-proxy stopping: the proxy's web session on the switch may still be open: the switch's web UI may refuse logins until the switch ends it", details: { phase: 'stop', poeLeftOff: false, sessionMaybeOpen, switch: swInfo } });
      }
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
      // cams-admin: bye and close within 1 s, before the HTTP server (spec §9.1).
      await Promise.all([composer.stop(), analytics.stop(), archive.stop(), ...cams.list().map((w) => w.stopRecordings()), inventory.stop(), camsAdmin.stop(opts.reason === 'restart-requested' ? 'restart' : 'shutdown')]);
      try {
        replayGuard.flush();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'admin_replay_save_failed');
      }
      certs?.stop();
      clearInterval(proxyLeafTimer);
      const s = server;
      if (s) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
      const hs = httpsServer;
      if (hs) {
        hs.closeAllConnections();
        await new Promise<void>((r) => hs.close(() => r()));
      }
      await clips?.stop();
      await Promise.all(cams.list().map((w) => w.stop()));
      await go2rtc?.stop();
      catalog.close();
  }
  return proxy;
}
