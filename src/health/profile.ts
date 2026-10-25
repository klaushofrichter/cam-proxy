import { availableParallelism, cpus, loadavg, totalmem } from 'os';
import type { Config } from '../config/defaults';
import { firewallLines, ftpOn, heldCameras, passiveRange, profileCameras, profileSet, profileWarnings, type ProfileWarning } from '../config/profile';

// The profile report (cams-admin spec 2026-10-25-proxy-profile-design §2):
// GET /control/profile and the heartbeat's `profile` (contract v1, strict:
// closed objects, every field required). The firewall lines hold camera
// addresses: never logged.
export interface ProfileReport {
  set: boolean;
  name: string | null;
  cameras: number;
  storageGB: number | null;
  held: number;
  ftp: { enabled: boolean; port: number; passive: { from: number; to: number } | null };
  storage: { budgetBytes: number | null; usedBytes: number | null; diskBytes: number | null; freeBytes: number | null };
  hardware: { pi: string | null; cpuCores: number; cpuModel: string | null; memoryBytes: number; load5: number; cpuTempC: number | null };
  warnings: ProfileWarning[];
  firewall: { tool: 'ufw' | 'nft'; lines: string[] };
}

// What the proxy reads elsewhere: the storage figures (storage.usage()), the
// platform and the CPU temperature (the host monitor: a Pi, or host.stats on).
export interface ProfileFacts {
  storage: ProfileReport['storage'];
  platform: { pi: boolean; model: string | null };
  cpuTempC: number | null;
}
export interface Hardware { cpuCores: number; cpuModel: string | null; memoryBytes: number; load5: number }

// The host as cam-proxy sees it (§2 "my call"): Node's os module on every
// host. With Docker's host networking that is the host; in a pod, the node.
export function osHardware(): Hardware {
  const list = cpus();
  return { cpuCores: availableParallelism(), cpuModel: list[0]?.model ?? null, memoryBytes: totalmem(), load5: loadavg()[1] };
}

const clampInt = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number.isFinite(n) ? n : min)));
const bytes = (n: number | null) => (n === null || !Number.isFinite(n) ? null : Math.max(0, Math.floor(n)));

export function profileReport(c: Config, facts: ProfileFacts, hw: Hardware = osHardware()): ProfileReport {
  const on = ftpOn(c);
  const model = hw.cpuModel?.replace(/\s+/g, ' ').trim().slice(0, 100).trim() || null;
  return {
    set: profileSet(c),
    name: c.profile.name ?? null,
    cameras: clampInt(profileCameras(c), 1, 64),
    storageGB: c.profile.storageGB ?? null,
    held: clampInt(heldCameras(c), 0, 64),
    ftp: { enabled: on, port: c.ftp.port, passive: on ? passiveRange(c.ftp.passive) : null },
    storage: { budgetBytes: bytes(facts.storage.budgetBytes), usedBytes: bytes(facts.storage.usedBytes), diskBytes: bytes(facts.storage.diskBytes), freeBytes: bytes(facts.storage.freeBytes) },
    hardware: {
      pi: facts.platform.pi ? (facts.platform.model ?? 'Raspberry Pi').slice(0, 200) : null,
      cpuCores: clampInt(hw.cpuCores, 1, 1024),
      cpuModel: model,
      memoryBytes: Math.max(0, Math.floor(Number.isFinite(hw.memoryBytes) ? hw.memoryBytes : 0)),
      load5: Number.isFinite(hw.load5) ? Math.max(0, Math.round(hw.load5 * 100) / 100) : 0,
      cpuTempC: facts.cpuTempC !== null && Number.isFinite(facts.cpuTempC) ? facts.cpuTempC : null,
    },
    warnings: profileWarnings(c),
    firewall: { tool: c.profile.firewall, lines: firewallLines(c).map((l) => l.slice(0, 200)) },
  };
}
