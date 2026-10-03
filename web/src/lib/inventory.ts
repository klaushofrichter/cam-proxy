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
  // The events repair compares with the camera again first (phase 'camera').
  if (r.op === 'repair' && p.phase !== 'camera') return p.total ? `Repairing ${r.kind}… ${p.done} of ${p.total}` : `Repairing ${r.kind}…`;
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
export const REPAIR_MAX_CLIPS = 50; // the server's caps per run (src/inventory/repair-clips.ts)
export const REPAIR_MAX_BYTES = 200 * 2 ** 20;
export const REPAIR_MAX_AGE_MS = 3_600_000; // a repair needs a compare less than an hour old
export interface CameraDayRow { date: string; state: 'listed' | 'unknown'; recordings: number; missingLocally: number; goneFromCamera: number }
export interface ClipsReport extends RunSummary {
  window: { from: number | null; to: number; reason: string; notes?: string[]; camera?: { stream: string; to: number; oldestSdDay: string | null; unknownDays: string[] } } | null;
  options?: { camera?: boolean };
  top: CameraDayRow[];
  items: { type: string; start?: number; size?: number }[];
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
          ...(c.prunedHere ? [`${c.prunedHere} recordings are older than the oldest clip here, deleted for space (not offered: they would be deleted again)`] : []),
          `Gone from the camera: ${c.goneFromCamera} local clips; ${c.olderThanSd} older than the SD card's oldest day (${cam.oldestSdDay ?? 'none'})`,
          ...(cam.unknownDays.length ? [`Not listed (the Search failed, nothing counted as missing): ${cam.unknownDays.join(', ')}`] : []),
        ]
      : []),
  ];
}

// The repair the newest clips report allows: a finished compare with the
// camera, less than an hour old, with recordings missing here. `count` and
// `bytes` are what one run fetches at most, picked as the server picks:
// the oldest 50 candidates, a recording larger than 200 MB skipped
// (`tooBig`), one that would pass the 200 MB after the others skipped too.
export function repairOffer(r: ClipsReport | null, now: number, repair: { source?: string } | null = null): { count: number; bytes: number; tooBig: number } | null {
  if (!r || repair?.source === r.runId || r.outcome !== 'ok' || !r.options?.camera || now - r.startedAt >= REPAIR_MAX_AGE_MS || !r.counts.missingLocally) return null;
  const first = r.items
    .filter((x) => x.type === 'missing-locally')
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
    .slice(0, REPAIR_MAX_CLIPS);
  const offer = { count: 0, bytes: 0, tooBig: 0 };
  for (const x of first) {
    const size = x.size ?? 0;
    if (size > REPAIR_MAX_BYTES) offer.tooBig++;
    else if (offer.bytes + size <= REPAIR_MAX_BYTES) {
      offer.count++;
      offer.bytes += size;
    }
  }
  return offer;
}

const SKIPS: Record<string, string> = {
  'outside-retention': 'outside the retention',
  'already-local': 'already here',
  'gone-from-camera': 'gone from the camera',
  'other-stream': 'of the other stream',
  viewer: 'a viewer was downloading it',
  invalid: 'unusable file name',
  'too-big': "larger than one run's 200 MB",
  'byte-cap': "would pass this run's 200 MB",
  busy: "the camera's Search stayed busy",
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

// The events inventory (#75) and its repair.
export const RECOVER_MAX = 1000; // the server's cap per run (src/inventory/repair-events.ts)
export interface EventsDayRow { date: string; state: 'listed' | 'unknown'; spans: number; missing: number }
export interface EventsReport extends RunSummary {
  window: { from: number | null; to: number; reason: string; notes?: string[]; eventsDays?: number; camera?: { stream: string; to: number; oldestSdDay: string | null; unknownDays: string[] } } | null;
  top: EventsDayRow[];
  items: { type: string; kind?: string; start?: number }[];
  itemsTruncated: boolean;
  error?: string;
}
const KINDS = ['person', 'vehicle', 'pet', 'motion'];
// "person 3, motion 9" from counts named <prefix><Kind>, or "none".
export function kindsText(counts: Record<string, number>, prefix: string): string {
  return KINDS.map((k) => [k, counts[`${prefix}${k[0].toUpperCase()}${k.slice(1)}`] ?? 0] as const).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
}
const EVENT_WINDOWS: Record<string, string> = { 'sd-card': "the SD card's reach", retention: 'the events retention' };

export function eventsLines(r: EventsReport, fmt: (ms: number) => string = local): string[] {
  if (r.outcome === 'failed') return [`Failed: ${r.error ?? 'unknown error'}`];
  if (!r.window) return [];
  const c = r.counts;
  const cam = r.window.camera;
  if (r.window.from === null) return [`No recordings on the SD card${cam ? ` (${cam.stream})` : ''} in the last ${c.eventsDays} days`];
  return [
    ...(r.outcome === 'cancelled' ? ['Cancelled: the counts are partial'] : []),
    `Window: ${fmt(r.window.from)} to ${fmt(r.window.to)} (${EVENT_WINDOWS[r.window.reason] ?? r.window.reason}; events are kept ${c.eventsDays} days)`,
    `Camera${cam ? ` (${cam.stream})` : ''}: ${c.recordings} recordings with a trigger in ${c.spans} spans by kind, ${c.timerOnly} timer-only (ignored)`,
    `Missing: ${c.missingEvents} spans without an event (${kindsText(c, 'missing')}); ${c.matched} have one`,
    `Events without a recording: ${c.eventsWithoutRecording} of ${c.events} (report only)`,
    ...(cam?.unknownDays.length ? [`Not listed (the Search failed, nothing judged): ${cam.unknownDays.join(', ')}`] : []),
  ];
}

// The repair the newest events report allows: a finished check less than an
// hour old with events missing, that no repair has used yet. `count` is
// what one run adds at most.
export function eventsOffer(r: EventsReport | null, now: number, repair: { source?: string } | null = null): { count: number } | null {
  if (!r || repair?.source === r.runId || r.outcome !== 'ok' || now - r.startedAt >= REPAIR_MAX_AGE_MS || !r.counts.missingEvents) return null;
  return { count: Math.min(r.counts.missingEvents, RECOVER_MAX) };
}

export function eventsRepairLines(r: RepairReport): string[] {
  if (r.outcome === 'failed') return [`Failed: ${r.error ?? 'unknown error'}`];
  if (r.outcome === 'cancelled') return ['Cancelled: nothing was added'];
  const c = r.counts;
  return [
    `Added: ${c.done ?? 0} of ${c.requested ?? 0} (${kindsText(c, 'done')}); had an event by then: ${c.skipped ?? 0}`,
    ...(c.candidates !== c.checked ? [`Missing when added: ${c.candidates ?? 0} (the check found ${c.checked ?? 0})`] : []),
    ...(r.stopped === 'event-cap' ? [`Stopped: the ${RECOVER_MAX}-event cap; check again for the rest`] : []),
  ];
}
