import { analysesFor } from '../catalog/analyses';
import type { Catalog } from '../catalog/db';
import { eventsOverlapping } from '../catalog/events';
import { checksInRange } from '../catalog/still-checks';

// The metadata snapshot and the thumbnail choice (spec
// 2026-10-05-archive-design §2.5, §2.6). The snapshot is the JSON the API
// serves (no server paths); the image paths it needs for the thumbnail stay
// in `images`.

export const SLACK_MS = 5000; // an event that ended up to 5 s before the window counts (cams's card rule)
const AI_KINDS = new Set(['person', 'vehicle', 'pet']);

interface SnapAnalysis { provider: string; status: string; stillTs: number | null; objects: unknown[]; summary: unknown[] }
export interface SnapEvent { id: number; kind: string; source: string; start: number; end: number | null; recovered: boolean; analysis: SnapAnalysis | null }
export interface SnapCheck { id: number; stillTs: number; provider: string; objects: unknown[]; summary: unknown[] }
export interface Snapshot {
  camera: { id: string; name: string; model: string | null };
  window: { from: number; to: number };
  events: SnapEvent[];
  stillChecks: SnapCheck[];
  eventKinds: string[]; // sorted, distinct
  found: string[]; // categories Vision found (analyses and checks), sorted
  proxy: { version: string };
  archivedAt: number;
}
// Image copies by event id (analyses) and by check id, for the thumbnail only.
export interface Taken { snapshot: Snapshot; images: { analyses: Map<number, string>; checks: Map<number, string> } }

const list = (s: string | null): unknown[] => {
  if (s === null) return [];
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const categories = (summary: unknown[]): string[] =>
  summary.map((x) => (x && typeof x === 'object' ? (x as { category?: unknown }).category : undefined)).filter((x): x is string => typeof x === 'string');

export function takeSnapshot(d: { catalog: Catalog; cam: string; cameraName: string; model: string | null; version: string; maxOpenMs: number; now: number }, from: number, to: number): Taken {
  const rows = eventsOverlapping(d.catalog, d.cam, from - SLACK_MS, to, d.maxOpenMs);
  const an = analysesFor(d.catalog, rows.map((e) => e.id));
  const analyses = new Map<number, string>();
  const events: SnapEvent[] = rows.map((e) => {
    const a = an.get(e.id);
    if (a?.image) analyses.set(e.id, a.image);
    return {
      id: e.id, kind: e.kind, source: e.source, start: e.start_ts, end: e.end_ts, recovered: e.source === 'recovered',
      analysis: a ? { provider: a.provider, status: a.status, stillTs: a.still_ts, objects: list(a.objects), summary: list(a.summary) } : null,
    };
  });
  const checks = new Map<number, string>();
  const stillChecks: SnapCheck[] = checksInRange(d.catalog, d.cam, from, to).map((r) => {
    if (r.image) checks.set(r.id, r.image);
    return { id: r.id, stillTs: r.still_ts, provider: r.provider, objects: list(r.objects), summary: list(r.summary) };
  });
  const found = new Set([...events.flatMap((e) => (e.analysis?.status === 'ok' ? categories(e.analysis.summary) : [])), ...stillChecks.flatMap((c) => categories(c.summary))]);
  return {
    snapshot: {
      camera: { id: d.cam, name: d.cameraName, model: d.model },
      window: { from, to },
      events,
      stillChecks,
      eventKinds: [...new Set(events.map((e) => e.kind))].sort(),
      found: [...found].sort(),
      proxy: { version: d.version },
      archivedAt: d.now,
    },
    images: { analyses, checks },
  };
}

export interface ThumbDeps {
  // The still at or just after a moment (a few seconds at most).
  stillNear: (ts: number) => Promise<{ ts: number; jpeg: Buffer } | undefined>;
  // A kept image copy (an analysis or check JPEG), by the path its row names;
  // the caller guards the folder.
  readImage: (path: string) => Promise<Buffer | undefined>;
  // The clip's first frame.
  frame: () => Promise<Buffer | undefined>;
}
export type ThumbFrom = 'analysis' | 'check' | 'still' | 'frame' | 'none';
export interface Thumb { from: ThumbFrom; at: number | null; jpeg?: Buffer }

const confirmed = (e: SnapEvent) => e.analysis?.status === 'ok' && categories(e.analysis.summary).includes(e.kind);

// Best first (ruling 12): cams's second; #157's card rule (a confirmed AI
// event's analysed copy or its still, then the first AI event's detection
// second); a still check that found something; the first frame; none.
export async function chooseThumbnail(d: ThumbDeps, t: Taken, thumbnailAt?: number): Promise<Thumb> {
  const { snapshot: s, images } = t;
  const image = async (from: 'analysis' | 'check', at: number, path: string | undefined): Promise<Thumb | undefined> => {
    const jpeg = path ? await d.readImage(path) : undefined;
    return jpeg ? { from, at, jpeg } : undefined;
  };
  const still = async (ts: number): Promise<Thumb | undefined> => {
    const r = await d.stillNear(ts);
    return r ? { from: 'still', at: r.ts, jpeg: r.jpeg } : undefined;
  };
  if (thumbnailAt !== undefined) {
    const e = s.events.find((x) => x.analysis?.stillTs === thumbnailAt && images.analyses.has(x.id));
    const c = s.stillChecks.find((x) => x.stillTs === thumbnailAt && images.checks.has(x.id));
    const hit = (e && (await image('analysis', thumbnailAt, images.analyses.get(e.id)))) || (await still(thumbnailAt)) || (c && (await image('check', thumbnailAt, images.checks.get(c.id))));
    if (hit) return hit;
  }
  const ai = s.events.filter((e) => AI_KINDS.has(e.kind) && e.start >= s.window.from - SLACK_MS && e.start <= s.window.to).sort((a, b) => a.start - b.start || a.id - b.id);
  for (const e of ai.filter(confirmed)) {
    const hit = (await image('analysis', e.analysis!.stillTs!, images.analyses.get(e.id))) || (e.analysis!.stillTs !== null ? await still(e.analysis!.stillTs) : undefined);
    if (hit) return hit;
  }
  if (ai.length) {
    const hit = await still(ai[0].start);
    if (hit) return hit;
  }
  for (const c of s.stillChecks.filter((x) => categories(x.summary).length)) {
    const hit = await image('check', c.stillTs, images.checks.get(c.id));
    if (hit) return hit;
  }
  const frame = await d.frame();
  return frame ? { from: 'frame', at: null, jpeg: frame } : { from: 'none', at: null };
}
