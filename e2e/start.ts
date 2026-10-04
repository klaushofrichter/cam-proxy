// The e2e servers: a cam-sim and a cam-proxy pointed at it, in one process.
import dgram from 'dgram';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCamSim } from 'cam-sim';
import { loadConfig } from '../src/config/load';
import { createProxy, type Proxy } from '../src/proxy';
import { startVisionMock } from '../test/helpers/vision-mock';
import { startPoeSwitchMock } from '../test/helpers/poe-switch-mock';
import { ADMIN_TOKEN, CLIENT_TOKEN, DISCOVERY_PORT, FTP, FTP_PASSWORD, POE_SWITCH_PASSWORD, POE_SWITCH_PORT, PROXY_PORT, SIM, SIM_CONTROL_TOKEN, VISION_KEY, VISION_MOCK_PORT } from './env';

// go2rtc and MediaMTX from tools/ (scripts/install-*.sh) unless CI set them.
const tool = (name: string) => (existsSync(join(__dirname, '..', 'tools', name)) ? join(__dirname, '..', 'tools', name) : undefined);
process.env.CAMSIM_MEDIAMTX ??= tool('mediamtx');
const GO2RTC = process.env.CAMPROXY_TEST_GO2RTC ?? tool('go2rtc');
// The host figures (health.spec): a Raspberry Pi 4's /proc and /sys from the
// test fixtures, so the Pi card shows on any machine; E2E_HOST_ROOT picks
// another tree (test/fixtures/host/linux: no Pi).
const HOST_ROOT = process.env.E2E_HOST_ROOT ?? join(__dirname, '..', 'test', 'fixtures', 'host', 'pi');

async function main() {
  const sim = await createCamSim({
    users: [{ name: 'proxy', level: 'admin', password: 'e2e-proxy-pw' }],
    controlToken: SIM_CONTROL_TOKEN,
    seedClips: 'demo',
    // A camera reboot (maintenance.spec): a few seconds offline, and the
    // connection drops before the answer, as the real camera may do.
    reboot: { ms: 3000, dropsConnection: true },
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
  // A stand-in for the camera's PoE switch (#85; the real one is never used):
  // port 8 (index 0) powers cam-sim, so a power-cycle really takes it away.
  // No switch is configured at start; maintenance.spec sets camera.poeSwitch.
  const poeSwitch = await startPoeSwitchMock({
    password: POE_SWITCH_PASSWORD,
    port: POE_SWITCH_PORT,
    onPoe: (index, on) => {
      if (index !== 0) return;
      if (on) void sim.engine.powerOn(3000);
      else sim.engine.powerOff();
    },
  });
  // Find camera (pi-config spec §3): a fake WS-Discovery responder on
  // 127.0.0.1 answers with the documented Reolink sample (192.168.1.20) and
  // the same answer for cam-sim's own address (the current camera).
  const sample = readFileSync(join(__dirname, '..', 'test', 'fixtures', 'ws-discovery', 'reolink-probe-match.xml'), 'utf8');
  const discovery = dgram.createSocket('udp4');
  discovery.on('message', (msg, rinfo) => {
    const id = /<a:MessageID>([^<]+)</.exec(msg.toString('utf8'))?.[1] ?? '';
    const a = sample.replace('{{RELATES_TO}}', id);
    discovery.send(a, rinfo.port, rinfo.address);
    discovery.send(a.replace(/192\.168\.1\.20/g, '127.0.0.1').replace(/RLC-1224A/g, 'CAM-SIM').replace('ec71db000001</wsa:Address>', 'ec71db000002</wsa:Address>'), rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => discovery.bind(DISCOVERY_PORT, '127.0.0.1', () => r()));
  // PI_ADDRESS (pi-config spec §1): ftp.publicHost and server.publicUrl come
  // from the environment, read-only on the Settings page. No CAMPROXY_ENV_FILE:
  // "Use this address" shows the line to add by hand.
  const env = { PI_ADDRESS: '127.0.0.1', CAMPROXY_POE_SWITCH_PASSWORD: POE_SWITCH_PASSWORD, CAMPROXY_GOOGLE_VISION_KEY: VISION_KEY, CAMPROXY_GOOGLE_VISION_URL: vision.url, CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: 'e2e-proxy-pw', CAMPROXY_FTP_PASSWORD: FTP_PASSWORD };
  // The restart-proxy action (#71) ends with exit(0), and a supervisor starts
  // the process again. Here the exit is stubbed: a new proxy starts in this
  // process on the same port and data folder, so the server stays up. A fixed
  // session key keeps the shared e2e session valid across it.
  const sessionSecret = Buffer.alloc(32, 7);
  let proxy: Proxy;
  const boot = async () => {
    // The camera's FTP settings every 2 s, not every 5 min (ftp-health.spec, #93).
    proxy = createProxy(loadConfig(env, { cwd: dir }), { sessionSecret, cameraFtpCheckMs: 2000, host: { root: HOST_ROOT }, discovery: { target: { address: '127.0.0.1', port: DISCOVERY_PORT }, timeoutMs: 500 }, exit: () => void boot().catch((err: Error) => process.stderr.write(`e2e: restart failed: ${err.message}\n`)) });
    await proxy.start({ port: PROXY_PORT, host: '127.0.0.1' });
  };
  await boot();
  const stop = async (sig: string) => {
    await proxy.stop({ reason: sig });
    await sim.close();
    await vision.close();
    await poeSwitch.close();
    discovery.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
}

void main();
