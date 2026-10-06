import { cameraPasswordEnv } from '../../../src/config/password-env';
// Per-camera settings and actions in the admin UI (spec
// 2026-10-05-multi-camera-host-design §6.3). Pure: tested in
// test/camera-settings-ui.test.ts.
// The server's rules (src/config/schema.ts CAMERA_ID, CAMERA_HOST).
const ID = /^(?!file$)(?!.*-file$)[a-z0-9][a-z0-9-]{0,31}$/;
const HOST = /^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/;

// The host's settings by group (first path segment), and the selected camera's.
export function settingGroups(paths: string[], camera: string | null): { host: Record<string, string[]>; camera: string[] } {
  const host: Record<string, string[]> = {};
  const mine: string[] = [];
  for (const p of paths) {
    const m = /^cameras\.([^.]+)\./.exec(p);
    if (m) {
      if (m[1] === camera) mine.push(p);
      continue;
    }
    (host[p.split('.')[0]] ??= []).push(p);
  }
  return { host, camera: mine };
}

// A camera route with several cameras; the old route (the only camera) with one.
export function cameraPath(id: string | null, multi: boolean, suffix: string): string {
  if (multi && id) return `/control/cameras/${encodeURIComponent(id)}/${suffix}`;
  return suffix === 'name' ? '/control/camera/name' : `/control/${suffix}`;
}

// Why a camera can't be added like this, or null.
export function newCameraProblem(c: { id: string; host: string }, existing: string[]): string | null {
  if (!ID.test(c.id)) return 'the id is lower-case letters, digits and -, up to 32 (not "file" or ending in "-file")';
  if (existing.includes(c.id)) return `${c.id} exists already`;
  if (!c.host.trim()) return 'the camera needs an address';
  if (!HOST.test(c.host.trim())) return 'the address is a name or IP address, optional :port';
  return null;
}

type Usage = Record<string, { bytes: number; files: number }>;
const size = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : b >= 1024 ? `${(b / 1024).toFixed(1)} kB` : `${b} B`);

// The Storage card's lines per camera (/control/stats `cameras`), with several cameras only.
export function storageRows(by: Record<string, Usage> | undefined, ids: string[]): { id: string; text: string }[] {
  if (ids.length < 2) return [];
  return ids.map((id) => {
    const u = by?.[id];
    if (!u || !Object.values(u).some((k) => k.bytes > 0)) return { id, text: 'nothing stored' };
    return { id, text: (['stills', 'previews', 'clips', 'recordings'] as const).map((k) => `${k} ${size(u[k]?.bytes ?? 0)}`).join(' · ') };
  });
}

// Where an added camera's password comes from (the variable the proxy reads).
export function passwordHint(id: string): string {
  return `Its password comes from the environment: ${cameraPasswordEnv(id || '<id>')}, or CAMPROXY_CAMERA_PASSWORD for all.`;
}

// "Restart to apply": the host-wide restart (every camera side, every pending
// setting). Answers the message to show; never throws.
export async function restartToApply(api: (method: string, path: string) => Promise<unknown>): Promise<string> {
  try {
    await api('POST', '/control/actions/restart');
    return 'Restarting every camera side; pending settings apply…';
  } catch (e) {
    return `Restart failed: ${e instanceof Error ? e.message : 'unknown error'}`;
  }
}
