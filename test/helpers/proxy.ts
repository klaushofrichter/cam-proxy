import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/load';
import { createProxy, type Proxy } from '../../src/proxy';
import { startSim } from './sim';

export const CLIENT_TOKEN = 'client-token-'.padEnd(40, 'x');
export const ADMIN_TOKEN = 'admin-token-'.padEnd(40, 'y');

// A proxy on a fresh data folder (or `dir`), pointed at a cam-sim.
export async function startProxy(sim: Awaited<ReturnType<typeof startSim>>, opts: { dir?: string; settings?: object } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'camproxy-proxy-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    camera: { host: sim.camera.host, protocol: 'http', user: 'proxy', onvifPort: sim.ports.onvif, rtspPort: sim.ports.rtsp || 554, statusPollS: 5 },
    events: { onvif: { subscribeMin: 1, pullTimeoutS: 1 }, poll: { enabled: true, intervalS: 1, afterOnvifDownS: 1 } },
    server: { logLevel: 'silent' },
    ...(opts.settings ?? {}),
  }));
  const loaded = loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: sim.password }, { cwd: dir });
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
