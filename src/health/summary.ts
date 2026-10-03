import { splitHost } from '../camera/http';
import type { CameraState } from '../camera/status';
import type { CameraFtpView, ClipsStall } from '../clips/ftp-health';
import type { IntakeState } from '../events/intake';
import type { DataVolume, HostReading, HostStats } from './host';
import type { RebootState } from '../camera/reboot';

// The health summary (spec 2026-10-03-health-summary-design A2): the one
// place with the problem rules. The Status page's Health and Pi cards, its red
// marks, and GET /api/local/health (the e-paper display) all read it, so they
// never disagree. The JSON is fixed in the plan
// (docs/superpowers/plans/2026-10-03-health-summary.md, "The API schema");
// a breaking change bumps `schema`.
//
// No secrets: no tokens, passwords, FTP settings, the PoE switch's host or
// the camera serial.

export type ItemId = 'camera' | 'stream' | 'events' | 'ftp' | 'storage' | 'disk' | 'cpuTemp' | 'underVoltage' | 'inventory' | 'version';
export interface HealthItem { id: ItemId; label: string; value: boolean | number | string | null; text: string; problem: boolean }
export interface Thresholds { diskPercent: number; tempC: number; ftpStalledHours: number }
export interface LastInventory { kind: string; op: 'check' | 'repair'; outcome: 'ok' | 'cancelled' | 'failed'; startedAt: number; message: string }
type RebootPhase = RebootState['phase'];

export interface HealthInput {
  now: number;
  version: string;
  startedAt: number | null;
  thresholds: Thresholds;
  camera: { id: string; name: string; host: string; state: CameraState; reboot: RebootPhase | null; poeSwitch: { model: string; port: number | null } | null };
  stream: { enabled: boolean; up: boolean; lastFrameTs: number | null };
  intake: IntakeState;
  ftp: { enabled: boolean; listening: boolean; camera: CameraFtpView | null; stalled: ClipsStall | null; lastClip: number | null; clips: number; failures: number };
  storage: { paused: boolean; lastRun: number | null };
  recordingsCache: { bytes: number; files: number; capBytes: number };
  sseClients: number;
  lastInventory: LastInventory | null;
  reading: HostReading;
}

export interface HealthSummary {
  schema: 1;
  generatedAt: number;
  version: string;
  startedAt: number | null;
  ok: boolean;
  problemCount: number;
  thresholds: Thresholds;
  platform: { pi: boolean; model: string | null; hostStats: boolean };
  items: HealthItem[];
  camera: { id: string; name: string; address: string; online: boolean; since: number; model: string | null; firmware: string | null; clockOffsetMs: number | null; error: string | null; reboot: RebootPhase | null; poeSwitch: { model: string; port: number | null } | null };
  stream: { enabled: boolean; up: boolean; lastFrameAt: number | null };
  events: { onvif: IntakeState['onvif']; source: IntakeState['source']; since: number; resubscribes: number };
  ftp: { enabled: boolean; listening: boolean; cameraUpload: CameraFtpView['state'] | null; checkedAt: number | null; lastClipAt: number | null; clipsStored: number; failures: number; stalled: boolean; eventsWithoutClip: number };
  proxy: { sseClients: number; storagePaused: boolean; lastRetentionRun: number | null; recordingsCache: { bytes: number; files: number; capBytes: number }; lastInventory: LastInventory | null };
  disk: DataVolume | null;
  host: HostStats | null;
}

const GB = 1024 ** 3;
const FTP_TEXT: Record<CameraFtpView['state'], string> = {
  on: 'on',
  off: 'off on the camera',
  elsewhere: 'points elsewhere',
  server_differs: 'other server name',
  not_set_up: 'not set up',
  unknown: 'not read yet',
};

export function buildHealth(i: HealthInput): HealthSummary {
  const items: HealthItem[] = [];
  const add = (id: ItemId, label: string, value: HealthItem['value'], text: string, problem: boolean) => items.push({ id, label, value, text, problem });

  const cam = i.camera.state;
  const camText = cam.online ? 'online' : i.camera.reboot === 'rebooting' || i.camera.reboot === 'power-cycling' ? i.camera.reboot : 'offline';
  add('camera', 'Camera', cam.online, camText, !cam.online);

  const stream = !i.stream.enabled ? 'off' : i.stream.up ? 'up' : 'down';
  add('stream', 'Live stream', stream, stream, stream === 'down');

  const onvif = i.intake.onvif;
  add('events', 'Events intake', onvif, onvif === 'subscribed' ? onvif : `${onvif}${i.intake.source === 'poll' ? ', polling' : ''}`, onvif !== 'subscribed');

  const stalled = i.ftp.enabled && i.ftp.stalled?.stalled === true;
  if (!i.ftp.enabled) add('ftp', 'Camera FTP upload', 'disabled', 'off in the proxy', false);
  else {
    const st = i.ftp.camera?.state ?? 'unknown';
    const text = stalled ? `no clip for ${i.ftp.stalled!.hours} h` : FTP_TEXT[st];
    // Never set up counts too while the proxy takes clips (Klaus, 2026-10-03).
    add('ftp', 'Camera FTP upload', st, text, stalled || st === 'off' || st === 'elsewhere' || st === 'not_set_up');
  }

  add('storage', 'Storage', i.storage.paused ? 'paused' : 'writing', i.storage.paused ? 'paused (low space)' : 'writing', i.storage.paused);

  const disk = i.reading.disk;
  if (disk) add('disk', 'Disk', disk.usedPercent, `${disk.usedPercent.toFixed(1)} % of ${(disk.sizeBytes / GB).toFixed(1)} GB`, disk.usedPercent >= i.thresholds.diskPercent);

  const host = i.reading.host;
  if (host?.cpuTempC != null) add('cpuTemp', 'CPU temperature', host.cpuTempC, `${host.cpuTempC.toFixed(1)} °C`, host.cpuTempC >= i.thresholds.tempC);
  if (host?.underVoltage != null) add('underVoltage', 'Under-voltage', host.underVoltage, host.underVoltage ? 'detected' : 'no', host.underVoltage);

  const inv = i.lastInventory;
  add('inventory', 'Last inventory', inv?.outcome ?? null, inv ? `${inv.kind}${inv.op === 'repair' ? ' repair' : ''}: ${inv.outcome}` : 'none yet', inv?.outcome === 'failed');

  add('version', 'Version', i.version, i.version, false);

  const problemCount = items.filter((x) => x.problem).length;
  return {
    schema: 1,
    generatedAt: i.now,
    version: i.version,
    startedAt: i.startedAt,
    ok: problemCount === 0,
    problemCount,
    thresholds: { ...i.thresholds },
    platform: { pi: i.reading.platform.pi, model: i.reading.platform.model, hostStats: i.reading.platform.hostStats },
    items,
    camera: {
      id: i.camera.id,
      name: i.camera.name,
      address: splitHost(i.camera.host).hostname,
      online: cam.online,
      since: cam.since,
      model: cam.model ?? null,
      firmware: cam.firmware ?? null,
      clockOffsetMs: cam.clockOffsetMs ?? null,
      error: cam.error ?? null,
      reboot: i.camera.reboot,
      poeSwitch: i.camera.poeSwitch ? { model: i.camera.poeSwitch.model, port: i.camera.poeSwitch.port } : null,
    },
    stream: { enabled: i.stream.enabled, up: i.stream.up, lastFrameAt: i.stream.lastFrameTs },
    events: { onvif: i.intake.onvif, source: i.intake.source, since: i.intake.since, resubscribes: i.intake.resubscribes },
    ftp: {
      enabled: i.ftp.enabled,
      listening: i.ftp.listening,
      cameraUpload: i.ftp.enabled ? (i.ftp.camera?.state ?? 'unknown') : null,
      checkedAt: i.ftp.enabled ? (i.ftp.camera?.checkedAt ?? null) : null,
      lastClipAt: i.ftp.lastClip,
      clipsStored: i.ftp.clips,
      failures: i.ftp.failures,
      stalled,
      eventsWithoutClip: stalled ? i.ftp.stalled!.events : 0,
    },
    proxy: {
      sseClients: i.sseClients,
      storagePaused: i.storage.paused,
      lastRetentionRun: i.storage.lastRun,
      recordingsCache: { ...i.recordingsCache },
      lastInventory: inv ? { ...inv } : null,
    },
    disk: disk ? { ...disk } : null,
    host: host ? structuredClone(host) : null,
  };
}
