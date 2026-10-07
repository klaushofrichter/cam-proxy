import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { Journal, type JournalEntry } from '../src/fleet/journal';
import { privateFileHooks, writePrivateJson } from '../src/fleet/private-file';

// The command journal (M §7.6): data/admin/commands.json, the final result
// of each cmdId, so a re-sent command answers its stored result.
const DAY = 86_400_000;
const cmd = (n: number) => `cmd_${String(n).padStart(20, '0')}`;
const entry = (n: number, at: number): JournalEntry => ({ cmdId: cmd(n), command: 'tokens.apply', actor: 'ops@example.com', at, status: 'ok', result: { revision: n } });
const fresh = () => join(mkdtempSync(join(tmpdir(), 'journal-')), 'admin', 'commands.json');
const quiet = () => {
  const lines: string[] = [];
  return { lines, log: { warn: (_o: object, m: string) => void lines.push(m) } };
};

describe('Journal', () => {
  it('record then get; file 600; survives a reload', () => {
    const file = fresh();
    const j = new Journal(file, () => 1_000);
    expect(j.get(cmd(1))).toBeUndefined();
    j.record(entry(1, 1_000));
    expect(j.get(cmd(1))).toEqual(entry(1, 1_000));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new Journal(file, () => 1_000).get(cmd(1))).toEqual(entry(1, 1_000));
  });
  it('keeps the newest 1000 plus anything younger than 7 days, never more than 2500', () => {
    const now = 100 * DAY;
    // 1200 old entries: a record keeps the newest 1000 (the new one included).
    let file = fresh();
    writePrivateJson(file, { v: 1, entries: Array.from({ length: 1200 }, (_, i) => entry(i, now - 30 * DAY + i)) });
    let j = new Journal(file, () => now);
    j.record(entry(5000, now));
    expect(j.recent(5000).length).toBe(1000);
    expect(j.get(cmd(200))).toBeUndefined();
    expect(j.get(cmd(201))).toBeDefined();
    // Young entries all stay, up to 2500 in total.
    file = fresh();
    writePrivateJson(file, { v: 1, entries: [...Array.from({ length: 500 }, (_, i) => entry(i, now - 30 * DAY + i)), ...Array.from({ length: 1500 }, (_, i) => entry(10_000 + i, now - DAY + i))] });
    j = new Journal(file, () => now);
    j.record(entry(20_000, now));
    expect(j.recent(5000).length).toBe(1501);
    file = fresh();
    writePrivateJson(file, { v: 1, entries: Array.from({ length: 2600 }, (_, i) => entry(10_000 + i, now - DAY + i)) });
    j = new Journal(file, () => now);
    j.record(entry(20_000, now));
    expect(j.recent(5000).length).toBe(2500);
    expect(j.get(cmd(10_100))).toBeUndefined();
    expect(j.get(cmd(10_101))).toBeDefined();
    expect(j.recent(2).map((e) => e.cmdId)).toEqual([cmd(20_000), cmd(12_599)]);
    expect(JSON.parse(readFileSync(file, 'utf8')).entries.length).toBe(2500);
  });
  it('an unsafe or corrupt file: get answers undefined, record starts a fresh one and keeps the old one aside', () => {
    for (const spoil of ['corrupt', 'unsafe'] as const) {
      const file = fresh();
      new Journal(file, () => 1).record(entry(1, 1));
      if (spoil === 'corrupt') writeFileSync(file, '{', { mode: 0o600 });
      // Another user's file (ours with 644 would be tightened and used).
      else privateFileHooks.fstat = () => ({ mode: 0o100644, uid: (process.getuid?.() ?? 0) + 1 });
      const q = quiet();
      let j: Journal;
      try {
        j = new Journal(file, () => 2, q.log);
      } finally {
        delete privateFileHooks.fstat;
      }
      expect(j.get(cmd(1))).toBeUndefined();
      j.record(entry(2, 2));
      expect(j.get(cmd(2))).toBeDefined();
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(q.lines).toContain('admin_journal_reset');
      expect(readdirSync(join(file, '..')).some((n) => /^commands\.json\.bad-\d+$/.test(n)), spoil).toBe(true);
    }
  });
  it('ours with 660 (the cluster volume under fsGroup): tightened to 600 and used', () => {
    const file = fresh();
    new Journal(file, () => 1).record(entry(1, 1));
    chmodSync(file, 0o660);
    const j = new Journal(file, () => 2);
    expect(j.problem()).toBeNull();
    expect(j.get(cmd(1))).toBeDefined();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
