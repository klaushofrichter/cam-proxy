// The profile report (cams-admin spec 2026-10-25-proxy-profile-design §2):
// GET /control/profile and the heartbeat's `profile`, on the vendored strict
// contract. Documentation addresses (RFC 5737) only.
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load';
import { osHardware, profileReport, type ProfileFacts } from '../src/health/profile';
import { buildHeartbeat, type HeartbeatProxyInfo } from '../src/fleet/heartbeat';
import { buildEnvelope } from '../src/fleet/protocol';
import { buildHealth } from '../src/health/summary';
import { input, NOW } from './helpers/health-input';
import { strict, why } from './helpers/contract';

const SECRETS = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'x', CAMPROXY_FTP_PASSWORD: 'f' };
const config = (file: object) => {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-profile-report-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(file));
  return loadConfig(SECRETS, { cwd: dir }).config;
};
const FACTS: ProfileFacts = {
  storage: { budgetBytes: 600e9, usedBytes: 41e9, diskBytes: 1e12, freeBytes: 880e9 },
  platform: { pi: false, model: null },
  cpuTempC: 48.5,
};
const HW = { cpuCores: 4, cpuModel: 'Intel N100', memoryBytes: 16e9, load5: 0.7 };
const PI_INFO: HeartbeatProxyInfo = { startedAt: NOW - 3600_000, uptimeS: 3600, configSchema: 3, tls: null, publicUrl: null };
const valid = (body: object) => {
  const v = strict('heartbeat');
  const ok = v(buildEnvelope('heartbeat', 2, body as Record<string, unknown>, { now: NOW }));
  return { ok, why: why(v) };
};

describe('the profile report', () => {
  it('een: set, FTP on, firewall lines; on the strict heartbeat', () => {
    const c = config({ cameras: [{ id: 'cam4', host: '192.0.2.85', ftp: { enabled: true } }], ftp: { enabled: true, passive: '30000-30029' }, profile: { name: 'een (N100, 1 TB)', cameras: 3, storageGB: 600 } });
    const p = profileReport(c, FACTS, HW);
    expect(p).toEqual({
      set: true, name: 'een (N100, 1 TB)', cameras: 3, storageGB: 600, held: 1,
      ftp: { enabled: true, port: 2121, passive: { from: 30000, to: 30029 } },
      storage: { budgetBytes: 600e9, usedBytes: 41e9, diskBytes: 1e12, freeBytes: 880e9 },
      hardware: { pi: null, cpuCores: 4, cpuModel: 'Intel N100', memoryBytes: 16e9, load5: 0.7, cpuTempC: 48.5 },
      warnings: [],
      firewall: { tool: 'ufw', lines: ['sudo ufw allow from 192.0.2.85 to any port 2121 proto tcp', 'sudo ufw allow from 192.0.2.85 to any port 30000:30029 proto tcp'] },
    });
    const hb = buildHeartbeat(buildHealth(input()), PI_INFO, undefined, p);
    expect(hb.body.profile).toEqual(p);
    const r = valid(hb.body);
    expect(r.ok, r.why).toBe(true);
  });

  it('unset (the defaults), FTP off, the Pi; facts that could not be read are null', () => {
    const c = config({ camera: { id: 'cam1', host: '192.0.2.103' } });
    const p = profileReport(c, { storage: { budgetBytes: null, usedBytes: null, diskBytes: null, freeBytes: null }, platform: { pi: true, model: 'Raspberry Pi 4 Model B Rev 1.5' }, cpuTempC: null }, { ...HW, cpuModel: null });
    expect(p).toMatchObject({ set: false, name: null, cameras: 1, storageGB: null, held: 1, ftp: { enabled: false, port: 2121, passive: null }, hardware: { pi: 'Raspberry Pi 4 Model B Rev 1.5', cpuModel: null, cpuTempC: null }, warnings: [], firewall: { tool: 'ufw', lines: [] } });
    const r = valid(buildHeartbeat(buildHealth(input()), PI_INFO, undefined, p).body);
    expect(r.ok, r.why).toBe(true);
  });

  it('warnings and clamps to the contract bounds', () => {
    const c = config({ cameras: [{ id: 'cam3', host: '192.0.2.3', ftp: { enabled: true } }, { id: 'cam4', host: '192.0.2.4' }, { id: 'cam5', host: '192.0.2.5' }], ftp: { passive: '30000-30019' }, profile: { cameras: 2 } });
    const p = profileReport(c, FACTS, { cpuCores: 0, cpuModel: `  ${'Very Long CPU '.repeat(10)}`, memoryBytes: -1, load5: -0.5 });
    expect(p.warnings).toEqual(['profile_ftp_ports', 'profile_cameras_exceeded']);
    expect(p.hardware.cpuCores).toBe(1);
    expect(p.hardware.cpuModel!.length).toBeLessThanOrEqual(100);
    expect(p.hardware.cpuModel!.startsWith('Very Long CPU Very')).toBe(true);
    expect(p.hardware.memoryBytes).toBe(0);
    expect(p.hardware.load5).toBe(0);
    const r = valid(buildHeartbeat(buildHealth(input()), PI_INFO, undefined, p).body);
    expect(r.ok, r.why).toBe(true);
  });

  it("the host's figures from Node's os module", () => {
    const hw = osHardware();
    expect(hw.cpuCores).toBeGreaterThanOrEqual(1);
    expect(hw.memoryBytes).toBeGreaterThan(0);
    expect(hw.load5).toBeGreaterThanOrEqual(0);
  });

  it('a heartbeat without a profile stays as before (no profile key)', () => {
    const hb = buildHeartbeat(buildHealth(input()), PI_INFO);
    expect(hb.body).not.toHaveProperty('profile');
  });
});
