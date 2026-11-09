import { sleep, TIMED_OUT, within } from '../async';
import { logger } from '../log';
import { driverFor, type LocateResult, type SwitchDetail, type SwitchDriver, type SwitchRef, type SwitchSession } from './switch/driver';
import { PoeSwitchError, SwitchRefusal } from './switch/errors';
import { pickPort, pingBurst, pingHost } from './switch/locate';

export { PoeSwitchError, type PoeSwitchErrorCode } from './switch/errors';
export { poeOpcode, portIndex, reverseOrder, Session } from './switch/sscpoe-web';
export type { LocateResult, SwitchRef } from './switch/driver';

const NO_PASSWORD = 'no password is set for the switch';
const ON_RETRY_MS = 60_000; // how long a failed PoE-on is retried (backoff 1, 2, 4, 8, 10, 10… s)
const STOP_RECOVERY_MS = 6_000; // on shutdown: the PoE-on retries end after this
const STOP_WAIT_MS = 8_000; // on shutdown: the longest wait for the switch (compose's stop grace is 20 s)
// Reads during the ~5 s ping burst. The GPS-208's rates refresh every
// ~2.5–3.5 s and lag the traffic (measured 2026-11-07: the burst showed 3–4 s
// after the ping started and stayed ~3 s after it ended), so one read at a
// fixed time missed it about half the time. Read every 0.7 s, up to 10 reads
// (~7 s plus the reads), and stop at the first read that shows a port.
const LOCATE_POLL_MS = 700;
const LOCATE_READS = 10;

// The camera's PoE switch (issue #85): power-cycle the camera by cutting its
// port's PoE. A driver per switch model (src/camera/switch/driver.ts); one so
// far, `sscpoe-web` (the GPS-208 and kin, src/camera/switch/sscpoe-web.ts).
// The GPS-208 has one web session at a time: while someone is logged in to
// its web UI, every other client's POST is dropped with no answer. So the
// proxy never polls it, and always logs out, also after an error.
// The password is sent in the login body only: never logged, returned, put
// in an error message or an audit record.

// The switch a controller works: a SwitchRef from cams-admin (spec
// 2026-11-07-poe-switches-design). Model none or no host: not usable.
export type ControllerRef = Omit<SwitchRef, 'model' | 'host'> & { model: SwitchRef['model'] | 'none'; host?: string };
type PoeSwitchConfig = ControllerRef & { port: number };
export type Located = LocateResult & { sn: string | null };
// Survey failures that concern the whole switch: nothing else would work either.
const WHOLE_SWITCH: readonly string[] = ['password_unset', 'switch_auth', 'switch_unknown'];
// A survey's switch_error detail: the code and the error in words, at most 200 characters.
const surveyDetail = (err: PoeSwitchError): string => {
  const t = [...`${err.code}: ${err.message}`.replace(/\s+/g, ' ').trim()];
  return t.length > 200 ? t.slice(0, 199).join('') + '…' : t.join('');
};
export interface SurveyResult { sn: string | null; results: Array<LocateResult & { camera: string }> }

// What the switch said about a camera's port, from its port detail.
export interface PortReading {
  at: number;
  port: number; // the UI port number
  index: number; // the switch's internal index
  poe: boolean;
  watts: number;
  link: boolean | null;
  tx: number;
  rx: number;
  sn: string | null;
  firmware: string | null;
}
export interface CycleResult { offAt: number; onAt: number; watts: number }
export type VerifiedCycleResult = CycleResult & { verified: boolean };
export interface SwitchReading { sn: string | null; firmware: string | null; ports: Array<{ port: number; poe: boolean; watts: number; link: boolean | null; tx: number; rx: number }> }
export type PoeOnResult = PortReading & { wasOn: boolean };

export interface PoeSwitchDeps {
  ref: () => ControllerRef;
  password: () => string | undefined;
  lane?: () => SessionLane; // the switch's session queue, shared by every controller of one host (default: its own)
  passwordHint?: string | (() => string); // what the 'not set' reason says (default: no password is set)
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number; // per call (5 s)
  onRetryMs?: number; // how long a failed PoE-on is retried (60 s)
  stopRecoveryMs?: number; // on shutdown (6 s)
  stopWaitMs?: number; // on shutdown (8 s)
  driver?: (model: string) => SwitchDriver | undefined; // default: driverFor (tests: a fake)
  readCacheMs?: number; // how long one read serves every port (10 s, Ruling P2-7)
  queueWaitMs?: () => number; // how long a request waits for the one before it (offSeconds + 60 s)
  pingBurst?: (host: string) => { done: Promise<{ answered: boolean }> }; // default: ping (tests: a fake)
}

// The queue of one physical switch: its web UI takes one session at a time, so
// every controller working that host shares one lane.
export interface SessionLane { tail: Promise<unknown> }

// One switch's PoE controller (spec 2026-10-05-multi-camera-host-design §8.4,
// 2026-11-07-poe-switches-design): one switch session at a time for every
// use, in arrival order; state per port.
export class PoeSwitch {
  private busy = false;
  private readonly ownLane: SessionLane = { tail: Promise.resolve() };
  private get lane(): SessionLane {
    return this.d.lane?.() ?? this.ownLane;
  }
  private stopped = false;
  private forgotten = false; // stopped by the registry's forget() (#364): its sessions answer switch_unknown
  private pending = 0; // sessions queued or running
  private own: Promise<unknown> = Promise.resolve(); // settles when this controller's sessions so far have (not the shared lane's)
  private stopSignal: () => void = () => undefined;
  private readonly stopping = new Promise<'stopped'>((r) => (this.stopSignal = () => r('stopped'))); // a queued session stops waiting
  private wake: (() => void) | null = null; // ends a wait early (stop)
  private stopDeadline: number | null = null; // on shutdown: no PoE-on retry after this
  private stopEnd: number | null = null; // on shutdown (wall clock): stop() waits until here at most
  private sessionMaybeOpen = false; // the last logout was not answered
  private readonly cutting = new Set<number>(); // ports between the PoE-off request and PoE on again
  private readonly offPorts = new Set<number>(); // ports whose PoE may be off
  private cache: { at: number; detail: SwitchDetail } | null = null; // the last read's detail
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: PoeSwitchDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? sleep;
  }

  private hint(): string {
    const h = this.d.passwordHint;
    return typeof h === 'function' ? h() : (h ?? NO_PASSWORD);
  }

  // Why the switch can't be used; null when it can. With a port (null:
  // none): also that port.
  notConfigured(port?: number | null): string | null {
    const c = this.d.ref();
    if (c.model === 'none') return 'the switch has no model';
    if (!c.host) return 'the switch has no address';
    if (port !== undefined && !port) return 'no switch port';
    if (port && port > c.ports) return `port ${port} is above the switch's ${c.ports} ports`;
    if (!this.d.password()) return this.hint();
    return null;
  }

  // Whether a switch session is open now.
  isBusy(): boolean {
    return this.busy;
  }

  // The ports whose PoE may be off (a cycle's PoE-on failed, or a read said so).
  portsMaybeOff(): number[] {
    return [...this.offPorts].sort((a, b) => a - b);
  }

  // On shutdown: a power-cycle in its off time turns PoE on at once (never
  // leave the camera dark because the process ended), with a short retry
  // window, then logs out. The wait is bounded (compose's stop grace is
  // 20 s); refuses new sessions afterwards. poeLeftOff: the camera's PoE may
  // be off now (the caller logs and audits it).
  // reason 'forgotten': the registry dropped the switch (forget()), not a proxy stop.
  async stop(reason: 'stopping' | 'forgotten' = 'stopping'): Promise<{ portsLeftOff: number[]; sessionMaybeOpen: boolean }> {
    this.stopped = true;
    if (reason === 'forgotten') this.forgotten = true;
    this.stopDeadline = this.now() + (this.d.stopRecoveryMs ?? STOP_RECOVERY_MS);
    this.stopEnd = Date.now() + (this.d.stopWaitMs ?? STOP_WAIT_MS);
    this.wake?.();
    this.stopSignal();
    let finished = true;
    // This controller's own sessions (a queued one ends at once: stopped). Not
    // the shared lane: another controller's work on the same switch is not ours
    // to wait for, nor a session we may have left open (#364).
    if (this.pending > 0) {
      finished = (await within(this.own.then(() => true, () => true), this.d.stopWaitMs ?? STOP_WAIT_MS)) !== TIMED_OUT;
    }
    const portsLeftOff = [...new Set([...this.offPorts, ...(finished ? [] : this.cutting)])].sort((x, y) => x - y);
    const sessionMaybeOpen = this.sessionMaybeOpen || !finished;
    if (portsLeftOff.length) logger.error({ ports: portsLeftOff }, 'poe_switch_poe_may_be_left_off_at_stop');
    if (sessionMaybeOpen) logger.error('poe_switch_session_may_be_left_open_at_stop');
    return { portsLeftOff, sessionMaybeOpen };
  }

  // A call's timeout. While stopping, bounded by what is left of the stop's
  // wait: retries leave 1.5 s for the final logout, which gets the rest.
  private callTimeout(final: boolean): number {
    const t = this.d.timeoutMs ?? 5000;
    if (this.stopEnd === null) return t;
    return Math.max(250, Math.min(t, this.stopEnd - Date.now() - (final ? 300 : 1500)));
  }
  private stopBudgetGone(): boolean {
    return this.stopEnd !== null && Date.now() > this.stopEnd - 1500;
  }

  // A wait that stop() ends early. While stopping, the off time is skipped
  // and a retry waits at most 1 s.
  private pause(ms: number, offTime = false): Promise<void> {
    if (this.stopped) return offTime ? Promise.resolve() : this.sleep(Math.min(ms, 1000));
    return new Promise<void>((resolve) => {
      this.wake = resolve;
      void this.sleep(ms).then(resolve);
    }).finally(() => (this.wake = null));
  }

  // A camera's port now: log in, read, log out. One read serves every port
  // for readCacheMs (10 s, Ruling P2-7) unless `fresh`.
  read(port: number, o: { fresh?: boolean } = {}): Promise<PortReading> {
    const cached = this.cache;
    const c = this.d.ref();
    const driver = (this.d.driver ?? driverFor)(c.model);
    if (!o.fresh && cached && driver && this.now() - cached.at <= (this.d.readCacheMs ?? 10_000) && this.notConfigured(port) === null) {
      try {
        return Promise.resolve(this.reading(cached.detail, { ...c, port }, driver));
      } catch (err) {
        return Promise.reject(err as Error);
      }
    }
    return this.session(port, async (s, cfg, drv) => {
      const d = await s.detail();
      this.cache = { at: this.now(), detail: d };
      return this.reading(d, cfg, drv);
    });
  }

  // Every PoE port of the switch in one session (switch.read): the ports by
  // their UI numbers, with the current rates. No port of ours; nothing is remembered.
  readAll(): Promise<SwitchReading> {
    return this.session(undefined, async (s, c, driver) => {
      const d = await s.detail();
      const ports: SwitchReading['ports'] = [];
      for (let port = 1; port <= c.ports; port++) {
        const i = driver.portIndex(port, c.ports, d.sn ?? '');
        if (i < 0 || i >= d.poe.length) throw new PoeSwitchError('switch_error', `port ${port} maps to index ${i}, outside the switch's ${d.poe.length} ports`);
        ports.push({ port, poe: d.poe[i], watts: d.watts[i] ?? 0, link: d.link[i] ?? null, tx: d.tx[i] ?? 0, rx: d.rx[i] ?? 0 });
      }
      return { sn: d.sn, firmware: d.firmware, ports };
    });
  }

  // Cut the camera's PoE for offSeconds, then turn it on again. Refuses
  // (no_power) unless the port has PoE on and draws power: it never cuts a
  // port that isn't powering something. `onOff` runs once PoE is off.
  // Once the PoE-off request is sent, every failure (a lost or refused
  // answer, a timeout, onOff throwing) still turns PoE on again, and the
  // error says so (poeOff: true, turnedOn).
  // verifyHost: first, in the same session, `locate` that host: unless its
  // traffic shows on this port, nothing is switched (not_verified). null: a
  // forced cycle, unverified.
  cycle(port: number, onOff: (at: number) => void, o: { verifyHost: string | null }): Promise<VerifiedCycleResult> {
    return this.session(port, async (s, c, driver) => {
      this.cache = null; // the read cache: never across a change
      let verified = false;
      if (o.verifyHost !== null) {
        const l = await this.locateIn(s, c, driver, o.verifyHost);
        if (!l.found || l.port !== c.port) throw new PoeSwitchError('not_verified', `port ${c.port} not verified: ${l.found ? `the camera's traffic showed on port ${l.port}` : l.reason === 'not_reachable' ? `the camera at ${o.verifyHost} did not answer the ping burst` : `the camera's traffic showed on no single port (${l.reason})`}: not switching`);
        verified = true;
      }
      const r = this.reading(await s.detail(), c, driver);
      if (!r.poe || !(r.watts > 0)) throw new PoeSwitchError('no_power', `port ${r.port} (index ${r.index}) has PoE ${r.poe ? 'on' : 'off'} and draws ${r.watts} W: not switching`);
      if (this.stopped) throw this.stoppedError(': not switching');
      let failure: Error | null = null;
      let offAt: number | null = null;
      this.cutting.add(c.port);
      try {
        await s.setPoe(r.index, false);
        offAt = this.now();
        logger.info({ port: r.port, index: r.index, watts: r.watts }, 'poe_switch_port_off');
        onOff(offAt);
        await this.pause(c.offSeconds * 1000, true);
      } catch (err) {
        failure = err as Error;
        // The switch answered the off with a no: if the port still has PoE
        // and power, nothing was cut (no recovery, no cooldown, no watch).
        if (offAt === null && failure instanceof SwitchRefusal) {
          let still: PortReading | null = null;
          try {
            still = this.reading(await s.detail(), c, driver);
          } catch {
            // can't tell: treat it as cut
          }
          if (still?.poe && still.watts > 0) {
            this.cutting.delete(c.port);
            throw new PoeSwitchError('switch_error', `the switch refused PoE off on port ${r.port}; the port still has power: nothing was cut (${failure.message})`);
          }
        }
        logger.error({ port: r.port, err: failure.message }, 'poe_switch_cut_failed_turning_on');
      }
      const on = await this.turnOn(s, c, driver, r.index);
      this.cutting.delete(c.port);
      this.cache = null;
      this.markOff(c.port, !on.ok);
      if (!on.ok) {
        logger.error({ port: r.port, err: on.last }, 'poe_switch_poe_may_still_be_off');
        throw new PoeSwitchError('switch_error', `PoE may still be OFF on port ${r.port}: the switch did not turn it on again (${on.last}). Use "Turn camera PoE on", or the switch's web UI (port ${r.port})`, true, false);
      }
      if (failure) throw new PoeSwitchError('switch_error', `PoE may have been cut on port ${r.port}; it is on again (${failure.message})`, true, true);
      const onAt = this.now();
      logger.info({ port: r.port, index: r.index, offMs: onAt - offAt! }, 'poe_switch_port_on');
      return { offAt: offAt!, onAt, watts: r.watts, verified };
    });
  }

  // Which port a camera's traffic shows on (spec 2026-11-07-poe-switches-design,
  // "Finding a camera"): in one session, a read, a ping burst to `host`, a
  // second read during it; logged out after the burst ended.
  locate(host: string): Promise<Located> {
    return this.session(undefined, (s, c, driver) => this.locateIn(s, c, driver, host));
  }

  // locate for each camera, one after another, each in its own queued
  // session: the switch is released between cameras, so a read or a cycle
  // queued during a survey goes next instead of waiting for all of it.
  // A switch failure on one camera (busy, a timeout: #364 m3) is that
  // camera's result (switch_error, the error in words) and the survey goes
  // on; one that concerns the whole switch (no or a wrong password, the
  // switch forgotten), or every camera failing, fails the survey.
  async survey(cameras: Array<{ camera: string; host: string }>): Promise<SurveyResult> {
    let sn: string | null = null;
    let first: PoeSwitchError | null = null;
    const results: SurveyResult['results'] = [];
    for (const cam of cameras) {
      try {
        const { sn: got, ...l } = await this.locate(cam.host);
        sn = got;
        results.push({ camera: cam.camera, ...l });
      } catch (err) {
        if (!(err instanceof PoeSwitchError) || WHOLE_SWITCH.includes(err.code)) throw err;
        first ??= err;
        logger.warn({ camera: cam.camera, code: err.code, err: err.message }, 'poe_switch_survey_camera_failed');
        results.push({ camera: cam.camera, found: false, reason: 'switch_error', detail: surveyDetail(err) });
      }
    }
    if (first && results.every((r) => r.reason === 'switch_error')) throw first;
    return { sn, results };
  }

  private async locateIn(s: SwitchSession, c: PoeSwitchConfig, driver: SwitchDriver, host: string): Promise<Located> {
    const base = await s.detail();
    const burst = (this.d.pingBurst ?? pingBurst)(pingHost(host));
    let ended: { answered: boolean } | null = null;
    void burst.done.then((r) => (ended = r));
    let during: SwitchDetail = base;
    let picked: LocateResult = { found: false, reason: 'no_traffic' };
    try {
      for (let i = 0; i < LOCATE_READS && !picked.found; i++) {
        await this.pause(LOCATE_POLL_MS);
        if (ended && !(ended as { answered: boolean }).answered) break; // no reply: nothing to find
        during = await s.detail();
        const sn = during.sn ?? '';
        picked = pickPort(c.ports, base, during, (p) => driver.portIndex(p, c.ports, sn));
      }
    } catch (err) {
      await burst.done; // the burst ends by itself (~5 s): the session stays until then
      throw err;
    }
    const { answered } = await burst.done;
    if (!answered) return { found: false, reason: 'not_reachable', sn: base.sn };
    return { ...picked, sn: during.sn };
  }

  // "Turn camera PoE on" (recovery): PoE on for the camera's port if it is
  // off. No power check (an unpowered port is the point).
  poeOn(port: number): Promise<PoeOnResult> {
    return this.session(port, async (s, c, driver) => {
      const r = this.reading(await s.detail(), c, driver);
      if (r.poe) return { ...r, wasOn: true };
      this.cache = null;
      const on = await this.turnOn(s, c, driver, r.index);
      this.markOff(c.port, !on.ok);
      if (!on.ok) throw new PoeSwitchError('switch_error', `PoE is still OFF on port ${r.port}: the switch did not turn it on (${on.last}). Try the switch's web UI (port ${r.port})`, true, false);
      logger.info({ port: r.port, index: r.index }, 'poe_switch_port_on_recovery');
      let after: PortReading = { ...r, poe: true };
      try {
        after = this.reading(await s.detail(), c, driver);
      } catch {
        // PoE on was confirmed; the reading is a bonus
      }
      return { ...after, wasOn: false };
    });
  }

  // PoE on, retried with backoff for about a minute (a short window while
  // stopping). After a failure the session may be gone: log out and in
  // again, and check whether the port is on already.
  private async turnOn(s: SwitchSession, c: PoeSwitchConfig, driver: SwitchDriver, index: number): Promise<{ ok: boolean; last: string }> {
    const until = this.now() + (this.d.onRetryMs ?? ON_RETRY_MS);
    let wait = 1000;
    let last = '';
    for (let attempt = 1; ; attempt++) {
      // First with the session we have (it may still be valid); after a
      // failure, a new session (relogin keeps the old cookie until the switch
      // answered its logout), the port read, and PoE on.
      try {
        await s.setPoe(index, true);
        return { ok: true, last };
      } catch (err) {
        last = (err as Error).message;
        logger.warn({ port: c.port, attempt, err: last }, 'poe_switch_port_on_failed');
      }
      if (attempt > 1 && !this.stopBudgetGone()) {
        try {
          await s.relogin(this.d.password()!);
          if (this.stopBudgetGone()) return { ok: false, last };
          if (this.reading(await s.detail(), c, driver).poe) return { ok: true, last };
          if (this.stopBudgetGone()) return { ok: false, last };
          await s.setPoe(index, true);
          return { ok: true, last };
        } catch (err) {
          last = (err as Error).message;
          logger.warn({ port: c.port, attempt, err: last }, 'poe_switch_port_on_after_login_failed');
        }
      }
      const deadline = Math.min(until, this.stopDeadline ?? Number.POSITIVE_INFINITY);
      if (this.now() + wait > deadline || this.stopBudgetGone()) return { ok: false, last };
      await this.pause(wait);
      wait = Math.min(wait * 2, 10_000);
    }
  }

  private reading(d: SwitchDetail, c: PoeSwitchConfig, driver: SwitchDriver): PortReading {
    const index = driver.portIndex(c.port, c.ports, d.sn ?? '');
    if (index < 0 || index >= d.poe.length) throw new PoeSwitchError('switch_error', `port ${c.port} maps to index ${index}, outside the switch's ${d.poe.length} ports`);
    const r: PortReading = { at: this.now(), port: c.port, index, poe: d.poe[index], watts: d.watts[index] ?? 0, link: d.link[index] ?? null, tx: d.tx[index] ?? 0, rx: d.rx[index] ?? 0, sn: d.sn, firmware: d.firmware };
    this.markOff(c.port, !r.poe);
    return { ...r };
  }

  // Why a session is refused after stop(): the proxy stopping, or the switch forgotten (#364).
  private stoppedError(suffix = ''): PoeSwitchError {
    return this.forgotten ? new PoeSwitchError('switch_unknown', `the switch was forgotten${suffix}`) : new PoeSwitchError('switch_error', `the proxy is stopping${suffix}`);
  }

  private markOff(port: number, off: boolean): void {
    if (off) this.offPorts.add(port);
    else this.offPorts.delete(port);
  }

  // One session at a time on this switch, in arrival order (spec
  // §8.4), logged out on every path. A request waits at most offSeconds + 60 s
  // for the one before it; beyond that it fails switch_busy without touching
  // the switch (HTTP 409, Ruling P2-3).
  // port undefined: switch-wide work (no camera port).
  private session<T>(port: number | undefined, f: (s: SwitchSession, c: PoeSwitchConfig, driver: SwitchDriver) => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(this.stoppedError());
    const why = this.notConfigured(port);
    if (why) return Promise.reject(new PoeSwitchError(!this.d.password() && why === this.hint() ? 'password_unset' : 'switch_error', why));
    const lane = this.lane;
    const before = lane.tail;
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    lane.tail = before.then(() => mine);
    const maxWait = this.d.queueWaitMs?.() ?? (this.d.ref().offSeconds + 60) * 1000;
    const run = (async () => {
      let opened = false;
      try {
        // The one before (any controller's on this lane), or stop(): a queued
        // session never opens after a stop, so it need not wait any longer.
        const waited = await within(Promise.race([before.then(() => true, () => true), this.stopping]), maxWait);
        if (waited === TIMED_OUT) {
          throw new PoeSwitchError('switch_busy', `another camera's switch work took longer than ${Math.round(maxWait / 1000)} s`);
        }
        if (this.stopped) throw this.stoppedError();
        this.busy = opened = true;
        return await this.open(port, f);
      } finally {
        if (opened) this.busy = false;
        release();
      }
    })();
    this.pending++;
    const settled = run.then(() => undefined, () => undefined).finally(() => this.pending--);
    this.own = Promise.all([this.own, settled]);
    return run;
  }

  private async open<T>(port: number | undefined, f: (s: SwitchSession, c: PoeSwitchConfig, driver: SwitchDriver) => Promise<T>): Promise<T> {
    const c: PoeSwitchConfig = { ...this.d.ref(), port: port ?? 0 };
    let final = false;
    const driver = (this.d.driver ?? driverFor)(c.model);
    if (!driver) throw new PoeSwitchError('switch_error', `no driver for the switch model ${c.model}`);
    const s = driver.open(c.host!, () => this.callTimeout(final));
    let loggedIn = false;
    try {
      try {
        await s.login(this.d.password()!);
      } catch (err) {
        // A lost logout of ours looks like someone else's session: say so.
        if (err instanceof PoeSwitchError && err.code === 'switch_busy' && this.sessionMaybeOpen) {
          throw new PoeSwitchError('switch_busy', `${err.message} (possibly the proxy's own session: its last logout was not answered; it frees itself about 3 minutes after the last call)`);
        }
        throw err;
      }
      loggedIn = true;
      return await f(s, c, driver);
    } finally {
      if (loggedIn) {
        final = true;
        // The logout is tried twice when time allows (never while the stop
        // budget is spent): a lost answer may be a blip, and the switch's one
        // session blocks every login, also its web UI, until it ends.
        for (let attempt = 1; ; attempt++) {
          try {
            await s.logout();
            this.sessionMaybeOpen = false;
            break;
          } catch (err) {
            if (attempt === 1 && !this.stopBudgetGone()) {
              logger.warn({ err: (err as Error).message }, 'poe_switch_logout_failed_retrying');
              await this.sleep(500);
              if (!this.stopBudgetGone()) continue;
            }
            // The switch keeps one session: its web UI may refuse logins until the switch ends it.
            this.sessionMaybeOpen = true;
            logger.error({ err: (err as Error).message }, 'poe_switch_logout_failed_session_may_be_open');
            break;
          }
        }
      }
    }
  }
}
