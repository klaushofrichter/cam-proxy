import { statfsSync } from 'fs';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Catalog } from '../catalog/db';
import type { Config } from '../config/defaults';
import type { StreamLog, StreamMessage } from '../stream/log';

export interface MetricsSources {
  config: () => Config;
  catalog: Catalog;
  log: StreamLog;
  cameraUp: () => boolean;
  onvifSubscribed: () => boolean;
  sseClients: () => number;
  version: string;
  target: string;
}

export function diskStats(dir: string): { free: number; size: number } {
  const s = statfsSync(dir);
  return { free: s.bavail * s.bsize, size: s.blocks * s.bsize };
}

export function eventsStored(c: Catalog): Record<string, number> {
  const rows = c.db.prepare('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind').all() as { kind: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}

// The phase 1 metrics (spec §13). Counts only, never event content.
export function createMetrics(s: MetricsSources) {
  const registry = new Registry();
  const cam = () => s.config().camera.id;
  const g = (name: string, help: string, labelNames: string[], collect: (this: Gauge) => void) =>
    new Gauge({ name: `camproxy_${name}`, help, labelNames, registers: [registry], collect });

  g('disk_bytes', 'Bytes on disk by kind', ['kind'], function () {
    this.set({ kind: 'catalog' }, s.catalog.sizeBytes());
  });
  g('disk_free_bytes', 'Free bytes on the data disk', [], function () {
    this.set(diskStats(s.config().server.dataDir).free);
  });
  g('disk_size_bytes', 'Size of the data disk', [], function () {
    this.set(diskStats(s.config().server.dataDir).size);
  });
  g('events_stored', 'Events in the catalog', ['cam', 'kind'], function () {
    this.reset();
    for (const [kind, n] of Object.entries(eventsStored(s.catalog))) this.set({ cam: cam(), kind }, n);
  });
  g('onvif_subscribed', '1 while the ONVIF subscription is active', ['cam'], function () {
    this.set({ cam: cam() }, s.onvifSubscribed() ? 1 : 0);
  });
  g('camera_up', '1 while the camera answers', ['cam'], function () {
    this.set({ cam: cam() }, s.cameraUp() ? 1 : 0);
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
  const retentionLast = new Gauge({ name: 'camproxy_retention_last_run_timestamp_seconds', help: 'Last retention run', registers: [registry] });
  resubscribes.inc({ cam: cam() }, 0);
  for (const kind of ['events', 'streamLog']) retentionDeleted.inc({ kind }, 0);

  s.log.on('message', (m: StreamMessage) => {
    sseMessages.inc({ type: m.type });
    if (m.type === 'camera-event' && m.data.phase === 'start') events.inc({ cam: m.cam, source: String(m.data.source), kind: String(m.data.kind) });
  });

  return {
    registry,
    onResubscribe: () => resubscribes.inc({ cam: cam() }),
    onCameraCheck: (c: { ok: boolean; ms: number; error?: string }) => {
      cameraSeconds.observe({ cam: cam(), cmd: 'status' }, c.ms / 1000);
      if (!c.ok) cameraErrors.inc({ cam: cam(), code: c.error ?? 'unknown' });
    },
    onRetention: (r: { deleted: Record<string, number>; at: number }) => {
      for (const [kind, n] of Object.entries(r.deleted)) retentionDeleted.inc({ kind }, n);
      retentionLast.set(r.at / 1000);
    },
  };
}
