import type { HealthInput } from '../../src/health/summary';

// Spec 2026-10-03-health-summary-design A2: one function, every problem rule.
export const NOW = Date.UTC(2026, 9, 3, 12, 0);
export const H = 3600_000;

export function input(over: Partial<HealthInput> = {}): HealthInput {
  return {
    now: NOW,
    version: '2026.10.03.2',
    startedAt: NOW - 2 * H,
    thresholds: { diskPercent: 90, tempC: 75, ftpStalledHours: 6 },
    camera: {
      id: 'cam1', name: 'Den', host: '192.168.1.103:443',
      state: { online: true, since: NOW - H, model: 'RLC-1224A', firmware: 'v3.1', serial: 'SERIAL-123', clockOffsetMs: -412 },
      reboot: null,
      poeSwitch: { model: 'sscpoe-web', port: 8 },
    },
    stream: { enabled: true, up: true, lastFrameTs: NOW - 1000 },
    intake: { onvif: 'subscribed', since: NOW - H, source: 'onvif', resubscribes: 3 },
    ftp: {
      enabled: true, listening: true,
      camera: { state: 'on', checkedAt: NOW - 60_000, enable: true, server: '192.168.1.220', port: 2121, user: 'camera', mismatch: [], error: null },
      stalled: { stalled: false, hours: 6, lastClip: NOW - H, events: 0 },
      lastClip: NOW - H, clips: 412, failures: 0,
    },
    storage: { paused: false, lastRun: NOW - 30 * 60_000 },
    recordingsCache: { bytes: 1000, files: 1, capBytes: 2 ** 31 },
    sseClients: 2,
    lastInventory: { kind: 'clips', op: 'check', outcome: 'ok', startedAt: NOW - 5 * H, message: 'Clips check: nothing missing' },
    reading: {
      platform: { pi: true, model: 'Raspberry Pi 4 Model B Rev 1.5', hostStats: true },
      disk: { sizeBytes: 245457289216, freeBytes: 205078347776, usedBytes: 26414358528, usedPercent: 11.4 },
      host: { cpuTempC: 53.6, underVoltage: false, memory: { totalBytes: 4e9, availableBytes: 3e9, usedPercent: 25 }, uptimeS: 412233, load: { m1: 0.42, m5: 0.38, m15: 0.35 } },
    },
    ...over,
  };
}
