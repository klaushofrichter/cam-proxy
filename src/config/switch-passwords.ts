import { join } from 'path';
import { PrivateFileInvalid, readPrivateJson, writePrivateJson } from '../fleet/private-file';

// <dataDir>/admin/switch-passwords.json: {v:1, switches:{<id>:{password, host}}},
// mode 600 (spec 2026-11-07-poe-switches-design): the web login of each PoE
// switch this proxy operates, by cams-admin's switch id. Write-only: never
// printed, logged, audited or served. `host` (lower case) is the switch
// address the password was set for: the registry sends it nowhere else, so a
// cams-admin naming another address for the switch never gets it. Entries
// written before the binding have no host until the registry binds them.
export interface StoredSwitchPassword { password: string; host?: string }
export interface SwitchPasswordStore {
  get(id: string): StoredSwitchPassword | undefined;
  set(id: string, password: string, host: string): void;
  // Binds a password stored without an address to `host`; false when there is nothing to bind.
  bind(id: string, host: string): boolean;
  delete(id: string): void;
}

export const switchPasswordsFile = (dataDir: string): string => join(dataDir, 'admin', 'switch-passwords.json');

type File = { v: 1; switches: Record<string, StoredSwitchPassword> };

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
  for (const e of Object.values(f.switches)) if (!e || typeof e.password !== 'string' || (e.host !== undefined && typeof e.host !== 'string')) throw new PrivateFileInvalid(`${path} is not a switch password file`);
  return f as File;
}

export function switchPasswordStore(dataDir: string): SwitchPasswordStore {
  const path = switchPasswordsFile(dataDir);
  return {
    get: (id) => {
      const s = readFile(path).switches;
      if (!Object.hasOwn(s, id) || !s[id].password) return undefined;
      return { password: s[id].password, ...(s[id].host ? { host: s[id].host } : {}) };
    },
    set: (id, password, host) => {
      const f = readFile(path);
      f.switches[id] = { password, host: host.toLowerCase() };
      writePrivateJson(path, f);
    },
    bind: (id, host) => {
      const f = readFile(path);
      if (!Object.hasOwn(f.switches, id) || f.switches[id].host) return false;
      f.switches[id] = { ...f.switches[id], host: host.toLowerCase() };
      writePrivateJson(path, f);
      return true;
    },
    delete: (id) => {
      const f = readFile(path);
      if (!Object.hasOwn(f.switches, id)) return;
      delete f.switches[id];
      writePrivateJson(path, f);
    },
  };
}
