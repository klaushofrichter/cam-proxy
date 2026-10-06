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
