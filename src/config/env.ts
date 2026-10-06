import { readFileSync } from 'fs';
import { checkEnvPath, readEnvValue } from './env-file';

// Settings from the environment (spec 2026-10-04-pi-config-design §1): the
// camera's address and the Pi's own, so the Pi's one .env file carries them.
// Precedence, highest first: the file's CAMPROXY_* name, the file's plain
// name, the process environment's CAMPROXY_* name, its plain name. Any value
// in the file (CAMPROXY_ENV_FILE) beats any in the process environment: a
// container restart keeps the environment it was created with, so "Use this
// address" (which writes the file's CAMERA_HOST) plus a restart would
// otherwise not apply, also against a CAMPROXY_CAMERA_HOST in compose's
// environment. Only these keys are read from the file.

export const CAMERA_HOST_NAMES = ['CAMPROXY_CAMERA_HOST', 'CAMERA_HOST'] as const;
export const PI_ADDRESS_NAMES = ['CAMPROXY_PI_ADDRESS', 'PI_ADDRESS'] as const;
// The cams-admin command kill switch (migration P2, Ruling R2-5): unset or
// "on" = commands possible; anything else = off. The file's value and the
// process environment's are both read: either one not "on" wins (fail closed).
export const ADMIN_COMMANDS_NAMES = ['CAMPROXY_ADMIN_COMMANDS'] as const;

// An address or name with an optional :port (1-65535): what camera.host
// takes from the environment and from "Use this address".
export function validCameraHost(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = /^([A-Za-z0-9.-]{1,253})(?::([0-9]{1,5}))?$/.exec(v);
  if (!m || m[1].startsWith('.') || m[1].startsWith('-')) return false;
  return m[2] === undefined || (Number(m[2]) >= 1 && Number(m[2]) <= 65535);
}
const validPiAddress = (v: string) => /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(v);

export class EnvSettingError extends Error {}

export interface EnvValue { value: string; name: string }
export interface EnvLayer {
  cameraHost?: EnvValue;
  piAddress?: EnvValue;
  file?: { path: string; read: boolean };
  adminCommands?: { value: 'on' | 'off'; name: string; raw: string };
}

export function readEnvLayer(env: NodeJS.ProcessEnv): EnvLayer {
  let text: string | undefined;
  const path = env.CAMPROXY_ENV_FILE || undefined;
  if (path) {
    try {
      text = readFileSync(checkEnvPath(path), 'utf8');
    } catch {
      text = undefined; // not readable: the process environment applies
    }
  }
  // Sources in order (the file first), then names in order (CAMPROXY_ first).
  const pick = (names: readonly string[]): EnvValue | undefined => {
    for (const src of [text === undefined ? undefined : (n: string) => readEnvValue(text!, n), (n: string) => env[n]]) {
      if (!src) continue;
      for (const name of names) {
        const value = src(name);
        if (value) return { value, name };
      }
    }
    return undefined;
  };
  const layer: EnvLayer = { ...(path ? { file: { path, read: text !== undefined } } : {}) };
  const cameraHost = pick(CAMERA_HOST_NAMES);
  if (cameraHost) {
    if (!validCameraHost(cameraHost.value)) throw new EnvSettingError(`${cameraHost.name}: must be an address or name, optional :port`);
    layer.cameraHost = cameraHost;
  }
  const piAddress = pick(PI_ADDRESS_NAMES);
  if (piAddress) {
    if (!validPiAddress(piAddress.value)) throw new EnvSettingError(`${piAddress.name}: must be an address or name, without a port`);
    layer.piAddress = piAddress;
  }
  const isOn = (v: string) => v.trim().toLowerCase() === 'on';
  const vals = [text === undefined ? undefined : readEnvValue(text, ADMIN_COMMANDS_NAMES[0]), env[ADMIN_COMMANDS_NAMES[0]]].filter((v): v is string => v !== undefined);
  if (vals.length) layer.adminCommands = { value: vals.every(isOn) ? 'on' : 'off', name: ADMIN_COMMANDS_NAMES[0], raw: vals.find((v) => !isOn(v))?.slice(0, 16) ?? 'on' };
  return layer;
}
