import { randomBytes } from 'crypto';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'fs';
import { dirname, join } from 'path';

// The files in <dataDir>/admin/ (key.json, tokens.json, commands.json,
// policy.json, replay.json, replay-mark.json): mode 600 in a 700 folder,
// written atomically, never printed, logged or served; error messages name
// the file, never its content (spec 2026-10-06-cams-admin-phase1-design §9.2).
// A file of ours that is looser than 600 is tightened before it is read: in
// the cluster the pod's fsGroup makes kubelet add g+rw to every file of the
// volume (660) on each pod start. A file owned by another user, or one that
// stays loose after the chmod, is refused (PrivateFileUnsafe).
export class PrivateFileUnsafe extends Error {}
export class PrivateFileInvalid extends Error {}

export type Stat = (fd: number) => { mode: number; uid: number };

// The files tightenAdminFiles() sweeps at startup.
export const ADMIN_FILES = ['key.json', 'tokens.json', 'commands.json', 'policy.json', 'replay.json', 'replay-mark.json'] as const;

// Tests: another owner (fstat), a chmod that does not take (fchmod).
// onTightened: the proxy logs it (the path and the old mode, never content).
export const privateFileHooks: {
  fstat?: Stat;
  fchmod?: (fd: number, mode: number) => void;
  onTightened?: (path: string, from: number) => void;
} = {};

const octal = (m: number) => (m & 0o777).toString(8);

// The folder of a private file: 700 when it is ours (a failure is no refusal:
// the file's own mode is what protects its content).
function tightenDir(dir: string, uid: number | undefined): void {
  try {
    const st = statSync(dir);
    if ((st.mode & 0o077) && (uid === undefined || st.uid === uid)) chmodSync(dir, 0o700);
  } catch {
    /* not there or not ours: left as it is */
  }
}

// On an open fd (no window between the check and the read): ours, and 600
// or tightened to it; else PrivateFileUnsafe.
function secureFd(fd: number, path: string, o: { stat?: Stat; uid?: number; unsafe: typeof PrivateFileUnsafe }): void {
  const fst = o.stat ?? privateFileHooks.fstat ?? ((f: number) => fstatSync(f));
  const st = fst(fd);
  const uid = o.uid ?? process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new o.unsafe(`${path} belongs to another user (uid ${st.uid}): refused`);
  if (!(st.mode & 0o077)) return;
  try {
    (privateFileHooks.fchmod ?? fchmodSync)(fd, 0o600);
  } catch {
    /* checked below */
  }
  const after = fst(fd);
  if (after.mode & 0o077) throw new o.unsafe(`${path} can be read by others (mode ${octal(after.mode)}) and could not be set to 600: refused`);
  privateFileHooks.onTightened?.(path, st.mode & 0o777);
}

// Open for reading; a file this user may not read (another owner's 600) is unsafe, not missing.
function openPrivate(path: string, Unsafe: typeof PrivateFileUnsafe): number {
  try {
    return openSync(path, constants.O_RDONLY);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      let owner = '';
      try {
        owner = ` (owner uid ${statSync(path).uid})`;
      } catch {
        /* the message without it */
      }
      throw new Unsafe(`${path} can't be read by this user${owner}: refused`);
    }
    throw err;
  }
}

// Throws PrivateFileUnsafe / PrivateFileInvalid (and the fs error when it is missing).
export function readPrivateJson(path: string, o: { stat?: Stat; uid?: number; unsafe?: typeof PrivateFileUnsafe; invalid?: typeof PrivateFileInvalid } = {}): unknown {
  const Unsafe = o.unsafe ?? PrivateFileUnsafe;
  const Invalid = o.invalid ?? PrivateFileInvalid;
  const uid = o.uid ?? process.getuid?.();
  tightenDir(dirname(path), uid);
  const fd = openPrivate(path, Unsafe);
  let text: string;
  try {
    secureFd(fd, path, { stat: o.stat, uid: o.uid, unsafe: Unsafe });
    text = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Invalid(`${path} is not valid JSON`);
  }
}

// Startup: the admin folder and its files, where they exist and are ours,
// tightened to 700 / 600 (nothing created, nothing read). Returns the files
// that are refused (another owner, or still loose), for one clear log line each.
export function tightenAdminFiles(dir: string): { file: string; reason: string }[] {
  const refused: { file: string; reason: string }[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return refused;
  }
  const uid = process.getuid?.();
  tightenDir(dir, uid);
  for (const n of ADMIN_FILES) {
    if (!names.includes(n)) continue;
    const path = join(dir, n);
    let fd: number;
    try {
      fd = openPrivate(path, PrivateFileUnsafe);
    } catch (err) {
      if (err instanceof PrivateFileUnsafe) refused.push({ file: path, reason: err.message });
      continue;
    }
    try {
      secureFd(fd, path, { unsafe: PrivateFileUnsafe });
    } catch (err) {
      refused.push({ file: path, reason: (err as Error).message });
    } finally {
      closeSync(fd);
    }
  }
  return refused;
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
      // 600 whatever the umask or a default ACL made of it.
      fchmodSync(fd, 0o600);
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
