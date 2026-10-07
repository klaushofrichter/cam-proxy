// The Status page's cams-admin card (spec 2026-10-06-cams-admin-phase1-design §9.2):
// GET /control/admin; never any key material.
export type CamsAdminState = 'off' | 'disabled' | 'not-enrolled' | 'key-unsafe' | 'key-invalid' | 'connecting' | 'connected' | 'backoff' | 'rejected' | 'incompatible' | 'stopped';

export interface CamsAdminView {
  state: CamsAdminState;
  url: string | null;
  account: string | null;
  proxyId: string | null;
  fingerprint: string | null;
  enrolledAt: number | null;
  connectedSince: number | null;
  lastHeartbeatAt: number | null;
  lastAckAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  retryInMs: number | null;
  truncated: boolean;
}

const TEXT: Record<CamsAdminState, string> = {
  off: 'not enrolled',
  'not-enrolled': 'not enrolled',
  disabled: 'off (camsAdmin.enabled is false)',
  connecting: 'connecting',
  connected: 'connected',
  backoff: 'disconnected, retrying',
  rejected: 'rejected by cams-admin: re-enroll',
  incompatible: 'incompatible: update the proxy or cams-admin',
  'key-unsafe': 'key file unsafe: not used',
  'key-invalid': 'key file unreadable: enroll again',
  stopped: 'stopped',
};
export const stateText = (s: CamsAdminState): string => TEXT[s] ?? s;
export const stateClass = (s: CamsAdminState): 'ok' | 'bad' | '' =>
  s === 'connected' ? 'ok' : s === 'rejected' || s === 'incompatible' || s === 'key-unsafe' || s === 'key-invalid' || s === 'backoff' ? 'bad' : '';
// The Enroll form: when nothing works that a new key would replace.
export const canEnroll = (s: CamsAdminState): boolean => ['off', 'not-enrolled', 'rejected', 'key-unsafe', 'key-invalid', 'incompatible'].includes(s);

// Commands from cams-admin and managed tokens (migration P2): GET
// /control/admin/commands and /control/admin/tokens.
export interface CommandEntry { entry: string; text: string }
export interface RecentCommand { cmdId: string; command: string; actor: string; at: number; status: 'ok' | 'failed' | 'conflict'; code?: string }
export interface CommandsView {
  enabled: boolean;
  envName: string | null;
  paused: boolean;
  pauseReason: string | null;
  allow: string[];
  implemented?: string[];
  known?: CommandEntry[];
  recent?: RecentCommand[];
}
export interface ManagedToken { id: string; kind: string; label: string; retireAt: number | null; blocked: boolean; live: boolean; hashPrefix: string }
export interface TokensView { revision: number; problem: string | null; items: ManagedToken[] }

// The banner over the allowed commands: the environment's kill switch first
// (cams-admin can't change it), then a pause.
export function commandsBanner(v: Pick<CommandsView, 'enabled' | 'envName' | 'paused' | 'pauseReason'>): string | null {
  if (!v.enabled) return `Off: ${v.envName ?? 'CAMPROXY_ADMIN_COMMANDS'} is set to off in the environment. cams-admin can't change this.`;
  if (v.paused) return v.pauseReason ? `Paused: ${v.pauseReason}` : 'Paused';
  return null;
}

export function tokenStateText(t: ManagedToken, now = Date.now()): string {
  if (t.blocked) return 'blocked';
  if (!t.live || (t.retireAt !== null && t.retireAt <= now)) return 'retired';
  if (t.retireAt !== null) {
    const s = Math.max(0, Math.round((t.retireAt - now) / 1000));
    return s < 120 ? `retires in ${s} s` : s < 7200 ? `retires in ${Math.round(s / 60)} min` : `retires in ${Math.round(s / 3600)} h`;
  }
  return 'live';
}

// A refused change: a widening with managed rights says how to do it.
export function widenErrorText(e: unknown, fallback: string): string {
  const b = (e as { body?: unknown })?.body as { error?: string; detail?: string; message?: string } | undefined;
  if (b?.error === 'local_admin_only') return "Adding a command needs the proxy's own admin token: sign in with it (not through cams).";
  return b?.detail ?? b?.message ?? fallback;
}
