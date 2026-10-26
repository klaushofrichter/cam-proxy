import { readFileSync } from 'fs';
import { cameraPasswordsNow } from './camera-passwords';
import type { Secrets } from './defaults';
import { SettingError } from './schema';

// A secret from NAME, or from the file NAME_FILE names (which wins). Error
// messages never contain a secret's value.
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) {
    try {
      return readFileSync(file, 'utf8').replace(/\r?\n$/, '');
    } catch {
      throw new SettingError(`${name}_FILE: cannot read the file`);
    }
  }
  return env[name] || undefined;
}

const MIN_TOKEN = 32;

// One camera's own password variable (spec 2026-10-05-multi-camera-host-design §4.2).
import { cameraPasswordEnv } from './password-env';
export { cameraPasswordEnv };

// The password a camera's worker logs in with: its own, else the default.
export function cameraPassword(s: Secrets, id: string): string {
  return s.cameraPasswords[id] ?? s.cameraPassword;
}

// tokensOptional (migration P2, M §10.2): CAMPROXY_TOKENS may be unset while
// a cams-admin-managed client token is live; the start checks that
// (checkClientTokens), the CLI keeps the strict default.
// passwordFromMove: cameras whose password a camera move brings later (the
// target's offer check and its secrets step validate the camera node before
// the password is there): their missing password is not an error. Nothing is
// put in its place; such a result is for validation only, never for a worker.
export function loadSecrets(env: NodeJS.ProcessEnv, ftpEnabled: boolean, cameraIds: string[] = [], o: { tokensOptional?: boolean; dataDir?: string; passwordFromMove?: readonly string[] } = {}): Secrets {
  const tokensRaw = read(env, 'CAMPROXY_TOKENS');
  const tokens = (tokensRaw ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (!tokens.length && !(o.tokensOptional && !tokensRaw)) throw new SettingError('CAMPROXY_TOKENS: required');
  tokens.forEach((t, i) => {
    if (t.length < MIN_TOKEN) throw new SettingError(`CAMPROXY_TOKENS: token ${i + 1} is shorter than ${MIN_TOKEN} characters`);
  });
  const adminToken = read(env, 'CAMPROXY_ADMIN_TOKEN');
  if (!adminToken) throw new SettingError('CAMPROXY_ADMIN_TOKEN: required');
  if (adminToken.length < MIN_TOKEN) throw new SettingError(`CAMPROXY_ADMIN_TOKEN: shorter than ${MIN_TOKEN} characters`);
  if (tokens.includes(adminToken)) throw new SettingError('CAMPROXY_ADMIN_TOKEN: must differ from every client token');
  const cameraPasswords: Record<string, string> = {};
  // The environment wins over the stored password of a moved camera (S §9.3).
  // The file is read once, at the first camera without one in the environment.
  let stored: ((id: string) => string | undefined) | undefined;
  for (const id of cameraIds) {
    let own = read(env, cameraPasswordEnv(id));
    if (!own && o.dataDir) {
      try {
        own = (stored ??= cameraPasswordsNow(o.dataDir))(id);
      } catch (err) {
        throw new SettingError(`camera-passwords.json: ${(err as Error).message}`);
      }
    }
    if (own) cameraPasswords[id] = own;
  }
  const cameraPassword = read(env, 'CAMPROXY_CAMERA_PASSWORD') ?? '';
  const without = cameraIds.find((id) => !cameraPasswords[id] && !o.passwordFromMove?.includes(id));
  if (!cameraPassword && (without !== undefined || !cameraIds.length)) {
    throw new SettingError(without !== undefined ? `CAMPROXY_CAMERA_PASSWORD: required (${without} has no ${cameraPasswordEnv(without)})` : 'CAMPROXY_CAMERA_PASSWORD: required');
  }
  const ftpPassword = read(env, 'CAMPROXY_FTP_PASSWORD');
  if (ftpEnabled && !ftpPassword) throw new SettingError('CAMPROXY_FTP_PASSWORD: required when ftp.enabled');
  // The FTP server compares at most 256 bytes (src/clips/ftp-server.ts).
  if (ftpPassword && Buffer.byteLength(ftpPassword, 'utf8') > 256) throw new SettingError('CAMPROXY_FTP_PASSWORD: longer than 256 bytes');
  const auditToken = read(env, 'CAMPROXY_AUDIT_TOKEN');
  if (auditToken !== undefined) {
    if (auditToken.length < MIN_TOKEN || /\s/.test(auditToken)) throw new SettingError(`CAMPROXY_AUDIT_TOKEN: at least ${MIN_TOKEN} characters, no spaces`);
    if (auditToken === adminToken || tokens.includes(auditToken)) throw new SettingError('CAMPROXY_AUDIT_TOKEN: must differ from the admin and client tokens');
  }
  const googleVisionKey = read(env, 'CAMPROXY_GOOGLE_VISION_KEY');
  const poeSwitchPassword = read(env, 'CAMPROXY_POE_SWITCH_PASSWORD');
  const googleVisionUrl = env.CAMPROXY_GOOGLE_VISION_URL || 'https://vision.googleapis.com';
  if (!/^https?:\/\/[^\s]+$/.test(googleVisionUrl)) throw new SettingError('CAMPROXY_GOOGLE_VISION_URL: must be an http(s) URL');
  // The key travels in a header: http:// only to this machine (the test mock).
  if (/^http:/.test(googleVisionUrl) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(googleVisionUrl)) {
    throw new SettingError('CAMPROXY_GOOGLE_VISION_URL: http:// only for localhost; use https://');
  }
  return { tokens, adminToken, cameraPassword, cameraPasswords, ...(ftpPassword ? { ftpPassword } : {}), ...(auditToken ? { auditToken } : {}), ...(googleVisionKey ? { googleVisionKey } : {}), ...(poeSwitchPassword ? { poeSwitchPassword } : {}), googleVisionUrl: googleVisionUrl.replace(/\/+$/, '') };
}
