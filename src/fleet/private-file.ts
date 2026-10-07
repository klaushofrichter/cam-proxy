import { randomBytes } from 'crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'fs';
import { dirname, join } from 'path';

// The files in <dataDir>/admin/ (key.json, tokens.json, commands.json,
// policy.json): mode 600 in a 700 folder, written atomically, refused when
// group- or world-readable or owned by another user (spec
// 2026-10-06-cams-admin-phase1-design §9.2). Never printed, logged or served;
// error messages name the file, never its content.
export class PrivateFileUnsafe extends Error {}
export class PrivateFileInvalid extends Error {}

export type Stat = (p: string) => { mode: number; uid: number };

// Throws PrivateFileUnsafe / PrivateFileInvalid (and the fs error when it is missing).
export function readPrivateJson(path: string, o: { stat?: Stat; uid?: number; unsafe?: typeof PrivateFileUnsafe; invalid?: typeof PrivateFileInvalid } = {}): unknown {
  const Unsafe = o.unsafe ?? PrivateFileUnsafe;
  const Invalid = o.invalid ?? PrivateFileInvalid;
  const st = (o.stat ?? statSync)(path);
  const uid = o.uid ?? process.getuid?.();
  if (st.mode & 0o077) throw new Unsafe(`${path} can be read by others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
  if (uid !== undefined && st.uid !== uid) throw new Unsafe(`${path} belongs to another user (uid ${st.uid})`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Invalid(`${path} is not valid JSON`);
  }
}

// Folder 700, file 600, a random temp name, fsync, rename: a crash leaves the
// old file or the new one, never half of one; a failure removes the temp file.
export function writePrivateJson(path: string, value: unknown, pretty = true): void {
  const text = `${pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}.tmp`);
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
