import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../../src/config/load';
import { createProxy, type Proxy, type ProxyOptions } from '../../src/proxy';
import { ADMIN_TOKEN, CLIENT_TOKEN, freePort } from './proxy';
import { startSim } from './sim';

export type Sim = Awaited<ReturnType<typeof startSim>>;

// `ignoreImport`: the indexes of the sims that refuse a certificate import (cam-sim's cert.ignoreImport).
export const startSims = (n: number, o: { ignoreImport?: number[] } = {}): Promise<Sim[]> => Promise.all(Array.from({ length: n }, (_, i) => startSim({ ignoreImport: o.ignoreImport?.includes(i) })));

// One proxy over several cam-sims: cameras cam3, cam4, … (or `ids`), in that
// order; `extra` camera nodes are appended as they are (e.g. one without host).
// `https`: the cameras on their sims' HTTPS port (protocol https), for the site CA.
export async function startMultiProxy(sims: Sim[], opts: { ids?: string[]; extra?: object[]; settings?: object; env?: Record<string, string>; https?: boolean; proxy?: ProxyOptions; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'camproxy-multi-'));
  const go2rtc = process.env.CAMPROXY_TEST_GO2RTC;
  const ids = opts.ids ?? sims.map((_, i) => `cam${i + 3}`);
  const cameras = [
    ...sims.map((s, i) => ({ id: ids[i], host: opts.https ? `127.0.0.1:${s.ports.https}` : s.camera.host, protocol: opts.https ? 'https' : 'http', user: 'proxy', onvifPort: s.ports.onvif, rtspPort: s.ports.rtsp || 554, baichuanPort: s.camera.baichuanPort, statusPollS: 5 })),
    ...(opts.extra ?? []),
  ];
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    stills: { enabled: !!go2rtc },
    go2rtc: { binary: go2rtc ?? 'go2rtc', rtspPort: await freePort(), apiPort: await freePort() },
    cameras,
    events: { onvif: { subscribeMin: 1, pullTimeoutS: 1 }, poll: { enabled: true, intervalS: 1, afterOnvifDownS: 1 } },
    server: { logLevel: 'silent' },
    ...(opts.settings ?? {}),
  }));
  // Every cam-sim of startSim() has the proxy user's password 'proxy-pw'.
  const loaded = loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: sims[0]?.password ?? 'proxy-pw', ...opts.env }, { cwd: dir });
  const proxy: Proxy = createProxy(loaded, opts.proxy);
  const { port } = await proxy.start({ port: 0, host: '127.0.0.1' });
  return { proxy, dir, base: `http://127.0.0.1:${port}`, ids: cameras.map((c) => (c as { id: string }).id) };
}
