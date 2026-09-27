import { CameraError, type ReolinkClient } from '../camera/client';

// The camera's FTP upload settings (GetFtpV20/SetFtpV20). The firmware takes
// the whole Ftp object only, and refuses an empty server (-4), so "off" keeps
// the server and sets enable 0.

export interface FtpTarget {
  server: string; // the address the camera connects to (ftp.publicHost)
  port: number;
  user: string;
  password: string;
  tls: boolean;
  stream: 'main' | 'sub';
}

type FtpObject = Record<string, unknown> & { schedule?: { channel?: number; table?: Record<string, string> } };

const ALL_HOURS = '1'.repeat(7 * 24);
// Uploads follow motion and the AI detections; timed recordings stay off.
const UPLOAD_ON = ['MD', 'AI_PEOPLE', 'AI_VEHICLE', 'AI_DOG_CAT'];

async function read(client: ReolinkClient): Promise<FtpObject> {
  const v = await client.command<{ Ftp?: FtpObject }>('GetFtpV20', { channel: 0 });
  if (!v?.Ftp || typeof v.Ftp !== 'object') throw new CameraError('camera_error', 'GetFtpV20 returned no Ftp object');
  return v.Ftp;
}

// The whole object with the proxy as the target, the rest as the camera has it.
export function ftpObject(current: FtpObject, t: FtpTarget): FtpObject {
  const table = { ...(current.schedule?.table ?? {}) };
  for (const k of UPLOAD_ON) table[k] = ALL_HOURS;
  return {
    ...current,
    enable: 1,
    server: t.server,
    port: t.port,
    anonymous: 0,
    userName: t.user,
    password: t.password,
    onlyFtps: t.tls ? 1 : 0,
    remoteDir: '',
    autoDir: 1,
    streamType: t.stream === 'sub' ? 1 : 0,
    schedule: { ...(current.schedule ?? {}), channel: current.schedule?.channel ?? 0, table },
  };
}

// What the API shows: the camera's settings without the password.
export function redact(ftp: FtpObject): FtpObject {
  const { password: _password, schedule, ...rest } = ftp;
  const on = Object.entries(schedule?.table ?? {})
    .filter(([, v]) => v.includes('1'))
    .map(([k]) => k);
  return { ...rest, uploadOn: on };
}

export async function setupCameraFtp(client: ReolinkClient, t: FtpTarget): Promise<FtpObject> {
  const next = ftpObject(await read(client), t);
  await client.command('SetFtpV20', { Ftp: next });
  return redact(await read(client));
}

// TestFtp with the whole object: the camera connects and logs in. 0 is
// success; the camera answers -454 when it can't reach or log in.
export async function testCameraFtp(client: ReolinkClient, t: FtpTarget): Promise<{ ok: boolean; rspCode: number }> {
  const obj = ftpObject(await read(client), t);
  try {
    await client.command('TestFtp', { Ftp: obj });
    return { ok: true, rspCode: 0 };
  } catch (err) {
    if (err instanceof CameraError && err.rspCode !== undefined) return { ok: false, rspCode: err.rspCode };
    throw err;
  }
}

export async function cameraFtpOff(client: ReolinkClient): Promise<FtpObject> {
  const current = await read(client);
  if (!current.server) return redact(current); // never configured: already off
  await client.command('SetFtpV20', { Ftp: { ...current, enable: 0 } });
  return redact(await read(client));
}
