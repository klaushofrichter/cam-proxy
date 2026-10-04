import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { checkEnvPath, EnvFileError, readEnvValue, setEnvLine, writeEnvKey } from '../src/config/env-file';

const SECRETS = 'CAMPROXY_TOKENS=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nCAMPROXY_ADMIN_TOKEN="bbb # not a comment"\n';

describe('readEnvValue', () => {
  it('reads plain, quoted, export and commented-out lines', () => {
    const t = '# CAMERA_HOST=10.0.0.9\nCAMERA_HOST=10.0.0.1\n';
    expect(readEnvValue(t, 'CAMERA_HOST')).toBe('10.0.0.1');
    expect(readEnvValue('export CAMERA_HOST="10.0.0.2"\n', 'CAMERA_HOST')).toBe('10.0.0.2');
    expect(readEnvValue("CAMERA_HOST='10.0.0.3'", 'CAMERA_HOST')).toBe('10.0.0.3');
    expect(readEnvValue('CAMERA_HOST=10.0.0.4 # den\n', 'CAMERA_HOST')).toBe('10.0.0.4');
    expect(readEnvValue('  CAMERA_HOST = 10.0.0.5\r\n', 'CAMERA_HOST')).toBe('10.0.0.5');
    expect(readEnvValue('# CAMERA_HOST=10.0.0.9\n', 'CAMERA_HOST')).toBeUndefined();
    expect(readEnvValue('XCAMERA_HOST=1\n', 'CAMERA_HOST')).toBeUndefined();
  });
  it('takes the last of duplicate keys (the one that counts)', () => {
    expect(readEnvValue('CAMERA_HOST=a\nCAMERA_HOST=b\n', 'CAMERA_HOST')).toBe('b');
  });
  it('returns an empty value as empty', () => {
    expect(readEnvValue('CAMERA_HOST=\n', 'CAMERA_HOST')).toBe('');
  });
});

describe('setEnvLine', () => {
  it('replaces only that line; every other byte stays', () => {
    const before = `${SECRETS}# the camera\nCAMERA_HOST=10.0.0.1\nPI_ADDRESS=10.0.0.2\n`;
    const after = setEnvLine(before, 'CAMERA_HOST', '10.0.0.7');
    expect(after).toBe(`${SECRETS}# the camera\nCAMERA_HOST=10.0.0.7\nPI_ADDRESS=10.0.0.2\n`);
  });
  it('leaves comments alone, also a commented-out assignment', () => {
    const before = '# CAMERA_HOST=old\nCAMERA_HOST=10.0.0.1\n';
    expect(setEnvLine(before, 'CAMERA_HOST', '10.0.0.7')).toBe('# CAMERA_HOST=old\nCAMERA_HOST=10.0.0.7\n');
  });
  it('replaces a quoted value, keeping indentation, export and an inline comment', () => {
    expect(setEnvLine('  export CAMERA_HOST="10.0.0.1" # den\n', 'CAMERA_HOST', '10.0.0.7')).toBe('  export CAMERA_HOST=10.0.0.7 # den\n');
    expect(setEnvLine("CAMERA_HOST='10.0.0.1'\n", 'CAMERA_HOST', '10.0.0.7')).toBe('CAMERA_HOST=10.0.0.7\n');
    expect(setEnvLine('CAMERA_HOST=10.0.0.1 # den\n', 'CAMERA_HOST', '10.0.0.7')).toBe('CAMERA_HOST=10.0.0.7 # den\n');
  });
  it('keeps CRLF line endings, and uses CRLF for an appended line', () => {
    expect(setEnvLine('A=1\r\nCAMERA_HOST=x\r\nB=2\r\n', 'CAMERA_HOST', 'y')).toBe('A=1\r\nCAMERA_HOST=y\r\nB=2\r\n');
    expect(setEnvLine('A=1\r\nB=2\r\n', 'CAMERA_HOST', 'y')).toBe('A=1\r\nB=2\r\nCAMERA_HOST=y\r\n');
  });
  it('appends after a missing trailing newline', () => {
    expect(setEnvLine('A=1', 'CAMERA_HOST', 'y')).toBe('A=1\nCAMERA_HOST=y\n');
    expect(setEnvLine('', 'CAMERA_HOST', 'y')).toBe('CAMERA_HOST=y\n');
  });
  it('replaces a last line without a newline, adding none', () => {
    expect(setEnvLine('A=1\nCAMERA_HOST=x', 'CAMERA_HOST', 'y')).toBe('A=1\nCAMERA_HOST=y');
  });
  it('with duplicate keys replaces only the last one', () => {
    expect(setEnvLine('CAMERA_HOST=a\nB=2\nCAMERA_HOST=b\n', 'CAMERA_HOST', 'c')).toBe('CAMERA_HOST=a\nB=2\nCAMERA_HOST=c\n');
  });
  it('never touches a key that only starts the same', () => {
    expect(setEnvLine('CAMERA_HOST_OLD=a\n', 'CAMERA_HOST', 'c')).toBe('CAMERA_HOST_OLD=a\nCAMERA_HOST=c\n');
  });
  it('refuses a value that would need quoting', () => {
    expect(() => setEnvLine('', 'CAMERA_HOST', 'a b')).toThrow(EnvFileError);
    expect(() => setEnvLine('', 'CAMERA_HOST', 'a\nB=1')).toThrow(EnvFileError);
  });
});

const dir = () => mkdtempSync(join(tmpdir(), 'envfile-'));

describe('checkEnvPath', () => {
  it('accepts an absolute .env regular file', () => {
    const d = dir();
    writeFileSync(join(d, '.env'), 'A=1\n');
    expect(checkEnvPath(join(d, '.env'))).toBe(join(d, '.env'));
    writeFileSync(join(d, '.env.pi'), 'A=1\n');
    expect(checkEnvPath(join(d, '.env.pi'))).toBe(join(d, '.env.pi'));
  });
  it('refuses unset, relative, .., other names, missing files, symlinks, directories and big files', () => {
    const d = dir();
    writeFileSync(join(d, '.env'), 'A=1\n');
    writeFileSync(join(d, 'config.json'), '{}');
    symlinkSync(join(d, '.env'), join(d, '.env.link'));
    mkdirSync(join(d, '.env.dir'));
    writeFileSync(join(d, '.env.big'), 'x'.repeat(70 * 1024));
    const why = (p: string | undefined) => {
      try {
        checkEnvPath(p);
        return 'ok';
      } catch (e) {
        return (e as EnvFileError).code;
      }
    };
    expect(why(undefined)).toBe('not_set');
    expect(why('.env')).toBe('bad_path');
    expect(why(`${d}/sub/../.env`)).toBe('bad_path');
    expect(why(join(d, 'config.json'))).toBe('bad_path');
    expect(why(join(d, '.env.missing'))).toBe('missing');
    expect(why(join(d, '.env.link'))).toBe('not_a_file');
    expect(why(join(d, '.env.dir'))).toBe('not_a_file');
    expect(why(join(d, '.env.big'))).toBe('too_large');
  });
});

describe('writeEnvKey', () => {
  const at = new Date(Date.UTC(2026, 9, 4, 13, 5, 9));
  it('writes a backup, then the file atomically with its mode kept', () => {
    const d = dir();
    const f = join(d, '.env');
    const before = `${SECRETS}CAMERA_HOST=10.0.0.1\n`;
    writeFileSync(f, before, { mode: 0o600 });
    chmodSync(f, 0o640);
    const r = writeEnvKey(f, 'CAMERA_HOST', '10.0.0.7', at);
    expect(r).toEqual({ previous: '10.0.0.1', backup: '.env.bak-20261004-130509' });
    expect(readFileSync(f, 'utf8')).toBe(`${SECRETS}CAMERA_HOST=10.0.0.7\n`);
    expect(statSync(f).mode & 0o777).toBe(0o640);
    expect(readFileSync(join(d, r.backup), 'utf8')).toBe(before);
    expect(statSync(join(d, r.backup)).mode & 0o777).toBe(0o640);
    expect(readdirSync(d).sort()).toEqual(['.env', '.env.bak-20261004-130509']);
  });
  it('a second write in the same second gets its own backup', () => {
    const d = dir();
    const f = join(d, '.env');
    writeFileSync(f, 'CAMERA_HOST=a\n');
    writeEnvKey(f, 'CAMERA_HOST', 'b', at);
    const r = writeEnvKey(f, 'CAMERA_HOST', 'c', at);
    expect(r.backup).toBe('.env.bak-20261004-130509-2');
    expect(readFileSync(join(d, r.backup), 'utf8')).toBe('CAMERA_HOST=b\n');
  });
  it('replaces CAMPROXY_CAMERA_HOST instead when the file sets that name', () => {
    const d = dir();
    const f = join(d, '.env');
    writeFileSync(f, 'CAMERA_HOST=a\nCAMPROXY_CAMERA_HOST=b\n');
    expect(writeEnvKey(f, ['CAMPROXY_CAMERA_HOST', 'CAMERA_HOST'], 'c', at).previous).toBe('b');
    expect(readFileSync(f, 'utf8')).toBe('CAMERA_HOST=a\nCAMPROXY_CAMERA_HOST=c\n');
  });
  it('appends when the key is missing; previous is null', () => {
    const d = dir();
    const f = join(d, '.env');
    writeFileSync(f, 'A=1');
    expect(writeEnvKey(f, 'CAMERA_HOST', 'c', at).previous).toBeNull();
    expect(readFileSync(f, 'utf8')).toBe('A=1\nCAMERA_HOST=c\n');
  });
  it('leaves the file and no temp file behind when the directory is not writable', () => {
    if (process.getuid?.() === 0) return; // root writes anyway
    const d = dir();
    const f = join(d, '.env');
    writeFileSync(f, 'CAMERA_HOST=a\n');
    chmodSync(d, 0o500);
    try {
      expect(() => writeEnvKey(f, 'CAMERA_HOST', 'b', at)).toThrow(EnvFileError);
    } finally {
      chmodSync(d, 0o700);
    }
    expect(readFileSync(f, 'utf8')).toBe('CAMERA_HOST=a\n');
    expect(readdirSync(d)).toEqual(['.env']);
    expect(existsSync(join(d, '.env.tmp'))).toBe(false);
  });
});
