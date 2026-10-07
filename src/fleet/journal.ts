import { renameSync } from 'fs';
import { PrivateFileInvalid, PrivateFileUnsafe, readPrivateJson, writePrivateJson } from './private-file';

// The command journal (migration spec M §7.6): data/admin/commands.json, mode
// 600, atomic. The final result of each executed cmdId, written before the
// `done` result is sent, so a re-sent command answers its stored result
// (duplicate) and never runs twice. Keeps the newest 1000 entries plus every
// one younger than 7 days, never more than 2500. Refusals are not journaled
// (Ruling R2-8).
export interface JournalEntry {
  cmdId: string;
  command: string;
  actor: string;
  at: number;
  status: 'ok' | 'failed' | 'conflict';
  code?: string;
  result?: Record<string, unknown>;
  changed?: string[];
}

const KEEP = 1000;
const YOUNG_MS = 7 * 86_400_000;
const CAP = 2500;

export class Journal {
  private entries: JournalEntry[] = [];
  private byId = new Map<string, JournalEntry>();
  private bad: string | null = null;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
    private readonly log: { warn(o: object, m: string): void } = { warn() {} },
  ) {
    try {
      const f = readPrivateJson(file) as { v?: unknown; entries?: unknown };
      if (f?.v !== 1 || !Array.isArray(f.entries)) throw new PrivateFileInvalid(`${file} is not version 1`);
      this.set((f.entries as JournalEntry[]).filter((e) => typeof e?.cmdId === 'string' && typeof e.at === 'number'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      // Unusable: no entry is trusted; the next record starts a fresh file
      // and keeps this one aside (commands.json.bad-<ts>).
      this.bad = e instanceof PrivateFileUnsafe || e instanceof PrivateFileInvalid ? e.message : `${file}: unreadable`;
    }
  }

  private set(list: JournalEntry[]): void {
    this.entries = [...list].sort((a, b) => a.at - b.at);
    this.byId = new Map(this.entries.map((e) => [e.cmdId, e]));
  }

  problem(): string | null {
    return this.bad;
  }

  get(cmdId: string): JournalEntry | undefined {
    return this.byId.get(cmdId);
  }

  record(e: JournalEntry): void {
    if (this.bad) {
      try {
        renameSync(this.file, `${this.file}.bad-${this.now()}`);
      } catch {
        // gone already
      }
      this.log.warn({ reason: this.bad }, 'admin_journal_reset');
      this.bad = null;
    }
    const list = [...this.entries.filter((x) => x.cmdId !== e.cmdId), e].sort((a, b) => a.at - b.at);
    const now = this.now();
    let drop = 0;
    while (list.length - drop > CAP || (list.length - drop > KEEP && now - list[drop].at > YOUNG_MS)) drop++;
    const next = list.slice(drop);
    writePrivateJson(this.file, { v: 1, entries: next }, false);
    this.set(next);
  }

  // The newest first.
  recent(n: number): JournalEntry[] {
    return this.entries.slice(-n).reverse();
  }
}
