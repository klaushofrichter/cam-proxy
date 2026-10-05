import { resolve, sep } from 'path';

// The path guard (spec 2026-10-05-archive-design §1.2): every file the
// Archive reads, writes or deletes goes through archivePath. The camera id
// must look like one (config's camera.id pattern), the id is a positive
// integer, the file one of three names, and the result must lie inside
// <dataDir>/archive/. No request value ever becomes a path: callers pass a
// row's fields.
export const ARCHIVE_FILES = ['clip.mp4', 'thumb.jpg', 'meta.json'] as const;
export type ArchiveFile = (typeof ARCHIVE_FILES)[number];
export const CAM_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export class ArchivePathError extends Error {}

export const archiveRoot = (dataDir: string) => resolve(dataDir, 'archive');

// Inside the archive folder, or throws.
export function inside(dataDir: string, path: string): string {
  const root = archiveRoot(dataDir);
  const p = resolve(path);
  if (!p.startsWith(root + sep)) throw new ArchivePathError('outside the archive folder');
  return p;
}

// <dataDir>/archive/<cam>/<id>[/<file>].
export function archivePath(dataDir: string, cam: string, id: number, file?: ArchiveFile): string {
  if (!CAM_ID.test(cam)) throw new ArchivePathError('not a camera id');
  if (!Number.isSafeInteger(id) || id < 1) throw new ArchivePathError('not an archive id');
  if (file !== undefined && !(ARCHIVE_FILES as readonly string[]).includes(file)) throw new ArchivePathError('not an archive file');
  return inside(dataDir, resolve(archiveRoot(dataDir), cam, String(id), ...(file ? [file] : [])));
}
