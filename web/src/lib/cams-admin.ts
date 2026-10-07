import { settingText } from './settings';

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
  groups?: EntryGroups;
}
// The allow entries by kind (migration P3): the disruptive ones apart.
export interface EntryGroups { tokens: string[]; read: string[]; settings: string[]; camera: string[]; disruptive: string[] }
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

// The allow entries in groups for the card (migration P3): the disruptive
// ones (Klaus's decision 3) last, under a warning. An older proxy sends no
// groups: one list.
const GROUP_TITLES: [keyof EntryGroups, string, string?][] = [
  ['tokens', 'Managed tokens'],
  ['read', 'Read settings'],
  ['settings', 'Change settings'],
  ['camera', 'Camera actions'],
  ['disruptive', 'Disruptive — off by default', 'Each of these lets cams-admin interrupt this proxy or a camera (a restart, a reboot, power off, rewritten camera settings). Allow one only while you need it.'],
];
export interface EntryGroup { key: string; title: string; warning?: string; entries: (CommandEntry & { allowed: boolean })[] }
export function entryGroups(v: Pick<CommandsView, 'known' | 'groups' | 'allow'>): EntryGroup[] {
  const known = v.known ?? [];
  const mark = (e: CommandEntry) => ({ ...e, allowed: v.allow.includes(e.entry) });
  if (!v.groups) return [{ key: 'all', title: 'Commands', entries: known.map(mark) }];
  return GROUP_TITLES.flatMap(([key, title, warning]) => {
    const entries = known.filter((k) => v.groups![key].includes(k.entry)).map(mark);
    return entries.length ? [{ key, title, ...(warning ? { warning } : {}), entries }] : [];
  });
}

// cams-admin's settings changes (GET /control/admin/changes) and the Settings marker.
export interface ChangeItem { cmdId: string; command: string; actor: string; at: number; paths: { path: string; from?: unknown; to?: unknown }[]; rolledBack: { at: number; by: 'cams-admin' | 'local'; user?: string; cmdId?: string } | null }
// A side without a value had no override: config.json's value or the default.
const side = (path: string, v: unknown) => (v === undefined ? 'default' : settingText(path, v));
export const changeLines = (c: ChangeItem): string[] => c.paths.map((p) => `${p.path}: ${side(p.path, p.from)} → ${side(p.path, p.to)}`);
export const byText = (by: { cmdId: string; actor: string; at: number }): string => `set by cams-admin (on behalf of ${by.actor})`;
export function undoErrorText(e: unknown): string {
  const b = (e as { body?: unknown })?.body as { error?: string; paths?: string[] } | undefined;
  if (b?.error === 'conflict') return `Not undone: ${(b.paths ?? []).join(', ')} changed here since. Reset it on the Settings page instead.`;
  if (b?.error === 'already_rolled_back') return 'Already undone.';
  if (b?.error === 'local_admin_only') return "Undo needs the proxy's own admin token: sign in with it (not through cams).";
  if (b?.error === 'no_backup') return 'Not undone: the record of that change is gone (only the last 20 are kept).';
  return 'Not undone';
}
