// The multi-camera e2e servers: three cam-sims and one cam-proxy over them.
import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCamSim } from 'cam-sim';
import { loadConfig } from '../../src/config/load';
import { createProxy } from '../../src/proxy';
import { ADMIN_TOKEN, CLIENT_TOKEN, PROXY_PORT, SIMS } from './env';

const tool = (name: string) => (existsSync(join(__dirname, '..', '..', 'tools', name)) ? join(__dirname, '..', '..', 'tools', name) : undefined);
process.env.CAMSIM_MEDIAMTX ??= tool('mediamtx');
const GO2RTC = process.env.CAMPROXY_TEST_GO2RTC ?? tool('go2rtc');

async function main() {
  const sims = await Promise.all(SIMS.map(async (s) => {
    const sim = await createCamSim({ users: [{ name: 'proxy', level: 'admin', password: 'e2e-proxy-pw' }], name: s.name, seedClips: 'demo' });
    const ports = await sim.listen({ http: s.http, https: s.https, control: s.control, onvif: s.onvif, rtsp: s.rtsp }, '127.0.0.1');
    return { sim, ports };
  }));
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-e2e-multi-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    cameras: sims.map(({ ports }, i) => ({ id: `cam${i + 3}`, host: `127.0.0.1:${ports.http}`, protocol: 'http', user: 'proxy', onvifPort: ports.onvif, rtspPort: ports.rtsp || 554, statusPollS: 5 })),
    events: { onvif: { subscribeMin: 1, pullTimeoutS: 2 } },
    server: { logLevel: 'warn' },
    stills: { enabled: !!GO2RTC },
    // One go2rtc for every camera (spec §8.5).
    go2rtc: { binary: GO2RTC ?? 'go2rtc', rtspPort: 18800, apiPort: 18850 },
  }));
  const proxy = createProxy(loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: 'e2e-proxy-pw' }, { cwd: dir }));
  await proxy.start({ port: PROXY_PORT, host: '127.0.0.1' });
  const stop = async () => {
    await proxy.stop({ reason: 'e2e' });
    await Promise.all(sims.map((s) => s.sim.close()));
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

void main();
