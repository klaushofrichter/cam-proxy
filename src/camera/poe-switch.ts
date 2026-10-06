import { sleep, TIMED_OUT, within } from '../async';
import { logger } from '../log';
import { driverFor, type SwitchDetail, type SwitchDriver, type SwitchSession } from './switch/driver';
import { PoeSwitchError, SwitchRefusal } from './switch/errors';

export { PoeSwitchError, type PoeSwitchErrorCode } from './switch/errors';
export { poeOpcode, portIndex, reverseOrder, Session } from './switch/sscpoe-web';

const ON_RETRY_MS = 60_000; // how long a failed PoE-on is retried (backoff 1, 2, 4, 8, 10, 10… s)
const STOP_RECOVERY_MS = 6_000; // on shutdown: the PoE-on retries end after this
const STOP_WAIT_MS = 8_000; // on shutdown: the longest wait for the switch (compose's stop grace is 20 s)

// The camera's PoE switch (issue #85): power-cycle the camera by cutting its
// port's PoE. A driver per switch model (src/camera/switch/driver.ts); one so
// far, `sscpoe-web` (the GPS-208 and kin, src/camera/switch/sscpoe-web.ts).
// The GPS-208 has one web session at a time: while someone is logged in to
// its web UI, every other client's POST is dropped with no answer. So the
// proxy never polls it, and always logs out, also after an error.
// The password is sent in the login body only: never logged, returned, put
// in an error message or an audit record.

type PoeSwitchModel = 'none' | 'sscpoe-web';
// The host's switch (spec 2026-10-05-multi-camera-host-design §8.4): one per
// host; each camera names its port.
export interface HostSwitchConfig { model: PoeSwitchModel; host?: string; ports: number; offSeconds: number }
type PoeSwitchConfig = HostSwitchConfig & { port: number };

// What the switch said about a camera's port, from its port detail.
export interface PortReading {
  at: number;
  port: number; // the UI port number
  index: number; // the switch's internal index
  poe: boolean;
  watts: number;
  link: boolean | null;
  sn: string | null;
  firmware: string | null;
}
export interface CycleResult { offAt: number; onAt: number; watts: number }
export interface PoeSwitchStatus {
  model: PoeSwitchModel;
  host: string | null;
  port: number | null;
  ports: number;
  offSeconds: number;
  passwordSet: boolean;
  configured: boolean;
  busy: boolean; // a switch session is open now
  // The camera's PoE may be OFF: the last reading said so, or turning it on
  // again failed. "Turn camera PoE on" (or a read showing it on) clears it.
  poeMaybeOff: boolean;
  last: PortReading | null; // the port's last reading (a read or a cycle); never polled
}
export type PoeOnResult = PortReading & { wasOn: boolean };

// One camera's view of the host's switch: its port, read on every use.
export interface PortHandle {
  notConfigured(): string | null;
  status(): PoeSwitchStatus;
  read(): Promise<PortReading>;
  cycle(onOff: (at: number) => void): Promise<CycleResult>;
  poeOn(): Promise<PoeOnResult>;
}

interface PoeSwitchDeps {
  config: () => HostSwitchConfig;
  password: () => string | undefined;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number; // per call (5 s)
  onRetryMs?: number; // how long a failed PoE-on is retried (60 s)
  stopRecoveryMs?: number; // on shutdown (6 s)
  stopWaitMs?: number; // on shutdown (8 s)
  driver?: (model: string) => SwitchDriver | undefined; // default: driverFor (tests: a fake)
  readCacheMs?: number; // how long one read serves every port (10 s, Ruling P2-7)
  queueWaitMs?: () => number; // how long a request waits for the one before it (offSeconds + 60 s)
}

// The host's PoE controller (spec 2026-10-05-multi-camera-host-design §8.4):
// one switch session at a time for every camera, in arrival order; state per port.
export class PoeSwitch {
  private busy = false;
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private pending = 0; // sessions queued or running
  private wake: (() => void) | null = null; // ends a wait early (stop)
  private stopDeadline: number | null = null; // on shutdown: no PoE-on retry after this
  private stopEnd: number | null = null; // on shutdown (wall clock): stop() waits until here at most
  private sessionMaybeOpen = false; // the last logout was not answered
  private readonly cutting = new Set<number>(); // ports between the PoE-off request and PoE on again
  private readonly offPorts = new Set<number>(); // ports whose PoE may be off
  private readonly last = new Map<number, PortReading>();
  private cache: { at: number; detail: SwitchDetail } | null = null; // the last read's detail
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: PoeSwitchDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? sleep;
  }

  // Why the switch can't be used, naming the setting; null when it can.
  // With a port (null: the camera has none): also the camera's port.
  notConfigured(port?: number | null): string | null {
    const c = this.d.config();
    if (c.model === 'none') return 'poeSwitch.model is none';
    if (!c.host) return 'poeSwitch.host is not set';
    if (port !== undefined && !port) return "the camera's poeSwitch.port is not set";
    if (port && port > c.ports) return "the camera's poeSwitch.port is above poeSwitch.ports";
    if (!this.d.password()) return 'CAMPROXY_POE_SWITCH_PASSWORD is not set';
    return null;
  }

  // The host's switch, and with a port (null: a camera without one) that port's last reading.
  status(port?: number | null): PoeSwitchStatus {
    const c = this.d.config();
    const last = port ? this.last.get(port) : undefined;
    return {
      model: c.model, host: c.host ?? null, port: port ?? null, ports: c.ports, offSeconds: c.offSeconds,
      passwordSet: !!this.d.password(), configured: this.notConfigured(port) === null, busy: this.busy,
      poeMaybeOff: port === undefined ? this.offPorts.size > 0 : !!port && this.offPorts.has(port), last: last ? { ...last } : null,
    };
  }

  // One camera's view of the switch (its port read on every use).
  forPort(port: () => number | undefined): PortHandle {
    const p = () => port() ?? 0;
    return {
      notConfigured: () => this.notConfigured(port() ?? null),
      status: () => this.status(port() ?? null),
      read: () => this.read(p()),
      cycle: (onOff) => this.cycle(p(), onOff),
      poeOn: () => this.poeOn(p()),
    };
  }

  // On shutdown: a power-cycle in its off time turns PoE on at once (never
  // leave the camera dark because the process ended), with a short retry
  // window, then logs out. The wait is bounded (compose's stop grace is
  // 20 s); refuses new sessions afterwards. poeLeftOff: the camera's PoE may
  // be off now (the caller logs and audits it).
  async stop(): Promise<{ portsLeftOff: number[]; sessionMaybeOpen: boolean }> {
    this.stopped = true;
    this.stopDeadline = this.now() + (this.d.stopRecoveryMs ?? STOP_RECOVERY_MS);
    this.stopEnd = Date.now() + (this.d.stopWaitMs ?? STOP_WAIT_MS);
    this.wake?.();
    let finished = true;
    // Every session queued so far (a waiting one ends at once: stopped).
    if (this.pending > 0) {
      finished = (await within(this.tail.then(() => true, () => true), this.d.stopWaitMs ?? STOP_WAIT_MS)) !== TIMED_OUT;
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
    const c = this.d.config();
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

  // Cut the camera's PoE for offSeconds, then turn it on again. Refuses
  // (no_power) unless the port has PoE on and draws power: it never cuts a
  // port that isn't powering something. `onOff` runs once PoE is off.
  // Once the PoE-off request is sent, every failure (a lost or refused
  // answer, a timeout, onOff throwing) still turns PoE on again, and the
  // error says so (poeOff: true, turnedOn).
  cycle(port: number, onOff: (at: number) => void): Promise<CycleResult> {
    return this.session(port, async (s, c, driver) => {
      this.cache = null; // the read cache: never across a change
      const r = this.reading(await s.detail(), c, driver);
      if (!r.poe || !(r.watts > 0)) throw new PoeSwitchError('no_power', `port ${r.port} (index ${r.index}) has PoE ${r.poe ? 'on' : 'off'} and draws ${r.watts} W: not switching`);
      if (this.stopped) throw new PoeSwitchError('switch_error', 'the proxy is stopping: not switching');
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
      return { offAt: offAt!, onAt, watts: r.watts };
    });
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
    const r: PortReading = { at: this.now(), port: c.port, index, poe: d.poe[index], watts: d.watts[index] ?? 0, link: d.link[index] ?? null, sn: d.sn, firmware: d.firmware };
    this.last.set(c.port, r);
    this.markOff(c.port, !r.poe);
    return { ...r };
  }

  private markOff(port: number, off: boolean): void {
    if (off) this.offPorts.add(port);
    else this.offPorts.delete(port);
  }

  // One switch session at a time for the whole host, in arrival order (spec
  // §8.4), logged out on every path. A request waits at most offSeconds + 60 s
  // for the one before it; beyond that it fails switch_busy without touching
  // the switch (HTTP 409, Ruling P2-3).
  private session<T>(port: number, f: (s: SwitchSession, c: PoeSwitchConfig, driver: SwitchDriver) => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new PoeSwitchError('switch_error', 'the proxy is stopping'));
    const why = this.notConfigured(port);
    if (why) return Promise.reject(new PoeSwitchError('switch_error', why));
    const before = this.tail;
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.tail = before.then(() => mine);
    const maxWait = this.d.queueWaitMs?.() ?? (this.d.config().offSeconds + 60) * 1000;
    const run = (async () => {
      let opened = false;
      try {
        if ((await within(before.then(() => true, () => true), maxWait)) === TIMED_OUT) {
          throw new PoeSwitchError('switch_busy', `another camera's switch work took longer than ${Math.round(maxWait / 1000)} s`);
        }
        if (this.stopped) throw new PoeSwitchError('switch_error', 'the proxy is stopping');
        this.busy = opened = true;
        return await this.open(port, f);
      } finally {
        if (opened) this.busy = false;
        release();
      }
    })();
    this.pending++;
    void run.then(() => undefined, () => undefined).finally(() => this.pending--);
    return run;
  }

  private async open<T>(port: number, f: (s: SwitchSession, c: PoeSwitchConfig, driver: SwitchDriver) => Promise<T>): Promise<T> {
    const c: PoeSwitchConfig = { ...this.d.config(), port };
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
