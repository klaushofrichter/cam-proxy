// The proxy profile (cams-admin spec 2026-10-25-proxy-profile-design §0, §1):
// profile.cameras (moves.maxCameras is its old name), name, storageGB,
// firewall; the derived FTP passive range, the warnings, the firewall lines.
// Documentation addresses (RFC 5737) only.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyOverrides, ConfigError, loadConfig, removeOverride } from '../src/config/load';
import { firewallLines, heldCameras, profileCameras, profileWarnings } from '../src/config/profile';
import { budgetOf } from '../src/storage';
import { classify } from '../src/fleet/remote-settable';
import { isLocalSetting } from '../src/api/auth';

const SECRETS = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'cam-pw', CAMPROXY_FTP_PASSWORD: 'f' };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camproxy-profile-'));
});
const write = (name: string, v: unknown) => {
  mkdirSync(join(dir, name, '..'), { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(v));
};
const load = () => loadConfig(SECRETS, { cwd: dir });
const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error('expected a ConfigError');
};
const cams = (n: number, ftp = false) => Array.from({ length: n }, (_, i) => ({ id: `cam${i + 3}`, host: `192.0.2.${i + 3}`, ...(ftp ? { ftp: { enabled: true } } : {}) }));

describe('the profile block', () => {
  it('defaults: nothing set, firewall ufw; cameras = the cameras held, at least 1', () => {
    write('config.json', { cameras: cams(2) });
    const l = load();
    expect(l.config.profile).toEqual({ firewall: 'ufw' });
    expect(heldCameras(l.config)).toBe(2);
    expect(profileCameras(l.config)).toBe(2);
    // A camera hidden after its move is not held.
    write('config.json', { cameras: [{ id: 'cam3', host: '192.0.2.3', moved: 'mv_0123456789ABCDEFGHJK' }] });
    expect(heldCameras(load().config)).toBe(0);
    expect(profileCameras(load().config)).toBe(1);
  });

  it('name, cameras, storageGB and firewall load and are checked', () => {
    write('config.json', { cameras: cams(1), profile: { name: 'een (N100, 1 TB)', cameras: 3, storageGB: 600, firewall: 'nft' } });
    expect(load().config.profile).toEqual({ name: 'een (N100, 1 TB)', cameras: 3, storageGB: 600, firewall: 'nft' });
    write('config.json', { cameras: cams(1), profile: { name: 'x'.repeat(61) } });
    expect(err(load)).toBe('profile.name: has the wrong format');
    write('config.json', { cameras: cams(1), profile: { cameras: 0 } });
    expect(err(load)).toBe('profile.cameras: must be from 1 to 64');
    write('config.json', { cameras: cams(1), profile: { storageGB: 100001 } });
    expect(err(load)).toBe('profile.storageGB: must be from 1 to 100000');
    write('config.json', { cameras: cams(1), profile: { firewall: 'iptables' } });
    expect(err(load)).toBe('profile.firewall: must be one of ufw, nft');
  });

  it('is local: cams-admin never sets it, nor a cams-admin sign-in', () => {
    for (const p of ['profile.cameras', 'profile.name', 'profile.storageGB', 'profile.firewall']) {
      expect(classify(p, ['cam3'])).toBe('denied');
      expect(isLocalSetting(p)).toBe(true);
    }
    expect(isLocalSetting('moves.maxCameras')).toBe(true);
  });
});

describe('moves.maxCameras: the old name of profile.cameras (one release)', () => {
  it('in config.json and in overrides.json it reads as profile.cameras', () => {
    write('config.json', { cameras: cams(1), moves: { maxCameras: 3 } });
    let l = load();
    expect(l.config.profile.cameras).toBe(3);
    expect(l.sources['profile.cameras']).toBe('file');
    expect((l.config as unknown as Record<string, unknown>).moves).toBeUndefined();
    write('config.json', { cameras: cams(1) });
    write('data/overrides.json', { moves: { maxCameras: 3 } });
    l = load();
    expect(l.config.profile.cameras).toBe(3);
    expect(l.sources['profile.cameras']).toBe('override');
    // The next save writes the new name.
    l = applyOverrides(l, { retention: { stillsDays: 8 } });
    expect(JSON.parse(readFileSync(join(dir, 'data', 'overrides.json'), 'utf8'))).toEqual({ profile: { cameras: 3 }, retention: { stillsDays: 8 } });
  });

  it('both set: equal is fine, different is a config error; a PUT and a reset take the old name too', () => {
    write('config.json', { cameras: cams(1), moves: { maxCameras: 3 }, profile: { cameras: 3 } });
    expect(load().config.profile.cameras).toBe(3);
    write('config.json', { cameras: cams(1), moves: { maxCameras: 3 }, profile: { cameras: 2 } });
    expect(err(load)).toBe('moves.maxCameras: 3, profile.cameras: 2; set profile.cameras only (moves.maxCameras is its old name)');
    write('config.json', { cameras: cams(1), moves: { maxCameras: 0 } });
    expect(err(load)).toBe('moves.maxCameras: must be from 1 to 64');
    write('config.json', { cameras: cams(1), moves: { other: 1 } });
    expect(err(load)).toBe('moves: unknown setting');
    write('config.json', { cameras: cams(1) });
    let l = applyOverrides(load(), { moves: { maxCameras: 4 } });
    expect(l.config.profile.cameras).toBe(4);
    l = removeOverride(l, 'moves.maxCameras');
    expect(l.config.profile.cameras).toBeUndefined();
  });
});

describe('the FTP passive range from the profile', () => {
  it('unset with FTP on: 30000 up, 10 ports per camera for max(profile.cameras, cameras held)', () => {
    write('config.json', { cameras: cams(1), profile: { cameras: 4 }, ftp: { enabled: true } });
    let l = load();
    expect(l.config.ftp.passive).toBe('30000-30039');
    expect(l.sources['ftp.passive']).toBe('default');
    // No profile: the cameras held (one camera: today's default).
    write('config.json', { cameras: cams(1), ftp: { enabled: true } });
    expect(load().config.ftp.passive).toBe('30000-30009');
    write('config.json', { cameras: cams(2, true), ftp: { enabled: true } });
    expect(load().config.ftp.passive).toBe('30000-30019');
    // A lower profile.cameras never shrinks it below the cameras held.
    write('config.json', { cameras: cams(3, true), profile: { cameras: 1 }, ftp: { enabled: true } });
    l = load();
    expect(l.config.ftp.passive).toBe('30000-30029');
    expect(profileWarnings(l.config)).toEqual(['profile_cameras_exceeded']);
    // An override of profile.cameras moves it with it.
    write('config.json', { cameras: cams(1), profile: { cameras: 2 }, ftp: { enabled: true } });
    expect(applyOverrides(load(), { profile: { cameras: 3 } }).config.ftp.passive).toBe('30000-30029');
  });

  it('with FTP on, profile.cameras goes up to 10 (100 ports); FTP off, up to 64 with the plain default', () => {
    write('config.json', { cameras: cams(1), profile: { cameras: 10 }, ftp: { enabled: true } });
    expect(load().config.ftp.passive).toBe('30000-30099');
    write('config.json', { cameras: cams(1), profile: { cameras: 11 }, ftp: { enabled: true } });
    expect(err(load)).toBe('profile.cameras: 11 cameras need 110 FTP passive ports (10 per camera); ftp.passive holds at most 100');
    write('config.json', { cameras: cams(1), profile: { cameras: 11 }, ftp: { enabled: true, passive: '40000-40099' } });
    expect(err(load)).toBe('profile.cameras: 11 cameras need 110 FTP passive ports (10 per camera); ftp.passive holds at most 100');
    write('config.json', { cameras: cams(1), profile: { cameras: 64 } });
    const l = load();
    expect(l.config.ftp.passive).toBe('30000-30009');
    expect(profileWarnings(l.config)).toEqual([]);
  });

  it('a range set by hand smaller than the profile needs loads, with the warning profile_ftp_ports', () => {
    write('config.json', { cameras: cams(1), profile: { cameras: 3 }, ftp: { enabled: true, passive: '40000-40019' } });
    let l = load();
    expect(l.config.ftp.passive).toBe('40000-40019');
    expect(profileWarnings(l.config)).toEqual(['profile_ftp_ports']);
    // As an override too.
    write('config.json', { cameras: cams(1), profile: { cameras: 3 }, ftp: { enabled: true } });
    l = applyOverrides(load(), { ftp: { passive: '40000-40009' } });
    expect(profileWarnings(l.config)).toEqual(['profile_ftp_ports']);
    // FTP off: no port needs.
    write('config.json', { cameras: cams(1), profile: { cameras: 3 }, ftp: { passive: '40000-40004' } });
    expect(profileWarnings(load().config)).toEqual([]);
  });

  it('10 ports per camera that has FTP stays a load error (cameras the proxy really runs)', () => {
    write('config.json', { cameras: cams(2, true), ftp: { enabled: true, passive: '40000-40009' } });
    expect(err(load)).toBe('ftp.passive: 10 ports for 2 cameras with FTP; at least 10 per camera');
  });

  it('profile_cameras_exceeded: more cameras held than profile.cameras; nothing removed', () => {
    write('config.json', { cameras: cams(3), profile: { cameras: 2 } });
    const l = load();
    expect(profileWarnings(l.config)).toEqual(['profile_cameras_exceeded']);
    expect(l.config.cameraOrder).toEqual(['cam3', 'cam4', 'cam5']);
    // Unset: never exceeded (the default is what it holds).
    write('config.json', { cameras: cams(3) });
    expect(profileWarnings(load().config)).toEqual([]);
  });
});

describe('profile.storageGB: the size budget', () => {
  it('replaces storage.maxBytes; both set is a config error; maxPercent still limits', () => {
    write('config.json', { cameras: cams(1), profile: { storageGB: 600 }, storage: { maxBytes: 10 ** 12 } });
    expect(err(load)).toBe('profile.storageGB: set either profile.storageGB or storage.maxBytes, not both');
    write('config.json', { cameras: cams(1), profile: { storageGB: 600 } });
    const c = load().config;
    expect(c.storage.maxPercent).toBe(85);
    // 600 GB of a 1 TB disk: 600 GB; of a 500 GB disk: 85 % of it.
    expect(budgetOf(c, 10 ** 12)).toBe(600 * 10 ** 9);
    expect(budgetOf(c, 500 * 10 ** 9)).toBe(425 * 10 ** 9);
    // Without it: as today.
    write('config.json', { cameras: cams(1) });
    expect(budgetOf(load().config, 10 ** 12)).toBe(850 * 10 ** 9);
    write('config.json', { cameras: cams(1), storage: { maxBytes: 5 * 10 ** 9 } });
    expect(budgetOf(load().config, 10 ** 12)).toBe(5 * 10 ** 9);
  });
});

describe('firewall lines for each camera with FTP', () => {
  it('ufw (default): the FTP port and the passive range from the camera address', () => {
    write('config.json', { cameras: [...cams(2, true), { id: 'cam9', host: '192.0.2.9' }], profile: { cameras: 3 }, ftp: { enabled: false } });
    expect(firewallLines(load().config)).toEqual([
      'sudo ufw allow from 192.0.2.3 to any port 2121 proto tcp',
      'sudo ufw allow from 192.0.2.3 to any port 30000:30029 proto tcp',
      'sudo ufw allow from 192.0.2.4 to any port 2121 proto tcp',
      'sudo ufw allow from 192.0.2.4 to any port 30000:30029 proto tcp',
    ]);
  });
  it('nft; a camera without an IPv4 address, hidden or without FTP gets none', () => {
    write('config.json', { cameras: [{ id: 'cam3', host: '192.0.2.3:443', ftp: { enabled: true } }, { id: 'cam4', host: 'cam4.example.net', ftp: { enabled: true, user: 'c4' } }, { id: 'cam5', host: '192.0.2.5', ftp: { enabled: true, user: 'c5' }, moved: 'mv_0123456789ABCDEFGHJK' }], profile: { firewall: 'nft' }, ftp: { port: 2100, passive: '30000-30029' } });
    expect(firewallLines(load().config)).toEqual([
      'sudo nft add rule inet filter input ip saddr 192.0.2.3 tcp dport 2100 accept',
      'sudo nft add rule inet filter input ip saddr 192.0.2.3 tcp dport 30000-30029 accept',
    ]);
  });
});

// The production shapes (2026-10-25) load unchanged. Addresses are documentation ones.
describe('the production configs keep loading', () => {
  const site = { site: 'home', cameraSubnet: '192.0.2.0/24', proxyAddresses: '192.0.2.200' };
  it('een: overrides ftp.passive 30000-30029 and moves.maxCameras 3', () => {
    write('config.json', { cameras: [{ id: 'cam4', host: '192.0.2.4', ftp: { enabled: true } }], ftp: { enabled: true, publicHost: '192.0.2.200' }, tls: site });
    write('data/overrides.json', { ftp: { passive: '30000-30029' }, moves: { maxCameras: 3 } });
    const c = load().config;
    expect(c.ftp.passive).toBe('30000-30029');
    expect(c.profile.cameras).toBe(3);
    expect(profileWarnings(c)).toEqual([]);
  });
  it('mini PC: override ftp.passive 30000-30019, no maxCameras', () => {
    write('config.json', { cameras: cams(2, true), ftp: { enabled: true, publicHost: '192.0.2.201' }, tls: site, profile: undefined });
    write('data/overrides.json', { ftp: { passive: '30000-30019' } });
    const c = load().config;
    expect(c.ftp.passive).toBe('30000-30019');
    expect(c.profile.cameras).toBeUndefined();
    expect(profileCameras(c)).toBe(2);
    expect(profileWarnings(c)).toEqual([]);
  });
  it('mini PC with profile.cameras 3 later: loads and warns (profile_ftp_ports)', () => {
    write('config.json', { cameras: cams(2, true), ftp: { enabled: true, publicHost: '192.0.2.201' }, tls: site });
    write('data/overrides.json', { ftp: { passive: '30000-30019' }, profile: { cameras: 3 } });
    expect(profileWarnings(load().config)).toEqual(['profile_ftp_ports']);
  });
  it('the Pi: a legacy camera, config.json ftp.passive 30000-30009', () => {
    write('config.json', { camera: { id: 'cam1', host: '192.0.2.103', protocol: 'https', tlsName: 'cam1.example.net' }, ftp: { enabled: true, user: 'camera', publicHost: '192.0.2.220', passive: '30000-30009' } });
    const c = load().config;
    expect(c.ftp.passive).toBe('30000-30009');
    expect(profileCameras(c)).toBe(1);
    expect(profileWarnings(c)).toEqual([]);
  });
  it('the cluster: deploy/cluster/config.json as it is', () => {
    const file = join(__dirname, '..', 'deploy', 'cluster', 'config.json');
    const l = loadConfig({ ...SECRETS, CAMPROXY_CONFIG: file }, { cwd: dir });
    expect(l.config.ftp.passive).toBe('30000-30009');
    expect(l.config.profile).toEqual({ firewall: 'ufw' });
    expect(profileWarnings(l.config)).toEqual([]);
  });
});
