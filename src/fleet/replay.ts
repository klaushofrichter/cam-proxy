import { dirname, join } from 'path';
import { readPrivateJson, writePrivateJson } from './private-file';

// Replays across connections and restarts (security review of PR #186): a
// MITM on the plain-http *.svc.cluster.local path could replay a recorded
// session (its signed challenge, then its commands). data/admin/replay.json
// (mode 600) keeps, per enrolled key:
// - the high-water mark of cams-admin's signed serverTime: a challenge older
//   than it minus `slackMs` is refused;
// - every cmdId that passed the signature check, accepted or refused, until
//   it can't be fresh any more (exp + 120 s + slack before the mark).
// Writes are coalesced (at most one a second); a challenge is written at once.
// The mark is also kept in replay-mark.json: when replay.json is unusable the
// mark from there applies; when both are unusable every challenge is refused
// (fail closed) until someone fixes or removes them (both missing = a fresh start).
const EXP_SLACK_MS = 120_000;

interface FileShape { v: 1; keyId: string; highWater: number; cmds: [string, number][] }
interface MarkShape { v: 1; keyId: string; highWater: number }

export class ReplayGuard {
  private loaded = false;
  private keyId = '';
  private highWater = 0;
  private cmds = new Map<string, number>(); // cmdId → exp, in insertion order
  private timer: NodeJS.Timeout | null = null;
  private err: string | null = null;
  private readonly slackMs: number;
  private readonly cap: number;

  constructor(private readonly d: { file: string; log: { warn(o: object, m: string): void }; slackMs?: number; cap?: number }) {
    this.slackMs = d.slackMs ?? 300_000;
    this.cap = d.cap ?? 10_000;
  }

  private get markFile(): string {
    return join(dirname(this.d.file), 'replay-mark.json');
  }

  private read<T>(file: string, ok: (f: Record<string, unknown>) => boolean): T | null | 'unusable' {
    try {
      const f = readPrivateJson(file) as Record<string, unknown>;
      return f && f.v === 1 && typeof f.keyId === 'string' && Number.isSafeInteger(f.highWater) && ok(f) ? (f as T) : 'unusable';
    } catch (e) {
      // Not there (ENOTDIR: a path that can't hold it): nothing known yet.
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      return 'unusable'; // unsafe, invalid or unreadable: fail closed
    }
  }

  // Unusable files are read again on the next handshake (a chmod or a fix
  // needs no restart); the warning is logged once until they are usable.
  private load(): void {
    if (this.loaded && !this.err) return;
    this.loaded = true;
    const wasErr = this.err;
    this.err = null;
    const main = this.read<FileShape>(this.d.file, (f) => Array.isArray(f.cmds));
    const mark = this.read<MarkShape>(this.markFile, () => true);
    if (main && main !== 'unusable') {
      this.keyId = main.keyId;
      this.highWater = Math.max(main.highWater, mark && mark !== 'unusable' && mark.keyId === main.keyId ? mark.highWater : 0);
      for (const c of main.cmds) if (Array.isArray(c) && typeof c[0] === 'string' && Number.isSafeInteger(c[1])) this.cmds.set(c[0], c[1]);
      return;
    }
    if (mark && mark !== 'unusable') {
      // replay.json is missing or unusable: the mark still holds.
      this.keyId = mark.keyId;
      this.highWater = mark.highWater;
      if (main === 'unusable') this.d.log.warn({ file: this.d.file }, 'admin_replay_reset');
      return;
    }
    if (main === 'unusable' || mark === 'unusable') {
      this.err = `${this.d.file} and replay-mark.json are unusable: no cams-admin handshake is answered until they are fixed or removed`;
      if (!wasErr) this.d.log.warn({ file: this.d.file }, 'admin_replay_unusable');
    }
  }

  problem(): string | null {
    this.load();
    return this.err;
  }

  // A verified challenge of this key: false when it is older than one seen
  // before (minus the slack): a replay. Moves the mark and saves at once.
  challenge(keyId: string, serverTime: number): boolean {
    this.load();
    if (this.err) return false;
    if (keyId !== this.keyId) {
      // Enrolled again (another key, maybe another cams-admin): afresh.
      this.keyId = keyId;
      this.highWater = 0;
      this.cmds.clear();
    }
    if (serverTime < this.highWater - this.slackMs) return false;
    this.highWater = Math.max(this.highWater, serverTime);
    this.flush();
    return true;
  }

  hasCmd(cmdId: string): boolean {
    this.load();
    return this.cmds.has(cmdId);
  }

  addCmd(cmdId: string, exp: number): void {
    this.load();
    this.cmds.delete(cmdId);
    this.cmds.set(cmdId, exp);
    for (const [k, e] of this.cmds) if (e + EXP_SLACK_MS + this.slackMs < this.highWater) this.cmds.delete(k);
    while (this.cmds.size > this.cap) this.cmds.delete(this.cmds.keys().next().value as string);
    if (!this.timer && !this.err) {
      this.timer = setTimeout(() => {
        try {
          this.flush();
        } catch (err) {
          this.d.log.warn({ err: String((err as Error).message).slice(0, 200) }, 'admin_replay_save_failed');
        }
      }, 1000);
      this.timer.unref();
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.loaded || this.err) return;
    writePrivateJson(this.markFile, { v: 1, keyId: this.keyId, highWater: this.highWater } satisfies MarkShape, false);
    writePrivateJson(this.d.file, { v: 1, keyId: this.keyId, highWater: this.highWater, cmds: [...this.cmds] } satisfies FileShape, false);
  }
}
