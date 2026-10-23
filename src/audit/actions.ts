// Every `event.action` the proxy writes (docs/audit-log.md): the audit API
// refuses a filter for any other, and the Audit page's filter lists them in
// this order. A new action goes here (test/audit-actions.test.ts checks).
export const AUDIT_ACTIONS = [
  'proxy-start', 'proxy-stop', 'proxy-restart',
  'camera-reboot', 'camera-powercycle', 'camera-poe-on', 'camera-check', 'camera-name', 'camera-address', 'camera-cert-push', 'camera-trust', 'camera-ntp',
  'login', 'logout', 'login-link-issued', 'auth-refused', 'ftp-login-refused',
  'control-action', 'config-change', 'secret-override',
  'still-check', 'event-analysis', 'composition',
  'archive-add', 'archive-update', 'archive-delete', 'archive-clear', 'archive-expire',
  'storage-daily', 'storage-paused', 'storage-resumed', 'activity-daily',
  'inventory', 'inventory-repair', 'admin-enroll', 'admin-unenroll', 'admin-command', 'admin-policy', 'admin-token', 'audit-throttled',
  'move-token-refused', 'move-request', 'move-offer', 'move-approve', 'move-auto-approve', 'move-switch', 'move-phase', 'move-progress', 'move-budget-exceeded', 'move-file-failed', 'move-source-unreachable', 'move-check', 'move-outcome-refused', 'move-cancel', 'move-cleanup', 'move-done', 'move-return',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
const KNOWN = new Set<string>(AUDIT_ACTIONS);
export const isAuditAction = (a: string): a is AuditAction => KNOWN.has(a);
