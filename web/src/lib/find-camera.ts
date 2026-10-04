// Settings → Find camera, and the settings the environment sets (spec
// 2026-10-04-pi-config-design §1, §3, §4).

// address: what the device names (its XAddr); sender: where its answer came
// from; useAddress: what "Use this address" writes (the sender on a mismatch).
export interface FoundDevice { endpoint: string; address: string; sender: string; mismatch: boolean; useAddress: string; xaddrs: string[]; name: string | null; hardware: string | null; model: string | null; current: boolean }
export interface EnvFileState { writable: boolean; reason?: string; path?: string }
export interface FindResult { devices: FoundDevice[]; tookMs: number; envFile: EnvFileState }

// A setting from CAMERA_HOST or PI_ADDRESS: read-only on the Settings page.
export const isEnvSet = (s: { source: string; env?: string }) => s.source === 'env';
export const envNote = (s: { source?: string; env?: string }) => (s.env ? `set in .env (${s.env})` : 'set in .env');

export function deviceLabel(d: Pick<FoundDevice, 'name' | 'model' | 'hardware'>): string {
  const model = d.model ?? d.hardware;
  if (d.name && model && model !== d.name) return `${d.name} (${model})`;
  return d.name ?? model ?? 'unnamed ONVIF device';
}

export function mismatchText(d: Pick<FoundDevice, 'address' | 'sender' | 'mismatch' | 'useAddress'>): string | null {
  return d.mismatch ? `address mismatch: it answered from ${d.sender} but names ${d.address}; "Use this address" takes ${d.useAddress}` : null;
}

export function foundText(count: number, tookMs: number): string {
  if (count === 0) return `No ONVIF camera answered within ${Math.round(tookMs / 1000)} s. Is the camera on this LAN, with ONVIF on?`;
  return `${count} device${count === 1 ? '' : 's'} answered.`;
}

export const handLine = (host: string) => `CAMERA_HOST=${host}`;

export function useAddressMessage(host: string, path: string | undefined): string {
  return `Use ${host} as the camera address? This writes ${handLine(host)} into ${path ?? 'the .env file'} (a backup is kept next to it) and restarts the proxy; you sign in again afterwards. Then use "Point the camera's FTP here" on the Maintenance page if the camera should upload here.`;
}

export function writtenText(r: { host: string; previous: string | null; backup: string }): string {
  return `${handLine(r.host)} written (was ${r.previous ?? 'not set'}; backup ${r.backup}). Restarting the proxy…`;
}

export function notAvailableText(reason: string | undefined): string {
  return `The proxy can't write its .env file (${reason ?? 'not available'}). Add this line to the .env file by hand (replace an existing CAMERA_HOST line), then recreate the container (docker compose up -d):`;
}
