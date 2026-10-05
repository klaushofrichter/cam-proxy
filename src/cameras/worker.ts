import { EventEmitter } from 'events';
import { withCamera, type AuditLog } from '../audit/audit-log';
import type { Catalog } from '../catalog/db';
import { Backoff } from './backoff';
import { lastClipReceived } from '../catalog/clips';
import { ReolinkClient } from '../camera/client';
import { bareHost, splitHost } from '../camera/http';
import { CameraNameAnnouncer, writeCameraName } from '../camera/name';
import { CameraReboot } from '../camera/reboot';
import { PoeSwitch } from '../camera/poe-switch';
import { StatusPoller, type CameraState } from '../camera/status';
import type { TimeInfo } from '../camera/time';
import { refreshingTimeInfo } from '../analytics/time-info';
import type { StillsSide } from '../api/client-api';
import { readCameraFtp, type FtpTarget } from '../clips/camera-ftp';
import { CameraFtpWatch, clipsStalled, type ClipsStall } from '../clips/ftp-health';
import { ClipIndexer } from '../clips/indexer';
import type { Config } from '../config/defaults';
import { cameraConfig, cameraEvents, cameraIds, type ResolvedCamera } from '../config/cameras';
import { EventIntake } from '../events/intake';
import { EventTracker } from '../events/tracker';
import { logger } from '../log';
import { createRecordingsSide, type RecordingsSide } from '../recordings/side';
import { Go2rtc } from '../stills/go2rtc';
import { FrameGrabber, type Frame } from '../stills/grabber';
import { MinuteStore, minuteOf } from '../stills/store';
import type { Storage } from '../storage';
import type { StreamLog } from '../stream/log';
import type { SseHandler } from '../stream/sse';

export type WorkerPhase = 'idle' | 'starting' | 'ready' | 'restarting' | 'stopped';

// What the host counts per camera (Prometheus); the proxy binds the camera id.
export interface WorkerHooks {
  onCameraCheck(c: { ok: boolean; ms: number; error?: string }): void;
  onResubscribe(): void;
  onStill(ts: number): void;
  onStillMissing(): void;
  onRecordingDownload(o: { stream: string; result: string; priority: string }): void;
}

export interface WorkerDeps {
  id: string;
  index: number; // position in config order: go2rtc ports until P2 (Ruling P1-1)
  running: () => Config;
  password: () => string;
  poeSwitchPassword: () => string | undefined;
  ftpTarget: () => FtpTarget;
  catalog: Catalog;
  log: StreamLog;
  sse: SseHandler;
  storage: Storage;
  audit: AuditLog;
  hooks: WorkerHooks;
  cameraFtpCheckMs?: number;
  // Test seams: a throw from beforeStart is a start failure; schedule replaces setTimeout.
  beforeStart?: () => void | Promise<void>;
  schedule?: (ms: number, fn: () => void) => () => void;
  // Test seam: how go2rtc is started (default: go2rtc.start()).
  startGo2rtc?: (g: Go2rtc) => Promise<void>;
}

// The camera's own web page for the admin UI: webUiUrl, none for no link,
// or https://<host without its port>/.
export function cameraWebUi(c: ResolvedCamera): string | null {
  if (c.webUiUrl === 'none') return null;
  if (c.webUiUrl) return c.webUiUrl;
  const { hostname } = splitHost(c.host);
  return hostname ? `https://${hostname}/` : null;
}

// One camera's side (spec 2026-10-05-multi-camera-host-design §3.1): its
// client, status poller, name, events, stills, recordings, reboot, PoE port
// and FTP watch. restart() builds the parts again with the current settings;
// one worker's trouble never touches another's.
export class CameraWorker extends EventEmitter {
  readonly id: string;
  client!: ReolinkClient;
  status!: StatusPoller;
  intake!: EventIntake;
  stills: StillsSide | undefined;
  readonly recordings: RecordingsSide;
  readonly reboot: CameraReboot;
  readonly poeSwitch: PoeSwitch;
  readonly ftpWatch: CameraFtpWatch;
  readonly timeInfo: () => TimeInfo | undefined;
  private phaseNow: WorkerPhase = 'idle';
  private errorNow: string | null = null;
  // The camera's name as last read (camera-name design); the configured name
  // is only the fallback until the first read. Each change goes to stream
  // clients once as a `camera` message with the camera's address.
  private nameRead: string | undefined;
  private toldName: string | undefined;
  private toldAddress: string | undefined;
  private readonly announcer: CameraNameAnnouncer;
  private lastResubscribes = 0;
  private stillsStarting: Promise<void> | undefined;
  private stopping = false;
  private watchStarted = false;
  private restarting: Promise<void> | undefined;
  // Supervision (spec 2026-10-05-multi-camera-host-design §3.3).
  private readonly backoff = new Backoff();
  private cancelRetry: (() => void) | undefined;
  private onlineSince: number | null = null;
  // Every record this camera's code writes names the camera (spec §5.2).
  private readonly audit: Pick<AuditLog, 'write'>;

  constructor(private readonly d: WorkerDeps) {
    super();
    this.id = d.id;
    this.audit = withCamera(d.audit, d.id);
    const lastTold = d.log.latest(d.id, 'camera')?.data;
    this.toldName = typeof lastTold?.name === 'string' ? lastTold.name : undefined;
    this.toldAddress = typeof lastTold?.address === 'string' ? lastTold.address : undefined;
    this.announcer = new CameraNameAnnouncer(this.toldName ?? this.cam().name, (name, previous) => {
      logger.info({ cameraId: this.id, name, previous }, 'camera_name_changed');
      this.toldName = name;
      this.toldAddress = this.cam().host;
      d.log.append(this.id, 'camera', { name, address: this.cam().host });
    });
    // The FTP watch is read by the status listeners build() adds: made first.
    this.ftpWatch = new CameraFtpWatch({
      read: () => readCameraFtp(this.client),
      target: d.ftpTarget,
      // Its last record is this camera's (a record without a camera: from before several cameras).
      audit: { write: this.audit.write, find: (pred, days) => d.audit.find((r) => pred(r) && ((r.labels as { camera?: string } | undefined)?.camera ?? this.id) === this.id, days) },
      active: () => this.cam().ftp.enabled && this.status.state().online,
      clipsBefore: () => lastClipReceived(d.catalog, this.id) !== null,
      everyMs: d.cameraFtpCheckMs,
    });
    this.build();
    // Recordings on the SD card over Baichuan (spec 2026-10-02-baichuan-recordings-design).
    this.recordings = createRecordingsSide({
      dataDir: d.running().server.dataDir,
      cam: () => this.id,
      target: () => {
        const c = this.cam();
        return { host: bareHost(splitHost(c.host).hostname), port: c.baichuanPort, user: c.user, password: d.password() };
      },
      // Ruling P1-3: the cap split evenly until the shared cache of P2.
      capBytes: () => Math.floor((d.running().recordings.cacheMB * 2 ** 20) / Math.max(1, cameraIds(d.running()).length)),
      search: (param) => this.client.command('Search', param),
      timeInfo: () => this.client.timeInfo(),
      paused: () => d.storage.paused(),
      noteWritten: (bytes) => d.storage.noteWritten('recordings', bytes, 1),
      onDownload: (o) => d.hooks.onRecordingDownload({ stream: o.stream, result: o.result, priority: o.priority }),
    });
    // A reboot (#83): the client and poller are read on use (restart builds
    // them anew); the Baichuan session dies with the camera.
    this.reboot = new CameraReboot({
      send: () => this.client.command('Reboot'),
      forgetToken: () => {
        this.client.forgetToken();
        this.recordings.reset();
      },
      serial: () => this.status.state().serial,
      check: async () => {
        const s = await this.status.checkNow();
        return { ok: s.error === undefined, serial: s.serial };
      },
      audit: this.audit,
    });
    // Ruling P1-4: this camera's port on the host switch (one controller per host in P2).
    this.poeSwitch = new PoeSwitch({ config: () => this.cam().poeSwitch, password: d.poeSwitchPassword });
    this.timeInfo = refreshingTimeInfo(() => this.client.timeInfo());
  }

  cam(): ResolvedCamera {
    const c = cameraConfig(this.d.running(), this.id);
    if (!c) throw new Error(`camera ${this.id} is not configured`);
    return c;
  }

  phase(): WorkerPhase {
    return this.phaseNow;
  }

  // The worker's own error (Task 6: supervision), else the camera's last check error.
  error(): string | null {
    return this.errorNow ?? this.status.state().error ?? null;
  }

  name(): string {
    return this.nameRead ?? this.cam().name;
  }

  nameSource(): 'camera' | 'config' {
    return this.nameRead === undefined ? 'config' : 'camera';
  }

  // Writes through to the camera and reads back; the poller (and so the
  // stream message) knows the new name at once.
  async writeName(name: string): Promise<string> {
    const read = await writeCameraName((cmd, param) => this.client.command(cmd, param), name);
    this.status.noteName(read);
    return read;
  }

  readStill(ts: number): Promise<Buffer | undefined> {
    return this.stills?.store.readStill(ts) ?? Promise.resolve(undefined);
  }

  listStills(from: number, to: number): number[] {
    return this.stills?.store.listStills(from, to) ?? [];
  }

  // A clip indexer for this camera; `growth: false` for a repair's fetches.
  makeIndexer(growth: boolean): ClipIndexer {
    const d = this.d;
    return new ClipIndexer({ catalog: d.catalog, log: d.log, config: d.running, timeInfo: () => this.client.timeInfo(), dataDir: d.running().server.dataDir, cam: this.id, stored: (bytes) => d.storage.noteWritten('clips', bytes, 1, { growth }) });
  }

  streamStatus(): { enabled: boolean; up: boolean; go2rtcUp: boolean; lastFrameTs: number | null } {
    const s = this.stills;
    return { enabled: !!s, up: s?.grabber.up() ?? false, go2rtcUp: s?.go2rtc.up() ?? false, lastFrameTs: s?.grabber.lastFrameTs() ?? null };
  }

  // No stall warning for a camera never set up, nor before the first read when no clip ever came.
  private ftpNotSetUp(): boolean {
    const st = this.ftpWatch.view().state;
    return st === 'not_set_up' || (st === 'unknown' && lastClipReceived(this.d.catalog, this.id) === null);
  }

  clipsHealth(): ClipsStall | null {
    return this.cam().ftp.enabled ? clipsStalled(this.d.catalog, this.id, Date.now(), this.d.running().ftp.stalledHours, { notSetUp: this.ftpNotSetUp() }) : null;
  }

  // What audit records name about the switch: never the password.
  poeSwitchInfo(): { model: string; host: string; port: number } {
    const c = this.cam().poeSwitch;
    return { model: c.model, host: c.host ?? '', port: c.port ?? 0 };
  }

  // Live settings changed (the proxy's setLoaded): a new Baichuan port is used
  // from the next connection on.
  settingsChanged(before: ResolvedCamera): void {
    if (this.cam().baichuanPort !== before.baichuanPort) this.recordings.session.close();
  }

  // Tells stream clients the camera's address when it starts with another
  // one than last told (spec 2026-10-04-pi-config-design §2).
  private announceAddress(): void {
    const host = this.cam().host;
    if (this.toldAddress === host) return;
    this.toldAddress = host;
    logger.info({ cameraId: this.id, address: host }, 'camera_address_told');
    this.d.log.append(this.id, 'camera', { ...(this.toldName !== undefined ? { name: this.toldName } : {}), address: host });
  }

  // The parts restart() makes anew: client, poller, tracker, intake, stills.
  private build(): void {
    const d = this.d;
    const c = this.cam();
    this.announceAddress();
    this.client = new ReolinkClient({ id: c.id, host: c.host, protocol: c.protocol, tlsServername: c.tlsName, user: c.user, password: d.password() });
    this.status = new StatusPoller(this.client, c.statusPollS);
    this.status.on('change', (s: CameraState) => d.log.append(c.id, 'camera-status', { online: s.online, reason: s.error ?? null, clockOffsetMs: s.clockOffsetMs ?? null }));
    this.status.on('check', (x: { ok: boolean; ms: number; error?: string }) => d.hooks.onCameraCheck(x));
    this.status.on('name', (name: string) => {
      this.nameRead = name;
      this.announcer.seen(name);
    });
    // The camera's FTP settings as soon as it answers (#93), then every few minutes.
    this.status.on('change', (s: CameraState) => {
      if (s.online) void this.ftpWatch.checkNow();
      // Online for 10 minutes: the next failure starts the backoff at 5 s again.
      this.onlineSince = s.online ? (this.onlineSince ?? Date.now()) : null;
      if (this.onlineSince !== null) this.backoff.healthy(this.onlineSince, Date.now());
    });
    const events = cameraEvents(d.running(), this.id);
    const tracker = new EventTracker(d.catalog, d.log, c.id, events);
    this.intake = new EventIntake({ client: this.client, tracker, cfg: events, onvif: { host: splitHost(c.host).hostname, port: c.onvifPort, user: c.user, password: d.password() } });
    this.lastResubscribes = 0;
    this.intake.on('state', (st: { resubscribes: number }) => {
      for (; this.lastResubscribes < st.resubscribes; this.lastResubscribes++) d.hooks.onResubscribe();
    });
    // Stills: go2rtc holds the camera connection, one ffmpeg makes stills and
    // tiles, the store writes a pack and a sprite per minute.
    this.stills = undefined;
    if (c.stills.enabled) {
      const r = d.running();
      const s = c.stills;
      const offset = 100 * d.index; // Ruling P1-1: index 0 keeps today's ports
      const go2rtc = new Go2rtc({ binary: r.go2rtc.binary, rtspPort: r.go2rtc.rtspPort + offset, apiPort: r.go2rtc.apiPort + offset, cam: c.id,
        source: { host: splitHost(c.host).hostname, port: c.rtspPort, user: c.user, password: d.password() } });
      const grabber = new FrameGrabber({ input: go2rtc.streamUrl(s.stream), intervalS: s.intervalS, size: s.size, tileSize: r.previews.tileSize, quality: s.quality, tileQuality: r.previews.quality });
      const store = new MinuteStore({ dataDir: r.server.dataDir, cam: c.id, intervalS: s.intervalS, still: { size: s.size, quality: s.quality }, tile: { size: r.previews.tileSize, grid: r.previews.grid, quality: r.previews.quality } });
      store.on('written', (w: { kind: 'stills' | 'previews'; bytes: number; files: number }) => d.storage.noteWritten(w.kind, w.bytes, w.files));
      grabber.on('frame', (f: Frame) => {
        if (d.storage.paused()) return d.hooks.onStillMissing(); // the disk is full: no writing
        store.add(f);
        d.hooks.onStill(f.ts);
        const minute = minuteOf(f.ts);
        const base = `/api/cameras/${encodeURIComponent(c.id)}`;
        d.sse.live(c.id, 'still', { ts: f.ts, url: `${base}/stills/${f.ts}.jpg`, sprite: `${base}/previews/${minute}.jpg`, tile: Math.floor((f.ts - minute) / (s.intervalS * 1000)) });
      });
      // Stream up and down reach stream clients as camera-status (spec §8).
      grabber.on('state', (st: { up: boolean }) => {
        const cs = this.status.state();
        d.log.append(c.id, 'camera-status', { online: cs.online, stream: st.up ? 'up' : 'down', reason: st.up ? null : 'no_frames', clockOffsetMs: cs.clockOffsetMs ?? null });
      });
      this.stills = { go2rtc, grabber, store };
    }
  }

  // go2rtc takes a moment to start; the grabber starts only if its side is
  // still the current one (a restart or stop may come in between).
  private startStills(): void {
    const s = this.stills;
    if (!s) return;
    this.stillsStarting = (this.d.startGo2rtc ? this.d.startGo2rtc(s.go2rtc) : s.go2rtc.start()).then(
      () => {
        if (this.stills === s && !this.stopping) s.grabber.start();
      },
      // This camera's error and a supervised retry (spec §3.3), unless a restart or stop came in between.
      (err: Error) => {
        if (this.stills === s && !this.stopping && this.phaseNow !== 'stopped') this.failed(`go2rtc_start_failed: ${err.message}`);
        else logger.error({ cameraId: this.id, err: err.message }, 'go2rtc_start_failed');
      },
    );
  }

  private async stopStills(): Promise<void> {
    const s = this.stills;
    if (!s) return;
    this.stopping = true;
    // go2rtc first: a start still waiting for it ends at once, and its ports
    // are free when this returns (live test 2026-10-05).
    const go2rtcStopped = s.go2rtc.stop();
    await this.stillsStarting;
    this.stopping = false;
    await s.grabber.stop();
    await go2rtcStopped;
    await s.store.flush();
  }

  private schedule(ms: number, fn: () => void): () => void {
    if (this.d.schedule) return this.d.schedule(ms, fn);
    const t = setTimeout(fn, ms);
    t.unref();
    return () => clearTimeout(t);
  }

  // A start failure: this camera's error, and a restart after the backoff.
  private failed(error: string): void {
    this.errorNow = error;
    // Healthy for 10 minutes before this failure (no status change needed to notice): 5 s again.
    if (this.onlineSince !== null) this.backoff.healthy(this.onlineSince, Date.now());
    const ms = this.backoff.next();
    logger.warn({ cameraId: this.id, err: error, retryMs: ms }, 'camera_side_start_failed');
    this.cancelRetry?.();
    this.cancelRetry = this.schedule(ms, () => void this.restart().catch((e: Error) => logger.error({ cameraId: this.id, err: e.message }, 'camera_side_restart_failed')));
  }

  // Starts the parts; a failure is this camera's error and a later retry,
  // never the process's (spec §3.3). Answers whether the parts run.
  private async startParts(): Promise<boolean> {
    if (!this.cam().host) {
      this.errorNow = 'no_address';
      this.phaseNow = 'idle';
      return false;
    }
    try {
      await this.d.beforeStart?.();
      this.status.start();
      this.intake.start();
      this.startStills();
      this.errorNow = null;
      return true;
    } catch (err) {
      this.failed((err as Error).message);
      return false;
    }
  }

  private async stopParts(): Promise<void> {
    await this.intake.stop();
    this.status.stop();
    await this.stopStills();
    await this.client.logout();
  }

  async start(): Promise<void> {
    this.phaseNow = 'starting';
    const running = await this.startParts();
    if (!this.watchStarted) {
      this.ftpWatch.start();
      this.watchStarted = true;
    }
    // Without an address: idle. A failed start serves stored data; its retry is scheduled.
    this.phaseNow = running || this.errorNow !== 'no_address' ? 'ready' : 'idle';
  }

  // One at a time: a second call while one runs joins it.
  restart(): Promise<void> {
    this.restarting ??= (async () => {
      this.phaseNow = 'restarting';
      try {
        await this.stopParts();
        this.recordings.reset();
        this.build();
        this.cancelRetry?.();
        const running = await this.startParts();
        this.phaseNow = running || this.errorNow !== 'no_address' ? 'ready' : 'idle';
        logger.info({ cameraId: this.id }, 'camera_side_restarted');
      } finally {
        this.restarting = undefined;
      }
    })();
    return this.restarting;
  }

  // A power-cycle in its off time turns the camera's PoE on now, not never;
  // bounded, and loud (audited) when it could not.
  async stopSwitch(): Promise<void> {
    const { poeLeftOff, sessionMaybeOpen } = await this.poeSwitch.stop();
    if (!poeLeftOff && !sessionMaybeOpen) return;
    const sw = this.poeSwitchInfo();
    const parts = [
      ...(poeLeftOff ? [`the camera's PoE may be left OFF on ${sw.host} port ${sw.port}; turn it on in the switch's web UI, or with "Turn camera PoE on" once the proxy is back`] : []),
      ...(sessionMaybeOpen ? ["the proxy's web session on the switch may still be open: the switch's web UI may refuse logins until the switch ends it"] : []),
    ];
    this.audit.write({ action: 'camera-powercycle', category: ['host'], type: ['end'], outcome: 'failure', user: 'system', message: `cam-proxy stopping: ${parts.join('; ')}`, details: { phase: 'stop', poeLeftOff, sessionMaybeOpen, switch: sw } });
  }

  stopRecordings(): Promise<void> {
    return this.recordings.stop();
  }

  async stop(): Promise<void> {
    this.cancelRetry?.();
    await this.restarting;
    this.phaseNow = 'stopped';
    this.ftpWatch.stop();
    this.reboot.stop();
    await this.stopParts();
  }
}
