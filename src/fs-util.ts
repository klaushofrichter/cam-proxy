import { statSync } from 'fs';
import { mkdir, readdir, rename, writeFile } from 'fs/promises';
import { dirname } from 'path';

// Writes a file whole or not at all: a temp file beside it, then a rename.
export async function writeFileAtomic(file: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

// A folder's names, or none when it can't be read (missing, pruned).
export async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
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
