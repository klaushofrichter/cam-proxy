// Text for the analytics UI (spec 2026-09-30-analytics-design). Pure: tested
// in test/analytics-ui.test.ts.
export interface UiProviderState {
  id: string;
  name: string;
  enabled: boolean;
  keyMasked: string | null;
  month: { calls: number; limit: number };
  today: { calls: number; cap: number };
  paused: { reason: string; until: number | null } | null;
  lastCall: { at: number; tookMs: number; status: string } | null;
  lastError: string | null;
}
export interface UiObject { name: string; score: number; box?: { x0: number; y0: number; x1: number; y1: number } }
export interface UiAnalysis { provider?: string; status: string; reason: string | null; objects: UiObject[] }

const n = (x: number) => x.toLocaleString('en-US');

export function costEstimate(monthlyLimit: number): string {
  if (monthlyLimit <= 0) return 'No calls.';
  if (monthlyLimit <= 1000) return `Up to ${n(monthlyLimit)} calls a month: free (Google's first 1,000 a month are free).`;
  const dollars = ((monthlyLimit - 1000) / 1000) * 1.5;
  return `Up to ${n(monthlyLimit)} calls a month: at most $${dollars.toFixed(2)} (the first 1,000 free, then $1.50 per 1,000).`;
}

export function usageLine(s: UiProviderState): string {
  if (!s.enabled) return 'not enabled';
  const today = s.today.cap > 0 ? `${n(s.today.calls)} of ${n(s.today.cap)} today` : `${n(s.today.calls)} today`;
  const last = s.lastCall
    ? ` · last ${new Date(s.lastCall.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} (${(s.lastCall.tookMs / 1000).toFixed(1)} s)`
    : '';
  return `${n(s.month.calls)} of ${n(s.month.limit)} this month · ${today}${last}`;
}

export function tagText(a: UiAnalysis | null): string | null {
  if (!a) return null;
  if (a.status !== 'ok') return `✦ not analysed (${a.reason ?? a.status})`;
  if (!a.objects.length) return '✦ Vision: nothing found';
  const top = [...a.objects].sort((x, y) => y.score - x.score).slice(0, 3);
  return `✦ Vision: ${top.map((o) => `${o.name} ${o.score.toFixed(2)}`).join(', ')}`;
}

// A limit typed into a number field: a whole number from 0 to max, else null
// (empty, not a number, negative, fractional or too big).
export function parseLimit(text: string | number | null | undefined, max: number): number | null {
  if (text === null || text === undefined) return null;
  const t = typeof text === 'number' ? String(text) : text.trim();
  if (!/^\d+$/.test(t)) return null;
  const v = Number(t);
  return v <= max ? v : null;
}
