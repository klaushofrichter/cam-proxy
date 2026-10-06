import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, needsProcessRestart } from '../src/config/load';

const SECRETS = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'x' };
const load = (cfg: object) => {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-tlscfg-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ cameras: [{ id: 'cam3', host: '192.168.60.13' }], ...cfg }));
  return loadConfig(SECRETS, { cwd: dir });
};
const err = (cfg: object) => {
  try {
    load(cfg);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error('expected a ConfigError');
};

describe('TLS settings (spec §10.4)', () => {
  it('off by default: no site, HTTP only (the Pi)', () => {
    const c = load({}).config;
    expect(c.tls).toEqual({ cameraCerts: true });
    expect(c.server.tls).toEqual({});
  });
  it('a site needs the addresses its CA covers (Ruling P5-2)', () => {
    expect(err({ tls: { site: 'garage' } })).toBe('tls.cameraSubnet: required with tls.site');
    expect(err({ tls: { site: 'garage', cameraSubnet: '192.168.60.0/24' } })).toBe('tls.proxyAddresses: required with tls.site');
    expect(load({ tls: { site: 'garage', cameraSubnet: '192.168.60.0/24', proxyAddresses: '192.168.1.230,192.168.60.1' } }).config.tls.site).toBe('garage');
  });
  it('HTTPS needs a site; the settings need a new process', () => {
    expect(err({ server: { tls: { port: 8443 } } })).toBe('server.tls.port: needs tls.site (the proxy certificate comes from the site CA)');
    expect(err({ tls: { site: 'g', cameraSubnet: '192.168.60.0/24', proxyAddresses: '1.2.3.4' }, server: { port: 8480, tls: { port: 8480 } } })).toBe('server.tls.port: must differ from server.port');
    expect(needsProcessRestart('tls.site')).toBe(true);
    expect(needsProcessRestart('server.tls.port')).toBe(true);
    expect(needsProcessRestart('ntp.server')).toBe(false);
  });
  it('bad values', () => {
    expect(err({ tls: { site: 'Garage' } })).toBe('tls.site: has the wrong format');
    expect(err({ tls: { site: 'g', cameraSubnet: '192.168.60.0', proxyAddresses: '1.2.3.4' } })).toBe('tls.cameraSubnet: has the wrong format');
    expect(err({ tls: { site: 'g', cameraSubnet: '192.168.60.0/33', proxyAddresses: '1.2.3.4' } })).toBe('tls.cameraSubnet: 192.168.60.0/33 is not an IPv4 network');
    expect(err({ tls: { site: 'g', cameraSubnet: '192.168.60.5/24', proxyAddresses: '1.2.3.4' } })).toBe('tls.cameraSubnet: 192.168.60.5/24 is not an IPv4 network');
    // The CA vouches for every address in it: a wide range would defeat the name constraints.
    expect(err({ tls: { site: 'g', cameraSubnet: '10.0.0.0/8', proxyAddresses: '1.2.3.4' } })).toBe('tls.cameraSubnet: 10.0.0.0/8 is wider than /16');
    expect(err({ tls: { site: 'g', cameraSubnet: '192.168.60.0/24', proxyAddresses: '1.2.3.999' } })).toBe('tls.proxyAddresses: 1.2.3.999 is not an IPv4 address');
  });
});
