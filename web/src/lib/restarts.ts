// The camera's restart and the proxy's restarts, told apart (Klaus
// 2026-11-15). A camera's restart takes the camera's own route on every
// proxy, also with one camera (the Pi): only that camera's side restarts.
// The proxy's restarts are host-wide: "Restart proxy services" (every
// camera side, go2rtc and the FTP server as needed, the pending settings;
// the process runs on) and "Restart proxy process" (a new process).
import { cameraIds, cameraRoute, pickCamera } from './cameras';
import type { Status } from './status-types';

type Api = (method: string, path: string) => Promise<unknown>;

export const PROXY_SERVICES_RESTART = '/control/actions/restart';
export const PROXY_PROCESS_RESTART = '/control/actions/restart-proxy';

const failText = (e: unknown) => (e instanceof Error ? e.message : 'failed');

// Restarts the picked camera's side only, on its own route (never the old
// route without a camera: that one is the host-wide restart); answers the
// line to show, never throws.
export async function restartCamera(api: Api, s: Status | null, selected: string | null): Promise<string> {
  const cam = pickCamera(cameraIds(s), selected);
  if (!cam) return 'Restart camera side: no camera';
  try {
    await api('POST', cameraRoute(cam, 'actions/restart'));
    return `Restart camera side (${cam}): started; this camera only, back in a few seconds`;
  } catch (e) {
    return `Restart camera side (${cam}): ${failText(e)}`;
  }
}

// The host-wide restart in the process; answers the line to show, never throws.
export async function restartProxyServices(api: Api): Promise<string> {
  try {
    await api('POST', PROXY_SERVICES_RESTART);
    return 'Restart proxy services: started; every camera is back in a few seconds and pending settings apply';
  } catch (e) {
    return `Restart proxy services: ${failText(e)}`;
  }
}

// The settings waiting for a restart (GET /control/config), by what
// applies them: `camera` the picked camera's restart, `cameras` every
// camera's (all of them also apply with Restart proxy services), `host`
// Restart proxy services, `process` only a new process (Restart proxy process).
export type RestartScope = 'camera' | 'host' | 'process';
export interface PendingSetting { pending: boolean; restartScope?: RestartScope }
export interface PendingRestarts { camera: string[]; cameras: string[]; host: string[]; process: string[] }
export function pendingRestarts(view: Record<string, PendingSetting>, cam: string | null): PendingRestarts {
  const out: PendingRestarts = { camera: [], cameras: [], host: [], process: [] };
  for (const [p, s] of Object.entries(view)) {
    if (!s.pending) continue;
    if (s.restartScope === 'process') out.process.push(p);
    else if (s.restartScope === 'camera') {
      out.cameras.push(p);
      if (cam && p.startsWith(`cameras.${cam}.`)) out.camera.push(p);
    } else out.host.push(p);
  }
  return out;
}

// A restart runs on after its answer, so the pending lists are read again a
// few times after it (the page no longer polls them). Returns a stop.
export const RESTART_RELOAD_MS = [1500, 4000, 10_000];
export function reloadAfterRestart(load: () => void, delays = RESTART_RELOAD_MS): () => void {
  const timers = delays.map((ms) => setTimeout(load, ms));
  return () => timers.forEach(clearTimeout);
}

// The Settings page's "restart" badge: which restart applies the setting.
export function restartBadgeTitle(scope: RestartScope | undefined): string {
  if (scope === 'process') return 'applies after Restart proxy process (Maintenance → Proxy): it is read when the process starts';
  if (scope === 'camera') return "applies after this camera's restart (Restart camera side) or Restart proxy services";
  return 'applies after Restart proxy services (Maintenance → Proxy; every camera side restarts)';
}
