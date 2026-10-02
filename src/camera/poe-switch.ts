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

export class PoeSwitchError extends Error {
  constructor(readonly code: PoeSwitchErrorCode, message: string, readonly poeOff = false) {
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
  last: PortReading | null; // the last reading (a read or a cycle); never polled
}

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
const ON_TRIES = 3;

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
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err instanceof PoeSwitchError) return reject(err);
        const code = err.code ?? '';
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
}

export class PoeSwitch {
  private busy = false;
  private stopped = false;
  private inflight: Promise<unknown> | null = null;
  private wake: (() => void) | null = null; // ends the off time early (stop)
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
      last: this.last ? { ...this.last } : null,
    };
  }

  // On shutdown: a power-cycle in its off time turns PoE on at once (never
  // leave the camera dark because the process ended), then logs out. Waits
  // for that; refuses new sessions afterwards.
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.inflight?.catch(() => {});
  }

  // The camera's port now: log in, 101, log out.
  read(): Promise<PortReading> {
    return this.session(async (s, c) => this.reading(await s.detail(), c));
  }

  // Cut the camera's PoE for offSeconds, then turn it on again. Refuses
  // (no_power) unless the port has PoE on and draws power: it never cuts a
  // port that isn't powering something. `onOff` runs once PoE is off.
  cycle(onOff: (at: number) => void): Promise<CycleResult> {
    return this.session(async (s, c) => {
      const r = this.reading(await s.detail(), c);
      if (!r.poe || !(r.watts > 0)) throw new PoeSwitchError('no_power', `port ${r.port} (index ${r.index}) has PoE ${r.poe ? 'on' : 'off'} and draws ${r.watts} W: not switching`);
      await s.setPoe(r.index, false);
      const offAt = this.now();
      logger.info({ port: r.port, index: r.index, watts: r.watts }, 'poe_switch_port_off');
      onOff(offAt);
      if (!this.stopped) await new Promise<void>((resolve) => {
        this.wake = resolve;
        void this.sleep(c.offSeconds * 1000).then(resolve);
      });
      this.wake = null;
      for (let i = 1; ; i++) {
        try {
          await s.setPoe(r.index, true);
          break;
        } catch (err) {
          logger.warn({ port: r.port, attempt: i, err: (err as Error).message }, 'poe_switch_port_on_failed');
          if (i >= ON_TRIES) throw new PoeSwitchError('switch_error', `PoE may still be off on port ${r.port}: the switch did not turn it on again (${(err as Error).message})`, true);
          await this.sleep(1000);
        }
      }
      const onAt = this.now();
      logger.info({ port: r.port, index: r.index, offMs: onAt - offAt }, 'poe_switch_port_on');
      return { offAt, onAt, watts: r.watts };
    });
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
