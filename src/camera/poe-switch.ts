import http from 'http';
import { logger } from '../log';

// The camera's PoE switch (issue #85): power-cycle the camera by cutting its
// port's PoE. One protocol so far, `sscpoe-web`: the STEAMEMO/SSCPOE local
// web API of the GPS-208 and kin, as its own web UI and slydiman/sscpoe
// (custom_components/sscpoe/protocol.py, coordinator.py) use it, measured on
// the real switch (~/Development/reolink/poe-switch-gps208.md):
//   POST http://<switch>/<callcmd>  {"data":{"callcmd":N,"calldata":{…}}}
//   123 log in {password} → data.calldata.login "success" and the session
//       cookie; 101 port detail (poec, pw, link by internal index; sn, V);
//   103 set one port's PoE {opcode: on<<9 | index<<4 | 2}; 126 log out.
// The switch has one web session at a time: while someone is logged in to
// its web UI, every other client's POST is dropped with no answer. So the
// proxy never polls it, and always logs out (126), also after an error.
// The password is sent in the login body only: never logged, returned, put
// in an error message or an audit record.

export type PoeSwitchModel = 'none' | 'sscpoe-web';
export interface PoeSwitchConfig { model: PoeSwitchModel; host?: string; port?: number; ports: number; offSeconds: number }
export type PoeSwitchErrorCode = 'switch_busy' | 'switch_auth' | 'switch_unreachable' | 'switch_error' | 'no_power';

// poeOff: the PoE-off request was sent, so the port may have been cut;
// turnedOn then says whether the proxy got it on again (null: not applicable).
export class PoeSwitchError extends Error {
  constructor(readonly code: PoeSwitchErrorCode, message: string, readonly poeOff = false, readonly turnedOn: boolean | null = null) {
    super(message);
  }
}

// What the switch said about the camera's port, from callcmd 101.
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
  last: PortReading | null; // the last reading (a read or a cycle); never polled
}
export type PoeOnResult = PortReading & { wasOn: boolean };

// sscpoe coordinator.py reverse_order: these count their ports backwards
// (GPS204, GPS208, GFS226V1, GPS424V3, GPS1xx, GS105); PS208G, PS308G and
// GPS316 don't. The switch's own UI hard-codes [7..0] on the GPS-208.
export function reverseOrder(sn: string): boolean {
  return ['GS1', 'GPS1', 'GPS2', 'GFS2', 'GPS4'].some((p) => sn.startsWith(p));
}

// The internal index of UI port `port` (1-based) on a switch with `ports` PoE
// ports (sscpoe switch.py): ports - port when reversed, else port - 1.
export function portIndex(port: number, ports: number, sn: string): number {
  return reverseOrder(sn) ? ports - port : port - 1;
}

// callcmd 103's opcode: PoE on or off for one port (sscpoe _switch_poe).
export function poeOpcode(index: number, on: boolean): number {
  return ((on ? 1 : 0) << 9) | (index << 4) | 2;
}

const CMD = { login: 123, detail: 101, setPoe: 103, logout: 126 } as const;
const UNREACHABLE = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']);
const ON_RETRY_MS = 60_000; // how long a failed PoE-on is retried (backoff 1, 2, 4, 8, 10, 10… s)
const STOP_RECOVERY_MS = 6_000; // on shutdown: the PoE-on retries end after this
const STOP_WAIT_MS = 8_000; // on shutdown: the longest wait for the switch (compose's stop grace is 20 s)
const TIMEOUT = 'CAMPROXY_SWITCH_TIMEOUT';

// One web session: the cookie from the login answer goes with every call.
class Session {
  private cookie = '';
  constructor(private readonly host: string, private readonly timeoutMs: number) {}

  call(cmd: number, calldata?: Record<string, unknown>): Promise<{ errcode?: number; data?: { calldata?: Record<string, unknown> } & Record<string, unknown> }> {
    const body = JSON.stringify({ data: { callcmd: cmd, ...(calldata ? { calldata } : {}) } });
    return new Promise((resolve, reject) => {
      const req = http.request(`http://${this.host}/${cmd}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'X-Requested-With': 'XMLHttpRequest',
          Origin: `http://${this.host}`,
          Referer: `http://${this.host}/`,
          ...(this.cookie ? { Cookie: this.cookie } : {}),
        },
        timeout: this.timeoutMs,
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (text += d));
        res.on('error', () => reject(new PoeSwitchError('switch_error', `the switch broke off its answer to callcmd ${cmd}`)));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new PoeSwitchError('switch_error', `the switch answered HTTP ${res.statusCode} to callcmd ${cmd}`));
          if (cmd === CMD.login) {
            const set = res.headers['set-cookie'] ?? [];
            const jar = set.map((c) => c.split(';')[0].trim()).filter(Boolean);
            if (jar.length) this.cookie = jar.join('; ');
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new PoeSwitchError('switch_error', `the switch's answer to callcmd ${cmd} is not JSON`));
          }
        });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: TIMEOUT })));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err instanceof PoeSwitchError) return reject(err);
        const code = err.code ?? '';
        // No answer in time. For the login that is what a busy switch can look
        // like (measured: an unauthenticated POST timed out while a browser
        // was logged in), or a switch that's away.
        if (code === TIMEOUT) {
          if (cmd === CMD.login) return reject(new PoeSwitchError('switch_busy', "the switch did not answer the login: busy or unreachable: is someone logged in to the switch's web UI?"));
          return reject(new PoeSwitchError('switch_error', `the switch did not answer callcmd ${cmd} within ${this.timeoutMs / 1000} s`));
        }
        if (UNREACHABLE.has(code)) return reject(new PoeSwitchError('switch_unreachable', `the switch at ${this.host} does not answer (${code})`));
        // Closed with no answer: what the switch does while another session is active.
        if (cmd === CMD.login) return reject(new PoeSwitchError('switch_busy', "the switch dropped the login: someone is logged in to the switch's web UI"));
        reject(new PoeSwitchError('switch_error', `the switch closed the connection on callcmd ${cmd} (${code || 'no answer'})`));
      });
      req.end(body);
    });
  }

  async login(password: string): Promise<void> {
    const r = await this.call(CMD.login, { password });
    if (r.data?.calldata?.login === 'success' && this.cookie) return;
    // sscpoe: errcode 10002 is multiple_login.
    if (r.errcode === 10002) throw new PoeSwitchError('switch_busy', "the switch refused the login: someone is logged in to the switch's web UI");
    if (r.data?.calldata?.login === 'success') throw new PoeSwitchError('switch_error', 'the switch accepted the login but set no session cookie');
    throw new PoeSwitchError('switch_auth', 'the switch refused the password (CAMPROXY_POE_SWITCH_PASSWORD)');
  }

  // A new session after a lost one: log out (if it still exists), log in.
  async relogin(password: string): Promise<void> {
    try {
      await this.logout();
    } catch {
      // the old session may be gone already
    }
    this.cookie = '';
    await this.login(password);
  }

  async detail(): Promise<Record<string, unknown>> {
    const r = await this.call(CMD.detail);
    const d = (r.data?.calldata ?? r.data) as Record<string, unknown> | undefined;
    if (!d || !Array.isArray(d.poec)) throw new PoeSwitchError('switch_error', 'the port detail (callcmd 101) has no poec list');
    return d;
  }

  async setPoe(index: number, on: boolean): Promise<void> {
    const r = await this.call(CMD.setPoe, { opcode: poeOpcode(index, on) });
    if (r.data?.calldata?.config !== 'ok') throw new PoeSwitchError('switch_error', `the switch did not confirm PoE ${on ? 'on' : 'off'} (callcmd 103)`);
  }

  async logout(): Promise<void> {
    await this.call(CMD.logout);
  }
}

export interface PoeSwitchDeps {
  config: () => PoeSwitchConfig;
  password: () => string | undefined;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number; // per call (5 s)
  onRetryMs?: number; // how long a failed PoE-on is retried (60 s)
  stopRecoveryMs?: number; // on shutdown (6 s)
  stopWaitMs?: number; // on shutdown (8 s)
}

export class PoeSwitch {
  private busy = false;
  private stopped = false;
  private inflight: Promise<unknown> | null = null;
  private wake: (() => void) | null = null; // ends a wait early (stop)
  private stopDeadline: number | null = null; // on shutdown: no PoE-on retry after this
  private cutting = false; // between the PoE-off request and PoE on again
  private poeMaybeOff = false;
  private last: PortReading | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: PoeSwitchDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // Why the switch can't be used, naming the setting; null when it can.
  notConfigured(): string | null {
    const c = this.d.config();
    if (c.model === 'none') return 'camera.poeSwitch.model is none';
    if (!c.host) return 'camera.poeSwitch.host is not set';
    if (!c.port) return 'camera.poeSwitch.port is not set';
    if (c.port > c.ports) return 'camera.poeSwitch.port is above camera.poeSwitch.ports';
    if (!this.d.password()) return 'CAMPROXY_POE_SWITCH_PASSWORD is not set';
    return null;
  }

  status(): PoeSwitchStatus {
    const c = this.d.config();
    return {
      model: c.model, host: c.host ?? null, port: c.port ?? null, ports: c.ports, offSeconds: c.offSeconds,
      passwordSet: !!this.d.password(), configured: this.notConfigured() === null, busy: this.busy,
      poeMaybeOff: this.poeMaybeOff, last: this.last ? { ...this.last } : null,
    };
  }

  // On shutdown: a power-cycle in its off time turns PoE on at once (never
  // leave the camera dark because the process ended), with a short retry
  // window, then logs out. The wait is bounded (compose's stop grace is
  // 20 s); refuses new sessions afterwards. poeLeftOff: the camera's PoE may
  // be off now (the caller logs and audits it).
  async stop(): Promise<{ poeLeftOff: boolean }> {
    this.stopped = true;
    this.stopDeadline = this.now() + (this.d.stopRecoveryMs ?? STOP_RECOVERY_MS);
    this.wake?.();
    let finished = true;
    const inflight = this.inflight;
    if (inflight) {
      let timer: NodeJS.Timeout | undefined;
      finished = await Promise.race([
        inflight.then(() => true, () => true),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(false), this.d.stopWaitMs ?? STOP_WAIT_MS))),
      ]);
      clearTimeout(timer);
    }
    const poeLeftOff = this.poeMaybeOff || (!finished && this.cutting);
    if (poeLeftOff) logger.error({ port: this.d.config().port }, 'poe_switch_poe_may_be_left_off_at_stop');
    return { poeLeftOff };
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

  // The camera's port now: log in, 101, log out.
  read(): Promise<PortReading> {
    return this.session(async (s, c) => this.reading(await s.detail(), c));
  }

  // Cut the camera's PoE for offSeconds, then turn it on again. Refuses
  // (no_power) unless the port has PoE on and draws power: it never cuts a
  // port that isn't powering something. `onOff` runs once PoE is off.
  // Once the PoE-off request is sent, every failure (a lost or refused
  // answer, a timeout, onOff throwing) still turns PoE on again, and the
  // error says so (poeOff: true, turnedOn).
  cycle(onOff: (at: number) => void): Promise<CycleResult> {
    return this.session(async (s, c) => {
      const r = this.reading(await s.detail(), c);
      if (!r.poe || !(r.watts > 0)) throw new PoeSwitchError('no_power', `port ${r.port} (index ${r.index}) has PoE ${r.poe ? 'on' : 'off'} and draws ${r.watts} W: not switching`);
      if (this.stopped) throw new PoeSwitchError('switch_error', 'the proxy is stopping: not switching');
      let failure: Error | null = null;
      let offAt: number | null = null;
      this.cutting = true;
      try {
        await s.setPoe(r.index, false);
        offAt = this.now();
        logger.info({ port: r.port, index: r.index, watts: r.watts }, 'poe_switch_port_off');
        onOff(offAt);
        await this.pause(c.offSeconds * 1000, true);
      } catch (err) {
        failure = err as Error;
        logger.error({ port: r.port, err: failure.message }, 'poe_switch_cut_failed_turning_on');
      }
      const on = await this.turnOn(s, c, r.index);
      this.cutting = false;
      this.poeMaybeOff = !on.ok;
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
  poeOn(): Promise<PoeOnResult> {
    return this.session(async (s, c) => {
      const r = this.reading(await s.detail(), c);
      if (r.poe) return { ...r, wasOn: true };
      const on = await this.turnOn(s, c, r.index);
      this.poeMaybeOff = !on.ok;
      if (!on.ok) throw new PoeSwitchError('switch_error', `PoE is still OFF on port ${r.port}: the switch did not turn it on (${on.last}). Try the switch's web UI (port ${r.port})`, true, false);
      logger.info({ port: r.port, index: r.index }, 'poe_switch_port_on_recovery');
      let after: PortReading = { ...r, poe: true };
      try {
        after = this.reading(await s.detail(), c);
      } catch {
        // PoE on was confirmed; the reading is a bonus
      }
      return { ...after, wasOn: false };
    });
  }

  // PoE on, retried with backoff for about a minute (a short window while
  // stopping). After a failure the session may be gone: log out and in
  // again, and check whether the port is on already.
  private async turnOn(s: Session, c: PoeSwitchConfig, index: number): Promise<{ ok: boolean; last: string }> {
    const until = this.now() + (this.d.onRetryMs ?? ON_RETRY_MS);
    let wait = 1000;
    let last = '';
    for (let attempt = 1; ; attempt++) {
      try {
        if (attempt > 1) {
          await s.relogin(this.d.password()!);
          if (this.reading(await s.detail(), c).poe) return { ok: true, last };
        }
        await s.setPoe(index, true);
        return { ok: true, last };
      } catch (err) {
        last = (err as Error).message;
        logger.warn({ port: c.port, attempt, err: last }, 'poe_switch_port_on_failed');
      }
      const deadline = Math.min(until, this.stopDeadline ?? Number.POSITIVE_INFINITY);
      if (this.now() + wait > deadline) return { ok: false, last };
      await this.pause(wait);
      wait = Math.min(wait * 2, 10_000);
    }
  }

  private reading(d: Record<string, unknown>, c: PoeSwitchConfig): PortReading {
    const sn = typeof d.sn === 'string' ? d.sn : '';
    const index = portIndex(c.port!, c.ports, sn);
    const poec = d.poec as unknown[];
    if (index < 0 || index >= poec.length) throw new PoeSwitchError('switch_error', `port ${c.port} maps to index ${index}, outside the switch's ${poec.length} ports`);
    const at = (k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[])[index] : undefined);
    const watts = Number(at('pw'));
    const link = at('link') ?? at('lnk');
    this.last = {
      at: this.now(), port: c.port!, index, poe: Number(poec[index]) === 1, watts: Number.isFinite(watts) ? watts : 0,
      link: link === undefined ? null : Number(link) > 0, sn: sn || null, firmware: typeof d.V === 'string' ? d.V : null,
    };
    this.poeMaybeOff = !this.last.poe;
    return { ...this.last };
  }

  // One switch session, logged out on every path. One at a time in this
  // process: a second caller gets switch_busy without touching the switch.
  private session<T>(f: (s: Session, c: PoeSwitchConfig) => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new PoeSwitchError('switch_error', 'the proxy is stopping'));
    if (this.busy) return Promise.reject(new PoeSwitchError('switch_busy', 'the proxy is using the switch already (a power-cycle or a read)'));
    const why = this.notConfigured();
    if (why) return Promise.reject(new PoeSwitchError('switch_error', why));
    this.busy = true;
    const run = this.open(f).finally(() => {
      this.busy = false;
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async open<T>(f: (s: Session, c: PoeSwitchConfig) => Promise<T>): Promise<T> {
    const c = { ...this.d.config() };
    const s = new Session(c.host!, this.d.timeoutMs ?? 5000);
    let loggedIn = false;
    try {
      await s.login(this.d.password()!);
      loggedIn = true;
      return await f(s, c);
    } finally {
      if (loggedIn) {
        try {
          await s.logout();
        } catch (err) {
          logger.warn({ err: (err as Error).message }, 'poe_switch_logout_failed');
        }
      }
    }
  }
}
