// The Maintenance page's restart and reboot helpers (#71, #83).

// After this long without a new proxy, the page says it did not come back.
export const RESTART_GIVE_UP_MS = 120_000;

export interface Health { version: string; startedAt?: number | null }

// A new process answers /health: another version, or another start time.
export function isNewStart(before: Health | null, now: Health): boolean {
  if (!before) return true;
  return now.version !== before.version || (now.startedAt ?? null) !== (before.startedAt ?? null);
}

export interface CameraReboot { phase: 'rebooting' | 'back' | 'not-back'; requestedAt: number; downSec?: number | null }

// The camera's state line: "rebooting (requested HH:MM)" during a reboot the
// proxy requested, instead of a plain "offline".
export function cameraStateText(c: { online: boolean; reboot?: CameraReboot | null }): string {
  if (c.reboot?.phase === 'rebooting') {
    const t = new Date(c.reboot.requestedAt);
    return `rebooting (requested ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')})`;
  }
  return c.online ? 'online' : 'offline';
}
