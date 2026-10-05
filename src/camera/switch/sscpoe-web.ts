import http from 'http';
import type { SwitchDriver } from './driver';
import { PoeSwitchError, SwitchRefusal } from './errors';

// The STEAMEMO/SSCPOE local web API of the GPS-208 and kin, as its own web UI
// and slydiman/sscpoe (custom_components/sscpoe/protocol.py, coordinator.py)
// use it, measured on the real switch (~/Development/reolink/poe-switch-gps208.md):
//   POST http://<switch>/<callcmd>  {"data":{"callcmd":N,"calldata":{…}}}
//   123 log in {password} → data.calldata.login "success" and the session
//       cookie; 101 port detail (poec, pw, link by internal index; sn, V);
//   103 set one port's PoE {opcode: on<<9 | index<<4 | 2}; 126 log out.
// The switch has one web session at a time: while someone is logged in to
// its web UI, every other client's POST is dropped with no answer.

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
const TIMEOUT = 'CAMPROXY_SWITCH_TIMEOUT';

// One web session: the cookie from the login answer goes with every call.
export class Session {
  private cookie = '';
  // The per-call timeout is asked on every call: a stopping proxy shortens it.
  constructor(private readonly host: string, private readonly timeout: () => number) {}

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
        timeout: this.timeout(),
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (text += d));
        res.on('error', () => reject(new PoeSwitchError('switch_error', `the switch broke off its answer to callcmd ${cmd}`)));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new PoeSwitchError('switch_error', `the switch answered HTTP ${res.statusCode} to callcmd ${cmd}`));
          let answer: Awaited<ReturnType<Session['call']>>;
          try {
            answer = JSON.parse(text);
          } catch {
            return reject(new PoeSwitchError('switch_error', `the switch's answer to callcmd ${cmd} is not JSON`));
          }
          // Only a login the switch accepted replaces the cookie: a refused one
          // must not drop the cookie of a session that may still be open.
          if (cmd === CMD.login && answer?.data?.calldata?.login === 'success') {
            const set = res.headers['set-cookie'] ?? [];
            const jar = set.map((c) => c.split(';')[0].trim()).filter(Boolean);
            if (jar.length) this.cookie = jar.join('; ');
          }
          resolve(answer);
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
          return reject(new PoeSwitchError('switch_error', `the switch did not answer callcmd ${cmd} in time`));
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

  // A new session after a lost one. The cookie goes only after the switch
  // answered the logout: the switch has one session, and an old one left
  // open (logout not answered) blocks every login without its cookie, also
  // the switch's own web UI. Then the login carries the old cookie, and a
  // login that answers with a new cookie replaces it.
  async relogin(password: string): Promise<void> {
    try {
      await this.logout();
      this.cookie = '';
    } catch {
      // not answered: keep the cookie, the session may still be open
    }
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
    if (r.data?.calldata?.config !== 'ok') throw new SwitchRefusal('switch_error', `the switch did not confirm PoE ${on ? 'on' : 'off'} (callcmd 103)`);
  }

  async logout(): Promise<void> {
    await this.call(CMD.logout);
  }
}


// The STEAMEMO/SSCPOE local web protocol (GPS-208 and kin). One web session at a time.
export const sscpoeWeb: SwitchDriver = {
  model: 'sscpoe-web',
  singleSession: true,
  portIndex,
  open(host, timeoutMs) {
    const s = new Session(host, timeoutMs);
    return {
      login: (pw) => s.login(pw),
      relogin: (pw) => s.relogin(pw),
      logout: () => s.logout(),
      setPoe: (i, on) => s.setPoe(i, on),
      async detail() {
        const d = await s.detail();
        const arr = (k: string) => (Array.isArray(d[k]) ? (d[k] as unknown[]) : []);
        const poec = arr('poec');
        const links = arr('link').length ? arr('link') : arr('lnk');
        return {
          poe: poec.map((x) => Number(x) === 1),
          watts: poec.map((_, i) => {
            const w = Number(arr('pw')[i]);
            return Number.isFinite(w) ? w : 0;
          }),
          link: poec.map((_, i) => (links[i] === undefined ? null : Number(links[i]) > 0)),
          sn: typeof d.sn === 'string' && d.sn ? d.sn : null,
          firmware: typeof d.V === 'string' ? d.V : null,
        };
      },
    };
  },
};
