import { ConfigError } from '../config/load-error';
import type { EnvLayer } from '../config/env';
import { PrivateFileInvalid, PrivateFileUnsafe, readPrivateJson, writePrivateJson } from './private-file';

// M §8.6: camera actions cams-admin may ask for (each its own allow entry),
// and the ones it never may: they change trust, delete data, or need
// someone at the hardware. Compiled in: no setting widens them.
// camera-ftp-off is never remote (coordinator ruling after the P3 security
// review, M5): it stops clip intake, like ftp.enabled (I4, local only).
export const REMOTE_ACTIONS = ['camera-test', 'onvif-resubscribe', 'camera-ftp-test', 'poe-switch-read', 'inventory', 'inventory-cancel', 'retention-run', 'restart', 'camera-reboot', 'camera-powercycle', 'camera-ftp-setup', 'camera-ntp-set', 'camera-cert-push'] as const;
export const NEVER_REMOTE_ACTIONS = ['find-camera', 'camera-address', 'camera-trust-clear', 'tls-ca-rotate', 'tls-ca-drop-previous', 'archive-clear', 'inventory-repair', 'camera-poe-on', 'restart-proxy', 'camera-ftp-off'] as const;
// Entries an earlier version accepted that this one no longer knows: dropped
// on read (policy.json, config.json), never an error (a stored policy must not
// pause everything after an upgrade).
export const RETIRED_ENTRIES: ReadonlySet<string> = new Set(['camera.action:camera-ftp-off']);
// The remote actions that disrupt service (Klaus's decision 3): each its own
// allow entry, off by default; with proxy.restart, under the journal budget.
export const DISRUPTIVE_ACTIONS = ['restart', 'camera-reboot', 'camera-powercycle', 'camera-ftp-setup', 'camera-ntp-set', 'camera-cert-push'] as const;
// What the journal budget counts: the disruptive actions, and camera-ftp-off
// (disruptive in the contract; journaled by a version that ran it).
export const BUDGETED_ACTIONS: ReadonlySet<string> = new Set([...DISRUPTIVE_ACTIONS, 'camera-ftp-off']);
export const DISRUPTIVE_ENTRIES: ReadonlySet<string> = new Set(['proxy.restart', ...DISRUPTIVE_ACTIONS.map((a) => `camera.action:${a}`)]);
export const ALLOW_ENTRIES: readonly string[] = ['tokens.apply', 'tokens.apply.admin', 'config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.name.set', 'proxy.restart', ...REMOTE_ACTIONS.map((a) => `camera.action:${a}`)];
// What this version runs (P2, P3): command names and allow entries. The
// heartbeat reports allow ∩ IMPLEMENTED.
export const IMPLEMENTED: ReadonlySet<string> = new Set(['tokens.apply', 'tokens.apply.admin', 'config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.action', 'camera.name.set', 'proxy.restart', ...REMOTE_ACTIONS.map((a) => `camera.action:${a}`)]);
// One sentence per allow entry: what allowing it lets cams-admin change (the
// Status card shows them next to the boxes).
const EFFECT: Record<string, string> = {
  restart: "restarts a camera's worker (stills and events pause)",
  'camera-reboot': 'reboots the camera (recording stops for about a minute)',
  'camera-powercycle': "cuts the camera's PoE power",
  'camera-ftp-setup': "rewrites the camera's FTP upload settings",
  'camera-ntp-set': "rewrites the camera's NTP settings",
  'camera-cert-push': "replaces the camera's HTTPS certificate",
};
const actionText = (a: string) => ((DISRUPTIVE_ACTIONS as readonly string[]).includes(a) ? `DISRUPTIVE: cams-admin may run ${a} on a camera: ${EFFECT[a]}` : `cams-admin may run ${a} on a camera`);
export const ENTRY_TEXT: Record<string, string> = {
  'tokens.apply': 'cams-admin may add, rotate and revoke managed client tokens for cams (CAMPROXY_TOKENS keeps working)',
  'tokens.apply.admin': 'cams-admin may also manage admin tokens (sign-in links, camera rename); your local admin token is never affected',
  'config.get': "cams-admin may read this proxy's settings (values and sources; no secrets)",
  'config.set': 'cams-admin may change the settings marked remote-settable (never addresses, ports, files, trust, users, storage, capture switches or cams-admin itself); local edits win',
  'config.unset': "cams-admin may reset those settings to config.json's value or the default",
  'config.rollback': 'cams-admin may undo its own setting changes',
  'camera.name.set': "cams-admin may rename a camera (the camera's own name)",
  'proxy.restart': 'DISRUPTIVE: cams-admin may restart this proxy (at most 2 an hour)',
  ...Object.fromEntries(REMOTE_ACTIONS.map((a) => [`camera.action:${a}`, actionText(a)])),
};

// The settings cams-admin may set (and never may): src/fleet/remote-settable.ts.

// `stored`: a list an earlier version wrote (policy.json, config.json): retired entries are dropped.
export function validateAllowList(list: unknown, where: string, stored = false): string[] {
  if (!Array.isArray(list) || list.length > 32) throw new ConfigError(`${where}: a list of at most 32 command names`);
  const kept = stored ? list.filter((e) => !(typeof e === 'string' && RETIRED_ENTRIES.has(e))) : list;
  for (const e of kept) if (typeof e !== 'string' || !ALLOW_ENTRIES.includes(e)) throw new ConfigError(`${where}: ${typeof e === 'string' ? e.slice(0, 64) : typeof e} is not a command cams-admin may be allowed`);
  return [...new Set(kept as string[])];
}

// Fresh local consent for P3 (coordinator ruling I3): an allow entry counts
// only when it was granted by a version that ran it. policy.json written by
// this version carries `consent: 3`; a list without it (a P2 file, or
// config.json's base) keeps only what P2 ran, and the rest waits as
// `unconfirmed` until the local admin ticks it again.
export const CONSENT_VERSION = 3;
const P2_ENTRIES: ReadonlySet<string> = new Set(['tokens.apply', 'tokens.apply.admin']);

export class WideningRefused extends Error {}

export interface PolicyFile { v: 1; allow?: string[]; consent?: number; paused?: boolean; pauseReason?: string | null; changedAt: number; changedBy: 'local' | 'managed' }
export interface EffectivePolicy { enabled: boolean; paused: boolean; pauseReason: string | null; allow: string[]; unconfirmed: string[]; envName: string | null }

export class CommandPolicy {
  constructor(private readonly d: { base: () => { allow: string[]; paused: boolean }; file: string; env: () => EnvLayer; log: { warn(o: object, m: string): void } }) {}

  private read(): PolicyFile | { unusable: string } | null {
    try {
      const f = readPrivateJson(this.d.file) as PolicyFile;
      if (f?.v !== 1) return { unusable: `${this.d.file} is not version 1` };
      if (f.allow !== undefined) f.allow = validateAllowList(f.allow, 'policy.json allow', true);
      return f;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (err instanceof PrivateFileUnsafe || err instanceof PrivateFileInvalid || err instanceof ConfigError) return { unusable: (err as Error).message };
      throw err;
    }
  }

  effective(): EffectivePolicy {
    const env = this.d.env().adminCommands;
    const enabled = !env || env.value === 'on';
    const f = this.read();
    // An unusable policy file pauses everything until someone fixes it (fail closed).
    if (f && 'unusable' in f) return { enabled, paused: true, pauseReason: f.unusable.slice(0, 200), allow: [], unconfirmed: [], envName: enabled ? null : env!.name };
    const base = this.d.base();
    const listed = f?.allow ?? base.allow;
    const consented = f?.allow !== undefined && (f.consent ?? 0) >= CONSENT_VERSION;
    return {
      enabled,
      paused: base.paused || !!f?.paused,
      pauseReason: f?.paused ? (f.pauseReason ?? null) : base.paused ? 'config.json: camsAdmin.commandsPaused' : null,
      allow: consented ? listed : listed.filter((e) => P2_ENTRIES.has(e)),
      unconfirmed: consented ? [] : listed.filter((e) => !P2_ENTRIES.has(e)),
      envName: enabled ? null : env!.name,
    };
  }

  private write(patch: Partial<PolicyFile>, by: 'local' | 'managed'): void {
    const cur = this.read();
    const prev = cur && !('unusable' in cur) ? cur : { v: 1 as const, changedAt: 0, changedBy: by };
    writePrivateJson(this.d.file, { ...prev, ...patch, v: 1, changedAt: Date.now(), changedBy: by });
  }

  setAllow(list: string[], by: 'local' | 'managed'): void {
    const next = validateAllowList(list, 'allowed commands');
    const now = this.effective().allow;
    if (by !== 'local' && next.some((e) => !now.includes(e))) throw new WideningRefused('adding an allowed command needs the local admin token');
    this.write({ allow: next, consent: CONSENT_VERSION }, by);
  }

  pause(reason: string | null, by: 'local' | 'managed'): void {
    this.write({ paused: true, pauseReason: reason ? reason.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200) : null }, by);
  }

  resume(by: 'local'): void {
    if (by !== 'local') throw new WideningRefused('resuming commands needs the local admin token');
    this.write({ paused: false, pauseReason: null }, by);
  }
}
