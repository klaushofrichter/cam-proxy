// The Audit page's helpers (spec 2026-10-01-audit-log-design).
export const ACTIONS = ['proxy-start', 'proxy-stop', 'proxy-restart', 'camera-reboot', 'login', 'logout', 'login-link-issued', 'auth-refused', 'control-action', 'config-change', 'secret-override', 'storage-daily', 'activity-daily', 'audit-throttled'];
type R = { user?: { name?: string }; source?: { ip?: string }; event?: { outcome?: string } };
export function who(r: R): string {
  const parts = [r.user?.name, r.source?.ip].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
}
export function outcomeClass(r: R): 'ok' | 'bad' | 'unknown' {
  return r.event?.outcome === 'success' ? 'ok' : r.event?.outcome === 'failure' ? 'bad' : 'unknown';
}
export function auditQuery(o: { limit: number; before?: string; action?: string; outcome?: string }): string {
  const p = new URLSearchParams();
  p.set('limit', String(o.limit));
  if (o.before) p.set('before', o.before);
  if (o.action) p.set('action', o.action);
  if (o.outcome) p.set('outcome', o.outcome);
  return p.toString();
}
