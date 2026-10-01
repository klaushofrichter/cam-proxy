import { readFileSync } from 'fs';
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

export function loadSecrets(env: NodeJS.ProcessEnv, ftpEnabled: boolean): Secrets {
  const tokensRaw = read(env, 'CAMPROXY_TOKENS');
  if (!tokensRaw) throw new SettingError('CAMPROXY_TOKENS: required');
  const tokens = tokensRaw.split(',').map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) throw new SettingError('CAMPROXY_TOKENS: required');
  tokens.forEach((t, i) => {
    if (t.length < MIN_TOKEN) throw new SettingError(`CAMPROXY_TOKENS: token ${i + 1} is shorter than ${MIN_TOKEN} characters`);
  });
  const adminToken = read(env, 'CAMPROXY_ADMIN_TOKEN');
  if (!adminToken) throw new SettingError('CAMPROXY_ADMIN_TOKEN: required');
  if (adminToken.length < MIN_TOKEN) throw new SettingError(`CAMPROXY_ADMIN_TOKEN: shorter than ${MIN_TOKEN} characters`);
  if (tokens.includes(adminToken)) throw new SettingError('CAMPROXY_ADMIN_TOKEN: must differ from every client token');
  const cameraPassword = read(env, 'CAMPROXY_CAMERA_PASSWORD');
  if (!cameraPassword) throw new SettingError('CAMPROXY_CAMERA_PASSWORD: required');
  const ftpPassword = read(env, 'CAMPROXY_FTP_PASSWORD');
  if (ftpEnabled && !ftpPassword) throw new SettingError('CAMPROXY_FTP_PASSWORD: required when ftp.enabled');
  const googleVisionKey = read(env, 'CAMPROXY_GOOGLE_VISION_KEY');
  const googleVisionUrl = env.CAMPROXY_GOOGLE_VISION_URL || 'https://vision.googleapis.com';
  if (!/^https?:\/\/[^\s]+$/.test(googleVisionUrl)) throw new SettingError('CAMPROXY_GOOGLE_VISION_URL: must be an http(s) URL');
  // The key travels in a header: http:// only to this machine (the test mock).
  if (/^http:/.test(googleVisionUrl) && !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(googleVisionUrl)) {
    throw new SettingError('CAMPROXY_GOOGLE_VISION_URL: http:// only for localhost; use https://');
  }
  return { tokens, adminToken, cameraPassword, ...(ftpPassword ? { ftpPassword } : {}), ...(googleVisionKey ? { googleVisionKey } : {}), googleVisionUrl: googleVisionUrl.replace(/\/+$/, '') };
}
