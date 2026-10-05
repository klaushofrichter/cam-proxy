import type { Config } from './defaults';

// One camera's settings as its worker runs them (spec
// 2026-10-05-multi-camera-host-design §4.1): the camera node plus the host
// defaults it may override. Always a copy.
export type PoeSwitchModel = 'none' | 'sscpoe-web';
export interface HostPoeSwitch { model: PoeSwitchModel; host?: string; ports: number; offSeconds: number }
export interface ResolvedCamera {
  id: string; name: string; host: string; protocol: 'https' | 'http'; tlsName?: string; webUiUrl?: string;
  user: string; onvifPort: number; rtspPort: number; baichuanPort: number; statusPollS: number;
  poeSwitch: HostPoeSwitch & { port?: number };
  ftp: { user: string; enabled: boolean; stream: 'main' | 'sub' };
  stills: Config['stills'];
  events: Config['events'];
  analytics: { kinds: Config['analytics']['kinds'] };
}

const defined = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

// The configured cameras' ids in config order (never the object key order:
// integer-like ids would sort numerically).
export function cameraIds(c: Config): string[] {
  return [...c.cameraOrder];
}

export function firstCameraId(c: Config): string {
  return cameraIds(c)[0];
}

// Live: the tracker and the intake read maxOpenMin and poll.* on every use,
// and a Settings change applies at once — the host object itself while the
// camera overrides nothing, else a copy with its override.
export function cameraEvents(c: Config, id: string): Config['events'] {
  const p = c.cameras[id]?.events?.poll?.enabled;
  return p === undefined ? c.events : { ...structuredClone(c.events), poll: { ...structuredClone(c.events.poll), enabled: p } };
}

export function cameraConfig(c: Config, id: string): ResolvedCamera | undefined {
  const n = Object.hasOwn(c.cameras, id) ? c.cameras[id] : undefined;
  if (!n) return undefined;
  const o = structuredClone(n);
  return {
    id, name: o.name, host: o.host, protocol: o.protocol, ...(o.tlsName !== undefined ? { tlsName: o.tlsName } : {}), ...(o.webUiUrl !== undefined ? { webUiUrl: o.webUiUrl } : {}),
    user: o.user, onvifPort: o.onvifPort, rtspPort: o.rtspPort, baichuanPort: o.baichuanPort, statusPollS: o.statusPollS,
    poeSwitch: { ...structuredClone(c.poeSwitch), ...(o.poeSwitch?.port !== undefined ? { port: o.poeSwitch.port } : {}) },
    ftp: { user: o.ftp?.user ?? id, enabled: o.ftp?.enabled ?? c.ftp.enabled, stream: o.ftp?.stream ?? c.ftp.stream },
    stills: { ...structuredClone(c.stills), ...defined(o.stills ?? {}) },
    events: structuredClone(cameraEvents(c, id)),
    analytics: { kinds: { ...c.analytics.kinds, ...defined(o.analytics?.kinds ?? {}) } },
  };
}
