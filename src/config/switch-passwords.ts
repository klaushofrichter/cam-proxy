import { join } from 'path';
import { PrivateFileInvalid, readPrivateJson, writePrivateJson } from '../fleet/private-file';

// <dataDir>/admin/switch-passwords.json: {v:1, switches:{<id>:{password}}}, mode
// 600 (spec 2026-11-07-poe-switches-design): the web login of each PoE switch
// this proxy operates, by cams-admin's switch id. Write-only: never printed,
// logged, audited or served.
export interface SwitchPasswordStore {
  get(id: string): string | undefined;
  set(id: string, password: string): void;
  delete(id: string): void;
}

export const switchPasswordsFile = (dataDir: string): string => join(dataDir, 'admin', 'switch-passwords.json');

type File = { v: 1; switches: Record<string, { password: string }> };

// A missing file is empty; an unreadable or malformed one throws (message names the file only).
function readFile(path: string): File {
  let raw: unknown;
  try {
    raw = readPrivateJson(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, switches: {} };
    throw err;
  }
  const f = raw as Partial<File> | null;
  if (!f || f.v !== 1 || !f.switches || typeof f.switches !== 'object' || Array.isArray(f.switches)) throw new PrivateFileInvalid(`${path} is not a switch password file`);
  for (const e of Object.values(f.switches)) if (!e || typeof e.password !== 'string') throw new PrivateFileInvalid(`${path} is not a switch password file`);
  return f as File;
}

export function switchPasswordStore(dataDir: string): SwitchPasswordStore {
  const path = switchPasswordsFile(dataDir);
  return {
    get: (id) => {
      const s = readFile(path).switches;
      return (Object.hasOwn(s, id) ? s[id].password : '') || undefined;
    },
    set: (id, password) => {
      const f = readFile(path);
      f.switches[id] = { password };
      writePrivateJson(path, f);
    },
    delete: (id) => {
      const f = readFile(path);
      if (!Object.hasOwn(f.switches, id)) return;
      delete f.switches[id];
      writePrivateJson(path, f);
    },
  };
}
