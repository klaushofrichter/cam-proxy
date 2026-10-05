import { cameraFtpClass, type CameraFtp } from './ftp';

// The Status page's Health and Pi cards (spec 2026-10-03-health-summary-design
// A3). The proxy's summary (`health` in /control/status, the same as
// GET /api/local/health) decides every problem; the page only draws it, so
// the page, its red marks and the e-paper display never disagree.

export interface HealthItem { id: string; label: string; value: boolean | number | string | null; text: string; problem: boolean }
export interface UiDisk { sizeBytes: number; freeBytes: number; usedBytes: number; usedPercent: number }
export interface UiMemory { totalBytes: number; availableBytes: number; usedPercent: number }
export interface UiLoad { m1: number; m5: number; m15: number }
export interface UiHost { cpuTempC: number | null; underVoltage: boolean | null; memory: UiMemory | null; uptimeS: number | null; load: UiLoad | null }
export interface UiPlatform { pi: boolean; model: string | null; hostStats: boolean }
export interface UiHealth {
  ok: boolean;
  problemCount: number;
  platform: UiPlatform;
  thresholds: { diskPercent: number; tempC: number; ftpStalledHours: number };
  items: HealthItem[];
  disk: UiDisk | null;
  host: UiHost | null;
  // Every camera's block (spec 2026-10-05-multi-camera-host-design §6.5); absent from an older proxy.
  cameras?: { camera: { id: string }; items: HealthItem[] }[];
}

const GB = 1024 ** 3;

export function healthHeadline(h: UiHealth): string {
  return h.problemCount === 0 ? 'All OK' : `${h.problemCount} problem${h.problemCount === 1 ? '' : 's'}`;
}

export function itemOf(h: UiHealth | null | undefined, id: string): HealthItem | undefined {
  return h?.items.find((i) => i.id === id);
}

// An item's red mark; false for an item the summary left out (a figure it
// could not read is never a problem).
export function problemOf(h: UiHealth | null | undefined, id: string): boolean {
  return itemOf(h, id)?.problem === true;
}

// "Pi" on a Raspberry Pi; "Host" when host.stats is on elsewhere.
export function piCardTitle(p: UiPlatform): string {
  return p.pi ? 'Pi' : 'Host';
}

export function uptimeText(s: number | null): string {
  if (s === null) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

export function memoryText(m: UiMemory | null): string {
  return m ? `${m.usedPercent.toFixed(1)} % of ${(m.totalBytes / GB).toFixed(1)} GB` : '—';
}

export function loadText(l: UiLoad | null): string {
  return l ? [l.m1, l.m5, l.m15].map((n) => n.toFixed(2)).join(' · ') : '—';
}

export function diskText(d: UiDisk | null): string {
  return d ? `${d.usedPercent.toFixed(1)} % used, ${(d.freeBytes / GB).toFixed(1)} GB free` : '—';
}

// The Clips card's "Camera upload" line: red exactly when the summary's ftp
// item is a problem; otherwise its own green (on), amber (another server
// name) or grey. Without a summary (an older proxy), the card's own rule.
export function cameraUploadClass(h: UiHealth | null | undefined, state: CameraFtp['state'] | undefined): string {
  if (!h) return cameraFtpClass(state);
  if (problemOf(h, 'ftp')) return 'bad';
  const c = cameraFtpClass(state);
  return c === 'bad' ? '' : c;
}

// The Clips card's "Last clip" line: red with the summary's ftp item.
export function lastClipClass(h: UiHealth | null | undefined, stalled: boolean): string {
  return (h ? problemOf(h, 'ftp') : stalled) ? 'bad' : '';
}
