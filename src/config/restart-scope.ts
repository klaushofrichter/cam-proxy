// Which settings wait for a restart, and which for a new process.

// Settings that only take effect after a restart (spec §14).
const RESTART = ['server.port', 'server.dataDir', 'cameras.', 'go2rtc.', 'events.onvif.', 'stills.enabled', 'stills.stream', 'stills.intervalS', 'stills.size', 'stills.quality', 'previews.tileSize', 'previews.grid', 'previews.quality', 'ftp.enabled', 'ftp.port', 'ftp.passive', 'ftp.tls', 'ftp.publicHost', 'ftp.certFile', 'ftp.keyFile', 'composition.font', 'server.trustProxy'];
// Read once when the process starts: the in-process restart leaves them
// pending until a new process.
const PROCESS = ['server.port', 'server.dataDir', 'server.trustProxy', 'composition.font', 'server.tls.port', 'tls.site', 'tls.cameraCerts', 'tls.cameraSubnet', 'tls.proxyAddresses'];
export function needsProcessRestart(path: string): boolean {
  return PROCESS.includes(path);
}
// Live although under a restart prefix: the Baichuan port at the next
// connection, analytics kinds on every event.
const LIVE = [/^cameras\.[^.]+\.baichuanPort$/, /^cameras\.[^.]+\.analytics\./];
export function needsRestart(path: string): boolean {
  if (LIVE.some((re) => re.test(path))) return false;
  return RESTART.some((r) => (r.endsWith('.') ? path.startsWith(r) : path === r));
}

// Which restart applies a setting: `process` a new process (it wins over
// the restart), `camera` that camera's restart (a cameras.<id>.* setting),
// `host` the host-wide restart; null: live.
export type RestartKind = 'process' | 'camera' | 'host';
export function restartKind(path: string): RestartKind | null {
  if (needsProcessRestart(path)) return 'process';
  if (!needsRestart(path)) return null;
  return /^cameras\.[^.]+\./.test(path) ? 'camera' : 'host';
}
// The same, coarse: a new process, or one of the restarts.
export function restartNeed(path: string): 'process' | 'restart' | null {
  const k = restartKind(path);
  return k === 'process' ? k : k ? 'restart' : null;
}
