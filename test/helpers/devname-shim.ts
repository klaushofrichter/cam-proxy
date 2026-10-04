// GetDevName and SetDevName in front of a cam-sim that has neither yet
// (camera-name design, step 1 is cam-sim's). Every other request goes on to
// the sim unchanged. The name is the sim's one name (GetDevInfo.name and the
// OSD name follow), with the measured rules: longer than 31 characters ->
// rspCode -56, anything else not allowed -> -54, and a refused write leaves
// the old name. Remove once the cam-sim release in package.json has them.
// For the e2e run (another process), POST /__shim/rename {name} renames the
// camera as the Reolink app would, and POST /__shim/refuse-next {rspCode}
// makes the next SetDevName fail.
import http from 'http';
import type { AddressInfo } from 'net';
import type { CamSim } from 'cam-sim';

const RULE = /^[A-Za-z0-9()+=[\]{}-](?:[A-Za-z0-9 ()+=[\]{}-]{0,29}[A-Za-z0-9()+=[\]{}-])?$/;

export interface DevNameShim {
  host: string; // 127.0.0.1:<port>, for camera.host
  port: number;
  setCalls: { name: unknown }[];
  getCalls: number;
  refuseNext: number | undefined; // the next SetDevName answers this rspCode
  close(): Promise<void>;
}

// Renames the sim's camera as the Reolink app or its web UI would.
export function renameSim(sim: CamSim, name: string): void {
  (sim.engine.config as { name: string }).name = name;
  const osd = (sim.engine.settings.running as { Osd?: { osdChannel?: { name?: string } } }).Osd;
  if (osd?.osdChannel) osd.osdChannel.name = name;
}

export async function startDevNameShim(sim: CamSim, simHttpPort: number, port = 0): Promise<DevNameShim> {
  const reply = (res: http.ServerResponse, body: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([body]));
  const shim: DevNameShim = { host: '', port: 0, setCalls: [], getCalls: 0, refuseNext: undefined, close: () => new Promise((r) => server.close(() => r())) };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const cmd = url.searchParams.get('cmd');
    if (req.method === 'POST' && url.pathname.startsWith('/__shim/')) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body: { name?: unknown; rspCode?: unknown } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          /* empty */
        }
        if (url.pathname === '/__shim/rename' && typeof body.name === 'string') renameSim(sim, body.name);
        else if (url.pathname === '/__shim/refuse-next' && typeof body.rspCode === 'number') shim.refuseNext = body.rspCode;
        else return void res.writeHead(404).end();
        res.writeHead(204).end();
      });
      return;
    }
    if (req.method === 'POST' && (cmd === 'GetDevName' || cmd === 'SetDevName')) {
      if (sim.engine.offline()) return void req.socket.destroy();
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (cmd === 'GetDevName') {
          shim.getCalls++;
          return reply(res, { cmd, code: 0, value: { DevName: { name: sim.engine.config.name } } });
        }
        let name: unknown;
        try {
          name = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { param?: { DevName?: { name?: unknown } } }[])[0]?.param?.DevName?.name;
        } catch {
          name = undefined;
        }
        shim.setCalls.push({ name });
        const forced = shim.refuseNext;
        shim.refuseNext = undefined;
        const rsp = forced ?? (typeof name !== 'string' ? -54 : name.length > 31 ? -56 : RULE.test(name) ? 0 : -54);
        if (rsp !== 0) return reply(res, { cmd, code: 1, error: { detail: rsp === -56 ? 'err get data from json' : 'the respode of msg is err', rspCode: rsp } });
        renameSim(sim, name as string);
        reply(res, { cmd, code: 0, value: { rspCode: 200 } });
      });
      return;
    }
    const up = http.request({ host: '127.0.0.1', port: simHttpPort, method: req.method, path: req.url, headers: req.headers }, (u) => {
      res.writeHead(u.statusCode ?? 502, u.headers);
      u.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  shim.port = (server.address() as AddressInfo).port;
  shim.host = `127.0.0.1:${shim.port}`;
  return shim;
}
