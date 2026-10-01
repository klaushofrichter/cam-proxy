import { mkdtempSync, writeFileSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/load';
import { createProxy, type Proxy } from '../../src/proxy';
import { startSim } from './sim';

export const CLIENT_TOKEN = 'client-token-'.padEnd(40, 'x');
export const ADMIN_TOKEN = 'admin-token-'.padEnd(40, 'y');

// A proxy on a fresh data folder (or `dir`), pointed at a cam-sim.
// A free port for go2rtc outside the system's ephemeral range (49152+ on
// macOS, 32768+ on Linux): a port from listen(0) could be handed to another
// test's server before go2rtc binds it, and go2rtc on 127.0.0.1 would then
// shadow that server (macOS allows both binds).
// Free on 127.0.0.1 and on the wildcard: the proxy's FTP server listens on
// 0.0.0.0 (no host setting), and a 127.0.0.1 probe alone succeeds on macOS
// while it holds the port, so go2rtc could take that port over (issue #44).
export async function freePort(): Promise<number> {
  const free = (port: number, host?: string) =>
    new Promise<boolean>((r) => {
      const s = net.createServer();
      s.once('error', () => r(false));
      s.listen(port, host, () => s.close(() => r(true)));
    });
  for (;;) {
    const port = 20000 + Math.floor(Math.random() * 12000);
    if ((await free(port, '127.0.0.1')) && (await free(port))) return port;
  }
}

// Stills run when go2rtc is installed (scripts/install-go2rtc.sh), on free
// ports so proxies in parallel test files don't collide.
// Tests send requests to `base` (the proxy's own 127.0.0.1 listener), not
// `request(proxy.app)`: supertest then opens a throwaway listener on `::`,
// and any process that binds 127.0.0.1 on that port later (a listen(0) and
// close, then a bind) takes the requests over (issue #44).
export async function startProxy(sim: Awaited<ReturnType<typeof startSim>>, opts: { dir?: string; settings?: object; env?: Record<string, string> } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'camproxy-proxy-'));
  const go2rtc = process.env.CAMPROXY_TEST_GO2RTC;
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    stills: { enabled: !!go2rtc },
    go2rtc: { binary: go2rtc ?? 'go2rtc', rtspPort: await freePort(), apiPort: await freePort() },
    camera: { host: sim.camera.host, protocol: 'http', user: 'proxy', onvifPort: sim.ports.onvif, rtspPort: sim.ports.rtsp || 554, statusPollS: 5 },
    events: { onvif: { subscribeMin: 1, pullTimeoutS: 1 }, poll: { enabled: true, intervalS: 1, afterOnvifDownS: 1 } },
    server: { logLevel: 'silent' },
    ...(opts.settings ?? {}),
  }));
  const loaded = loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: sim.password, ...opts.env }, { cwd: dir });
  const proxy: Proxy = createProxy(loaded);
  const { port } = await proxy.start({ port: 0, host: '127.0.0.1' });
  return { proxy, dir, port, base: `http://127.0.0.1:${port}` };
}

export const auth = (t = CLIENT_TOKEN) => ({ Authorization: `Bearer ${t}` });

export async function until(cond: () => boolean | Promise<boolean>, ms = 10000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
