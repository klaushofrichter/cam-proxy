import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { privateFileHooks, tightenAdminFiles } from '../src/fleet/private-file';
import { MoveJournal, type MoveRecord } from '../src/moves/journal';
import { hashMoveToken, moveTokenMatches } from '../src/moves/token';

const rec = (id: string, over: Partial<MoveRecord> = {}): MoveRecord => ({
  v: 1, id, role: 'target', camera: 'cam9', phase: 'opened', plan: null,
  peer: { proxyId: 'p-src', name: 'Source', url: 'https://src.example:8443', caFingerprints: ['ab:cd'], tlsServername: 'src.example' },
  token: 'plain-token', x25519: { privatePkcs8: 'priv', publicSpki: 'pub' },
  cameraConnection: { proxyCameraId: 'cam1', name: 'Garden', host: '192.0.2.10', protocol: 'https', user: 'proxy', onvifPort: 8000, rtspPort: 554, baichuanPort: 9000 },
  chunks: { 'clips:2026-10-01': { state: 'pending' } }, bytesDone: 0, startedAt: 1000, ...over,
});
const dir = () => join(mkdtempSync(join(tmpdir(), 'journal-')), 'admin', 'moves');

describe('move journal', () => {
  it('journal round-trips and lists active', () => {
    const j = new MoveJournal(dir());
    expect(j.load('m1')).toBeNull();
    expect(j.active()).toEqual([]);
    expect(j.currentPhase()).toBeNull();
    j.save(rec('m1'));
    j.save(rec('m2', { phase: 'copying', startedAt: 2000 }));
    j.save(rec('m3', { phase: 'finished', startedAt: 3000 }));
    expect(j.load('m1')).toEqual(rec('m1'));
    expect(j.active().map((r) => r.id)).toEqual(['m1', 'm2']);
    expect(j.currentPhase()).toEqual({ moveId: 'm2', role: 'target', phase: 'copying' });
    j.remove('m2');
    expect(j.load('m2')).toBeNull();
    expect(() => j.load('../x')).toThrow();
  });

  it('journal file is 600 and a 644 file is tightened', () => {
    const d = dir();
    const j = new MoveJournal(d);
    j.save(rec('m1'));
    const f = join(d, 'm1.json');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    chmodSync(f, 0o644);
    expect(j.load('m1')?.id).toBe('m1');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    chmodSync(f, 0o644);
    expect(tightenAdminFiles(join(d, '..'))).toEqual([]);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('corrupt journal is set aside, not thrown', () => {
    const d = dir();
    const seen: string[] = [];
    const j = new MoveJournal(d, (m) => seen.push(m));
    j.save(rec('m1'));
    writeFileSync(join(d, 'm1.json'), '{not json');
    writeFileSync(join(d, 'm2.json'), JSON.stringify({ v: 2 }));
    expect(j.load('m1')).toBeNull();
    expect(j.active()).toEqual([]);
    expect(readdirSync(d).filter((n) => n.includes('.bad-')).length).toBe(2);
    expect(existsSync(join(d, 'm1.json'))).toBe(false);
    expect(seen.length).toBe(2);
    expect(j.problems().length).toBe(2);
    expect(seen.join()).not.toContain('not json');
  });

  it('holds a source record with a token hash and compares tokens in constant time', () => {
    const d = dir();
    const j = new MoveJournal(d);
    const h = hashMoveToken('secret-token');
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    j.save(rec('m1', { role: 'source', token: undefined, x25519: undefined, tokenHash: h }));
    expect(readFileSync(join(d, 'm1.json'), 'utf8')).not.toContain('secret-token');
    const stored = j.load('m1')!.tokenHash!;
    expect(moveTokenMatches('secret-token', stored)).toBe(true);
    expect(moveTokenMatches('secret-tokeN', stored)).toBe(false);
    expect(moveTokenMatches('x', stored)).toBe(false);
    expect(moveTokenMatches('secret-token', 'sha256:abc')).toBe(false);
    expect(moveTokenMatches('secret-token', '')).toBe(false);
  });

  describe('read failures that are not corruption', () => {
    afterEach(() => {
      delete privateFileHooks.fstat;
    });

    it('an unsafe-owner journal is refused, not renamed, and the move is kept', () => {
      const d = dir();
      const j = new MoveJournal(d);
      j.save(rec('m1'));
      privateFileHooks.fstat = (fd) => ({ mode: 0o600, uid: (process.getuid?.() ?? 0) + 1 + fd * 0 });
      expect(() => j.load('m1')).toThrow(/another user/);
      expect(() => j.active()).toThrow();
      expect(readdirSync(d)).toEqual(['m1.json']);
      delete privateFileHooks.fstat;
      expect(j.active().map((r) => r.id)).toEqual(['m1']);
      expect(j.problems()).toEqual([]);
    });

    it('a transient EMFILE is not renamed and the move is not lost', () => {
      const d = dir();
      const j = new MoveJournal(d);
      j.save(rec('m1'));
      privateFileHooks.fstat = () => {
        throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
      };
      expect(() => j.load('m1')).toThrow(/too many/);
      expect(readdirSync(d)).toEqual(['m1.json']);
      delete privateFileHooks.fstat;
      expect(j.load('m1')?.id).toBe('m1');
    });
  });

  it('tightenAdminFiles tightens the cached manifests in moves/<id>.manifests/', () => {
    const d = dir();
    const side = join(d, 'mv_1.manifests');
    mkdirSync(side, { recursive: true, mode: 0o755 });
    chmodSync(side, 0o755);
    const f = join(side, 'clips-2026-10-01.json');
    writeFileSync(f, '{}', { mode: 0o644 });
    chmodSync(f, 0o644);
    expect(tightenAdminFiles(join(d, '..'))).toEqual([]);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(side).mode & 0o777).toBe(0o700);
  });

  it('all() and load() ignore the manifest folders', () => {
    const d = dir();
    const j = new MoveJournal(d);
    j.save(rec('m1'));
    mkdirSync(join(d, 'm1.manifests'), { recursive: true });
    writeFileSync(join(d, 'm1.manifests', 'clips-2026-10-01.json'), '{}');
    mkdirSync(join(d, 'm2.json'), { recursive: true }); // a folder named like a record
    expect(j.all().map((r) => r.id)).toEqual(['m1']);
    expect(j.problems()).toEqual([]);
    expect(() => j.load('m1.manifests')).toThrow();
  });

  it('tightenAdminFiles tightens set-aside and temp files in moves/', () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    const bad = join(d, 'm1.json.bad-123');
    const tmp = join(d, '.tmp-abcd.tmp');
    for (const f of [bad, tmp]) writeFileSync(f, 'x', { mode: 0o644 });
    chmodSync(bad, 0o644);
    chmodSync(tmp, 0o644);
    expect(tightenAdminFiles(join(d, '..'))).toEqual([]);
    expect(statSync(bad).mode & 0o777).toBe(0o600);
    expect(statSync(tmp).mode & 0o777).toBe(0o600);
  });

  it('tombstones: one per ended move and role, 600, not records, kept 7 days then swept with orphan chunk parts (final review 4)', () => {
    const d = dir();
    let now = 10 * 86_400_000;
    const j = new MoveJournal(d, undefined, { now: () => now });
    j.save(rec('m1'));
    j.bury({ moveId: 'm2', role: 'source', phase: 'finished', deleted: { stills: { files: 1, bytes: 2 } } as never });
    j.bury({ moveId: 'm3', role: 'target', phase: 'failed', code: 'token_address' });
    expect(statSync(join(d, 'm2.source.ended.json')).mode & 0o777).toBe(0o600);
    expect(j.all().map((r) => r.id)).toEqual(['m1']);
    expect(j.ended('m2', 'source')).toMatchObject({ moveId: 'm2', role: 'source', phase: 'finished', deleted: { stills: { files: 1, bytes: 2 } }, endedAt: now });
    expect(j.ended('m2', 'target')).toBeNull();
    expect(j.ended('m3', 'target')).toMatchObject({ phase: 'failed', code: 'token_address' });
    // Chunk parts of a move with no record go; those of a record stay.
    mkdirSync(join(d, 'm1.chunks'));
    mkdirSync(join(d, 'm9.chunks'));
    j.sweep();
    expect(existsSync(join(d, 'm1.chunks'))).toBe(true);
    expect(existsSync(join(d, 'm9.chunks'))).toBe(false);
    now += 7 * 86_400_000 + 1;
    expect(j.ended('m2', 'source')).toBeNull();
    j.sweep();
    expect(readdirSync(d).filter((f) => f.endsWith('.ended.json'))).toEqual([]);
    expect(j.load('m1')).not.toBeNull();
  });

  it('failed() lists the records of failed moves with their code, for the welcome re-emit (final review 4)', () => {
    const j = new MoveJournal(dir());
    j.save(rec('m1', { phase: 'failed', failure: 'token_address', role: 'source' }));
    j.save(rec('m2', { phase: 'copying' }));
    expect(j.failed()).toEqual([{ moveId: 'm1', role: 'source', code: 'token_address' }]);
  });

  it('a move id that would leave the journal folder is refused by every file operation (CodeQL js/path-injection)', () => {
    const d = dir();
    const j = new MoveJournal(d);
    j.save(rec('m1'));
    for (const id of ['../x', '..', '/etc/passwd', '..%2F..%2Fx', 'a/b', 'a\\b', '%2e%2e', '']) {
      expect(() => j.load(id), id).toThrow('invalid move id');
      expect(() => j.save(rec(id)), id).toThrow('invalid move id');
      expect(() => j.remove(id), id).toThrow('invalid move id');
      expect(() => j.bury({ moveId: id, role: 'source', phase: 'finished' }), id).toThrow('invalid move id');
      expect(j.ended(id, 'source'), id).toBeNull();
    }
    expect(readdirSync(join(d, '..')).sort()).toEqual(['moves']);
    expect(readdirSync(d)).toEqual(['m1.json']);
  });
});
