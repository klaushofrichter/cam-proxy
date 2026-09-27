// Read-only check of cam-proxy against the real camera: runs the whole proxy
// for a while in a temporary data folder and reports what it saw. It signs
// in, reads status and time, subscribes to ONVIF events, and on exit
// unsubscribes and logs out. It changes nothing on the camera.
//
//   npx tsx scripts/verify-camera.ts [seconds]      (default 90)
//   npx tsx scripts/verify-camera.ts --ftp [seconds] (default 600)
//
// With --ftp it does change the camera: it points the camera's FTP upload at
// this machine (its LAN address, port 2121, FTPS, a password made for this
// run), runs the camera's FTP test, waits for a real motion clip, and at the
// end turns the camera's FTP off again (enable 0). Clips stay in the
// temporary folder and are deleted with it.
//
// Camera address from ~/Development/reolink/.env (REOLINK_IP). User
// CAMERA_USER (default proxy, the proxy's own camera user, whose password is
// CAMPROXY_CAMERA_PASSWORD in this repo's .env; for admin, REOLINK_PASSWORD).
// TLS name CAMERA_TLS_NAME (default cam1.skylar.technology). Prints no secrets.
import { randomBytes } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import sharp from 'sharp';
import { homedir, networkInterfaces, tmpdir } from 'os';
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

// This machine's IPv4 address on the camera's subnet (/24).
function lanAddressFor(camera: string): string | undefined {
  const prefix = camera.split(':')[0].split('.').slice(0, 3).join('.') + '.';
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && a.address.startsWith(prefix)) return a.address;
  return undefined;
}

async function main() {
  const ftp = process.argv.includes('--ftp');
  const args = process.argv.slice(2).filter((a) => a !== '--ftp');
  const seconds = Number(args[0] ?? (ftp ? 600 : 90));
  const e = env(join(homedir(), 'Development/reolink/.env'));
  const publicHost = ftp ? lanAddressFor(e.REOLINK_IP) : undefined;
  if (ftp && !publicHost) throw new Error('no LAN address on the camera subnet');
  const ftpPassword = randomBytes(12).toString('hex');
  const adminToken = randomBytes(24).toString('hex');
  const user = process.env.CAMERA_USER ?? 'proxy';
  const password = user === 'proxy' ? env(join(__dirname, '..', '.env')).CAMPROXY_CAMERA_PASSWORD : e.REOLINK_PASSWORD;
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-verify-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    camera: { host: e.REOLINK_IP, protocol: 'https', tlsName: process.env.CAMERA_TLS_NAME ?? 'cam1.skylar.technology', user, statusPollS: 15 },
    server: { logLevel: 'warn' },
    // Stills through go2rtc (tools/go2rtc from scripts/install-go2rtc.sh).
    stills: { enabled: existsSync(join(__dirname, '..', 'tools', 'go2rtc')) },
    go2rtc: { binary: join(__dirname, '..', 'tools', 'go2rtc'), rtspPort: 28554, apiPort: 21984 },
    ...(ftp ? { ftp: { enabled: true, port: 2121, passive: '30000-30009', publicHost, tls: true, stream: 'main' } } : {}),
  }));
  const loaded = loadConfig(
    { CAMPROXY_TOKENS: randomBytes(24).toString('hex'), CAMPROXY_ADMIN_TOKEN: adminToken, CAMPROXY_CAMERA_PASSWORD: password, ...(ftp ? { CAMPROXY_FTP_PASSWORD: ftpPassword } : {}) },
    { cwd: dir },
  );
  const proxy = createProxy(loaded);
  const seen: StreamMessage[] = [];
  proxy.log.on('message', (m: StreamMessage) => {
    seen.push(m);
    console.log(`  ${new Date(m.ts).toLocaleTimeString()} ${m.type} ${JSON.stringify(m.data)}`);
  });
  const { port } = await proxy.start({ port: 0, host: '127.0.0.1' });
  const action = async (name: string) => {
    const r = await fetch(`http://127.0.0.1:${port}/control/actions/${name}`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
    return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
  };
  const commands: string[] = [];
  if (ftp) {
    proxy.clips?.server.on('command', (line: string) => commands.push(line));
    // Whatever happens, the camera's FTP goes back off.
    const off = async () => console.log('camera-ftp-off:', JSON.stringify(await action('camera-ftp-off').catch((err: Error) => ({ error: err.message }))));
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void off().finally(() => process.exit(1)));
    const setup = await action('camera-ftp-setup');
    console.log('camera-ftp-setup:', setup.status, JSON.stringify(setup.body));
    const test = await action('camera-ftp-test');
    console.log('camera-ftp-test:', test.status, JSON.stringify(test.body));
    console.log('ftp commands during the test:', JSON.stringify(commands));
    console.log(`waiting up to ${seconds} s for a motion clip from the camera (FTP at ${publicHost}:2121)…`);
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000 && !seen.some((m) => m.type === 'clip')) await new Promise((r) => setTimeout(r, 1000));
    // The snapshot follows the clip.
    await new Promise((r) => setTimeout(r, 10_000));
    await off();
    const clip = seen.find((m) => m.type === 'clip');
    console.log('clip:', clip ? JSON.stringify({ ...clip.data, durationS: ((clip.data.end as number) - (clip.data.start as number)) / 1000 }) : 'none');
    console.log('ftp status:', JSON.stringify(((await (await fetch(`http://127.0.0.1:${port}/control/status`, { headers: { Authorization: `Bearer ${adminToken}` } })).json()) as { ftp: unknown }).ftp));
    // The camera's command sequence (the first session, then a count).
    console.log('ftp commands:', JSON.stringify(commands.slice(0, 40)), commands.length > 40 ? `(+${commands.length - 40})` : '');
  } else {
    console.log(`running against the camera for ${seconds} s (read-only)…`);
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
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
  console.log('written:', JSON.stringify({ packs: packs(join(dir, 'data', 'stills')), sprites: packs(join(dir, 'data', 'previews')), clipFiles: existsSync(join(dir, 'data', 'clips')) ? readdirSync(join(dir, 'data', 'clips'), { recursive: true }).filter((f) => /\.(mp4|jpg)$/.test(String(f))).length : 0 }), '(deleted with the temporary folder)');
  rmSync(dir, { recursive: true, force: true });
  process.exit(cam.online && intake.onvif === 'subscribed' ? 0 : 1);
}

void main();
