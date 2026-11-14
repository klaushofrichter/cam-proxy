import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { writeFileAtomicSync } from '../src/fs-util';

describe('writeFileAtomicSync', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'cp-atomic-'));

  it('writes the file whole and leaves no temp file', () => {
    const d = dir();
    const f = join(d, 'a.json');
    writeFileSync(f, 'old');
    writeFileAtomicSync(f, 'new', { dirFsync: true });
    expect(readFileSync(f, 'utf8')).toBe('new');
    expect(readdirSync(d)).toEqual(['a.json']);
  });

  it('applies the mode exactly with chmod, through the umask without', () => {
    const d = dir();
    const old = process.umask(0o077);
    try {
      writeFileAtomicSync(join(d, 'exact'), 'x', { mode: 0o644, chmod: true });
      writeFileAtomicSync(join(d, 'masked'), 'x', { mode: 0o644 });
    } finally {
      process.umask(old);
    }
    expect(statSync(join(d, 'exact')).mode & 0o777).toBe(0o644);
    expect(statSync(join(d, 'masked')).mode & 0o777).toBe(0o600);
  });

  it('keeps the old file and removes the temp file when the rename fails', () => {
    const d = dir();
    const target = join(d, 'target');
    mkdirSync(target); // a folder: rename of a file over it fails
    writeFileSync(join(target, 'keep'), 'k');
    expect(() => writeFileAtomicSync(target, 'data')).toThrow();
    expect(readdirSync(d)).toEqual(['target']);
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('k');
  });
});
