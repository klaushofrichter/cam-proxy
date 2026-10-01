// The e2e servers: a cam-sim and a cam-proxy pointed at it, in one process.
import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCamSim } from 'cam-sim';
import { loadConfig } from '../src/config/load';
import { createProxy } from '../src/proxy';
import { startVisionMock } from '../test/helpers/vision-mock';
import { ADMIN_TOKEN, CLIENT_TOKEN, FTP, FTP_PASSWORD, PROXY_PORT, SIM, SIM_CONTROL_TOKEN, VISION_KEY, VISION_MOCK_PORT } from './env';

// go2rtc and MediaMTX from tools/ (scripts/install-*.sh) unless CI set them.
const tool = (name: string) => (existsSync(join(__dirname, '..', 'tools', name)) ? join(__dirname, '..', 'tools', name) : undefined);
process.env.CAMSIM_MEDIAMTX ??= tool('mediamtx');
const GO2RTC = process.env.CAMPROXY_TEST_GO2RTC ?? tool('go2rtc');

async function main() {
  const sim = await createCamSim({
    users: [{ name: 'proxy', level: 'admin', password: 'e2e-proxy-pw' }],
    controlToken: SIM_CONTROL_TOKEN,
    seedClips: 'demo',
  });
  const ports = await sim.listen(SIM, '127.0.0.1');
  // Recordings end a second after the event, so clips upload quickly.
  sim.engine.settings.running.Rec.postRec = '1 Seconds';
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-e2e-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    camera: { host: `127.0.0.1:${ports.http}`, protocol: 'http', user: 'proxy', onvifPort: ports.onvif, rtspPort: ports.rtsp || 554, statusPollS: 5 },
    events: { onvif: { subscribeMin: 1, pullTimeoutS: 2 } },
    server: { logLevel: 'warn' },
    stills: { enabled: !!GO2RTC },
    go2rtc: { binary: GO2RTC ?? 'go2rtc', rtspPort: 18585, apiPort: 18586 },
    ftp: { enabled: true, port: FTP.port, passive: FTP.passive, publicHost: '127.0.0.1', stream: 'sub' },
  }));
  // A stand-in for Google Vision; GET /calls tells the tests how often it was asked.
  const vision = await startVisionMock({ key: VISION_KEY, port: VISION_MOCK_PORT });
  const loaded = loadConfig({ CAMPROXY_GOOGLE_VISION_KEY: VISION_KEY, CAMPROXY_GOOGLE_VISION_URL: vision.url, CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: 'e2e-proxy-pw', CAMPROXY_FTP_PASSWORD: FTP_PASSWORD }, { cwd: dir });
  const proxy = createProxy(loaded);
  await proxy.start({ port: PROXY_PORT, host: '127.0.0.1' });
  const stop = async (sig: string) => {
    await proxy.stop({ reason: sig });
    await sim.close();
    await vision.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
}

void main();
