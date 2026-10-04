import type { AnalysisRow } from '../catalog/analyses';
import type { Catalog } from '../catalog/db';
import { linkedEvents, type LinkedEvent, type StillCheckRow } from '../catalog/still-checks';

// The JSON of a still check (spec 2026-10-04-still-checks-design §5.1), the
// same in the POST answer, the stream message and the reads.
const parse = (s: string | null): unknown => {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null; // one corrupt row must not fail a list
  }
};
const list = (s: string | null): unknown[] => {
  const v = parse(s);
  return Array.isArray(v) ? v : [];
};
const base = (cam: string) => `/api/cameras/${encodeURIComponent(cam)}`;

export interface CheckSummaryJson { id: number | null; stillTs: number; provider: string; summary: unknown[]; events: LinkedEvent[]; imageUrl: string | null }
export interface CheckJson extends CheckSummaryJson { eventId?: number; objects: unknown[]; requestedAt: number; tookMs: number | null }

// A list entry: no objects.
export function checkSummaryJson(c: Catalog, r: StillCheckRow, maxOpenMs: number): CheckSummaryJson {
  const summary = list(r.summary);
  return { id: r.id, stillTs: r.still_ts, provider: r.provider, summary, events: linkedEvents(c, r.cam, r.still_ts, summary, maxOpenMs), imageUrl: r.image ? `${base(r.cam)}/still-checks/${r.id}.jpg` : null };
}

export function checkJson(c: Catalog, r: StillCheckRow, maxOpenMs: number): CheckJson {
  return { ...checkSummaryJson(c, r, maxOpenMs), objects: list(r.objects), requestedAt: r.requested_at, tookMs: r.took_ms };
}

// The full record (GET …/still-checks/{id}): the provider's raw answer too.
export function checkFullJson(c: Catalog, r: StillCheckRow, maxOpenMs: number): CheckJson & { raw: unknown } {
  return { ...checkJson(c, r, maxOpenMs), raw: parse(r.raw) };
}

// A second the automatic analysis already sent, answered as a check (§2.5,
// ruling 24): no row, so no id; the event it was made for and its image.
export function analysisCheckJson(c: Catalog, cam: string, a: AnalysisRow, maxOpenMs: number): CheckJson {
  const summary = list(a.summary);
  return {
    id: null, eventId: a.event_id, stillTs: a.still_ts!, provider: a.provider, summary,
    events: linkedEvents(c, cam, a.still_ts!, summary, maxOpenMs),
    imageUrl: a.image ? `${base(cam)}/events/${a.event_id}/analysis.jpg` : null,
    objects: list(a.objects), requestedAt: a.requested_at, tookMs: a.took_ms,
  };
}
