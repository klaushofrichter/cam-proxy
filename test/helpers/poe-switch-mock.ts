import { randomBytes } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';

// A stand-in for the STEAMEMO GPS-208's local web protocol (issue #85; the
// real switch is never contacted from tests). Measured on the real switch
// (~/Development/reolink/poe-switch-gps208.md) and in slydiman/sscpoe:
//   POST /<callcmd> {"data":{"callcmd":N,"calldata":{…}}}
//   123 log in {password}: the session is a cookie; 101 port detail (poec,
//   pw, link by internal index, sn); 103 set PoE {opcode: on<<9|index<<4|2};
//   126 log out.
// One web session at a time: while one is active, a POST without its cookie
// is dropped with no answer (the connection closes).
export interface PoeSwitchMockOptions {
  password: string;
  sn?: string; // GPS2… has the reverse port order (sscpoe reverse_order)
  ports?: number; // PoE ports; the detail arrays have two more (the uplinks)
  powered?: Record<number, number>; // internal index → watts drawn while PoE is on
  port?: number; // listen port (0: any)
  // Called when PoE on an index changes (e2e: cam-sim's power-off and power-on).
  onPoe?: (index: number, on: boolean) => void;
}

export interface PoeSwitchMock {
  url: string;
  host: string; // 127.0.0.1:<port>, for camera.poeSwitch.host
  calls: Array<{ cmd: number; session: boolean; dropped?: boolean; expired?: boolean }>;
  poec: number[];
  pw: number[];
  opcodes: number[];
  // A browser logged in to the web UI: other clients' POSTs are dropped.
  browserLogin(): void;
  browserLogout(): void;
  activeSession(): boolean;
  // The next 103 call(s) answer {config: fail} without applying anything.
  failSet: number;
  // The next PoE-off: applied, then the answer is lost: the connection
  // drops, never comes (hang), or comes without config: ok.
  offFault: 'drop' | 'hang' | 'noconfig' | null;
  // The next logout(s) are dropped with no answer; the session stays open.
  dropLogout: number;
  // A refused login (wrong password) still sets a cookie, as an unknown switch might.
  failCookie: boolean;
  // Every POST hangs with no answer (the real switch, seen from curl, while busy).
  hang: boolean;
  // Delay the answer to a callcmd (ms).
  delay: Record<number, number>;
  // Our session ends on the switch (as after a switch-side timeout): a
  // request with its cookie is answered errcode 1 (recorded as expired).
  expireSession(): void;
  // Every POST hangs for this long, then the switch answers again.
  hangFor(ms: number): void;
  close(): Promise<void>;
}

export async function startPoeSwitchMock(o: PoeSwitchMockOptions): Promise<PoeSwitchMock> {
  const ports = o.ports ?? 8;
  const powered = o.powered ?? { 0: 6.8 };
  const n = ports + 2;
  const poec = Array.from({ length: n }, (_, i) => (i < ports ? 1 : 0));
  const pw = Array.from({ length: n }, (_, i) => powered[i] ?? 0);
  let session: string | null = null;
  const expired = new Set<string>();
  let server: Server;
  const mock: PoeSwitchMock = {
    url: '',
    host: '',
    calls: [],
    poec,
    pw,
    opcodes: [],
    failSet: 0,
    dropLogout: 0,
    failCookie: false,
    offFault: null,
    hang: false,
    delay: {},
    expireSession: () => {
      if (session && session !== 'browser') expired.add(session);
      session = null;
    },
    hangFor: (ms) => {
      mock.hang = true;
      setTimeout(() => (mock.hang = false), ms).unref();
    },
    browserLogin: () => void (session = 'browser'),
    browserLogout: () => void (session = null),
    activeSession: () => session !== null,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  const answer = (res: ServerResponse, cmd: number, calldata: unknown, extra: Record<string, unknown> = {}) => {
    res.writeHead(200, { 'Content-Type': 'application/json', ...((extra.headers as object) ?? {}) });
    res.end(JSON.stringify({ errcode: 0, data: { callcmd: cmd, calldata } }));
  };
  const handle = (req: IncomingMessage, res: ServerResponse, body: string) => {
    // A test hook, not the switch's protocol (e2e): {index, on} sets PoE as
    // if someone used the switch's web UI.
    if (req.url === '/mock/poe') {
      const { index, on } = JSON.parse(body || '{}') as { index: number; on: boolean };
      if (poec[index] !== (on ? 1 : 0)) {
        poec[index] = on ? 1 : 0;
        o.onPoe?.(index, on);
      }
      res.writeHead(204);
      return void res.end();
    }
    const cmd = Number((req.url ?? '/').slice(1));
    const cookie = req.headers.cookie ?? '';
    const ours = session !== null && session !== 'browser' && cookie.split(/;\s*/).some((c) => c.split('=')[0] === session);
    let parsed: { data?: { callcmd?: number; calldata?: Record<string, unknown> } } = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      // answered below as a bad request
    }
    // Another session is active: no answer at all.
    if (session !== null && !ours) {
      mock.calls.push({ cmd, session: false, dropped: true });
      return void req.socket.destroy();
    }
    if (mock.hang) {
      mock.calls.push({ cmd, session: ours, dropped: true });
      return; // no answer, the socket stays open until the client gives up
    }
    mock.calls.push({ cmd, session: ours });
    if (parsed.data?.callcmd !== cmd) {
      res.writeHead(400);
      return void res.end();
    }
    const cd = parsed.data.calldata ?? {};
    if (cmd === 123) {
      if (cd.password !== o.password) return answer(res, cmd, { login: 'fail' }, mock.failCookie ? { headers: { 'Set-Cookie': 'junk=; Path=/' } } : {});
      // sscpoe: the session id is the cookie's name.
      session = randomBytes(6).toString('hex');
      return answer(res, cmd, { login: 'success' }, { headers: { 'Set-Cookie': `${session}=; Path=/` } });
    }
    if (!ours) {
      // Not logged in (or an expired session): an error answer.
      if (cookie.split(/;\s*/).some((c) => expired.has(c.split('=')[0]))) mock.calls[mock.calls.length - 1].expired = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return void res.end(JSON.stringify({ errcode: 1, data: { callcmd: cmd } }));
    }
    if (cmd === 101) {
      return answer(res, cmd, { sn: o.sn ?? 'GPS208MOCK0001', V: 'mock-1.0', poec: [...poec], pw: pw.map((w, i) => (poec[i] ? String(w) : '0')), link: poec.map((p, i) => (p && pw[i] > 0 ? 1 : 0)) });
    }
    if (cmd === 103) {
      const op = Number(cd.opcode);
      mock.opcodes.push(op);
      if (mock.failSet > 0) {
        mock.failSet--;
        return answer(res, cmd, { config: 'fail' });
      }
      const index = (op >> 4) & 0x1f;
      const on = ((op >> 9) & 1) === 1;
      if ((op & 0xf) !== 2 || index >= ports) return answer(res, cmd, { config: 'fail' });
      if (poec[index] !== (on ? 1 : 0)) {
        poec[index] = on ? 1 : 0;
        o.onPoe?.(index, on);
      }
      const fault = on ? null : mock.offFault;
      if (fault) {
        mock.offFault = null;
        if (fault === 'drop') return void req.socket.destroy();
        if (fault === 'hang') return;
        return answer(res, cmd, { config: 'fail' });
      }
      return answer(res, cmd, { config: 'ok' });
    }
    if (cmd === 126) {
      if (mock.dropLogout > 0) {
        mock.dropLogout--;
        return void req.socket.destroy();
      }
      session = null;
      return answer(res, cmd, { logout: 'success' });
    }
    return answer(res, cmd, {});
  };
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const ms = mock.delay[Number((req.url ?? '/').slice(1))];
      if (ms) setTimeout(() => handle(req, res, body), ms);
      else handle(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  mock.host = `127.0.0.1:${port}`;
  mock.url = `http://${mock.host}`;
  return mock;
}
