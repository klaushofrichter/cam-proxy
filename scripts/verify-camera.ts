// Read-only check of cam-proxy against the real camera: runs the whole proxy
// for a while in a temporary data folder and reports what it saw. It signs
// in, reads status and time, subscribes to ONVIF events, and on exit
// unsubscribes and logs out. It changes nothing on the camera.
//
//   npx tsx scripts/verify-camera.ts [seconds]      (default 90)
//
// Camera address from ~/Development/reolink/.env (REOLINK_IP). User
// CAMERA_USER (default proxy, the proxy's own camera user, whose password is
// CAMPROXY_CAMERA_PASSWORD in this repo's .env; for admin, REOLINK_PASSWORD).
// TLS name CAMERA_TLS_NAME (default cam1.skylar.technology). Prints no secrets.
import { randomBytes } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import sharp from 'sharp';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from '../src/config/load';
import { createProxy } from '../src/proxy';
import type { StreamMessage } from '../src/stream/log';

function env(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '');
  }
  return out;
}

async function main() {
  const seconds = Number(process.argv[2] ?? 90);
  const e = env(join(homedir(), 'Development/reolink/.env'));
  const user = process.env.CAMERA_USER ?? 'proxy';
  const password = user === 'proxy' ? env(join(__dirname, '..', '.env')).CAMPROXY_CAMERA_PASSWORD : e.REOLINK_PASSWORD;
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-verify-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    camera: { host: e.REOLINK_IP, protocol: 'https', tlsName: process.env.CAMERA_TLS_NAME ?? 'cam1.skylar.technology', user, statusPollS: 15 },
    server: { logLevel: 'warn' },
    // Stills through go2rtc (tools/go2rtc from scripts/install-go2rtc.sh).
    stills: { enabled: existsSync(join(__dirname, '..', 'tools', 'go2rtc')) },
    go2rtc: { binary: join(__dirname, '..', 'tools', 'go2rtc'), rtspPort: 28554, apiPort: 21984 },
  }));
  const loaded = loadConfig({ CAMPROXY_TOKENS: randomBytes(24).toString('hex'), CAMPROXY_ADMIN_TOKEN: randomBytes(24).toString('hex'), CAMPROXY_CAMERA_PASSWORD: password }, { cwd: dir });
  const proxy = createProxy(loaded);
  const seen: StreamMessage[] = [];
  proxy.log.on('message', (m: StreamMessage) => {
    seen.push(m);
    console.log(`  ${new Date(m.ts).toLocaleTimeString()} ${m.type} ${JSON.stringify(m.data)}`);
  });
  await proxy.start({ port: 0, host: '127.0.0.1' });
  console.log(`running against the camera for ${seconds} s (read-only)…`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const cam = proxy.status.state();
  const intake = proxy.intake.state();
  console.log('camera:', JSON.stringify({ online: cam.online, model: cam.model, firmware: cam.firmware, clockOffsetMs: cam.clockOffsetMs, error: cam.error }));
  console.log('events:', JSON.stringify({ onvif: intake.onvif, source: intake.source, resubscribes: intake.resubscribes, lastError: intake.lastError }));
  console.log(`stream messages: ${seen.length} (${seen.filter((m) => m.type === 'camera-event').length} camera events)`);
  const st = proxy.stills;
  if (st) {
    const producers = (await st.go2rtc.streams().catch(() => ({}) as Record<string, { producers: unknown[] }>)).cam1_sub?.producers.length;
    const to = Date.now();
    const list = st.store.listStills(to - seconds * 1000, to);
    const perMinute = new Map<number, number>();
    for (const t of list) perMinute.set(Math.floor(t / 60_000), (perMinute.get(Math.floor(t / 60_000)) ?? 0) + 1);
    const sample = list.length ? await st.store.readStill(list[list.length - 1]) : undefined;
    const meta = sample ? await sharp(sample).metadata() : undefined;
    console.log('stills:', JSON.stringify({ total: list.length, perMinute: [...perMinute.values()], still: meta ? `${meta.width}x${meta.height} ${sample!.length} bytes` : null, go2rtcCameraConnections: producers }));
  }
  await proxy.stop();
  const packs = (d: string) => (existsSync(d) ? readdirSync(d, { recursive: true }).filter((f) => String(f).endsWith('.pack') || String(f).endsWith('.jpg')).length : 0);
  console.log('written:', JSON.stringify({ packs: packs(join(dir, 'data', 'stills')), sprites: packs(join(dir, 'data', 'previews')) }), '(deleted with the temporary folder)');
  rmSync(dir, { recursive: true, force: true });
  process.exit(cam.online && intake.onvif === 'subscribed' ? 0 : 1);
}

void main();
