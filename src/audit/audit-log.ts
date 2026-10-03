import { appendFileSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { logger, maskPath } from '../log';
import { addDays, DAY, dayStart } from '../time-units';
import { fileSize } from '../fs-util';
export { maskPath };

// The audit log (spec 2026-10-01-audit-log-design): ECS 8.x JSON lines, one
// append-only file per UTC day under <dataDir>/audit. Writes never throw into
// the caller; reads page by cursor ("<day>:<line>", 1-based) in either
// direction across the day files.
const AUDIT_DATASET = 'cam-proxy.audit';
export type Outcome = 'success' | 'failure' | 'unknown';
interface AuditInput {
  action: string;
  category: string[];
  type: string[];
  outcome: Outcome;
  message: string;
  user?: string;
  ip?: string;
  userAgent?: string;
  error?: string;
  details?: Record<string, unknown>;
  ecs?: Record<string, unknown>;
}
export type AuditRecord = Record<string, unknown> & {
  '@timestamp': string;
  event: { kind: 'event'; category: string[]; type: string[]; action: string; outcome: Outcome; dataset: string };
  message: string;
  cam_proxy?: Record<string, unknown>;
};
interface AuditQuery { limit?: number; before?: string; after?: string; from?: number; to?: number; actions?: string[]; outcome?: Outcome }
export class AuditQueryError extends Error {}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const CURSOR = /^(\d{4}-\d{2}-\d{2}):(\d{1,9})$/;
// Secret field names, by explicit name (#78): token, password, secret, authorization
// and cookie anywhere in the name, an api key, and names ending in `Key`/`_key`
// (apiKey, googleVisionKey). Not keyframe or ftp.keyFile.
const SECRET_WORDS = /token|password|passwd|passphrase|pwd|credential|secret|authorization|cookie/i;
const SECRET_KEY = /key$/i; // apiKey, privatekey, ACCESS_KEY; not keyframe or keyFile
const isSecret = (n: string) => SECRET_WORDS.test(n) || SECRET_KEY.test(n);
// Field names that look secret but only describe: a config change's `key`, the kind of token refused.
const SAFE = new Set(['key', 'tokenKind']);

// `secret` may name the secret a record is about (secret-override): these names only.
const SECRET_NAMES = new Set(['CAMPROXY_GOOGLE_VISION_KEY']);

// Values of secret-looking keys become "[redacted]", at any depth. A config
// change ({key, from, to}) is redacted by the name in `key`.
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const last = typeof o.key === 'string' ? o.key.slice(o.key.lastIndexOf('.') + 1) : '';
  const byName = typeof o.key === 'string' && (last === 'key' || isSecret(last)) && ('from' in o || 'to' in o);
  return Object.fromEntries(Object.entries(o).map(([k, x]) => {
    if (byName && (k === 'from' || k === 'to')) return [k, '[redacted]'];
    if (k === 'secret' && typeof x === 'string' && SECRET_NAMES.has(x)) return [k, x];
    return [k, isSecret(k) && !SAFE.has(k) ? '[redacted]' : redact(x)];
  }));
}

// The first `max` UTF-16 units of `s`, one fewer when the cut would split a
// surrogate pair (an emoji): records stay valid UTF-8.
export function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}

export class AuditLog {
  private readonly now: () => number;
  private readonly host: string;
  private readonly max: number;
  private throttledDay: string | null = null;
  private readonly clean = new Set<string>(); // files whose last byte was checked this process

  constructor(private readonly d: { dir: string; version: string; camera: () => string; now?: () => number; host?: string; maxFileBytes?: number }) {
    this.now = d.now ?? Date.now;
    this.host = d.host ?? hostname();
    this.max = d.maxFileBytes ?? 50 * 1024 * 1024;
  }

  write(i: AuditInput): AuditRecord | null {
    const ts = this.now();
    const day = new Date(ts).toISOString().slice(0, 10);
    const file = join(this.d.dir, `${day}.jsonl`);
    try {
      // Refused tokens and failed sign-ins are what a flood writes: those stop at the size limit.
      if ((i.action === 'auth-refused' || (i.action === 'login' && i.outcome === 'failure')) && fileSize(file) >= this.max) {
        if (this.throttledDay !== day) {
          this.throttledDay = day;
          const t = this.record(ts, { action: 'audit-throttled', category: ['host'], type: ['info'], outcome: 'unknown', message: 'The audit file reached its size limit; further refused-token and failed sign-in records today are dropped' });
          this.append(file, t);
          logger.info({ audit: true, ecs: t }, 'audit');
        }
        return null;
      }
      const r = this.record(ts, i);
      this.append(file, r);
      logger.info({ audit: true, ecs: r }, 'audit');
      return r;
    } catch (err) {
      logger.error({ err: (err as Error).message, action: i.action }, 'audit_write_failed');
      return null;
    }
  }

  list(q: AuditQuery): { records: AuditRecord[]; next: string | null; hasMore: boolean } {
    const limit = q.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new AuditQueryError('limit is 1 to 500');
    if (q.before !== undefined && q.after !== undefined) throw new AuditQueryError('before and after together');
    if (q.from !== undefined && q.to !== undefined && q.to < q.from) throw new AuditQueryError('to is before from');
    const cur = (s: string | undefined) => {
      if (s === undefined || s === '') return null;
      const m = CURSOR.exec(s);
      if (!m) throw new AuditQueryError('bad cursor');
      return { day: m[1], line: Number(m[2]) };
    };
    const up = q.after !== undefined;
    const c = cur(up ? q.after : q.before);
    const days = this.days();
    const out: AuditRecord[] = [];
    // A line can match only if it names a wanted action: the others are not
    // parsed (#106: the inventories read days of records for a few actions).
    // JSON.stringify writes `"action":"<name>"`, so this never drops a match.
    const needles = q.actions?.map((a) => `"action":${JSON.stringify(a)}`);
    const ok = (r: AuditRecord) => {
      const t = Date.parse(r['@timestamp']);
      return (!q.actions || q.actions.includes(r.event?.action)) && (!q.outcome || r.event?.outcome === q.outcome) && (q.from === undefined || t >= q.from) && (q.to === undefined || t <= q.to);
    };
    outer: for (const day of up ? days : [...days].reverse()) {
      if (c && (up ? day < c.day : day > c.day)) continue;
      // Skip a day whose UTC range [00:00Z, next 00:00Z) is outside [from, to].
      const start = Date.parse(`${day}T00:00:00Z`);
      if ((q.to !== undefined && start > q.to) || (q.from !== undefined && start + DAY <= q.from)) continue;
      const lines = this.lines(day);
      const order = lines.map((_, k) => k + 1);
      for (const n of up ? order : order.reverse()) {
        if (c && day === c.day && (up ? n <= c.line : n >= c.line)) continue;
        const line = lines[n - 1];
        if (needles && !needles.some((x) => line.includes(x))) continue;
        const r = parse(line);
        if (!r || !ok(r)) continue;
        out.push({ ...r, cam_proxy: { ...(r.cam_proxy ?? {}), cursor: `${day}:${n}` } });
        if (out.length > limit) break outer;
      }
    }
    const hasMore = out.length > limit;
    const records = out.slice(0, limit);
    const last = records.at(-1)?.cam_proxy?.cursor as string | undefined;
    return { records, next: last ?? (up ? (q.after || null) : null), hasMore };
  }

  find(pred: (r: AuditRecord) => boolean, days = 2): AuditRecord | undefined {
    const all = this.days();
    if (!all.length) return undefined;
    const cutoff = addDays(all.at(-1)!, -(Math.max(1, Math.floor(days) || 1) - 1));
    for (const day of all.filter((d) => d >= cutoff).reverse()) {
      for (const l of this.lines(day).reverse()) {
        const r = parse(l);
        if (r && pred(r)) return r;
      }
    }
    return undefined;
  }

  deleteBefore(day: string, dryRun = false): number {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      logger.error({ day }, 'audit_delete_bad_day');
      return 0;
    }
    const old = this.days().filter((d) => d < day);
    if (dryRun) return old.length;
    let n = 0;
    for (const d of old) {
      try { rmSync(join(this.d.dir, `${d}.jsonl`), { force: true }); n++; } catch (err) { logger.error({ err: (err as Error).message, day: d }, 'audit_delete_failed'); }
    }
    return n;
  }

  usage(): { bytes: number; files: number; oldest: number | null; newest: number | null; growthPerDay: number } {
    const days = this.days();
    const sizes = days.map((d) => fileSize(join(this.d.dir, `${d}.jsonl`)));
    const bytes = sizes.reduce((a, b) => a + b, 0);
    // Growth: bytes per calendar day over the last 7 whole UTC days (today is
    // partial), counting days without a file as 0, from the first file on.
    const today = dayStart(this.now());
    const from = Math.max(today - 7 * DAY, days.length ? Date.parse(`${days[0]}T00:00:00Z`) : today);
    const whole = (today - from) / DAY;
    const recent = days.reduce((n, d, i) => { const t = Date.parse(`${d}T00:00:00Z`); return t >= from && t < today ? n + sizes[i] : n; }, 0);
    return {
      bytes, files: days.length,
      oldest: days.length ? Date.parse(`${days[0]}T00:00:00Z`) : null,
      newest: days.length ? Date.parse(`${days.at(-1)}T00:00:00Z`) : null,
      growthPerDay: whole > 0 ? recent / whole : 0,
    };
  }

  private record(ts: number, i: AuditInput): AuditRecord {
    const r: Record<string, unknown> = {
      ...(i.ecs ? (redact(i.ecs) as Record<string, unknown>) : {}),
      '@timestamp': new Date(ts).toISOString(),
      ecs: { version: '8.11.0' },
      event: { kind: 'event', category: i.category, type: i.type, action: i.action, outcome: i.outcome, dataset: AUDIT_DATASET },
      service: { name: 'cam-proxy', version: this.d.version },
      host: { name: this.host },
      labels: { camera: this.d.camera() },
    };
    if (i.user) r.user = { name: i.user };
    if (i.ip) r.source = { ip: i.ip };
    if (i.userAgent) r.user_agent = { original: cut(i.userAgent, 512) };
    if (i.error) r.error = { message: i.error };
    r.message = i.message;
    if (i.details) r.cam_proxy = redact(i.details);
    return r as AuditRecord;
  }

  private append(file: string, r: AuditRecord): void {
    mkdirSync(this.d.dir, { recursive: true });
    let prefix = '';
    if (!this.clean.has(file)) {
      prefix = this.endsPartial(file) ? '\n' : '';
    }
    appendFileSync(file, prefix + JSON.stringify(r) + '\n');
    this.clean.add(file);
  }

  // True when the file exists, is not empty and does not end in a newline (a crash mid-append).
  private endsPartial(file: string): boolean {
    let fd: number | undefined;
    try {
      const size = statSync(file).size;
      if (!size) return false;
      fd = openSync(file, 'r');
      const b = Buffer.alloc(1);
      readSync(fd, b, 0, 1, size - 1);
      return b[0] !== 0x0a;
    } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
  }


  private days(): string[] {
    let names: string[] = [];
    try { names = readdirSync(this.d.dir); } catch { return []; }
    return names.map((n) => DAY_FILE.exec(n)?.[1]).filter((d): d is string => !!d).sort();
  }

  private lines(day: string): string[] {
    try {
      const text = readFileSync(join(this.d.dir, `${day}.jsonl`), 'utf8');
      return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text ? text.split('\n') : [];
    } catch { return []; }
  }
}

function parse(line: string | undefined): AuditRecord | null {
  if (!line) return null;
  try {
    const r = JSON.parse(line) as AuditRecord;
    return r && typeof r === 'object' && r.event ? r : null;
  } catch { return null; }
}

