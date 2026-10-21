import { join } from 'path';
import { PrivateFileInvalid, readPrivateJson, writePrivateJson } from '../fleet/private-file';

// <dataDir>/admin/camera-passwords.json: {v:1, cameras:{<id>:{password}}}, mode
// 600. A camera moved here brings its password (camera-move spec S §9.3); the
// environment still wins (loadSecrets). Never printed, logged or served.
export interface CameraPasswordStore {
  get(id: string): string | undefined;
  set(id: string, password: string): void;
  delete(id: string): void;
}

export const cameraPasswordsFile = (dataDir: string): string => join(dataDir, 'admin', 'camera-passwords.json');

type File = { v: 1; cameras: Record<string, { password: string }> };

// A missing file is empty; an unreadable or malformed one throws (message names the file only).
function readFile(path: string): File {
  let raw: unknown;
  try {
    raw = readPrivateJson(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, cameras: {} };
    throw err;
  }
  const f = raw as Partial<File> | null;
  if (!f || f.v !== 1 || !f.cameras || typeof f.cameras !== 'object' || Array.isArray(f.cameras)) throw new PrivateFileInvalid(`${path} is not a camera password file`);
  for (const e of Object.values(f.cameras)) if (!e || typeof e.password !== 'string') throw new PrivateFileInvalid(`${path} is not a camera password file`);
  return f as File;
}

export function cameraPasswordStore(dataDir: string): CameraPasswordStore {
  const path = cameraPasswordsFile(dataDir);
  return {
    get: (id) => {
      const cameras = readFile(path).cameras;
      return (Object.hasOwn(cameras, id) ? cameras[id].password : '') || undefined;
    },
    set: (id, password) => {
      const f = readFile(path);
      f.cameras[id] = { password };
      writePrivateJson(path, f);
    },
    delete: (id) => {
      const f = readFile(path);
      if (!Object.hasOwn(f.cameras, id)) return;
      delete f.cameras[id];
      writePrivateJson(path, f);
    },
  };
}
