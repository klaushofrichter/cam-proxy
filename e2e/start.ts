// The e2e servers: a cam-sim and a cam-proxy pointed at it, in one process.
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCamSim } from 'cam-sim';
import { loadConfig } from '../src/config/load';
import { createProxy } from '../src/proxy';
import { ADMIN_TOKEN, CLIENT_TOKEN, PROXY_PORT, SIM, SIM_CONTROL_TOKEN } from './env';

async function main() {
  const sim = await createCamSim({
    users: [{ name: 'proxy', level: 'admin', password: 'e2e-proxy-pw' }],
    controlToken: SIM_CONTROL_TOKEN,
    seedClips: 'demo',
  });
  const ports = await sim.listen(SIM, '127.0.0.1');
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-e2e-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    camera: { host: `127.0.0.1:${ports.http}`, protocol: 'http', user: 'proxy', onvifPort: ports.onvif, rtspPort: ports.rtsp || 554, statusPollS: 5 },
    events: { onvif: { subscribeMin: 1, pullTimeoutS: 2 } },
    server: { logLevel: 'warn' },
  }));
  const loaded = loadConfig({ CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: 'e2e-proxy-pw' }, { cwd: dir });
  const proxy = createProxy(loaded);
  await proxy.start({ port: PROXY_PORT, host: '127.0.0.1' });
  const stop = async () => {
    await proxy.stop();
    await sim.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

void main();
