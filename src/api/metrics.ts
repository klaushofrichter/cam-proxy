import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Catalog } from '../catalog/db';
import type { Config } from '../config/defaults';
import type { StreamLog, StreamMessage } from '../stream/log';
import type { Storage } from '../storage';
import type { StillsSide } from './client-api';

// One camera's figures (spec 2026-10-05-multi-camera-host-design §3.1). ftpEnabled:
// the camera's FTP upload as last read (null: not read, or FTP off for it);
// clips: clip arrival (#93; null: FTP off).
export interface CameraMetrics { id: string; up: boolean; ftpEnabled: boolean | null; clips: { lastClip: number | null; stalled: boolean } | null; onvifSubscribed: boolean; stills: StillsSide | undefined }

interface MetricsSources {
  storage: Storage;
  config: () => Config;
  catalog: Catalog;
  log: StreamLog;
  // Every camera, config order.
  cameras: () => CameraMetrics[];
  sseClients: () => number;
  version: string;
  target: string;
}

// Live events per kind (camproxy_events_stored, the status): recovered ones
// (#75) are left out, a reconstruction from the SD card, not intake.
export function eventsStored(c: Catalog): Record<string, number> {
  const rows = c.db.prepare("SELECT kind, COUNT(*) AS n FROM events WHERE source != 'recovered' GROUP BY kind").all() as { kind: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}

// The same per camera (the Status page's Events card shows the picked camera's).
export function eventsStoredByCamera(c: Catalog): Record<string, Record<string, number>> {
  const rows = c.db.prepare("SELECT cam, kind, COUNT(*) AS n FROM events WHERE source != 'recovered' GROUP BY cam, kind").all() as { cam: string; kind: string; n: number }[];
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[r.cam] ??= {})[r.kind] = r.n;
  return out;
}

// The phase 1 metrics (spec §13). Counts only, never event content.
export function createMetrics(s: MetricsSources) {
  const registry = new Registry();
  // Host totals not yet split per camera (storage, events) carry the first camera's label until P2.
  const cam = () => s.cameras()[0]?.id ?? '';
  // usage() scans the data folders: one scrape (render) measures once for all gauges.
  let scrape: ReturnType<Storage['usage']> | undefined;
  const usage = () => scrape ?? s.storage.usage();
  const g = (name: string, help: string, labelNames: string[], collect: (this: Gauge) => void) =>
    new Gauge({ name: `camproxy_${name}`, help, labelNames, registers: [registry], collect });

  const kinds = ['catalog', 'stills', 'previews', 'clips', 'recordings', 'audit'] as const;
  g('disk_bytes', 'Bytes on disk by kind', ['kind'], function () {
    const u = usage();
    for (const k of kinds) this.set({ kind: k }, u[k].bytes);
  });
  g('disk_files', 'Files on disk by kind', ['kind'], function () {
    const u = usage();
    for (const k of kinds) this.set({ kind: k }, u[k].files);
  });
  g('disk_free_bytes', 'Free bytes on the data disk', [], function () {
    this.set(usage().free);
  });
  g('disk_size_bytes', 'Size of the data disk', [], function () {
    this.set(usage().size);
  });
  g('storage_budget_bytes', 'Size budget for the data', [], function () {
    this.set(usage().budget);
  });
  g('storage_growth_bytes_per_day', 'Bytes written per day (3-day average)', ['kind'], function () {
    const u = usage();
    for (const k of ['stills', 'previews', 'clips', 'recordings'] as const) this.set({ kind: k }, u[k].growthPerDay);
  });
  g('storage_days_until_full', 'Projected days until the budget is reached (-1: not growing)', [], function () {
    this.set(usage().daysUntilFull ?? -1);
  });
  g('storage_writing_paused', '1 while free space is below the floor', [], function () {
    this.set(s.storage.paused() ? 1 : 0);
  });
  g('stills_minutes_stored', 'Minute packs of stills on disk', ['cam'], function () {
    this.set({ cam: cam() }, usage().stills.files);
  });
  g('previews_stored', 'Preview sprite sheets on disk', ['cam'], function () {
    this.set({ cam: cam() }, Math.round(usage().previews.files / 2));
  });
  g('frame_grabber_up', '1 while stills arrive', ['cam'], function () {
    this.reset();
    for (const c of s.cameras()) this.set({ cam: c.id }, c.stills?.grabber.up() ? 1 : 0);
  });
  g('go2rtc_up', '1 while go2rtc runs', ['cam'], function () {
    this.reset();
    for (const c of s.cameras()) this.set({ cam: c.id }, c.stills?.go2rtc.up() ? 1 : 0);
  });
  g('events_stored', 'Events in the catalog', ['cam', 'kind'], function () {
    this.reset();
    for (const [kind, n] of Object.entries(eventsStored(s.catalog))) this.set({ cam: cam(), kind }, n);
  });
  g('onvif_subscribed', '1 while the ONVIF subscription is active', ['cam'], function () {
    this.reset();
    for (const c of s.cameras()) this.set({ cam: c.id }, c.onvifSubscribed ? 1 : 0);
  });
  g('camera_up', '1 while the camera answers', ['cam'], function () {
    this.reset();
    for (const c of s.cameras()) this.set({ cam: c.id }, c.up ? 1 : 0);
  });
  g('camera_ftp_enabled', "1 while the camera's FTP upload is on (no sample before the first read)", ['cam'], function () {
    this.reset();
    for (const c of s.cameras()) if (c.ftpEnabled !== null) this.set({ cam: c.id }, c.ftpEnabled ? 1 : 0);
  });
  g('clips_last_received_timestamp_seconds', 'When the newest clip arrived (0: none)', ['cam'], function () {
    this.reset();
    for (const c of s.cameras()) if (c.clips) this.set({ cam: c.id }, (c.clips.lastClip ?? 0) / 1000);
  });
  g('clips_stalled', '1 while no clip arrived for ftp.stalledHours although the camera recorded events', ['cam'], function () {
    this.reset();
    for (const c of s.cameras()) if (c.clips) this.set({ cam: c.id }, c.clips.stalled ? 1 : 0);
  });
  g('sse_clients', 'Connected SSE clients', [], function () {
    this.set(s.sseClients());
  });
  g('stream_log_rows', 'Rows in the stream log', [], function () {
    this.set(s.log.count());
  });
  new Gauge({ name: 'camproxy_build_info', help: 'Build information', labelNames: ['version', 'target'], registers: [registry] }).set({ version: s.version, target: s.target }, 1);

  const events = new Counter({ name: 'camproxy_events_total', help: 'Events started', labelNames: ['cam', 'source', 'kind'], registers: [registry] });
  const sseMessages = new Counter({ name: 'camproxy_sse_messages_total', help: 'Messages appended to the stream log', labelNames: ['type'], registers: [registry] });
  const resubscribes = new Counter({ name: 'camproxy_onvif_resubscribes_total', help: 'ONVIF re-subscriptions', labelNames: ['cam'], registers: [registry] });
  const cameraErrors = new Counter({ name: 'camproxy_camera_errors_total', help: 'Failed camera checks', labelNames: ['cam', 'code'], registers: [registry] });
  const cameraSeconds = new Histogram({ name: 'camproxy_camera_request_seconds', help: 'Camera status check duration', labelNames: ['cam', 'cmd'], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry] });
  const retentionDeleted = new Counter({ name: 'camproxy_retention_deleted_total', help: 'Rows and files removed by retention', labelNames: ['kind'], registers: [registry] });
  const stillsTotal = new Counter({ name: 'camproxy_stills_total', help: 'Stills written', labelNames: ['cam'], registers: [registry] });
  const recordingDownloads = new Counter({ name: 'camproxy_recording_downloads_total', help: 'Recording downloads over Baichuan, by result; priority low: an inventory repair', labelNames: ['cam', 'stream', 'result', 'priority'], registers: [registry] });
  const stillsMissing = new Counter({ name: 'camproxy_stills_missing_total', help: 'Stills not written (disk full)', labelNames: ['cam'], registers: [registry] });
  const lastStill = new Gauge({ name: 'camproxy_last_still_timestamp_seconds', help: 'Time of the last still', labelNames: ['cam'], registers: [registry] });
  for (const { id } of s.cameras()) {
    stillsTotal.inc({ cam: id }, 0);
    stillsMissing.inc({ cam: id }, 0);
    lastStill.set({ cam: id }, 0);
    resubscribes.inc({ cam: id }, 0);
  }
  const retentionLast = new Gauge({ name: 'camproxy_retention_last_run_timestamp_seconds', help: 'Last retention run', registers: [registry] });
  for (const kind of ['events', 'streamLog', 'audit']) retentionDeleted.inc({ kind }, 0);

  s.log.on('message', (m: StreamMessage) => {
    sseMessages.inc({ type: m.type });
    if (m.type === 'camera-event' && m.data.phase === 'start') events.inc({ cam: m.cam, source: String(m.data.source), kind: String(m.data.kind) });
  });

  return {
    registry,
    // The Prometheus text, with one storage measurement for the whole scrape.
    render: async (): Promise<string> => {
      scrape = s.storage.usage();
      try {
        return await registry.metrics();
      } finally {
        scrape = undefined;
      }
    },
    // Each hook names the camera it came from.
    onResubscribe: (cam: string) => resubscribes.inc({ cam }),
    onStill: (cam: string, ts: number) => (stillsTotal.inc({ cam }), lastStill.set({ cam }, ts / 1000)),
    onStillMissing: (cam: string) => stillsMissing.inc({ cam }),
    onRecordingDownload: (cam: string, o: { stream: string; result: string; priority: string }) => recordingDownloads.inc({ cam, stream: o.stream, result: o.result, priority: o.priority }),
    onCameraCheck: (cam: string, c: { ok: boolean; ms: number; error?: string }) => {
      cameraSeconds.observe({ cam, cmd: 'status' }, c.ms / 1000);
      if (!c.ok) cameraErrors.inc({ cam, code: c.error ?? 'unknown' });
    },
    onRetention: (r: { deleted: Record<string, number>; at: number }) => {
      for (const [kind, n] of Object.entries(r.deleted)) retentionDeleted.inc({ kind }, n);
      retentionLast.set(r.at / 1000);
    },
  };
}
