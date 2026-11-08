// The Maintenance page's restart, reboot and power-cycle helpers (#71, #83, #85).

import { agoText, localHhmm } from './format';
import { REFUSED_TEXT } from './rights';

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

// /health as the page reads it; null when the proxy does not answer.
export async function readHealth(): Promise<Health | null> {
  try {
    const r = await fetch('/health', { cache: 'no-store' });
    return r.ok ? ((await r.json()) as Health) : null;
  } catch {
    return null;
  }
}

// After a restart request (posted at `postedAt`): /health every second
// until a new process answers (restartWatch), then `back` (the page
// reloads); after RESTART_GIVE_UP_MS without one, `gone`. Returns what
// stops the wait.
export function waitForNewProxy(before: Health | null, postedAt: number, back: () => void, gone: () => void): () => void {
  const isNew = restartWatch(before, postedAt);
  const t0 = Date.now();
  const timer = setInterval(async () => {
    if (isNew(await readHealth())) {
      clearInterval(timer);
      back();
    } else if (Date.now() - t0 > RESTART_GIVE_UP_MS) {
      clearInterval(timer);
      gone();
    }
  }, 1000);
  return () => clearInterval(timer);
}

export interface CameraReboot { kind?: 'reboot' | 'powercycle'; phase: 'power-cycling' | 'rebooting' | 'back' | 'not-back'; requestedAt: number; offAt?: number | null; downSec?: number | null; message?: string }

// The line for a reboot or power-cycle that ended without the camera back:
// a power-cycle that failed says what cams-admin said.
export function rebootEndText(r: CameraReboot): string {
  if (r.kind === 'powercycle' && r.message) return `The power-cycle failed: ${r.message}`;
  return `The camera did not answer within 5 minutes of the ${r.kind === 'powercycle' ? 'power-cycle' : 'reboot'}.`;
}

// The camera's state line: "power-cycling" while its PoE is off (#85), then
// "rebooting (requested HH:MM)" until it answers, instead of a plain "offline".
export function cameraStateText(c: { online: boolean; reboot?: CameraReboot | null }): string {
  if (c.reboot?.phase === 'power-cycling') return `power-cycling (requested ${localHhmm(c.reboot.requestedAt)})`;
  if (c.reboot?.phase === 'rebooting') return `rebooting (requested ${localHhmm(c.reboot.requestedAt)})`;
  return c.online ? 'online' : 'offline';
}

// A refused power-cycle request's line, from the 409/429 body.
export function powerCycleFailText(body: { error: string; detail?: string }): string {
  if (body.error === 'local_admin_only') return `Camera power-cycle: ${REFUSED_TEXT}`;
  return `Camera power-cycle: ${body.detail ?? body.error}`;
}

// The camera's power as cams-admin sent it (GET /control/cameras/:cam/power;
// spec 2026-11-07-poe-switches-design, "Camera power").
export interface CameraPower { kind: 'poe' | 'data-only' | 'adapter' | 'unknown'; switchName?: string; port?: number; watts?: number; verifiedAt?: number; notSeen?: boolean }
export interface PowerCycleOutcome { requestId: string; ok: boolean; reason?: string; at: number }
export interface PowerView { power: CameraPower | null; setAt: number | null; asked: { requestId: string; at: number } | null; result: PowerCycleOutcome | null; canRequest: boolean; why: string | null }

const switchPort = (p: CameraPower) => `${p.switchName ?? 'a switch'}, port ${p.port ?? '?'}`;

// "PoE: Switch 2, port 3, verified 2 h ago" / "Data only: power adapter" / "Power adapter" / "Unknown".
export function powerLine(p: CameraPower | null, now = Date.now()): string {
  if (!p || p.kind === 'unknown') return 'Unknown';
  if (p.kind === 'adapter') return 'Power adapter';
  if (p.kind === 'data-only') return 'Data only: power adapter';
  const verified = p.verifiedAt ? `verified ${agoText(p.verifiedAt, now)}` : 'not verified';
  return `PoE: ${switchPort(p)}, ${verified}${p.notSeen ? '; not seen there at the last check' : ''}`;
}

// The confirmation before asking cams-admin (no force from a proxy).
export function powerCycleMessage(p: CameraPower | null): string {
  const where = p?.kind === 'poe' ? ` (PoE: ${switchPort(p)})` : '';
  return `Ask cams-admin to power-cycle the camera${where}? cams-admin first checks that the camera is on that port, then cuts its PoE for a few seconds. The camera is offline for about a minute.`;
}

// The power-cycle button is off while a request is open (the proxy ends one
// unanswered after 5 minutes), while the camera is busy, or when cams-admin
// can't be asked (not connected, no power record from it).
// Why the power-cycle button is off, as a sentence: the reason already
// says "a power-cycle needs cams-admin: …".
export function powerWhyText(why: string): string {
  const t = why.charAt(0).toUpperCase() + why.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function powerCycleDisabled(v: PowerView | null, busy: boolean): boolean {
  return busy || !v || !!v.asked || !v.canRequest;
}

// cams-admin's answer (camera.power.cycle.result).
export function powerResultText(r: PowerCycleOutcome): string {
  if (r.ok) return 'Camera power-cycle: done by cams-admin';
  return `Camera power-cycle refused by cams-admin${r.reason ? `: ${r.reason}` : ''}`;
}

