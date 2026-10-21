import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { tightenAdminFiles } from '../src/fleet/private-file';
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
});
