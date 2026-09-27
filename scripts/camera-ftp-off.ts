// Turns the camera's FTP upload off (enable 0, the rest kept) and prints the
// result. For cleanup after scripts/verify-camera.ts --ftp was interrupted.
//
//   npx tsx scripts/camera-ftp-off.ts
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ReolinkClient } from '../src/camera/client';
import { cameraFtpOff } from '../src/clips/camera-ftp';

function env(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '');
  }
  return out;
}

async function main() {
  const e = env(join(homedir(), 'Development/reolink/.env'));
  const client = new ReolinkClient({ id: 'cam1', host: e.REOLINK_IP, protocol: 'https', tlsServername: process.env.CAMERA_TLS_NAME ?? 'cam1.skylar.technology', user: 'proxy', password: env(join(__dirname, '..', '.env')).CAMPROXY_CAMERA_PASSWORD });
  try {
    const ftp = await cameraFtpOff(client);
    console.log('camera FTP:', JSON.stringify({ enable: ftp.enable, server: ftp.server, port: ftp.port }));
  } finally {
    await client.logout();
  }
}

void main();
