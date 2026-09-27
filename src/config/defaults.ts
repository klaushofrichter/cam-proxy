// Every setting that isn't a secret, with its default (spec §14). The file
// config.json only needs what differs; secrets come from the environment.

export interface Config {
  server: { port: number; dataDir: string; logLevel: string; publicUrl?: string };
  camera: {
    id: string; name: string; host: string; protocol: 'https' | 'http'; tlsName?: string;
    user: string; onvifPort: number; rtspPort: number; statusPollS: number;
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
    stillsDays: number; previewsDays: number; clipsDays: number; eventsDays: number;
    streamLogDays: number; intervalMin: number;
  };
  storage: {
    maxPercent?: number; maxBytes?: number; minFreeBytes: number;
    keepHours: { stills: number; clips: number; previews: number };
  };
  sse: { maxClients: number; queuePerClient: number; pingS: number };
  ftp: { enabled: boolean; port: number; passive: string; user: string; tls: boolean; stream: 'main' | 'sub'; maxGB?: number; publicHost?: string; certFile?: string; keyFile?: string };
}

export const DEFAULTS: Config = {
  server: { port: 8480, dataDir: 'data', logLevel: 'info' },
  camera: { id: 'cam1', name: 'Den', host: '', protocol: 'https', user: 'proxy', onvifPort: 8000, rtspPort: 554, statusPollS: 30 },
  go2rtc: { binary: 'go2rtc', rtspPort: 18554, apiPort: 11984 },
  stills: { enabled: true, stream: 'sub', intervalS: 1, size: '896x512', quality: 5 },
  previews: { tileSize: '160x90', grid: '10x6', quality: 7 },
  events: {
    onvif: { subscribeMin: 10, pullTimeoutS: 30 },
    poll: { enabled: true, intervalS: 2, afterOnvifDownS: 60 },
    maxOpenMin: 10,
  },
  retention: { stillsDays: 7, previewsDays: 14, clipsDays: 7, eventsDays: 30, streamLogDays: 7, intervalMin: 60 },
  storage: { maxPercent: 85, minFreeBytes: 2 * 1024 ** 3, keepHours: { stills: 24, clips: 24, previews: 72 } },
  sse: { maxClients: 50, queuePerClient: 1000, pingS: 15 },
  ftp: { enabled: false, port: 2121, passive: '30000-30009', user: 'camera', tls: true, stream: 'main' },
};

export interface Secrets {
  tokens: string[];
  adminToken: string;
  cameraPassword: string;
  ftpPassword?: string;
}
