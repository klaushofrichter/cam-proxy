import { randomBytes } from 'crypto';
import { closeSync, fchmodSync, fsyncSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { mkdir, readdir, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';

// Writes a file whole or not at all: a temp file beside it, then a rename.
export async function writeFileAtomic(file: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

// The same, synchronously and durably: a fresh temp file beside it (O_EXCL,
// never through a planted file or symlink), fsync, rename; the temp file is
// removed when a step after its creation fails. `mode`: the new file's (the
// umask applies, unless `chmod`: then exactly that). `dirFsync`: also sync the
// folder, so the rename survives a power cut.
export function writeFileAtomicSync(file: string, data: Buffer | string, o: { mode?: number; chmod?: boolean; dirFsync?: boolean } = {}): void {
  const mode = o.mode ?? 0o666;
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const fd = openSync(tmp, 'wx', mode);
  try {
    try {
      if (o.chmod) fchmodSync(fd, mode);
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  if (!o.dirFsync) return;
  try {
    const d = openSync(dirname(file), 'r');
    try {
      fsyncSync(d);
    } finally {
      closeSync(d);
    }
  } catch {
    // Not every platform syncs a folder; the rename is done.
  }
}

// A folder's names, or none when it can't be read (missing, pruned).
export async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
export function listDirSync(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// A file's size, or 0 when it can't be read.
export function fileSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
