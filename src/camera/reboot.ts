import type { AuditLog } from '../audit/audit-log';
import { logger } from '../log';
import { CameraError, type CameraErrorCode } from './client';

// A camera reboot requested through the control API (issue #83). The camera
// is offline about a minute, may drop the connection before answering, and
// every token is invalid afterwards (cams docs/reolink-api.md, Reboot). The
// proxy rides it out: nothing is restarted on purpose; the event intake
// re-subscribes, stills and FTP carry on once the camera is back.

export const REBOOT_COOLDOWN_MS = 120_000; // the same as cams
export const REBOOT_WAIT_MS = 5 * 60_000; // "rebooting" until back, or this long
const POLL_MS = 2000;

export interface RebootState {
  requestedAt: number;
  confirmed: boolean; // the camera answered before going down
  phase: 'rebooting' | 'back' | 'not-back';
  endedAt: number | null;
  downSec: number | null; // request to the first answer after it
}
export type RebootAnswer =
  | { status: 202; confirmed: boolean }
  | { status: 429; retryAfterS: number }
  | { status: 502; error: CameraErrorCode; detail: string };
export interface RebootRequester { requestedBy: 'session' | 'token'; ip: string; userAgent?: string }

export interface RebootDeps {
  send: () => Promise<unknown>; // the camera's Reboot command
  forgetToken: () => void; // a reboot invalidates every token
  serial: () => string | undefined; // from the last good status check
  check: () => Promise<{ ok: boolean; serial?: string }>; // a status check now
  audit: AuditLog;
  now?: () => number;
  pollMs?: number;
  timeoutMs?: number;
  cooldownMs?: number;
}

// Back means: a check answered after one failed (the camera was seen down),
// or the camera answers with a new serial number (it changes on every
// reboot), for a reboot faster than the checks.
export class CameraReboot {
  private current: RebootState | null = null;
  private lastSent = Number.NEGATIVE_INFINITY;
  private sending = false;
  private timer: NodeJS.Timeout | undefined;
  private watchId = 0;
  private readonly now: () => number;

  constructor(private readonly d: RebootDeps) {
    this.now = d.now ?? Date.now;
  }

  state(): RebootState | null {
    return this.current ? { ...this.current } : null;
  }

  async request(who: RebootRequester): Promise<RebootAnswer> {
    const cooldown = this.d.cooldownMs ?? REBOOT_COOLDOWN_MS;
    const since = this.now() - this.lastSent;
    if (this.sending || since < cooldown) return { status: 429, retryAfterS: this.sending ? Math.ceil(cooldown / 1000) : Math.ceil((cooldown - since) / 1000) };
    this.sending = true;
    const serialBefore = this.d.serial();
    const base = { action: 'camera-reboot', category: ['host'], type: ['change'], user: 'admin', ip: who.ip, userAgent: who.userAgent };
    let confirmed: boolean;
    try {
      await this.d.send();
      confirmed = true;
    } catch (err) {
      const sent = err instanceof CameraError && err.requestSent;
      if (!sent) {
        this.sending = false;
        const code: CameraErrorCode = err instanceof CameraError ? err.code : 'camera_error';
        this.d.audit.write({ ...base, outcome: 'failure', error: code, message: `Camera reboot requested; the request did not reach the camera (${code})`, details: { confirmed: false, requestedBy: who.requestedBy, phase: 'requested' } });
        return { status: 502, error: code, detail: (err as Error).message };
      }
      confirmed = false; // received, then the connection dropped: the camera is going down
    }
    const at = this.now();
    this.sending = false;
    this.lastSent = at;
    this.d.forgetToken();
    this.current = { requestedAt: at, confirmed, phase: 'rebooting', endedAt: null, downSec: null };
    this.d.audit.write({
      ...base, outcome: confirmed ? 'success' : 'unknown',
      message: confirmed ? 'Camera reboot requested; the camera confirmed it' : 'Camera reboot requested; the camera dropped the connection before answering',
      details: { confirmed, requestedBy: who.requestedBy, phase: 'requested' },
    });
    logger.info({ confirmed }, 'camera_reboot_requested');
    this.watch(serialBefore);
    return { status: 202, confirmed };
  }

  stop(): void {
    this.watchId++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private watch(serialBefore: string | undefined): void {
    this.stop();
    const id = this.watchId;
    const wait = this.d.timeoutMs ?? REBOOT_WAIT_MS;
    let seenDown = false;
    const end = (phase: 'back' | 'not-back') => {
      const c = this.current!;
      const t = this.now();
      const downSec = phase === 'back' ? Math.round((t - c.requestedAt) / 1000) : null;
      this.current = { ...c, phase, endedAt: t, downSec };
      const base = { action: 'camera-reboot', category: ['host'], type: ['end'], user: 'system' };
      if (phase === 'back') this.d.audit.write({ ...base, outcome: 'success', message: `The camera answers again after the reboot (${downSec} s)`, details: { phase, downSec, confirmed: c.confirmed } });
      else this.d.audit.write({ ...base, outcome: 'failure', message: `The camera did not answer within ${Math.round(wait / 1000)} s of the reboot`, details: { phase, waitedSec: Math.round(wait / 1000), confirmed: c.confirmed } });
      logger.info({ phase, downSec }, 'camera_reboot_ended');
    };
    const tick = async () => {
      if (id !== this.watchId || !this.current) return;
      let r: { ok: boolean; serial?: string };
      try {
        r = await this.d.check();
      } catch {
        r = { ok: false };
      }
      if (id !== this.watchId) return;
      if (!r.ok) seenDown = true;
      else if (seenDown || (serialBefore !== undefined && r.serial !== undefined && r.serial !== serialBefore)) return end('back');
      if (this.now() - this.current.requestedAt >= wait) return end('not-back');
      this.timer = setTimeout(() => void tick(), this.d.pollMs ?? POLL_MS);
      this.timer.unref();
    };
    this.timer = setTimeout(() => void tick(), this.d.pollMs ?? POLL_MS);
    this.timer.unref();
  }
}
