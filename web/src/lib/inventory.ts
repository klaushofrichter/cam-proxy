// The Maintenance page's Inventory box (spec 2026-10-02-inventory-design).

export interface Progress { phase: string; done: number; total: number; note?: string }
export interface RunningView { runId: string; kind: string; startedAt: number; outcome: 'running'; progress: Progress }
export interface RunSummary { runId: string; kind: string; startedAt: number; tookMs: number; outcome: 'ok' | 'cancelled' | 'failed'; counts: Record<string, number>; message: string }
export interface InventoryState { running: RunningView | null; runs: Record<string, RunSummary[]> }
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
  return p.total ? `Checking ${r.kind}… day ${p.done} of ${p.total}${p.note ? ` (${p.note})` : ''}` : `Checking ${r.kind}…`;
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
