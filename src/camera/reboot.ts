import type { AuditLog } from '../audit/audit-log';
import { logger } from '../log';
import { CameraError, type CameraErrorCode } from './client';
import { PoeSwitchError, type CycleResult, type PoeSwitchErrorCode } from './poe-switch';

// A camera reboot requested through the control API (issue #83). The camera
// is offline about a minute, may drop the connection before answering, and
// every token is invalid afterwards (cams docs/reolink-api.md, Reboot). The
// proxy rides it out: nothing is restarted on purpose; the event intake
// re-subscribes, stills and FTP carry on once the camera is back.
// A power-cycle through the camera's PoE switch (issue #85) is the same to
// the proxy, after a "power-cycling" phase while the PoE is off: one state,
// one cooldown and one watch for both.

export const REBOOT_COOLDOWN_MS = 120_000; // the same as cams
export const REBOOT_WAIT_MS = 5 * 60_000; // "rebooting" until back, or this long
const POLL_MS = 2000;

export type RebootKind = 'reboot' | 'powercycle';
export interface RebootState {
  kind: RebootKind;
  requestedAt: number;
  confirmed: boolean; // the camera answered before going down (a power-cycle: true)
  phase: 'power-cycling' | 'rebooting' | 'back' | 'not-back';
  offAt: number | null; // a power-cycle: when the PoE went off
  endedAt: number | null;
  downSec: number | null; // request (a power-cycle: the cut) to the first answer after it
}
// 429: within the cooldown, or `inFlight` while a reboot or power-cycle is being sent.
export type TooSoon = { status: 429; retryAfterS: number; inFlight: boolean };
export type RebootAnswer =
  | { status: 202; confirmed: boolean }
  | TooSoon
  | { status: 502; error: CameraErrorCode; detail: string };
export type PowerCycleAnswer =
  | ({ status: 202 } & CycleResult)
  | TooSoon
  | { status: 409 | 502; error: PoeSwitchErrorCode; detail: string; poeOff?: true; turnedOn?: boolean };
// What the audit records name: never the password.
export interface PowerCycleInfo { switch: { model: string; host: string; port: number }; offSeconds: number }
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

  // The cooldown (shared by the reboot and the power-cycle), or null.
  private tooSoon(): TooSoon | null {
    const cooldown = this.d.cooldownMs ?? REBOOT_COOLDOWN_MS;
    const since = this.now() - this.lastSent;
    if (this.sending) return { status: 429, retryAfterS: Math.ceil(cooldown / 1000), inFlight: true };
    if (since < cooldown) return { status: 429, retryAfterS: Math.ceil((cooldown - since) / 1000), inFlight: false };
    return null;
  }

  async request(who: RebootRequester): Promise<RebootAnswer> {
    const refused = this.tooSoon();
    if (refused) return refused;
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
    this.current = { kind: 'reboot', requestedAt: at, confirmed, phase: 'rebooting', offAt: null, endedAt: null, downSec: null };
    this.d.audit.write({
      ...base, outcome: confirmed ? 'success' : 'unknown',
      message: confirmed ? 'Camera reboot requested; the camera confirmed it' : 'Camera reboot requested; the camera dropped the connection before answering',
      details: { confirmed, requestedBy: who.requestedBy, phase: 'requested' },
    });
    logger.info({ confirmed }, 'camera_reboot_requested');
    this.watch(serialBefore);
    return { status: 202, confirmed };
  }

  // Power-cycle through the PoE switch: `run` logs in to the switch, cuts the
  // port, waits and turns it on again (PoeSwitch.cycle). The answer comes once
  // PoE is back on. A refusal before the cut (busy, no power, a wrong
  // password, unreachable) changes nothing and starts no cooldown.
  async powerCycle(who: RebootRequester, info: PowerCycleInfo, run: (onOff: (at: number) => void) => Promise<CycleResult>): Promise<PowerCycleAnswer> {
    const refused = this.tooSoon();
    if (refused) return refused;
    this.sending = true;
    const serialBefore = this.d.serial();
    const requestedAt = this.now();
    const previous = this.current;
    let offAt: number | null = null;
    const base = { action: 'camera-powercycle', category: ['host'], type: ['change'], user: 'admin', ip: who.ip, userAgent: who.userAgent };
    const where = `${info.switch.host} port ${info.switch.port}`;
    const details = { switch: { ...info.switch }, offSeconds: info.offSeconds, requestedBy: who.requestedBy, phase: 'requested' };
    // The cut, on this class's clock (the cooldown and downSec count from it).
    const cut = () => {
      const at = this.now();
      offAt = at;
      this.lastSent = at;
      this.d.forgetToken(); // the camera loses every token
      this.current = { kind: 'powercycle', requestedAt, confirmed: true, phase: 'power-cycling', offAt: at, endedAt: null, downSec: null };
    };
    try {
      const r = await run(cut);
      this.current = { ...this.current!, phase: 'rebooting' };
      this.d.audit.write({
        ...base, outcome: 'success',
        message: `Camera power-cycled through the PoE switch (${where}): ${r.watts} W before, PoE off for ${info.offSeconds} s`,
        details: { ...details, watts: r.watts, offAt: r.offAt, onAt: r.onAt },
      });
      logger.info({ watts: r.watts, offMs: r.onAt - r.offAt }, 'camera_powercycle_done');
      this.watch(serialBefore);
      return { status: 202, ...r };
    } catch (err) {
      const e = err instanceof PoeSwitchError ? err : new PoeSwitchError('switch_error', (err as Error).message, offAt !== null, null);
      // The switch says whether the PoE-off request went out (also when its
      // answer was lost and onOff never ran): then the port may have been cut.
      const poeOff = e.poeOff;
      const turnedOn = e.turnedOn === true;
      // The port may have been cut: from now on (if the cut wasn't seen), and
      // the record says when (#106: the stills inventory counts from the cut).
      if (poeOff && offAt === null) cut();
      const cutAt = offAt as number | null;
      this.d.audit.write({
        ...base, outcome: 'failure', error: e.code,
        message: poeOff
          ? `Camera power-cycle through the PoE switch (${where}) failed: PoE may have been cut; turned back on: ${turnedOn ? 'yes' : 'no'} (${e.message})`
          : `Camera power-cycle through the PoE switch (${where}) refused: ${e.message}`,
        details: { ...details, poeOff, ...(poeOff ? { turnedOn, offAt: cutAt } : {}) },
      });
      (poeOff && !turnedOn ? logger.error : logger.warn).call(logger, { code: e.code, poeOff, turnedOn }, 'camera_powercycle_failed');
      if (poeOff) {
        // The camera may have gone dark: the cooldown holds and the watch tells when (or whether) it is back.
        this.current = { ...this.current!, phase: 'rebooting' };
        this.watch(serialBefore);
        return { status: 502, error: e.code, detail: e.message, poeOff: true, turnedOn };
      }
      this.current = previous;
      return { status: e.code === 'switch_busy' || e.code === 'no_power' ? 409 : 502, error: e.code, detail: e.message };
    } finally {
      this.sending = false;
    }
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
      const downSec = phase === 'back' ? Math.round((t - (c.offAt ?? c.requestedAt)) / 1000) : null;
      this.current = { ...c, phase, endedAt: t, downSec };
      const cycle = c.kind === 'powercycle';
      const what = cycle ? 'power-cycle' : 'reboot';
      const base = { action: cycle ? 'camera-powercycle' : 'camera-reboot', category: ['host'], type: ['end'], user: 'system' };
      const more = cycle ? {} : { confirmed: c.confirmed };
      if (phase === 'back') this.d.audit.write({ ...base, outcome: 'success', message: `The camera answers again after the ${what} (${downSec} s)`, details: { phase, downSec, ...more } });
      else this.d.audit.write({ ...base, outcome: 'failure', message: `The camera did not answer within ${Math.round(wait / 1000)} s of the ${what}`, details: { phase, waitedSec: Math.round(wait / 1000), ...more } });
      logger.info({ kind: c.kind, phase, downSec }, 'camera_reboot_ended');
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
      if (this.now() - (this.current.offAt ?? this.current.requestedAt) >= wait) return end('not-back');
      this.timer = setTimeout(() => void tick(), this.d.pollMs ?? POLL_MS);
      this.timer.unref();
    };
    this.timer = setTimeout(() => void tick(), this.d.pollMs ?? POLL_MS);
    this.timer.unref();
  }
}
