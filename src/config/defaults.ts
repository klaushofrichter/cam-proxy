// Every setting that isn't a secret, with its default (spec §14). The file
// config.json only needs what differs; secrets come from the environment.

export interface Config {
  server: { port: number; dataDir: string; logLevel: string; publicUrl?: string; trustProxy?: number };
  camera: {
    id: string; name: string; host: string; protocol: 'https' | 'http'; tlsName?: string; webUiUrl?: string;
    user: string; onvifPort: number; rtspPort: number; baichuanPort: number; statusPollS: number;
    // The camera's PoE switch (issue #85); `none` for no switch.
    poeSwitch: { model: 'none' | 'sscpoe-web'; host?: string; port?: number; ports: number; offSeconds: number };
  };
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
  composition: { font?: string };
  ftp: { enabled: boolean; port: number; passive: string; user: string; tls: boolean; stream: 'main' | 'sub'; stalledHours: number; maxGB?: number; publicHost?: string; certFile?: string; keyFile?: string };
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
    googleVision: { enabled: boolean; monthlyLimit: number; dailyCap: number; checksPerDay: number };
  };
}

export const DEFAULTS: Config = {
  server: { port: 8480, dataDir: 'data', logLevel: 'info' },
  camera: { id: 'cam1', name: 'Den', host: '', protocol: 'https', user: 'proxy', onvifPort: 8000, rtspPort: 554, baichuanPort: 9000, statusPollS: 30, poeSwitch: { model: 'none', ports: 8, offSeconds: 10 } },
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
  composition: {},
  ftp: { enabled: false, port: 2121, passive: '30000-30009', user: 'camera', tls: true, stream: 'main', stalledHours: 6 },
  recordings: { cacheMB: 2048 },
  health: { diskPercent: 90, tempC: 75 },
  host: { stats: 'auto' },
  archive: { enabled: true, warnPercent: 50 },
  analytics: {
    kinds: { person: true, vehicle: false, pet: false },
    googleVision: { enabled: false, monthlyLimit: 0, dailyCap: 0, checksPerDay: 10 },
  },
};

export interface Secrets {
  tokens: string[];
  adminToken: string;
  cameraPassword: string;
  ftpPassword?: string;
  auditToken?: string; // CAMPROXY_AUDIT_TOKEN: reads GET /control/audit only
  googleVisionKey?: string;
  poeSwitchPassword?: string; // CAMPROXY_POE_SWITCH_PASSWORD: the PoE switch's web login
  googleVisionUrl: string; // not a secret; read with them (default Google's)
}
