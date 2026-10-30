// Where a camera's password comes from and whether it works (spec
// 2026-10-30-camera-onboarding-design §4.1). Names only, never a value.
import type { CameraState } from '../camera/status';
import { cameraPasswordStore } from '../config/camera-passwords';
import type { Loaded } from '../config/load';
import { cameraPasswordEnv } from '../config/password-env';

export type CredentialSource = 'env' | 'store' | 'none';
export interface Credentials { source: CredentialSource; envName?: string; authOk: boolean | null; checkedAt: number | null }

// A variable loadSecrets reads: NAME_FILE wins over NAME; an empty NAME is unset.
const setName = (env: NodeJS.ProcessEnv, name: string): string | undefined => (env[`${name}_FILE`] ? `${name}_FILE` : env[name] ? name : undefined);

// loadSecrets' order: the camera's own variable (or its _FILE), the stored
// password, the shared CAMPROXY_CAMERA_PASSWORD. `ownEnv`: the own variable
// sets it (a save through the API has to remove it first).
export function passwordSource(l: Loaded, id: string): { source: CredentialSource; envName?: string; ownEnv: boolean } {
  const own = setName(l.env, cameraPasswordEnv(id));
  if (own) return { source: 'env', envName: own, ownEnv: true };
  let stored = false;
  try {
    stored = cameraPasswordStore(l.config.server.dataDir).get(id) !== undefined;
  } catch {
    stored = false; // unreadable: the start refused it already; nothing to report from it
  }
  if (stored) return { source: 'store', ownEnv: false };
  const shared = setName(l.env, 'CAMPROXY_CAMERA_PASSWORD');
  if (shared) return { source: 'env', envName: shared, ownEnv: false };
  return { source: 'none', ownEnv: false };
}

// authOk: true while the camera answers, false when it refused the login, else unknown.
export function credentialsOf(src: ReturnType<typeof passwordSource>, st: CameraState): Credentials {
  return {
    source: src.source,
    ...(src.envName ? { envName: src.envName } : {}),
    authOk: st.online ? true : st.error === 'camera_auth_failed' ? false : null,
    checkedAt: st.checkedAt ?? null,
  };
}
