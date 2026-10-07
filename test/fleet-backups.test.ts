import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { OverridesBackups, type Backup } from '../src/fleet/backups';
import { privateFileHooks } from '../src/fleet/private-file';

// Overrides backups per cams-admin settings write (plan P3 R3-5, Task 6):
// data/admin/overrides.bak-<cmdId>.json, private files, the last 20.
const CMD = (n: number) => `cmd_${String(n).padStart(20, '0')}`;
const dir = () => join(mkdtempSync(join(tmpdir(), 'backups-')), 'admin');
const backup = (n: number, at = n * 1000, paths: Backup['paths'] = [{ path: 'sse.pingS', before: { set: false }, after: { set: true, value: n } }]): Backup => ({
  v: 1, cmdId: CMD(n), command: 'config.set', actor: 'admin@example.org', at, revisionBefore: `sha256:${'a'.repeat(64)}`, revisionAfter: `sha256:${'b'.repeat(64)}`, paths,
});
const quiet = () => {
  const lines: string[] = [];
  return { lines, log: { warn: (_o: object, m: string) => void lines.push(m) } };
};

describe('OverridesBackups', () => {
  it('save then get; file 600 in a 700 folder', () => {
    const d = dir();
    const b = new OverridesBackups(d);
    b.save(backup(1));
    expect(b.get(CMD(1))).toEqual(backup(1));
    expect(statSync(join(d, `overrides.bak-${CMD(1)}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(d).mode & 0o777).toBe(0o700);
    expect(b.get(CMD(2))).toBeNull();
  });
  it('the 21st save deletes the oldest file', () => {
    const d = dir();
    const b = new OverridesBackups(d);
    for (let i = 1; i <= 21; i++) b.save(backup(i));
    const files = readdirSync(d).filter((f) => f.startsWith('overrides.bak-'));
    expect(files).toHaveLength(20);
    expect(b.get(CMD(1))).toBeNull();
    expect(b.get(CMD(21))).not.toBeNull();
    expect(b.list().map((x) => x.cmdId)).toEqual(Array.from({ length: 20 }, (_, i) => CMD(21 - i)));
  });
  it("another user's file, or a malformed one, is no backup (null), logged", () => {
    const d = dir();
    const q = quiet();
    const b = new OverridesBackups(d, Date.now, q.log);
    b.save(backup(1));
    privateFileHooks.fstat = () => ({ mode: 0o100644, uid: (process.getuid?.() ?? 0) + 1 });
    try {
      expect(b.get(CMD(1))).toBeNull();
    } finally {
      delete privateFileHooks.fstat;
    }
    writeFileSync(join(d, `overrides.bak-${CMD(2)}.json`), '{"v": 1, "cmdId": 7}', { mode: 0o600 });
    expect(b.get(CMD(2))).toBeNull();
    writeFileSync(join(d, `overrides.bak-${CMD(3)}.json`), 'not json', { mode: 0o600 });
    expect(b.get(CMD(3))).toBeNull();
    expect(b.list().map((x) => x.cmdId)).toEqual([CMD(1)]);
    expect(q.lines.length).toBeGreaterThan(0);
  });
  it('a cmdId must be a command id: a traversal id throws before any file name is built', () => {
    const b = new OverridesBackups(dir());
    expect(() => b.get('../x')).toThrow();
    expect(() => b.save({ ...backup(1), cmdId: '../../etc/passwd' })).toThrow();
    expect(() => b.markRolledBack('cmd_../x', { at: 1, by: 'local', user: 'admin' })).toThrow();
  });
  it('markRolledBack persists', () => {
    const d = dir();
    new OverridesBackups(d).save(backup(1));
    new OverridesBackups(d).markRolledBack(CMD(1), { at: 5, by: 'cams-admin', cmdId: CMD(2) });
    expect(new OverridesBackups(d).get(CMD(1))!.rolledBack).toEqual({ at: 5, by: 'cams-admin', cmdId: CMD(2) });
  });
  it('byPath: the newest not-rolled-back backup that set each path', () => {
    const b = new OverridesBackups(dir());
    b.save(backup(1, 1000, [{ path: 'sse.pingS', before: { set: false }, after: { set: true, value: 7 } }, { path: 'sse.maxClients', before: { set: false }, after: { set: true, value: 9 } }]));
    b.save(backup(2, 2000, [{ path: 'sse.pingS', before: { set: true, value: 7 }, after: { set: true, value: 8 } }]));
    b.save(backup(3, 3000, [{ path: 'stills.quality', before: { set: false }, after: { set: true, value: 6 } }]));
    b.save(backup(4, 4000, [{ path: 'stills.size', before: { set: true, value: '1x1' }, after: { set: false } }]));
    b.markRolledBack(CMD(3), { at: 3500, by: 'local', user: 'admin' });
    const m = b.byPath();
    expect(m.get('sse.pingS')).toEqual({ cmdId: CMD(2), actor: 'admin@example.org', at: 2000, value: 8 });
    expect(m.get('sse.maxClients')).toEqual({ cmdId: CMD(1), actor: 'admin@example.org', at: 1000, value: 9 });
    expect(m.has('stills.quality')).toBe(false);
    expect(m.has('stills.size')).toBe(false); // an unset sets no value
    // cmd 2 rolled back: sse.pingS is cmd 1's value again, and marked so.
    b.markRolledBack(CMD(2), { at: 5000, by: 'cams-admin', cmdId: CMD(5) });
    b.save({ ...backup(5, 5000, [{ path: 'sse.pingS', before: { set: true, value: 8 }, after: { set: true, value: 7 } }]), command: 'config.rollback' });
    expect(b.byPath().get('sse.pingS')).toBeUndefined(); // the rollback restored it: not cams-admin's own value
  });
});
