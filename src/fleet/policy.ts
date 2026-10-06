import { ConfigError } from '../config/load-error';
import type { EnvLayer } from '../config/env';
import { PrivateFileInvalid, PrivateFileUnsafe, readPrivateJson, writePrivateJson } from './private-file';

// M §8.6: camera actions cams-admin may ask for (each its own allow entry),
// and the ones it never may: they change trust, delete data, or need
// someone at the hardware. Compiled in: no setting widens them.
export const REMOTE_ACTIONS = ['camera-test', 'onvif-resubscribe', 'camera-ftp-test', 'poe-switch-read', 'inventory', 'inventory-cancel', 'retention-run', 'restart', 'camera-reboot', 'camera-powercycle', 'camera-ftp-setup', 'camera-ftp-off', 'camera-ntp-set', 'camera-cert-push'] as const;
export const NEVER_REMOTE_ACTIONS = ['find-camera', 'camera-address', 'camera-trust-clear', 'tls-ca-rotate', 'tls-ca-drop-previous', 'archive-clear', 'inventory-repair', 'camera-poe-on'] as const;
export const ALLOW_ENTRIES: readonly string[] = ['tokens.apply', 'tokens.apply.admin', 'config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.name.set', 'proxy.restart', ...REMOTE_ACTIONS.map((a) => `camera.action:${a}`)];
// What this version runs (P2). The heartbeat reports allow ∩ IMPLEMENTED.
export const IMPLEMENTED: ReadonlySet<string> = new Set(['tokens.apply', 'tokens.apply.admin']);
// M §8.2 right column (M5): never settable by cams-admin. P3's config.set
// checks every path against isDeniedPath before anything else; the per-camera
// entries apply under cameras.<id>.
export const DENIED_PATH_PREFIXES = ['camsAdmin', 'server', 'go2rtc', 'ftp.port', 'ftp.passive', 'ftp.tls', 'ftp.publicHost', 'ftp.certFile', 'ftp.keyFile', 'tls', 'composition.font', 'ntp.server', 'poeSwitch'] as const;
const DENIED_CAMERA_KEYS = ['host', 'protocol', 'tlsName', 'user', 'onvifPort', 'rtspPort', 'baichuanPort', 'poeSwitch', 'ftp.user', 'webUiUrl'] as const;
const under = (p: string, x: string) => p === x || p.startsWith(`${x}.`);

export function isDeniedPath(path: string): boolean {
  if (DENIED_PATH_PREFIXES.some((x) => under(path, x))) return true;
  const m = /^cameras\.[^.]+\.(.+)$/.exec(path);
  return !!m && DENIED_CAMERA_KEYS.some((k) => under(m[1], k));
}

export function validateAllowList(list: unknown, where: string): string[] {
  if (!Array.isArray(list) || list.length > 32) throw new ConfigError(`${where}: a list of at most 32 command names`);
  for (const e of list) if (typeof e !== 'string' || !ALLOW_ENTRIES.includes(e)) throw new ConfigError(`${where}: ${typeof e === 'string' ? e.slice(0, 64) : typeof e} is not a command cams-admin may be allowed`);
  return [...new Set(list as string[])];
}

export class WideningRefused extends Error {}

export interface PolicyFile { v: 1; allow?: string[]; paused?: boolean; pauseReason?: string | null; changedAt: number; changedBy: 'local' | 'managed' }
export interface EffectivePolicy { enabled: boolean; paused: boolean; pauseReason: string | null; allow: string[]; envName: string | null }

export class CommandPolicy {
  constructor(private readonly d: { base: () => { allow: string[]; paused: boolean }; file: string; env: () => EnvLayer; log: { warn(o: object, m: string): void } }) {}

  private read(): PolicyFile | { unusable: string } | null {
    try {
      const f = readPrivateJson(this.d.file) as PolicyFile;
      if (f?.v !== 1) return { unusable: `${this.d.file} is not version 1` };
      if (f.allow !== undefined) validateAllowList(f.allow, 'policy.json allow');
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
    if (f && 'unusable' in f) return { enabled, paused: true, pauseReason: f.unusable.slice(0, 200), allow: [], envName: enabled ? null : env!.name };
    const base = this.d.base();
    return {
      enabled,
      paused: base.paused || !!f?.paused,
      pauseReason: f?.paused ? (f.pauseReason ?? null) : base.paused ? 'config.json: camsAdmin.commandsPaused' : null,
      allow: f?.allow ?? base.allow,
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
    this.write({ allow: next }, by);
  }

  pause(reason: string | null, by: 'local' | 'managed'): void {
    this.write({ paused: true, pauseReason: reason ? reason.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200) : null }, by);
  }

  resume(by: 'local'): void {
    if (by !== 'local') throw new WideningRefused('resuming commands needs the local admin token');
    this.write({ paused: false, pauseReason: null }, by);
  }
}
