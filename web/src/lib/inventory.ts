// The Maintenance page's Inventory box (spec 2026-10-02-inventory-design).

export interface Progress { phase: string; done: number; total: number; note?: string }
export interface RunningView { runId: string; kind: string; op?: 'check' | 'repair'; startedAt: number; outcome: 'running'; progress: Progress }
export interface RunSummary { runId: string; kind: string; startedAt: number; tookMs: number; outcome: 'ok' | 'cancelled' | 'failed'; counts: Record<string, number>; message: string }
export interface InventoryState { running: RunningView | null; runs: Record<string, RunSummary[]>; repairs?: Record<string, RunSummary[]> }
export type GapCause = 'stop' | 'crash' | 'reboot' | 'powercycle';
export interface Gap { from: number; to: number; seconds: number; explained: GapCause | null; explainedSeconds: number }
export interface StillsReport extends RunSummary {
  window: { from: number | null; to: number; reason: string; notes?: string[] } | null;
  top: Gap[];
  items: { type: string; minute: number }[];
  itemsTruncated: boolean;
  error?: string;
}

const REASONS: Record<string, string> = {
  retention: 'the retention window',
  budget: 'shorter: older stills were deleted for space',
  'store-younger': 'shorter: the store is younger than the retention',
  empty: 'no stills stored',
};
const CAUSES: Record<GapCause, string> = { stop: 'proxy stopped', crash: 'proxy crashed', reboot: 'camera reboot', powercycle: 'power cycle' };
const local = (ms: number) => new Date(ms).toLocaleString();

// 0 s, 59 s, 1 min, 10 min 5 s, 1 h, 1 h 30 min (no seconds once it is hours).
export function duration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  const m = Math.floor((s % 3600) / 60);
  return `${Math.floor(s / 3600)} h${m ? ` ${m} min` : ''}`;
}

export function progressText(r: RunningView): string {
  const p = r.progress;
  if (r.op === 'repair') return p.total ? `Repairing ${r.kind}… ${p.done} of ${p.total}` : `Repairing ${r.kind}…`;
  const what = p.phase === 'camera' ? `Comparing ${r.kind} with the camera` : `Checking ${r.kind}`;
  return p.total ? `${what}… day ${p.done} of ${p.total}${p.note ? ` (${p.note})` : ''}` : `${what}…`;
}

export function stillsLines(r: StillsReport, fmt: (ms: number) => string = local): string[] {
  if (r.outcome === 'failed') return [`Failed: ${r.error ?? 'unknown error'}`];
  if (!r.window || r.window.from === null) return ['No stills stored'];
  const c = r.counts;
  return [
    ...(r.outcome === 'cancelled' ? ['Cancelled: the counts are partial'] : []),
    `Window: ${fmt(r.window.from)} to ${fmt(r.window.to)} (${REASONS[r.window.reason] ?? r.window.reason})`,
    `Missing: ${duration(c.missingSeconds)} of ${duration(c.expectedSeconds)} (${c.missingPct}%) in ${c.gaps} gaps`,
    `Explained (proxy stop or crash, camera reboot or power cycle): ${duration(c.explainedSeconds)}; unexplained: ${duration(c.unexplainedSeconds)}`,
    `Restorable from local clips: ${duration(c.restorableSeconds)}`,
    `Files: ${c.unreadablePacks} unreadable packs, ${c.packsWithoutSprite} packs without sprite, ${c.spritesWithoutPack} sprites without pack`,
  ];
}

export function gapRows(r: StillsReport, fmt: (ms: number) => string = local): { from: string; to: string; length: string; why: string }[] {
  return r.top.map((g) => ({
    from: fmt(g.from),
    to: fmt(g.to),
    length: duration(g.seconds),
    why: g.explained ? `${CAUSES[g.explained]} (${duration(g.explainedSeconds)})` : '—',
  }));
}

// Quiet notes under the result: previews pruned by their own retention are not
// file problems; the camera-clock note of the restorable count.
export function stillsNotes(r: StillsReport): string[] {
  if (r.outcome === 'failed' || !r.window || r.window.from === null) return [];
  const pruned = r.counts.previewsPruned ?? 0;
  return [...(pruned ? [`${pruned} packs without sprite were previews already pruned by their own retention; not counted as problems`] : []), ...(r.window.notes ?? [])];
}

// The clips inventory (#74) and its repair.
export const REPAIR_MAX_CLIPS = 50; // the server's cap per run (src/inventory/repair-clips.ts)
export const REPAIR_MAX_AGE_MS = 3_600_000; // a repair needs a compare less than an hour old
export interface CameraDayRow { date: string; state: 'listed' | 'unknown'; recordings: number; missingLocally: number; goneFromCamera: number }
export interface ClipsReport extends RunSummary {
  window: { from: number | null; to: number; reason: string; notes?: string[]; camera?: { stream: string; to: number; oldestSdDay: string | null; unknownDays: string[] } } | null;
  options?: { camera?: boolean };
  top: CameraDayRow[];
  items: { type: string; size?: number }[];
  itemsTruncated: boolean;
  error?: string;
}
export interface RepairItem { id: string; start: number; result: 'ok' | 'skipped' | 'failed'; reason?: string }
export interface RepairReport extends RunSummary {
  source?: string;
  stopped?: string | null;
  top: { id: string; start: number; error: string }[];
  items?: RepairItem[];
  error?: string;
}

export const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MB`;

export function clipsLines(r: ClipsReport, fmt: (ms: number) => string = local): string[] {
  if (r.outcome === 'failed') return [`Failed: ${r.error ?? 'unknown error'}`];
  if (!r.window || r.window.from === null) return [];
  const c = r.counts;
  const cam = r.window.camera;
  return [
    ...(r.outcome === 'cancelled' ? ['Cancelled: the counts are partial'] : []),
    `Window: ${fmt(r.window.from)} to ${fmt(r.window.to)} (the clips retention, ${c.clipsDays} days)`,
    `Clips: ${c.clips}${c.fromCamera ? ` (${c.fromCamera} from the camera)` : ''}; ${c.rowsWithoutFile} without their file, ${c.filesWithoutRow} files without a clip`,
    `Events: ${c.eventsWithoutClip} of ${c.events} recording events without a clip; ${c.clipsWithoutEvent} clips without an event`,
    ...(cam
      ? [
          `Camera (${cam.stream}): ${c.recordings} recordings, ${c.paired} here, ${c.missingLocally} missing here (${mb(c.missingLocallyBytes)}), ${c.timerOnly} timer-only (ignored)`,
          ...(c.pairedOtherStream ? [`${c.pairedOtherStream} recordings are here as clips of the other stream (not counted as missing)`] : []),
          `Gone from the camera: ${c.goneFromCamera} local clips; ${c.olderThanSd} older than the SD card's oldest day (${cam.oldestSdDay ?? 'none'})`,
          ...(cam.unknownDays.length ? [`Not listed (the Search failed, nothing counted as missing): ${cam.unknownDays.join(', ')}`] : []),
        ]
      : []),
  ];
}

// The repair the newest clips report allows: a finished compare with the
// camera, less than an hour old, with recordings missing here. `count` and
// `bytes` are what one run fetches at most (the first 50 candidates).
export function repairOffer(r: ClipsReport | null, now: number, repair: { source?: string } | null = null): { count: number; bytes: number } | null {
  if (!r || repair?.source === r.runId || r.outcome !== 'ok' || !r.options?.camera || now - r.startedAt >= REPAIR_MAX_AGE_MS || !r.counts.missingLocally) return null;
  const first = r.items.filter((x) => x.type === 'missing-locally').slice(0, REPAIR_MAX_CLIPS);
  return { count: Math.min(r.counts.missingLocally, REPAIR_MAX_CLIPS), bytes: first.reduce((n, x) => n + (x.size ?? 0), 0) };
}

const SKIPS: Record<string, string> = {
  'outside-retention': 'outside the retention',
  'already-local': 'already here',
  'gone-from-camera': 'gone from the camera',
  'other-stream': 'of the other stream',
  viewer: 'a viewer was downloading it',
  invalid: 'unusable file name',
};
const STOPS: Record<string, string> = {
  'clip-cap': 'the 50-clip cap',
  'byte-cap': 'the 200 MB cap',
  'max-gb': 'ftp.maxGB would be exceeded',
  paused: 'storage is paused (disk full)',
  failures: '3 failures in a row',
  refused: 'the camera refused a download',
  camera_offline: 'the camera is offline',
};

export function repairLines(r: RepairReport): string[] {
  if (r.outcome === 'failed') return [`Failed: ${r.error ?? 'unknown error'}`];
  const c = r.counts;
  const skips = new Map<string, number>();
  for (const i of r.items ?? []) if (i.result === 'skipped') skips.set(i.reason ?? 'other', (skips.get(i.reason ?? 'other') ?? 0) + 1);
  return [
    ...(r.outcome === 'cancelled' ? ['Cancelled: the clips fetched so far stay'] : []),
    `Fetched: ${c.done ?? 0} of ${c.requested ?? 0} (${mb(c.bytes ?? 0)}); failed: ${c.failed ?? 0}; skipped: ${c.skipped ?? 0}`,
    ...[...skips].map(([k, n]) => `Skipped, ${SKIPS[k] ?? k}: ${n}`),
    ...(r.stopped ? [`Stopped: ${STOPS[r.stopped] ?? r.stopped}`] : []),
  ];
}

export function repairRows(r: RepairReport, fmt: (ms: number) => string = local): { at: string; error: string }[] {
  return r.top.map((f) => ({ at: fmt(f.start), error: f.error }));
}
