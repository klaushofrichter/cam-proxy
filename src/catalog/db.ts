import { DatabaseSync } from 'node:sqlite';
import { accessSync, constants, existsSync, mkdirSync, statSync } from 'fs';
import { dirname } from 'path';
import { MIGRATIONS } from './migrations';
import { logger } from '../log';

// The catalog: SQLite in WAL mode (node:sqlite, no native module). Images
// never go in here.
export interface Catalog {
  db: DatabaseSync;
  file: string;
  close(): void;
  schemaVersion(): number;
  sizeBytes(): number; // the database plus its WAL and shared-memory files
}

export function openCatalog(file: string): Catalog {
  let db: DatabaseSync;
  try {
    mkdirSync(dirname(file), { recursive: true });
    // SQLite opens a file it can't write read-only and fails only at the
    // first write (issue #34): check up front.
    if (existsSync(file)) {
      try {
        accessSync(file, constants.W_OK);
      } catch {
        throw new Error(`the catalog file ${file} isn't writable by this process (uid ${process.getuid?.() ?? '?'}): chown it (and its folder) to that user`);
      }
    }
    db = new DatabaseSync(file);
  } catch (err) {
    if ((err as Error).message.startsWith('the catalog file ')) throw err;
    // A volume mounted as root said only EACCES (issue #5): name the folder.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || /readonly|unable to open/i.test((err as Error).message)) {
      throw new Error(`the data folder ${dirname(file)} isn't writable by this process (uid ${process.getuid?.() ?? '?'}): chown it to that user, or set server.dataDir to a writable folder`);
    }
    throw err;
  }
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const version = () => (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }).v ?? 0;
  if (version() > MIGRATIONS.length) {
    logger.warn({ file, version: version(), known: MIGRATIONS.length }, 'catalog_newer_than_code');
  }
  for (let v = version(); v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v + 1);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  const size = (f: string) => {
    try {
      return statSync(f).size;
    } catch {
      return 0;
    }
  };
  return {
    db,
    file,
    close: () => db.close(),
    schemaVersion: version,
    sizeBytes: () => size(file) + size(`${file}-wal`) + size(`${file}-shm`),
  };
}
