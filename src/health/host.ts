import { existsSync, readdirSync, readFileSync, statfsSync } from 'fs';
import { join } from 'path';

// The host figures for the health summary (spec 2026-10-03-health-summary-design
// A1). cam-proxy also runs in the cluster, so every figure is optional: one
// that can't be read is null. File reads only, no shell-outs.
//
// The data volume (statfs of the data folder) is the proxy's own storage and
// is read everywhere. The rest describes the host only on the Pi, where the
// container runs with network_mode: host and sees the host's /proc and /sys
// (checked 2026-10-03); in a pod, meminfo, uptime and load would describe the
// node, so they are read only while host.stats is on (auto: on a Pi).

// Where /proc and /sys are: '/' in production, a fixture tree in tests.
export interface HostPaths { root: string }
export interface Platform { pi: boolean; model: string | null }
export interface HostStats {
  cpuTempC: number | null; // hwmon cpu_thermal temp1_input, one decimal
  underVoltage: boolean | null; // hwmon rpi_volt in0_lcrit_alarm
  memory: { totalBytes: number; availableBytes: number; usedPercent: number } | null;
  uptimeS: number | null;
  load: { m1: number; m5: number; m15: number } | null;
}
export interface DataVolume { sizeBytes: number; freeBytes: number; usedBytes: number; usedPercent: number }
export type StatFs = (dir: string) => { bsize: number; blocks: number; bfree: number; bavail: number };
export type HostStatsSetting = 'auto' | 'on' | 'off';
export interface HostReading { platform: Platform & { hostStats: boolean }; disk: DataVolume | null; host: HostStats | null }

export const HOST_EVERY_MS = 60_000;

const oneDecimal = (n: number) => Math.round(n * 10) / 10;

function readAt(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
const read = (p: HostPaths, ...parts: string[]) => readAt(join(p.root, ...parts));

// A Raspberry Pi by the `Model : Raspberry Pi …` line of /proc/cpuinfo
// (visible in the container; /proc/device-tree is not).
export function detectPlatform(p: HostPaths): Platform {
  const m = /^Model\s*:\s*(Raspberry Pi.*?)\s*$/m.exec(read(p, 'proc', 'cpuinfo') ?? '');
  return m ? { pi: true, model: m[1] } : { pi: false, model: null };
}

export function hostStatsOn(setting: HostStatsSetting, platform: Platform): boolean {
  return setting === 'on' || (setting === 'auto' && platform.pi);
}

// The hwmon sensors by their `name` file (cpu_thermal, rpi_volt): the
// numbers (hwmon0, hwmon1) depend on the probe order and are never used.
export function hwmonByName(p: HostPaths): Map<string, string> {
  const out = new Map<string, string>();
  const base = join(p.root, 'sys', 'class', 'hwmon');
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return out;
  }
  for (const e of entries.sort()) {
    const name = readAt(join(base, e, 'name'))?.trim();
    if (name && !out.has(name)) out.set(name, join(base, e));
  }
  return out;
}

const intOf = (text: string | null): number | null => {
  const t = text?.trim();
  return t && /^-?\d+$/.test(t) ? Number(t) : null;
};

export function readHostStats(p: HostPaths): HostStats {
  const hw = hwmonByName(p);
  const sensor = (name: string, file: string) => {
    const dir = hw.get(name);
    return dir ? intOf(readAt(join(dir, file))) : null;
  };
  const milli = sensor('cpu_thermal', 'temp1_input');
  const alarm = sensor('rpi_volt', 'in0_lcrit_alarm');

  let memory: HostStats['memory'] = null;
  const mem = read(p, 'proc', 'meminfo') ?? '';
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(mem);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  if (total && available !== null) memory = { totalBytes: total, availableBytes: available, usedPercent: oneDecimal(((total - available) / total) * 100) };

  const up = /^(\d+(?:\.\d+)?)\s/.exec(read(p, 'proc', 'uptime') ?? '');
  const ld = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)\s/.exec(read(p, 'proc', 'loadavg') ?? '');
  return {
    cpuTempC: milli === null ? null : oneDecimal(milli / 1000),
    underVoltage: alarm === 0 ? false : alarm === 1 ? true : null,
    memory,
    uptimeS: up ? Math.floor(Number(up[1])) : null,
    load: ld ? { m1: Number(ld[1]), m5: Number(ld[2]), m15: Number(ld[3]) } : null,
  };
}

// statfs of the data folder, or of its parent before it exists.
export const realStatfs: StatFs = (dir) => statfsSync(existsSync(dir) ? dir : join(dir, '..'));

// The data folder's volume as df shows it: free is what the proxy can still
// write (bavail), used is size minus all free blocks, and Use% is
// used / (used + available), one decimal.
export function dataVolume(dir: string, statfs: StatFs = realStatfs): DataVolume | null {
  try {
    const s = statfs(dir);
    const usedBlocks = s.blocks - s.bfree;
    if (s.blocks <= 0 || usedBlocks + s.bavail <= 0) return null;
    return {
      sizeBytes: s.blocks * s.bsize,
      freeBytes: s.bavail * s.bsize,
      usedBytes: usedBlocks * s.bsize,
      usedPercent: oneDecimal((usedBlocks / (usedBlocks + s.bavail)) * 100),
    };
  } catch {
    return null;
  }
}

// Reads the figures at start and once a minute; the summary uses the last reading.
export class HostMonitor {
  private last: HostReading | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly d: {
      paths: HostPaths;
      dataDir: () => string;
      setting: () => HostStatsSetting;
      statfs?: StatFs;
      everyMs?: number;
    },
  ) {}

  refresh(): HostReading {
    const platform = detectPlatform(this.d.paths);
    const on = hostStatsOn(this.d.setting(), platform);
    this.last = {
      platform: { ...platform, hostStats: on },
      disk: dataVolume(this.d.dataDir(), this.d.statfs),
      host: on ? readHostStats(this.d.paths) : null,
    };
    return this.last;
  }

  // The last reading; a changed host.stats takes effect at once.
  reading(): HostReading {
    const r = this.last;
    if (!r) return this.refresh();
    const on = hostStatsOn(this.d.setting(), r.platform);
    return on === r.platform.hostStats ? r : this.refresh();
  }

  start(): void {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.d.everyMs ?? HOST_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
