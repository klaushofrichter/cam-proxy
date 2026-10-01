// Text for the analytics UI (spec 2026-09-30-analytics-design). Pure: tested
// in test/analytics-ui.test.ts.
export interface UiProviderState {
  id: string;
  name: string;
  enabled: boolean;
  keyMasked: string | null;
  keySource?: 'env' | 'manual' | 'none';
  month: { calls: number; limit: number };
  today: { calls: number; cap: number };
  paused: { reason: string; until: number | null } | null;
  lastCall: { at: number; tookMs: number; status: string } | null;
  lastError: string | null;
}
export interface UiObject { name: string; score: number; box?: { x0: number; y0: number; x1: number; y1: number } }
export interface UiSummaryEntry { category: 'person' | 'vehicle' | 'pet'; subtype: string; score: number; box: { x0: number; y0: number; x1: number; y1: number } }
export interface UiAnalysis { provider?: string; status: string; reason: string | null; objects: UiObject[]; summary?: UiSummaryEntry[] }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const n = (x: number) => x.toLocaleString('en-US');

export function costEstimate(monthlyLimit: number): string {
  if (monthlyLimit <= 0) return 'No calls.';
  if (monthlyLimit <= 1000) return `Up to ${n(monthlyLimit)} calls a month: free (Google's first 1,000 a month are free).`;
  const dollars = ((monthlyLimit - 1000) / 1000) * 2.25;
  return `Up to ${n(monthlyLimit)} calls a month: at most $${dollars.toFixed(2)} (the first 1,000 free, then $2.25 per 1,000; Google's price list, checked 2026-09-30).`;
}

// The estimate next to the monthly field: for what is typed when it is a
// valid limit (a preview before saving), else for the saved limit.
export function estimateFor(typed: string, saved: number): string {
  return costEstimate(parseLimit(typed, 100000) ?? saved);
}

export function pausedText(p: UiProviderState['paused']): string | null {
  if (!p) return null;
  if (p.reason === 'bad_key') return 'invalid key (check CAMPROXY_GOOGLE_VISION_KEY or set a new key in Settings; switch analytics off and on, or restart, to try again)';
  if (p.reason === 'quota') return `quota, until ${new Date(p.until ?? 0).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return p.reason;
}

// Issue #70: the notice while a key set on the Settings page is in use.
export function keyNotice(s: Pick<UiProviderState, 'keySource' | 'keyMasked'> | null): string | null {
  if (s?.keySource !== 'manual') return null;
  return `Manual key active (${s.keyMasked}). Not saved: a restart restores the configured key.`;
}

// What PUT /control/secrets/google-vision-key accepts: 20 to 200 characters, no whitespace.
export function validKey(text: string): boolean {
  return /^\S{20,200}$/.test(text);
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
  if (a.summary) {
    if (!a.summary.length) return '✦ Vision: nothing relevant';
    return `✦ Vision: ${a.summary.slice(0, 3).map((e) => `${cap(e.subtype)} ${e.score.toFixed(2)}`).join(', ')}`;
  }
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

// The label next to a box in the analysis picture: "Clothing 20%" (the name
// with its first letter capitalised, the rounded percent). The percent is the
// table's score (toFixed(2)) in other units, so both agree on a .xx5.
// A score as a percent, from its 2-decimal value, so the overlay and the
// table always agree (0.99 → "99%").
export function scorePct(score: number): string {
  return `${Math.round(Number(score.toFixed(2)) * 100)}%`;
}

export function boxLabel(name: string, score: number): string {
  return `${cap(name)} ${scorePct(score)}`;
}

// Where a box's label goes (inline CSS, in % of the picture): above the box's
// left corner; inside the box when it touches the top (above it would be cut
// off); anchored to the box's right edge when it starts in the right quarter
// (else the label runs past the picture).
const pct = (v: number) => `${Number((v * 100).toFixed(3))}%`;
export function labelStyle(b: { x0: number; y0: number; x1: number; y1: number }): string {
  const x = b.x0 > 0.75 ? `right:${pct(1 - b.x1)}` : `left:${pct(b.x0)}`;
  return b.y0 < 0.08 ? `${x};top:${pct(b.y0)}` : `${x};top:${pct(b.y0)};transform:translateY(-100%)`;
}

// The selected object row: clicking it again clears the selection (all boxes).
export function toggleSelection(current: number | null, clicked: number): number | null {
  return current === clicked ? null : clicked;
}
