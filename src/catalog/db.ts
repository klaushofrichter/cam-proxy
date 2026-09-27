import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'fs';
import { dirname } from 'path';
import { MIGRATIONS } from './migrations';

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
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const version = () => (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }).v ?? 0;
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
