import { splitHost } from '../camera/http';
import type { CertState } from '../tls/camera-certs';
import type { CameraState } from '../camera/status';
import type { CameraFtpView, ClipsStall } from '../clips/ftp-health';
import type { IntakeState } from '../events/intake';
import type { DataVolume, HostReading, HostStats } from './host';
import type { RebootState } from '../camera/reboot';
import type { SdView } from '../camera/sd-card';

// The health summary (spec 2026-10-03-health-summary-design A2): the one
// place with the problem rules. The Status page's Health and Pi cards, its red
// marks, and GET /api/local/health (the e-paper display) all read it, so they
// never disagree. The JSON is fixed in the plan
// (docs/superpowers/plans/2026-10-03-health-summary.md, "The API schema");
// a breaking change bumps `schema`.
//
// No secrets: no tokens, passwords, FTP settings, the PoE switch's host or
// the camera serial.

type ItemId = 'camera' | 'stream' | 'events' | 'ftp' | 'sd' | 'storage' | 'disk' | 'archive' | 'certificates' | 'cpuTemp' | 'underVoltage' | 'inventory' | 'version';
// warning (#199): present (true) on an item that needs a look but is no problem; it never counts in problemCount.
export interface HealthItem { id: ItemId; label: string; value: boolean | number | string | null; text: string; problem: boolean; warning?: true }
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
  // The camera's SD card (#199): null before the first read; absent from an input without it (no sd key, no item).
  sd?: SdHealthInput | null;
  storage: { paused: boolean; lastRun: number | null };
  recordingsCache: { bytes: number; files: number; capBytes: number };
  sseClients: number;
  lastInventory: LastInventory | null;
  reading: HostReading;
  // The Archive (spec 2026-10-05-archive-design §6): null or absent while it is off.
  archive?: { count: number; bytes: number; percentOfDisk: number; warning: boolean } | null;
  // The other cameras, config order (spec 2026-10-05-multi-camera-host-design §6.5); camera, stream, intake and ftp above are the first.
  others?: CameraHealthInput[];
  // The site CA (spec §10.5): absent or null without tls.site (the Pi: no item).
  certificates?: { proxy: { notAfter: number } | null; cameras: { id: string; state: CertState }[]; problems: string[] } | null;
}

// One camera's part of the input and of the summary (spec 2026-10-05-multi-camera-host-design §6.5).
export interface CameraHealthInput { camera: HealthInput['camera']; stream: HealthInput['stream']; intake: IntakeState; ftp: HealthInput['ftp']; sd?: SdHealthInput | null }
// The SD watch's view, with the camera's UTC offset (minutes) at its newest recording for the text; without it, UTC.
export type SdHealthInput = SdView & { offsetMinutes?: number };
// What the summary shows of the card (camera.sd).
export interface SdHealth { mounted: boolean; formatted: boolean; capacityMB: number | null; freeMB: number | null; overwrite: boolean | null; recordingEnabled: boolean | null; checkedAt: number; lastRecordingAt: number | null; stalled: boolean }
export interface CameraHealth { camera: HealthSummary['camera']; stream: HealthSummary['stream']; events: HealthSummary['events']; ftp: HealthSummary['ftp']; cert: CertState | null; items: HealthItem[] }

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
  camera: { id: string; name: string; address: string; online: boolean; since: number; model: string | null; firmware: string | null; clockOffsetMs: number | null; error: string | null; reboot: RebootPhase | null; poeSwitch: { model: string; port: number | null } | null; sd?: SdHealth | null };
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

// The SD card's rules (#199, Klaus 2026-10-07): overwrite off is a warning
// on its own; a card that can't take recordings, recording off, a nearly full
// card (free under 5 %) with overwrite off, and recording to the card that
// stopped (its newest recording more than an hour before the newest FTP
// clip, the camera online) are problems. The first that applies is the text.
const SD_FULL_FRACTION = 0.05;
const SD_STALL_MS = 3600_000;
const camTime = (ts: number, offsetMinutes: number | undefined) => `${new Date(ts + (offsetMinutes ?? 0) * 60_000).toISOString().slice(0, 16).replace('T', ' ')}${offsetMinutes === undefined ? ' UTC' : ''}`;
function sdState(sd: SdHealthInput, online: boolean): { value: string; text: string; problem: boolean; warning: boolean; stalled: boolean } {
  const stalled = online && sd.lastClipAt !== null && sd.recordingsFrom !== null && (sd.lastRecordingAt === null || sd.lastClipAt - sd.lastRecordingAt > SD_STALL_MS);
  const nearlyFull = sd.capacityMB !== null && sd.freeMB !== null && sd.freeMB < sd.capacityMB * SD_FULL_FRACTION;
  const bad = (value: string, text: string) => ({ value, text, problem: true, warning: false, stalled });
  if (!sd.present) return bad('no_card', "No SD card: the camera can't record");
  if (!sd.mounted) return bad('not_mounted', "The SD card isn't mounted: the camera can't record to it");
  if (!sd.formatted) return bad('not_formatted', "The SD card isn't formatted: the camera can't record to it");
  if (sd.recordingEnabled === false) return bad('recording_off', "Recording is off: the camera doesn't record to its SD card");
  if (nearlyFull && sd.overwrite === false) return bad('almost_full', 'SD card almost full and overwrite is off: recording to the SD card will stop');
  if (stalled) return bad('stalled', sd.lastRecordingAt === null ? `The camera hasn't recorded to its SD card for more than ${Math.round((sd.checkedAt - sd.recordingsFrom!) / 3600_000)} h` : `The camera hasn't recorded to its SD card since ${camTime(sd.lastRecordingAt, sd.offsetMinutes)}`);
  if (sd.overwrite === false) return { value: 'overwrite_off', text: 'Overwrite is off: the camera stops recording to its SD card when it is full', problem: false, warning: true, stalled };
  const gb = (m: number) => (m / 1024).toFixed(1);
  const space = sd.capacityMB !== null && sd.freeMB !== null ? `${gb(sd.freeMB)} of ${gb(sd.capacityMB)} GB free` : 'mounted';
  return { value: 'ok', text: `${space}${sd.overwrite ? ', overwrite on' : ''}`, problem: false, warning: false, stalled };
}

// One camera's items and blocks (the rules of A2, unchanged).
function cameraHealth(c: CameraHealthInput): CameraHealth {
  const items: HealthItem[] = [];
  const add = (id: ItemId, label: string, value: HealthItem['value'], text: string, problem: boolean, warning = false) => items.push({ id, label, value, text, problem, ...(warning ? { warning: true as const } : {}) });

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
  const sd = c.sd ? sdState(c.sd, cam.online) : null;
  if (sd) add('sd', 'SD card', sd.value, sd.text, sd.problem, sd.warning);
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
      // Only with an sd input (schema 1, additive): null until the first read.
      ...(c.sd === undefined ? {} : { sd: c.sd && sd ? { mounted: c.sd.mounted, formatted: c.sd.formatted, capacityMB: c.sd.capacityMB, freeMB: c.sd.freeMB, overwrite: c.sd.overwrite, recordingEnabled: c.sd.recordingEnabled, checkedAt: c.sd.checkedAt, lastRecordingAt: c.sd.lastRecordingAt, stalled: sd.stalled } : null }),
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
    cert: null, // buildHealth fills it from the certificates input (spec §10.5)
    items,
  };
}

// One item per kind for the whole host (spec §6.5): with one camera exactly
// that camera's; with several, value = the cameras without the problem. A
// warning (sd, #199) only shows while no camera has a problem.
function aggregate(per: { cam: string; item: HealthItem }[]): HealthItem {
  const first = per[0].item;
  if (per.length === 1) return first;
  const bad = per.filter((p) => p.item.problem);
  const warned = bad.length ? [] : per.filter((p) => p.item.warning);
  const value = per.length - bad.length;
  const word = { camera: 'online', stream: 'up', events: 'subscribed', ftp: 'on', sd: 'fine' }[first.id as 'camera' | 'stream' | 'events' | 'ftp' | 'sd'];
  // Each card's own figures (sd) are no common text.
  const same = first.id !== 'sd' && per.every((p) => p.item.text === first.text);
  const text = bad.length === 1 ? `${bad[0].cam} ${bad[0].item.text}` : bad.length > 1 ? `${value} of ${per.length} ${word}`
    : warned.length === 1 ? `${warned[0].cam} ${warned[0].item.text}` : warned.length > 1 ? `${warned.length} of ${per.length} cameras with a warning`
    : same ? `all ${per.length} ${first.text}` : `no problem (${per.length} cameras)`;
  return { id: first.id, label: first.label, value, text, problem: bad.length > 0, ...(warned.length ? { warning: true as const } : {}) };
}

export function buildHealth(i: HealthInput): HealthSummary {
  const items: HealthItem[] = [];
  const add = (id: ItemId, label: string, value: HealthItem['value'], text: string, problem: boolean) => items.push({ id, label, value, text, problem });

  const cams = [{ camera: i.camera, stream: i.stream, intake: i.intake, ftp: i.ftp, ...(i.sd === undefined ? {} : { sd: i.sd }) }, ...(i.others ?? [])].map((c) => ({ id: c.camera.id, h: cameraHealth(c) }));
  for (const c of cams) c.h.cert = i.certificates?.cameras.find((x) => x.id === c.id)?.state ?? null;
  for (const id of ['camera', 'stream', 'events', 'ftp'] as const) {
    let per = cams.map((c) => ({ cam: c.id, item: c.h.items.find((x) => x.id === id)! }));
    // FTP: only the cameras that upload (one FTP camera: its item, as on one camera); none: the first's "off".
    if (id === 'ftp') per = per.filter((p) => p.item.value !== 'disabled').length ? per.filter((p) => p.item.value !== 'disabled') : per.slice(0, 1);
    items.push(aggregate(per));
  }
  // The SD card (#199): the cameras read so far; none: no item.
  const sdPer = cams.flatMap((c) => c.h.items.filter((x) => x.id === 'sd').map((item) => ({ cam: c.id, item })));
  if (sdPer.length) items.push(aggregate(sdPer));

  add('storage', 'Storage', i.storage.paused ? 'paused' : 'writing', i.storage.paused ? 'paused (low space)' : 'writing', i.storage.paused);

  const disk = i.reading.disk;
  if (disk) add('disk', 'Disk', disk.usedPercent, `${disk.usedPercent.toFixed(1)} % of ${(disk.sizeBytes / GB).toFixed(1)} GB`, disk.usedPercent >= i.thresholds.diskPercent);

  // The Archive's size against archive.warnPercent: a warning, never a limit.
  const ar = i.archive;
  if (ar) add('archive', 'Archive', ar.percentOfDisk, `${ar.count} clip${ar.count === 1 ? '' : 's'}, ${(ar.bytes / GB).toFixed(1)} GB (${ar.percentOfDisk.toFixed(1)} % of disk)`, ar.warning);

  // The site CA's certificates (spec §10.5, Ruling P5-9): a problem within 14
  // days of the first expiry, after a failed or refused push, or with a CA problem.
  const ce = i.certificates;
  if (ce) {
    const days = (t: number) => Math.floor((t - i.now) / 86400_000);
    const bad = ce.cameras.find((c) => c.state.lastPush && (c.state.lastPush.outcome === 'failed' || c.state.lastPush.outcome === 'refused'));
    const expiries = [
      ...(ce.proxy ? [{ who: 'the proxy', at: ce.proxy.notAfter }] : []),
      ...ce.cameras.flatMap((c) => (c.state.mode === 'site-ca' && c.state.notAfter !== null ? [{ who: c.id, at: c.state.notAfter }] : [])),
    ].sort((a, b) => a.at - b.at);
    const first = expiries[0];
    const soon = first !== undefined && days(first.at) < 14;
    const text = ce.problems[0] ?? (bad ? `${bad.id}: push ${bad.state.lastPush!.outcome}${bad.state.mode === 'pinned' ? ' (pinned)' : ''}` : soon ? `${first.who} expires in ${days(first.at)} days` : first ? `valid ${days(first.at)} more days` : 'no certificates yet');
    add('certificates', 'Certificates', first ? days(first.at) : null, text, ce.problems.length > 0 || !!bad || soon);
  }

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
