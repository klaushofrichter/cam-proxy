import { localOffsetMinutes } from '../analytics/local-day';
import type { TimeInfo } from '../camera/time';

// The Archive's input rules (spec 2026-10-05-archive-design §2.4): what a
// name, the labels and a retention may be, the default name, and the file
// names downloads get. A RuleError's message is the 400's `detail`.
export class RuleError extends Error {}

export const NAME_MAX = 120;
export const LABELS_MAX = 16;
export const LABEL_MAX = 24;
export const RETENTION_MAX_DAYS = 36500;
export const RETENTION_DEFAULT_DAYS = 365;
// Klaus, 2026-10-05: these five, plus any custom ones.
export const PREDEFINED_LABELS = ['Pet', 'Person', 'Vehicle', 'SD', '4K'] as const;
const PREDEFINED = new Map(PREDEFINED_LABELS.map((l) => [l.toLowerCase(), l]));

// Any text but control characters (newlines, tabs, NUL), 1 to 120 after trimming.
export function checkName(v: unknown): string {
  if (typeof v !== 'string') throw new RuleError('name is text');
  const s = v.trim();
  if (!s) throw new RuleError('name is empty');
  if (/\p{Cc}/u.test(s)) throw new RuleError('name has control characters');
  // Format characters (U+202E right-to-left override, zero-width ones) can
  // make a name read as another (review of #159).
  if (/\p{Cf}/u.test(s)) throw new RuleError('name has invisible formatting characters');
  if ([...s].length > NAME_MAX) throw new RuleError(`name is at most ${NAME_MAX} characters`);
  return s;
}

// One word each (letters and digits), case-insensitive: duplicates go (the
// first spelling stays), the predefined ones get their own spelling.
export function checkLabels(v: unknown): string[] {
  if (!Array.isArray(v)) throw new RuleError('labels is a list of words');
  const out = new Map<string, string>();
  for (const l of v) {
    if (typeof l !== 'string' || !/^[A-Za-z0-9]+$/.test(l) || l.length > LABEL_MAX) throw new RuleError(`a label is 1 to ${LABEL_MAX} letters or digits (no spaces)`);
    const k = l.toLowerCase();
    if (!out.has(k)) out.set(k, PREDEFINED.get(k) ?? l);
  }
  if (out.size > LABELS_MAX) throw new RuleError(`at most ${LABELS_MAX} labels`);
  return [...out.values()];
}

// Whole days, or null for forever.
export function checkRetention(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > RETENTION_MAX_DAYS) throw new RuleError(`retentionDays is whole days from 1 to ${RETENTION_MAX_DAYS}, or null (forever)`);
  return v;
}

const pad = (n: number) => String(n).padStart(2, '0');

// "YYYY-MM-DD HH:MM:SS <camera name>" of a moment in camera time (UTC
// without the camera's time info), within NAME_MAX.
export function defaultName(ts: number, cameraName: string, t: TimeInfo | undefined): string {
  const d = new Date(ts + localOffsetMinutes(ts, t) * 60_000);
  const when = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return [...`${when} ${cameraName}`.replace(/\p{Cc}/gu, ' ').replace(/\p{Cf}/gu, '')].slice(0, NAME_MAX).join('').trim();
}

// A name as a file name: colons become dashes (times), the characters file
// systems refuse become "_", no leading or trailing dots or spaces, at most
// 100 characters; "clip" when nothing is left.
export function safeFileName(name: string): string {
  const s = name.replace(/\p{Cf}/gu, '').replace(/:/g, '-').replace(/[/\\*?"<>|\p{Cc}]/gu, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  const cut = [...s].slice(0, 100).join('').replace(/[\s.]+$/, '');
  return cut || 'clip';
}

// An attachment header: an ASCII fallback and the UTF-8 name (RFC 6266/5987).
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// The person cams acts for (X-On-Behalf-Of, ruling 8): printable ASCII
// without spaces, 1 to 254 characters; anything else is ignored.
export function onBehalfOf(v: unknown): string | undefined {
  return typeof v === 'string' && /^[\x21-\x7e]{1,254}$/.test(v) ? v : undefined;
}
