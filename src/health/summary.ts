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

type ItemId = 'camera' | 'stream' | 'events' | 'ftp' | 'storage' | 'disk' | 'archive' | 'cpuTemp' | 'underVoltage' | 'inventory' | 'version';
export interface HealthItem { id: ItemId; label: string; value: boolean | number | string | null; text: string; problem: boolean }
// archiveWarnPercent: while the Archive is on (spec 2026-10-05-archive-design §6).
interface Thresholds { diskPercent: number; tempC: number; ftpStalledHours: number; archiveWarnPercent?: number }
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
  // The Archive (spec 2026-10-05-archive-design §6): null or absent while it is off.
  archive?: { count: number; bytes: number; percentOfDisk: number; warning: boolean } | null;
  // The other cameras, config order (spec 2026-10-05-multi-camera-host-design §6.5); camera, stream, intake and ftp above are the first.
  others?: CameraHealthInput[];
}

// One camera's part of the input and of the summary (spec 2026-10-05-multi-camera-host-design §6.5).
export interface CameraHealthInput { camera: HealthInput['camera']; stream: HealthInput['stream']; intake: IntakeState; ftp: HealthInput['ftp'] }
export interface CameraHealth { camera: HealthSummary['camera']; stream: HealthSummary['stream']; events: HealthSummary['events']; ftp: HealthSummary['ftp']; cert: null; items: HealthItem[] }

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
  // Every camera, config order; the first is the top level (schema 1: additive).
  cameras: CameraHealth[];
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

// One camera's items and blocks (the rules of A2, unchanged).
function cameraHealth(c: CameraHealthInput): CameraHealth {
  const items: HealthItem[] = [];
  const add = (id: ItemId, label: string, value: HealthItem['value'], text: string, problem: boolean) => items.push({ id, label, value, text, problem });

  const cam = c.camera.state;
  const camText = cam.online ? 'online' : c.camera.reboot === 'rebooting' || c.camera.reboot === 'power-cycling' ? c.camera.reboot : 'offline';
  add('camera', 'Camera', cam.online, camText, !cam.online);

  const stream = !c.stream.enabled ? 'off' : c.stream.up ? 'up' : 'down';
  add('stream', 'Live stream', stream, stream, stream === 'down');

  const onvif = c.intake.onvif;
  add('events', 'Events intake', onvif, onvif === 'subscribed' ? onvif : `${onvif}${c.intake.source === 'poll' ? ', polling' : ''}`, onvif !== 'subscribed');

  const stalled = c.ftp.enabled && c.ftp.stalled?.stalled === true;
  if (!c.ftp.enabled) add('ftp', 'Camera FTP upload', 'disabled', 'off in the proxy', false);
  else {
    const st = c.ftp.camera?.state ?? 'unknown';
    const text = stalled ? `no clip for ${c.ftp.stalled!.hours} h` : FTP_TEXT[st];
    // Never set up counts too while the proxy takes clips (Klaus, 2026-10-03).
    add('ftp', 'Camera FTP upload', st, text, stalled || st === 'off' || st === 'elsewhere' || st === 'not_set_up');
  }
  return {
    camera: {
      id: c.camera.id,
      name: c.camera.name,
      address: splitHost(c.camera.host).hostname,
      online: cam.online,
      since: cam.since,
      model: cam.model ?? null,
      firmware: cam.firmware ?? null,
      clockOffsetMs: cam.clockOffsetMs ?? null,
      error: cam.error ?? null,
      reboot: c.camera.reboot,
      poeSwitch: c.camera.poeSwitch ? { model: c.camera.poeSwitch.model, port: c.camera.poeSwitch.port } : null,
    },
    stream: { enabled: c.stream.enabled, up: c.stream.up, lastFrameAt: c.stream.lastFrameTs },
    events: { onvif: c.intake.onvif, source: c.intake.source, since: c.intake.since, resubscribes: c.intake.resubscribes },
    ftp: {
      enabled: c.ftp.enabled,
      listening: c.ftp.listening,
      cameraUpload: c.ftp.enabled ? (c.ftp.camera?.state ?? 'unknown') : null,
      checkedAt: c.ftp.enabled ? (c.ftp.camera?.checkedAt ?? null) : null,
      lastClipAt: c.ftp.lastClip,
      clipsStored: c.ftp.clips,
      failures: c.ftp.failures,
      stalled,
      eventsWithoutClip: stalled ? c.ftp.stalled!.events : 0,
    },
    cert: null, // P5 fills it (spec §10.5)
    items,
  };
}

// One item per kind for the whole host (spec §6.5): with one camera exactly
// that camera's; with several, value = the cameras without the problem.
function aggregate(per: { cam: string; item: HealthItem }[]): HealthItem {
  const first = per[0].item;
  if (per.length === 1) return first;
  const bad = per.filter((p) => p.item.problem);
  const value = per.length - bad.length;
  const word = { camera: 'online', stream: 'up', events: 'subscribed', ftp: 'on' }[first.id as 'camera' | 'stream' | 'events' | 'ftp'];
  const same = per.every((p) => p.item.text === first.text);
  const text = bad.length === 1 ? `${bad[0].cam} ${bad[0].item.text}` : bad.length > 1 ? `${value} of ${per.length} ${word}` : same ? `all ${per.length} ${first.text}` : `no problem (${per.length} cameras)`;
  return { id: first.id, label: first.label, value, text, problem: bad.length > 0 };
}

export function buildHealth(i: HealthInput): HealthSummary {
  const items: HealthItem[] = [];
  const add = (id: ItemId, label: string, value: HealthItem['value'], text: string, problem: boolean) => items.push({ id, label, value, text, problem });

  const cams = [{ camera: i.camera, stream: i.stream, intake: i.intake, ftp: i.ftp }, ...(i.others ?? [])].map((c) => ({ id: c.camera.id, h: cameraHealth(c) }));
  for (const id of ['camera', 'stream', 'events', 'ftp'] as const) items.push(aggregate(cams.map((c) => ({ cam: c.id, item: c.h.items.find((x) => x.id === id)! }))));

  add('storage', 'Storage', i.storage.paused ? 'paused' : 'writing', i.storage.paused ? 'paused (low space)' : 'writing', i.storage.paused);

  const disk = i.reading.disk;
  if (disk) add('disk', 'Disk', disk.usedPercent, `${disk.usedPercent.toFixed(1)} % of ${(disk.sizeBytes / GB).toFixed(1)} GB`, disk.usedPercent >= i.thresholds.diskPercent);

  // The Archive's size against archive.warnPercent: a warning, never a limit.
  const ar = i.archive;
  if (ar) add('archive', 'Archive', ar.percentOfDisk, `${ar.count} clip${ar.count === 1 ? '' : 's'}, ${(ar.bytes / GB).toFixed(1)} GB (${ar.percentOfDisk.toFixed(1)} % of disk)`, ar.warning);

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
    camera: cams[0].h.camera,
    stream: cams[0].h.stream,
    events: cams[0].h.events,
    ftp: cams[0].h.ftp,
    proxy: {
      sseClients: i.sseClients,
      storagePaused: i.storage.paused,
      lastRetentionRun: i.storage.lastRun,
      recordingsCache: { ...i.recordingsCache },
      lastInventory: inv ? { ...inv } : null,
    },
    disk: disk ? { ...disk } : null,
    host: host ? structuredClone(host) : null,
    cameras: cams.map((c) => c.h),
  };
}
