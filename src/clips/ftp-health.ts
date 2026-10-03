import { CameraError } from '../camera/client';
import type { AuditLog } from '../audit/audit-log';
import type { Catalog } from '../catalog/db';
import { lastClipReceived } from '../catalog/clips';
import { countEventsOfKinds } from '../catalog/events';
import { logger } from '../log';
import type { FtpTarget } from './camera-ftp';

// Issue #93: on 2026-10-01 the camera's FTP upload was found off, 37 hours
// after the last clip, and nobody had noticed. The proxy reads the camera's
// Ftp object every few minutes (GetFtpV20, without the password), shows it on
// the Status page, audits its changes (`camera-check`), and warns when clips
// stop arriving while the camera records events.

// on: to this proxy. off: switched off with a server set, or with none
// after clips arrived before (red). elsewhere: another port or user, or
// server and more (red). server_differs: only the server name differs
// (amber: may be another name for this proxy). not_set_up: no server and
// never a clip (a fresh or reset camera; grey, no alarm).
type FtpState = 'on' | 'off' | 'elsewhere' | 'server_differs' | 'not_set_up';
interface FtpReading { state: FtpState; enable: boolean; server: string; port: number; user: string; mismatch: string[] }
export interface CameraFtpView {
  state: FtpState | 'unknown'; // unknown: not read yet
  checkedAt: number | null; // the last successful read
  enable: boolean | null;
  server: string | null;
  port: number | null;
  user: string | null;
  mismatch: string[]; // what differs from this proxy: server, port, user
  error: string | null; // why the last read failed
}
type Target = Pick<FtpTarget, 'server' | 'port' | 'user'>;

// The kinds the camera records and the FTP schedule uploads (camera-ftp.ts:
// MD, AI_PEOPLE, AI_VEHICLE, AI_DOG_CAT).
export const RECORDING_KINDS = ['motion', 'person', 'vehicle', 'pet'] as const;
// Events this recent don't count yet: the clip follows after the
// post-record time and the upload.
export const STALL_GRACE_MS = 10 * 60_000;
const CHECK_MS = 5 * 60_000;

// The camera masks the FTP user in its answer. Measured 2026-10-02: only the
// 6-character `camera` -> `ca**ra` (first two characters, stars, last two).
// The match is best effort: any number of stars, the expected user needs 5+
// characters, and with more than two stars the length must agree (a fixed `**`
// leaves it unchecked). A different user with the same first and last two
// characters passes.
function sameFtpUser(seen: string, expected: string): boolean {
  if (!seen.includes('*')) return seen === expected;
  const m = /^([^*]{2})(\*+)([^*]{2})$/u.exec(seen);
  const e = Array.from(expected);
  if (!m || e.length < 5) return false;
  if (m[2].length > 2 && Array.from(seen).length !== e.length) return false;
  return m[1] === e.slice(0, 2).join('') && m[3] === e.slice(-2).join('');
}

// What camera-ftp-setup would write for this proxy, compared with the
// camera's settings (see FtpState). The server is compared trimmed and in
// lower case (no DNS); without ftp.publicHost it isn't compared.
// `clipsBefore`: a clip was ever received (clip_arrivals).
export function classifyFtp(ftp: Record<string, unknown>, t: Target, ctx: { clipsBefore: boolean } = { clipsBefore: false }): FtpReading {
  const server = typeof ftp.server === 'string' ? ftp.server.trim() : '';
  const port = Number(ftp.port ?? 0);
  const user = typeof ftp.userName === 'string' ? ftp.userName : '';
  const enable = Number(ftp.enable) === 1 && server !== '';
  const norm = (h: string) => h.trim().toLowerCase();
  const mismatch = [
    ...(t.server && norm(server) !== norm(t.server) ? ['server'] : []),
    ...(port !== t.port ? ['port'] : []),
    ...(!sameFtpUser(user, t.user) ? ['user'] : []),
  ];
  const state: FtpState = !server && !ctx.clipsBefore ? 'not_set_up'
    : !enable ? 'off'
    : !mismatch.length ? 'on'
    : mismatch.length === 1 && mismatch[0] === 'server' ? 'server_differs'
    : 'elsewhere';
  return { state, enable, server, port, user, mismatch };
}

const where = (r: { server: string | null; port: number | null; user: string | null }) => `${r.server || '(none)'}:${r.port ?? '?'}, user ${r.user || '(none)'}`;

export class CameraFtpWatch {
  private current: CameraFtpView = { state: 'unknown', checkedAt: null, enable: null, server: null, port: null, user: null, mismatch: [], error: null };
  private recorded: { state: string } | null | undefined; // the last camera-check record's `to` (undefined: not looked up yet)
  private running: Promise<CameraFtpView> | undefined;
  private seq = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(
    private readonly d: {
      read: () => Promise<Record<string, unknown>>; // the camera's Ftp object, without the password
      target: () => Target;
      audit: AuditLog;
      active: () => boolean; // FTP on in the proxy and the camera online
      clipsBefore?: () => boolean; // a clip was ever received
      now?: () => number;
      everyMs?: number;
    },
  ) {
    this.now = d.now ?? Date.now;
  }

  view(): CameraFtpView {
    return { ...this.current, mismatch: [...this.current.mismatch] };
  }

  start(): void {
    if (this.timer) return;
    const tick = () => {
      void this.checkNow().finally(() => {
        if (this.timer) this.timer = setTimeout(tick, this.d.everyMs ?? CHECK_MS);
      });
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  // One read; concurrent callers share it. A read overtaken by note() is dropped.
  checkNow(): Promise<CameraFtpView> {
    this.running ??= this.check().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  // The camera's answer to an action (setup, off): no need to wait for the next read.
  note(ftp: Record<string, unknown>): void {
    this.seq++;
    this.apply(classifyFtp(ftp, this.d.target(), { clipsBefore: this.d.clipsBefore?.() ?? false }));
  }

  private async check(): Promise<CameraFtpView> {
    if (!this.d.active()) return this.view();
    const seq = this.seq;
    try {
      const ftp = await this.d.read();
      if (seq === this.seq) this.apply(classifyFtp(ftp, this.d.target(), { clipsBefore: this.d.clipsBefore?.() ?? false }));
    } catch (err) {
      if (seq === this.seq) this.current = { ...this.current, error: err instanceof CameraError ? err.code : (err as Error).message };
    }
    return this.view();
  }

  private apply(r: FtpReading): void {
    const before = this.current;
    this.current = { state: r.state, checkedAt: this.now(), enable: r.enable, server: r.server, port: r.port, user: r.user, mismatch: r.mismatch, error: null };
    // The audit log knows the state from the last record (a restart doesn't
    // repeat it); with none, the baseline is on.
    // Never set up is no change to record (and no alarm).
    if (r.state === 'not_set_up') return;
    if (this.recorded === undefined) this.recorded = this.lastRecorded();
    if (r.state === (this.recorded?.state ?? 'on')) return;
    const summary = (v: CameraFtpView) => ({ state: v.state, enable: v.enable, server: v.server, port: v.port, user: v.user });
    const from = before.state !== 'unknown' ? summary(before) : (this.recorded ?? { state: 'unknown' });
    const to = summary(this.current);
    const t = this.d.target();
    const message =
      r.state === 'off' ? `Camera FTP upload is off (was ${from.state}); its settings: ${where(to)}`
      : r.state === 'elsewhere' ? `Camera FTP upload points elsewhere: ${where(to)}, not this proxy (${where(t)}); was ${from.state}`
      : r.state === 'server_differs' ? `Camera FTP server is ${to.server}, this proxy is ${t.server}; was ${from.state}`
      : `Camera FTP upload is on, to this proxy (${where(to)}); was ${from.state}`;
    const ok = this.d.audit.write({ action: 'camera-check', category: ['host'], type: ['change'], outcome: r.state === 'off' || r.state === 'elsewhere' ? 'failure' : 'success', user: 'system', message, details: { check: 'ftp', from, to, ...(r.mismatch.length ? { mismatch: r.mismatch } : {}) } });
    if (ok) this.recorded = to;
    logger.warn({ from: from.state, to: r.state }, 'camera_ftp_changed');
  }

  private lastRecorded(): { state: string } | null {
    const r = this.d.audit.find((x) => x.event?.action === 'camera-check' && x.cam_proxy?.check === 'ftp', 90);
    const to = r?.cam_proxy?.to as { state?: unknown } | undefined;
    return to && typeof to.state === 'string' ? (to as { state: string }) : null;
  }
}

export interface ClipsStall { stalled: boolean; hours: number; lastClip: number | null; events: number }

// No clip received for `hours` while the camera recorded events in that
// time (the kinds it uploads, older than STALL_GRACE_MS): FTP isn't working
// even if it is on. A quiet day is no warning, and neither is a camera
// whose FTP was never set up (`notSetUp`).
export function clipsStalled(c: Catalog, cam: string, now: number, hours: number, opts: { notSetUp?: boolean } = {}): ClipsStall {
  const from = now - hours * 3600_000;
  const lastClip = lastClipReceived(c, cam);
  if ((lastClip !== null && lastClip >= from) || opts.notSetUp) return { stalled: false, hours, lastClip, events: 0 };
  const events = countEventsOfKinds(c, cam, RECORDING_KINDS, from, now - STALL_GRACE_MS);
  return { stalled: events > 0, hours, lastClip, events };
}
