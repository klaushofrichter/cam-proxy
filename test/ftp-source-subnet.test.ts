import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ftpUsers } from '../src/clips/side';
import { ConfigError, loadConfig } from '../src/config/load';
import { NEVER_FROM_CAMS_ADMIN } from '../src/fleet/remote-settable';
import { inCidr } from '../src/util/cidr';

const SECRETS = { CAMPROXY_TOKENS: 'c'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'a'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'p'.repeat(12), CAMPROXY_FTP_PASSWORD: 'f'.repeat(24) };
const load = (cfg: object) => {
  const cwd = mkdtempSync(join(tmpdir(), 'camproxy-ftpsrc-'));
  writeFileSync(join(cwd, 'config.json'), JSON.stringify(cfg));
  return loadConfig(SECRETS, { cwd });
};
const err = (cfg: object) => {
  try {
    load(cfg);
  } catch (e) {
    if (e instanceof ConfigError) return e.message;
    throw e;
  }
  return null;
};
const CAM = { camera: { id: 'cam2', name: 'cam2', host: '10.43.61.52:443', protocol: 'https', user: 'proxy', onvifPort: 8000, rtspPort: 554, statusPollS: 30 } };

describe('ftp.sourceSubnet', () => {
  it('replaces the camera-address match: every camera user logs in from the subnet', () => {
    expect([...ftpUsers(load({ ...CAM, ftp: { enabled: true } }).config)]).toEqual([['camera', { cam: 'cam2', ip: '10.43.61.52' }]]);
    expect([...ftpUsers(load({ ...CAM, ftp: { enabled: true, sourceSubnet: '10.42.0.0/16' } }).config)]).toEqual([['camera', { cam: 'cam2', subnet: '10.42.0.0/16' }]]);
  });
  it('must be an IPv4 network, /16 or narrower', () => {
    expect(err({ ...CAM, ftp: { sourceSubnet: '10.42.0.0' } })).toBe('ftp.sourceSubnet: has the wrong format');
    expect(err({ ...CAM, ftp: { sourceSubnet: '10.42.0.5/16' } })).toBe('ftp.sourceSubnet: 10.42.0.5/16 is not an IPv4 network');
    expect(err({ ...CAM, ftp: { sourceSubnet: '10.0.0.0/8' } })).toBe('ftp.sourceSubnet: 10.0.0.0/8 is wider than /16');
  });
  it('is never set from cams-admin: it widens who may log in', () => {
    expect(NEVER_FROM_CAMS_ADMIN).toContain('ftp.sourceSubnet');
  });
  it('inCidr', () => {
    expect(inCidr('10.42.0.89', '10.42.0.0/16')).toBe(true);
    expect(inCidr('10.43.61.52', '10.42.0.0/16')).toBe(false);
    expect(inCidr('10.43.61.52', '10.43.61.52/32')).toBe(true);
    expect(inCidr('::ffff:10.42.0.89', '10.42.0.0/16')).toBe(true);
    expect(inCidr('nonsense', '10.42.0.0/16')).toBe(false);
  });
});
