// The Maintenance page's restart, reboot and power-cycle helpers (#71, #83, #85).

import { localHhmm } from './format';

// After this long without a new proxy, the page says it did not come back.
export const RESTART_GIVE_UP_MS = 120_000;

export interface Health { version: string; startedAt?: number | null }

// A new process answers /health: another version, or another start time.
export function isNewStart(before: Health | null, now: Health): boolean {
  if (!before) return true;
  return now.version !== before.version || (now.startedAt ?? null) !== (before.startedAt ?? null);
}

// Each /health read after a restart request: true once a new process
// answers. The reference is `before`. Without it (the read before the
// request failed), an answer whose start time is after the request
// (`postedAt`) is the new process; otherwise the first answer is the
// reference, which may still be the old process: never a reload on the old
// one (#78 review).
export function restartWatch(before: Health | null, postedAt?: number): (now: Health | null) => boolean {
  let ref = before;
  return (now) => {
    if (!now) return false;
    if (!before && postedAt !== undefined && typeof now.startedAt === 'number' && now.startedAt > postedAt) return true;
    if (!ref) {
      ref = now;
      return false;
    }
    return isNewStart(ref, now);
  };
}

export interface CameraReboot { kind?: 'reboot' | 'powercycle'; phase: 'power-cycling' | 'rebooting' | 'back' | 'not-back'; requestedAt: number; offAt?: number | null; downSec?: number | null }

// The camera's state line: "power-cycling" while its PoE is off (#85), then
// "rebooting (requested HH:MM)" until it answers, instead of a plain "offline".
export function cameraStateText(c: { online: boolean; reboot?: CameraReboot | null }): string {
  if (c.reboot?.phase === 'power-cycling') return `power-cycling (requested ${localHhmm(c.reboot.requestedAt)})`;
  if (c.reboot?.phase === 'rebooting') return `rebooting (requested ${localHhmm(c.reboot.requestedAt)})`;
  return c.online ? 'online' : 'offline';
}

// The camera's PoE switch (#85), as /control/status reports it.
export interface PortReading { at: number; port: number; index: number; poe: boolean; watts: number; link: boolean | null; sn: string | null; firmware: string | null }
export interface PoeSwitchStatus { model: string; host: string | null; port: number | null; ports: number; offSeconds: number; passwordSet: boolean; configured: boolean; busy: boolean; poeMaybeOff?: boolean; last: PortReading | null }

const offWarning = (port: number | null) => `The camera's PoE may be OFF: use 'Turn camera PoE on', or the switch's web UI (port ${port ?? '?'}).`;

// The Maintenance page's warning while the camera's PoE may be off (a
// power-cycle that could not turn it on again, or a reading that says off).
export function poeAlert(s: PoeSwitchStatus | null): string | null {
  return s?.poeMaybeOff ? offWarning(s.port) : null;
}

// A failed power-cycle's line, from the 409/502 body.
export function powerCycleFailText(body: { error: string; detail?: string; poeOff?: boolean; turnedOn?: boolean }, port: number | null): string {
  const detail = body.detail ?? body.error;
  if (body.poeOff && body.turnedOn) return `Camera power-cycle failed after the PoE-off request: PoE may have been cut, and it is on again (${detail})`;
  if (body.poeOff) return `Camera power-cycle failed: the camera's PoE may be OFF: use 'Turn camera PoE on', or the switch's web UI (port ${port ?? '?'}). (${detail})`;
  return `Camera power-cycle: ${detail}`;
}

// "Turn camera PoE on"'s answer.
export function poeOnText(r: { port: number; wasOn: boolean; watts: number }): string {
  return r.wasOn ? `Camera PoE: port ${r.port} was on already (${r.watts} W)` : `Camera PoE: turned on on port ${r.port}; the camera boots in about a minute`;
}

export function powerCycleMessage(s: { host: string | null; port: number | null; offSeconds: number }): string {
  return `Cut the camera's PoE power on ${s.host} port ${s.port} for ${s.offSeconds} s? The camera is offline for about a minute. Only works while nobody is logged in to the switch's web UI.`;
}

// Why the switch can't be used (as the proxy says it), or null.
function notConfigured(s: PoeSwitchStatus): string | null {
  if (!s.host) return 'camera.poeSwitch.host is not set';
  if (!s.port) return 'camera.poeSwitch.port is not set';
  if (s.port > s.ports) return 'camera.poeSwitch.port is above camera.poeSwitch.ports';
  if (!s.passwordSet) return 'CAMPROXY_POE_SWITCH_PASSWORD is not set';
  return null;
}

// One line for the Status and Settings pages: the switch, the port and the
// last reading (read when asked, never polled).
export function poeLine(s: PoeSwitchStatus): string {
  if (s.model === 'none') return 'none';
  const where = `${s.host ?? '—'} port ${s.port ?? '—'}`;
  if (!s.configured) return `${where} · not configured: ${notConfigured(s) ?? 'unknown'}`;
  if (!s.last) return `${where} · not read yet`;
  return `${where} · PoE ${s.last.poe ? 'on' : 'off'}, ${s.last.watts} W (read ${localHhmm(s.last.at)})`;
}
