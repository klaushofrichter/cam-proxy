// Every setting that isn't a secret, with its default (spec §14). The file
// config.json only needs what differs; secrets come from the environment.
import type { HostPoeSwitch } from './cameras';

// One camera of `cameras` (spec 2026-10-05-multi-camera-host-design §4.1).
// The optional groups override a host default; absent = the host value.
export interface CameraNode {
  id: string; name: string; host: string; protocol: 'https' | 'http'; tlsName?: string; webUiUrl?: string;
  user: string; onvifPort: number; rtspPort: number; baichuanPort: number; statusPollS: number;
  poeSwitch: { port?: number };
  ftp: { user?: string; enabled?: boolean; stream?: 'main' | 'sub' };
  stills: { enabled?: boolean; stream?: 'sub' | 'main'; intervalS?: number };
  storage: { sharePercent?: number };
  analytics: { kinds: { person?: boolean; vehicle?: boolean; pet?: boolean } };
  events: { poll: { enabled?: boolean } };
}

// A new camera's defaults: its name is its id (Ruling P1-11; a legacy camera
// keeps the name Den, src/config/legacy.ts).
export function cameraDefaults(id: string): CameraNode {
  return { id, name: id, host: '', protocol: 'https', user: 'proxy', onvifPort: 8000, rtspPort: 554, baichuanPort: 9000, statusPollS: 30, poeSwitch: {}, ftp: {}, stills: {}, storage: {}, analytics: { kinds: {} }, events: { poll: {} } };
}

export interface Config {
  server: { port: number; dataDir: string; logLevel: string; publicUrl?: string; trustProxy?: number; tls: { port?: number } };
  // The cameras by id, and their order (config order: display order).
  cameras: Record<string, CameraNode>;
  cameraOrder: string[];
  // The cameras' PoE switch, one per host (issue #85); `none` for no switch.
  poeSwitch: HostPoeSwitch;
  go2rtc: { binary?: string; url?: string; rtspPort: number; apiPort: number };
  stills: { enabled: boolean; stream: 'sub' | 'main'; intervalS: number; size: string; quality: number; maxGB?: number };
  previews: { tileSize: string; grid: string; quality: number; maxGB?: number };
  events: {
    onvif: { subscribeMin: number; pullTimeoutS: number };
    poll: { enabled: boolean; intervalS: number; afterOnvifDownS: number };
    maxOpenMin: number;
  };
  retention: {
    stillsDays: number; previewsDays: number; clipsDays: number; eventsDays: number; auditDays: number;
    streamLogDays: number; intervalMin: number;
  };
  storage: {
    maxPercent?: number; maxBytes?: number; minFreeBytes: number;
    keepHours: { stills: number; clips: number; previews: number };
  };
  sse: { maxClients: number; queuePerClient: number; pingS: number };
  // Composed clips (spec 2026-09-28): the font for the badge and card text.
  composition: { font?: string; concurrent: number };
  ftp: { enabled: boolean; port: number; passive: string; tls: boolean; stream: 'main' | 'sub'; stalledHours: number; maxGB?: number; publicHost?: string; certFile?: string; keyFile?: string };
  recordings: { cacheMB: number };
  // The health summary's thresholds and the host figures (spec 2026-10-03-health-summary-design).
  health: { diskPercent: number; tempC: number };
  host: { stats: 'auto' | 'on' | 'off' };
  // The Archive (spec 2026-10-05-archive-design §6): new clips on or off,
  // and the size warning, percent of the data volume (no limit).
  archive: { enabled: boolean; warnPercent: number };
  // External analytics (spec 2026-09-30-analytics-design): which event kinds,
  // and per provider its switch and call limits. 0 = no calls.
  analytics: {
    kinds: { person: boolean; vehicle: boolean; pet: boolean };
    // checksPerDay: still checks by hand per camera day (cams #179); 0 = none.
    googleVision: { enabled: boolean; monthlyLimit: number; dailyCap: number; checksPerDay: number; perCameraDailyCap: number };
  };
  // The site CA (spec 2026-10-05-multi-camera-host-design §10.4); no site = off.
  tls: { site?: string; cameraCerts: boolean; cameraSubnet?: string; proxyAddresses?: string };
  // The NTP server the proxy keeps on its cameras (§14.2); unset = left alone.
  ntp: { server?: string };
}

export const DEFAULTS: Config = {
  server: { port: 8480, dataDir: 'data', logLevel: 'info', tls: {} },
  cameras: {},
  cameraOrder: [],
  poeSwitch: { model: 'none', ports: 8, offSeconds: 10 },
  go2rtc: { binary: 'go2rtc', rtspPort: 18554, apiPort: 11984 },
  stills: { enabled: true, stream: 'sub', intervalS: 1, size: '896x512', quality: 5 },
  previews: { tileSize: '160x90', grid: '10x6', quality: 7 },
  events: {
    onvif: { subscribeMin: 10, pullTimeoutS: 30 },
    poll: { enabled: true, intervalS: 2, afterOnvifDownS: 60 },
    maxOpenMin: 10,
  },
  retention: { stillsDays: 7, previewsDays: 14, clipsDays: 7, eventsDays: 30, auditDays: 90, streamLogDays: 7, intervalMin: 60 },
  storage: { maxPercent: 85, minFreeBytes: 2 * 1024 ** 3, keepHours: { stills: 24, clips: 24, previews: 72 } },
  sse: { maxClients: 50, queuePerClient: 1000, pingS: 15 },
  composition: { concurrent: 1 },
  ftp: { enabled: false, port: 2121, passive: '30000-30009', tls: true, stream: 'main', stalledHours: 6 },
  recordings: { cacheMB: 2048 },
  health: { diskPercent: 90, tempC: 75 },
  host: { stats: 'auto' },
  archive: { enabled: true, warnPercent: 50 },
  analytics: {
    kinds: { person: true, vehicle: false, pet: false },
    googleVision: { enabled: false, monthlyLimit: 0, dailyCap: 0, checksPerDay: 10, perCameraDailyCap: 0 },
  },
  tls: { cameraCerts: true },
  ntp: {},
};

export interface Secrets {
  tokens: string[];
  adminToken: string;
  cameraPassword: string; // CAMPROXY_CAMERA_PASSWORD: every camera's default ('' when each has its own)
  cameraPasswords: Record<string, string>; // CAMPROXY_CAMERA_PASSWORD_<ID>: one camera's own
  ftpPassword?: string;
  auditToken?: string; // CAMPROXY_AUDIT_TOKEN: reads GET /control/audit only
  googleVisionKey?: string;
  poeSwitchPassword?: string; // CAMPROXY_POE_SWITCH_PASSWORD: the PoE switch's web login
  googleVisionUrl: string; // not a secret; read with them (default Google's)
}
