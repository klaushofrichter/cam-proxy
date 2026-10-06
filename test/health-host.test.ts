import { describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { dataVolume, detectPlatform, hostStatsOn, HostMonitor, hwmonByName, readHostStats, type StatFs } from '../src/health/host';

// Spec 2026-10-03-health-summary-design A1: the host figures from /proc and
// /sys, read from a root that tests point at a fixture tree.
const FIX = join(__dirname, 'fixtures', 'host');
const PI = { root: join(FIX, 'pi') };
const LINUX = { root: join(FIX, 'linux') };
const NONE = { root: join(FIX, 'does-not-exist') };
const copyOfPi = () => {
  const root = mkdtempSync(join(tmpdir(), 'camproxy-host-'));
  cpSync(PI.root, root, { recursive: true });
  return { root };
};

describe('platform', () => {
  it('a Raspberry Pi by its cpuinfo Model line', () => {
    expect(detectPlatform(PI)).toEqual({ pi: true, model: 'Raspberry Pi 4 Model B Rev 1.5' });
  });
  it('another Linux host, or no /proc at all (macOS), is no Pi', () => {
    expect(detectPlatform(LINUX)).toEqual({ pi: false, model: null });
    expect(detectPlatform(NONE)).toEqual({ pi: false, model: null });
  });
  it('a Model line that is not a Raspberry Pi is no Pi', () => {
    const p = copyOfPi();
    writeFileSync(join(p.root, 'proc', 'cpuinfo'), 'processor\t: 0\nModel\t\t: Some Board\n');
    expect(detectPlatform(p)).toEqual({ pi: false, model: null });
  });
  it('host stats: auto on a Pi only, on and off as set', () => {
    const pi = { pi: true, model: 'x' };
    const other = { pi: false, model: null };
    expect(hostStatsOn('auto', pi)).toBe(true);
    expect(hostStatsOn('auto', other)).toBe(false);
    expect(hostStatsOn('on', other)).toBe(true);
    expect(hostStatsOn('off', pi)).toBe(false);
  });
});

describe('hwmon', () => {
  it('finds the sensors by name, whatever their number', () => {
    const m = hwmonByName(PI);
    expect(m.get('cpu_thermal')).toBe(join(PI.root, 'sys', 'class', 'hwmon', 'hwmon1'));
    expect(m.get('rpi_volt')).toBe(join(PI.root, 'sys', 'class', 'hwmon', 'hwmon0'));
    expect(hwmonByName(LINUX).size).toBe(0);
  });
  it('renumbered sensors are still found', () => {
    const p = copyOfPi();
    const h = join(p.root, 'sys', 'class', 'hwmon');
    cpSync(join(h, 'hwmon1'), join(h, 'hwmon7'), { recursive: true });
    rmSync(join(h, 'hwmon1'), { recursive: true });
    writeFileSync(join(h, 'hwmon7', 'temp1_input'), '61234\n');
    expect(readHostStats(p).cpuTempC).toBe(61.2);
  });
});

describe('host stats', () => {
  it('the Pi: temperature, under-voltage, memory, uptime, load', () => {
    expect(readHostStats(PI)).toEqual({
      cpuTempC: 53.6,
      underVoltage: false,
      memory: { totalBytes: 3930680 * 1024, availableBytes: 3354624 * 1024, usedPercent: 14.7 },
      uptimeS: 412233,
      load: { m1: 0.42, m5: 0.38, m15: 0.35 },
    });
  });
  it('under-voltage when the alarm is set', () => {
    const p = copyOfPi();
    writeFileSync(join(p.root, 'sys', 'class', 'hwmon', 'hwmon0', 'in0_lcrit_alarm'), '1\n');
    expect(readHostStats(p).underVoltage).toBe(true);
  });
  it('without the sensors: null temperature and under-voltage, the rest read', () => {
    const s = readHostStats(LINUX);
    expect(s.cpuTempC).toBeNull();
    expect(s.underVoltage).toBeNull();
    expect(s.memory).toEqual({ totalBytes: 16384000 * 1024, availableBytes: 8192000 * 1024, usedPercent: 50 });
    expect(s.uptimeS).toBe(1000);
    expect(s.load).toEqual({ m1: 1.5, m5: 1.2, m15: 1 });
  });
  it('missing or garbled files are null, never an error', () => {
    expect(readHostStats(NONE)).toEqual({ cpuTempC: null, underVoltage: null, memory: null, uptimeS: null, load: null });
    const p = copyOfPi();
    writeFileSync(join(p.root, 'proc', 'meminfo'), 'MemTotal: lots\n');
    writeFileSync(join(p.root, 'proc', 'uptime'), 'soon\n');
    writeFileSync(join(p.root, 'proc', 'loadavg'), '\n');
    writeFileSync(join(p.root, 'sys', 'class', 'hwmon', 'hwmon1', 'temp1_input'), 'hot\n');
    writeFileSync(join(p.root, 'sys', 'class', 'hwmon', 'hwmon0', 'in0_lcrit_alarm'), 'x\n');
    expect(readHostStats(p)).toEqual({ cpuTempC: null, underVoltage: null, memory: null, uptimeS: null, load: null });
  });
});

describe('data volume', () => {
  const fs = (o: Partial<ReturnType<StatFs>> = {}): StatFs => () => ({ bsize: 4096, blocks: 1000, bfree: 300, bavail: 250, ...o });
  it("df's Use%: used / (used + available), one decimal", () => {
    // used 700 blocks, available 250: 73.68 %
    expect(dataVolume('/data', fs())).toEqual({ sizeBytes: 4096000, freeBytes: 1024000, usedBytes: 2867200, usedPercent: 73.7 });
  });
  it('null when statfs fails or the volume is empty', () => {
    expect(dataVolume('/data', () => { throw new Error('ENOENT'); })).toBeNull();
    expect(dataVolume('/data', fs({ blocks: 0, bfree: 0, bavail: 0 }))).toBeNull();
  });
  it('the real statfs of an existing folder', () => {
    const v = dataVolume(tmpdir());
    expect(v?.sizeBytes).toBeGreaterThan(0);
    expect(v?.usedPercent).toBeGreaterThanOrEqual(0);
    expect(v?.usedPercent).toBeLessThanOrEqual(100);
  });
});

describe('HostMonitor', () => {
  const statfs: StatFs = () => ({ bsize: 1024, blocks: 100, bfree: 50, bavail: 50 });
  it('on a Pi: the platform, the disk and the host stats', () => {
    let setting: 'auto' | 'on' | 'off' = 'auto';
    const m = new HostMonitor({ paths: PI, dataDir: () => '/data', setting: () => setting, statfs });
    const r = m.refresh();
    expect(r.platform).toEqual({ pi: true, model: 'Raspberry Pi 4 Model B Rev 1.5', hostStats: true });
    expect(r.disk?.usedPercent).toBe(50);
    expect(r.host?.cpuTempC).toBe(53.6);
    expect(m.reading()).toEqual(r);
    // off: still a Pi, the disk still read, no host figures; at once on refresh
    setting = 'off';
    expect(m.refresh()).toMatchObject({ platform: { pi: true, hostStats: false }, host: null, disk: { usedPercent: 50 } });
  });
  it('off a Pi: no host figures unless host.stats is on', () => {
    let setting: 'auto' | 'on' | 'off' = 'auto';
    const m = new HostMonitor({ paths: LINUX, dataDir: () => '/data', setting: () => setting, statfs });
    expect(m.refresh()).toMatchObject({ platform: { pi: false, model: null, hostStats: false }, host: null });
    setting = 'on';
    expect(m.refresh()).toMatchObject({ platform: { pi: false, hostStats: true }, host: { cpuTempC: null, uptimeS: 1000 } });
  });
  it('reads at start and then every interval; stop ends it', async () => {
    let reads = 0;
    const m = new HostMonitor({ paths: PI, dataDir: () => '/data', setting: () => 'auto', statfs: () => (reads++, { bsize: 1, blocks: 10, bfree: 5, bavail: 5 }), everyMs: 20 });
    m.start();
    expect(reads).toBe(1);
    await new Promise((r) => setTimeout(r, 70));
    m.stop();
    const n = reads;
    expect(n).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(reads).toBe(n);
  });
  it('before the first read: a reading without figures', () => {
    const m = new HostMonitor({ paths: PI, dataDir: () => '/data', setting: () => 'auto', statfs });
    expect(m.reading()).toMatchObject({ disk: expect.anything() });
  });
});

describe('the mini PC (spec 2026-10-05-multi-camera-host-design §6.5)', () => {
  it('CPU temperature from k10temp Tctl (whichever channel is labelled so); no under-voltage reading', () => {
    const s = readHostStats({ root: join(__dirname, 'fixtures', 'host', 'ryzen') });
    expect(s.cpuTempC).toBe(48.1);
    expect(s.underVoltage).toBeNull();
  });
});
