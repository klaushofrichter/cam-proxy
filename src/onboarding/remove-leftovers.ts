// What a removed camera left that this proxy can't remove itself (spec
// 2026-10-30-camera-onboarding-design §4.3, the sibling of move leftovers):
// the camera's password in the process environment (compose's environment or
// env_file) or a _FILE secret, a camera.host in config.json on a
// single-camera proxy. Kept in data/admin/remove-leftovers.json and checked
// again on every read: a fixed item drops out, and so does a camera that is
// configured again. Names only, never a value.
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPath, type Loaded } from '../config/load';
import { cameraIds } from '../config/cameras';
import { cameraPasswordEnv } from '../config/password-env';
import { writePrivateJson } from '../fleet/private-file';
import { LEFTOVERS_MAX } from '../moves/leftovers';

export interface RemoveLeftover { camera: string; at: number; items: string[] }

// `legacy`: the camera was the legacy one-camera proxy's (the Pi's); then also
// what that setup keeps besides the camera: its `camera` node in config.json
// (not turned into an empty host), and on an empty host the shared
// CAMPROXY_CAMERA_PASSWORD and CAMERA_HOST still in the process environment
// (compose's environment, or env_file until the container is recreated).
export function removeLeftoverItems(l: Loaded, cam: string, o: { legacy?: boolean } = {}): string[] {
  const name = cameraPasswordEnv(cam);
  const items: string[] = [];
  if ((l.env[name] ?? '').trim() !== '') items.push(`env ${name}`);
  if (l.env[`${name}_FILE`] !== undefined) items.push(`env ${name}_FILE`);
  if (l.legacyCamera && l.order[0] === cam) {
    if (o.legacy) items.push('config.json camera');
    else if (typeof getPath(l.fileSettings, `cameras.${cam}.host`) === 'string' && getPath(l.fileSettings, `cameras.${cam}.host`) !== '') items.push('config.json camera.host');
  }
  if (o.legacy && !l.legacyCamera) {
    const shared = 'CAMPROXY_CAMERA_PASSWORD';
    const needed = cameraIds(l.config).some((id) => !l.config.cameras[id]?.moved && l.secrets.cameraPasswords[id] === undefined);
    if (!needed && (l.env[shared] ?? '').trim() !== '') items.push(`env ${shared}`);
    if (!needed && l.env[`${shared}_FILE`] !== undefined) items.push(`env ${shared}_FILE`);
    if (l.envLayer.cameraHost && l.order.length === 0) items.push(`env ${l.envLayer.cameraHost.name}`);
  }
  return items;
}

// Configured again: an added camera, a config.json camera on a several-camera proxy, the Pi's camera with an address from the environment.
const configuredAgain = (l: Loaded, cam: string): boolean =>
  !l.config.cameras[cam]?.moved && (l.addedCameras.includes(cam) || (l.legacyCamera ? l.order[0] === cam && !!l.envLayer.cameraHost : l.order.includes(cam)));

const entryOk = (e: unknown): e is RemoveLeftover => {
  const o = e as RemoveLeftover;
  return !!o && typeof o.camera === 'string' && typeof o.at === 'number' && Array.isArray(o.items) && o.items.every((i) => typeof i === 'string');
};

export class RemoveLeftovers {
  private readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, 'admin', 'remove-leftovers.json');
  }

  private read(): RemoveLeftover[] {
    try {
      const v = JSON.parse(readFileSync(this.path, 'utf8')) as { entries?: unknown };
      return Array.isArray(v.entries) ? v.entries.filter(entryOk) : [];
    } catch {
      return [];
    }
  }

  // Replaces an entry of that camera; the newest LEFTOVERS_MAX stay.
  add(e: RemoveLeftover): void {
    const next = [...this.read().filter((x) => x.camera !== e.camera), { camera: e.camera, at: e.at, items: [...e.items] }].slice(-LEFTOVERS_MAX);
    writePrivateJson(this.path, { v: 1, entries: next });
  }

  current(l: Loaded): RemoveLeftover[] {
    return this.read()
      .filter((e) => !configuredAgain(l, e.camera))
      .map((e) => ({ ...e, items: removeLeftoverItems(l, e.camera, { legacy: true }).filter((i) => e.items.some((x) => x === i || x.startsWith(`${i} (`))) }))
      .filter((e) => e.items.length > 0);
  }
}
