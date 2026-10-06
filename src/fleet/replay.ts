import { renameSync } from 'fs';
import { PrivateFileInvalid, PrivateFileUnsafe, readPrivateJson, writePrivateJson } from './private-file';

// Replays across connections and restarts (security review of PR #186): a
// MITM on the plain-http *.svc.cluster.local path could replay a recorded
// session (its signed challenge, then its commands). data/admin/replay.json
// (mode 600) keeps, per enrolled key:
// - the high-water mark of cams-admin's signed serverTime: a challenge older
//   than it minus `slackMs` is refused;
// - every cmdId that passed the signature check, accepted or refused, until
//   it can't be fresh any more (exp + 120 s + slack before the mark).
// Writes are coalesced (at most one a second); a challenge is written at once.
const EXP_SLACK_MS = 120_000;

interface FileShape { v: 1; keyId: string; highWater: number; cmds: [string, number][] }

export class ReplayGuard {
  private loaded = false;
  private keyId = '';
  private highWater = 0;
  private cmds = new Map<string, number>(); // cmdId → exp, in insertion order
  private timer: NodeJS.Timeout | null = null;
  private readonly slackMs: number;
  private readonly cap: number;

  constructor(private readonly d: { file: string; log: { warn(o: object, m: string): void }; slackMs?: number; cap?: number }) {
    this.slackMs = d.slackMs ?? 300_000;
    this.cap = d.cap ?? 10_000;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const f = readPrivateJson(this.d.file) as Partial<FileShape>;
      if (f?.v !== 1 || typeof f.keyId !== 'string' || !Number.isSafeInteger(f.highWater) || !Array.isArray(f.cmds)) throw new PrivateFileInvalid(`${this.d.file} is not version 1`);
      this.keyId = f.keyId;
      this.highWater = f.highWater as number;
      for (const c of f.cmds) if (Array.isArray(c) && typeof c[0] === 'string' && Number.isSafeInteger(c[1])) this.cmds.set(c[0], c[1]);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      // Unusable (only a local change can do that): set aside, start empty.
      try {
        renameSync(this.d.file, `${this.d.file}.bad-${Date.now()}`);
      } catch {
        /* gone already */
      }
      this.d.log.warn({ reason: e instanceof PrivateFileUnsafe || e instanceof PrivateFileInvalid ? e.message : 'unreadable' }, 'admin_replay_reset');
    }
  }

  // A verified challenge of this key: false when it is older than one seen
  // before (minus the slack): a replay. Moves the mark and saves at once.
  challenge(keyId: string, serverTime: number): boolean {
    this.load();
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
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 1000);
      this.timer.unref();
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.loaded) return;
    writePrivateJson(this.d.file, { v: 1, keyId: this.keyId, highWater: this.highWater, cmds: [...this.cmds] } satisfies FileShape, false);
  }
}
