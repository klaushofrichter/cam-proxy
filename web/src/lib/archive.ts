// The Archive on the Status and Maintenance pages (spec
// 2026-10-05-archive-design §6): GET /control/status `archive`.
import { agoText, localDate, localHhmm } from './format';

export interface UiArchive {
  enabled: boolean;
  count: number;
  bytes: number;
  forever: number;
  oldestCreatedAt: number | null;
  newestCreatedAt: number | null;
  disk: { free: number; size: number };
  percentOfDisk: number;
  warnPercent: number;
  warning: boolean;
  minFreeBytes: number;
  nextCleanupAt: number;
  expiringAtNextCleanup: number;
  lastCleanup: { at: number; removed: number; bytes: number } | null;
  labels: { label: string; count: number }[];
}
export interface ArchiveRow { key: string; label: string; text: string; bad?: boolean; title?: string }

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const when = (ts: number) => `${localDate(ts)} ${localHhmm(ts)}`;
const inText = (ts: number, now: number) => {
  const min = Math.round((ts - now) / 60_000);
  return min <= 0 ? 'now' : min < 60 ? `in ${min} min` : `in ${Math.round(min / 60)} h`;
};

export function archiveRows(a: UiArchive, now = Date.now()): ArchiveRow[] {
  const expiring = a.expiringAtNextCleanup ? `${a.expiringAtNextCleanup} clip${a.expiringAtNextCleanup === 1 ? '' : 's'} expire${a.expiringAtNextCleanup === 1 ? 's' : ''}` : 'nothing expires';
  return [
    { key: 'count', label: 'Clips', text: `${a.count}${a.forever ? ` (${a.forever} kept forever)` : ''}${a.enabled ? '' : ' · new clips off'}` },
    { key: 'size', label: 'Size', text: gb(a.bytes) },
    {
      key: 'percent', label: 'Of the disk', text: a.warning ? `${a.percentOfDisk.toFixed(1)} % — WARNING: over ${a.warnPercent} %` : `${a.percentOfDisk.toFixed(1)} %`, bad: a.warning,
      title: `a warning (no limit) above ${a.warnPercent} % (archive.warnPercent)`,
    },
    { key: 'free', label: 'Disk free', text: `${gb(a.disk.free)} of ${gb(a.disk.size)}` },
    { key: 'oldest', label: 'Oldest', text: a.oldestCreatedAt ? when(a.oldestCreatedAt) : '—' },
    { key: 'newest', label: 'Newest', text: agoText(a.newestCreatedAt, now) },
    { key: 'next', label: 'Next cleanup', text: `${inText(a.nextCleanupAt, now)} · ${expiring}`, title: when(a.nextCleanupAt) },
    { key: 'last', label: 'Last cleanup', text: a.lastCleanup ? `${agoText(a.lastCleanup.at, now)} · ${a.lastCleanup.removed} removed` : '— (not since the start)' },
  ];
}

// The dialog's button: only the exact number of clips, typed.
export function clearMatches(typed: string, count: number): boolean {
  const t = typed.trim();
  return /^(0|[1-9]\d*)$/.test(t) && Number(t) === count && t !== '';
}

export function clearMessage(a: { count: number; bytes: number }): string {
  return `Delete all ${a.count} clip${a.count === 1 ? '' : 's'} in the Archive (${gb(a.bytes)}), with their thumbnails and metadata? This cannot be undone. Type ${a.count} to confirm.`;
}
