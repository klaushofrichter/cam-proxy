// The Audit page's helpers (spec 2026-10-01-audit-log-design).
// The known actions, the proxy's own list (src/audit/actions.ts).
import { AUDIT_ACTIONS } from '../../../src/audit/actions';
export const ACTIONS: readonly string[] = AUDIT_ACTIONS;
type R = { user?: { name?: string }; source?: { ip?: string }; event?: { outcome?: string } };
export function who(r: R): string {
  const parts = [r.user?.name, r.source?.ip].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}
export function outcomeClass(r: R): 'ok' | 'bad' | 'unknown' {
  return r.event?.outcome === 'success' ? 'ok' : r.event?.outcome === 'failure' ? 'bad' : 'unknown';
}
export function auditQuery(o: { limit: number; before?: string; action?: string; actions?: readonly string[]; outcome?: string }): string {
  const p = new URLSearchParams();
  p.set('limit', String(o.limit));
  if (o.before) p.set('before', o.before);
  const action = o.actions ? actionsParam(o.actions) : o.action;
  if (action) p.set('action', action);
  if (o.outcome) p.set('outcome', o.outcome);
  return p.toString();
}

// The action filter (a multi-select). A selection is kept in the list's order.
const inOrder = (sel: Iterable<string>) => { const s = new Set(sel); return ACTIONS.filter((a) => s.has(a)); };
export const toggleAction = (sel: readonly string[], a: string): string[] => inOrder(sel.includes(a) ? sel.filter((x) => x !== a) : [...sel, a]);
// "All actions": all, or none when all are selected (Klaus 2026-10-05).
export const toggleAll = (sel: readonly string[]): string[] => (isAll(sel) ? [] : [...ACTIONS]);
export const isAll = (sel: readonly string[]): boolean => ACTIONS.every((a) => sel.includes(a));
// The `action` query: undefined for all (no filter, so records of an action
// this page doesn't know yet show too), null for none (nothing to ask).
export function actionsParam(sel: readonly string[]): string | undefined | null {
  if (isAll(sel)) return undefined;
  if (!sel.length) return null;
  return inOrder(sel).join(',');
}
export function filterLabel(sel: readonly string[]): string {
  if (isAll(sel)) return 'All actions';
  if (!sel.length) return 'No actions';
  return sel.length === 1 ? sel[0] : `${sel.length} actions`;
}

// The line under the title: how long records are kept and how many there are.
export function retentionLine(s: { retentionDays: number; records: number } | null): string {
  if (!s) return 'Kept for the days set in retention.auditDays (Settings).';
  const n = (k: number, one: string) => `${k.toLocaleString('en-US')} ${one}${k === 1 ? '' : 's'}`;
  return `Kept for ${n(s.retentionDays, 'day')} (Settings) · ${n(s.records, 'event')} in that time.`;
}
