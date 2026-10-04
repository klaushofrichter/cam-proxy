import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULTS } from '../src/config/defaults';
import { checkPartial, SettingError } from '../src/config/schema';
import { loadSecrets } from '../src/config/secrets';
import { maskKey, PROVIDERS } from '../src/analytics/providers';

const env = { CAMPROXY_TOKENS: 'c'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'a'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'pw' };

describe('analytics settings', () => {
  it('default to no calls: disabled, limit 0, person only', () => {
    expect(DEFAULTS.analytics).toEqual({
      kinds: { person: true, vehicle: false, pet: false },
      googleVision: { enabled: false, monthlyLimit: 0, dailyCap: 0, checksPerDay: 10 },
    });
  });

  it('accept valid values', () => {
    expect(() => checkPartial({ analytics: { kinds: { vehicle: true }, googleVision: { enabled: true, monthlyLimit: 1000, dailyCap: 50, checksPerDay: 0 } } })).not.toThrow();
    expect(() => checkPartial({ analytics: { googleVision: { checksPerDay: 1000 } } })).not.toThrow();
  });

  it.each([
    [{ analytics: { kinds: { motion: true } } }, 'analytics.kinds.motion: unknown setting'],
    [{ analytics: { googleVision: { monthlyLimit: -1 } } }, 'analytics.googleVision.monthlyLimit: must be from 0 to 100000'],
    [{ analytics: { googleVision: { dailyCap: 10001 } } }, 'analytics.googleVision.dailyCap: must be from 0 to 10000'],
    [{ analytics: { googleVision: { checksPerDay: 1001 } } }, 'analytics.googleVision.checksPerDay: must be from 0 to 1000'],
    [{ analytics: { googleVision: { checksPerDay: -1 } } }, 'analytics.googleVision.checksPerDay: must be from 0 to 1000'],
    [{ analytics: { googleVision: { enabled: 'yes' } } }, 'analytics.googleVision.enabled: must be true or false'],
    [{ analytics: { roboflow: {} } }, 'analytics.roboflow: unknown setting'],
  ])('reject %j', (obj, message) => {
    expect(() => checkPartial(obj)).toThrow(new SettingError(message));
  });
});

describe('the Vision key and URL', () => {
  it('come from the environment, with Google as the default URL', () => {
    expect(loadSecrets(env, false)).toMatchObject({ googleVisionUrl: 'https://vision.googleapis.com' });
    expect(loadSecrets(env, false).googleVisionKey).toBeUndefined();
    const s = loadSecrets({ ...env, CAMPROXY_GOOGLE_VISION_KEY: 'AIzaSyExample1234x7Qk', CAMPROXY_GOOGLE_VISION_URL: 'http://127.0.0.1:9' }, false);
    expect(s.googleVisionKey).toBe('AIzaSyExample1234x7Qk');
    expect(s.googleVisionUrl).toBe('http://127.0.0.1:9');
  });

  it('reject a URL that is not http(s), without echoing it', () => {
    expect(() => loadSecrets({ ...env, CAMPROXY_GOOGLE_VISION_URL: 'ftp://x' }, false)).toThrow('CAMPROXY_GOOGLE_VISION_URL: must be an http(s) URL');
  });

  // Issue #52: the key header would cross the network in clear text.
  it('accept http:// only for this machine (a test mock), https:// anywhere', () => {
    for (const url of ['http://vision.example.com', 'http://10.0.0.5:8080', 'http://127.0.0.1.example.com']) {
      expect(() => loadSecrets({ ...env, CAMPROXY_GOOGLE_VISION_URL: url }, false)).toThrow('CAMPROXY_GOOGLE_VISION_URL: http:// only for localhost; use https://');
    }
    for (const url of ['http://127.0.0.1:18600', 'http://localhost:9', 'http://[::1]:9', 'https://vision.example.com']) {
      expect(loadSecrets({ ...env, CAMPROXY_GOOGLE_VISION_URL: url }, false).googleVisionUrl).toBe(url);
    }
  });

  it('drop trailing slashes from the URL', () => {
    expect(loadSecrets({ ...env, CAMPROXY_GOOGLE_VISION_URL: 'https://vision.example.com//' }, false).googleVisionUrl).toBe('https://vision.example.com');
  });

  it('read the key from CAMPROXY_GOOGLE_VISION_KEY_FILE, which wins', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'camproxy-key-')), 'key');
    writeFileSync(file, 'k-from-file-0000\n');
    expect(loadSecrets({ ...env, CAMPROXY_GOOGLE_VISION_KEY: 'k-from-env-0000', CAMPROXY_GOOGLE_VISION_KEY_FILE: file }, false).googleVisionKey).toBe('k-from-file-0000');
  });

  it('are masked: first and last four characters', () => {
    expect(maskKey('AIzaSyExample1234x7Qk')).toBe('AIza…x7Qk');
    expect(maskKey('short')).toBe('set');
    expect(maskKey('12345678901')).toBe('set'); // 11: too short to show 8 of
    expect(maskKey('123456789012')).toBe('1234…9012');
    expect(maskKey(undefined)).toBeNull();
  });

  it('name the provider list', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['google-vision']);
  });
});
