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

// The configured cameras' ids in config order (today: the one camera).
export function cameraIds(c: Config): string[] {
  return [c.camera.id];
}

export function firstCameraId(c: Config): string {
  return cameraIds(c)[0];
}

// Live: the tracker and the intake read maxOpenMin and poll.* on every use,
// and a Settings change applies at once (as before several cameras).
export function cameraEvents(c: Config, _id: string): Config['events'] {
  return c.events;
}

export function cameraConfig(c: Config, id: string): ResolvedCamera | undefined {
  if (id !== c.camera.id) return undefined;
  const { poeSwitch, ...cam } = structuredClone(c.camera);
  return {
    ...cam,
    poeSwitch,
    ftp: { user: c.ftp.user, enabled: c.ftp.enabled, stream: c.ftp.stream },
    stills: structuredClone(c.stills),
    events: structuredClone(c.events),
    analytics: { kinds: { ...c.analytics.kinds } },
  };
}
