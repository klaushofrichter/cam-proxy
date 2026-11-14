import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { inTransaction } from '../src/catalog/db';

describe('inTransaction', () => {
  const fresh = () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (x INTEGER)');
    return db;
  };
  const count = (db: DatabaseSync) => (db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n;

  it('commits and returns what fn returns', () => {
    const db = fresh();
    expect(inTransaction(db, () => (db.prepare('INSERT INTO t VALUES (1)').run(), 'done'))).toBe('done');
    expect(count(db)).toBe(1);
  });

  it('rolls back and rethrows when fn throws; the db stays usable', () => {
    const db = fresh();
    expect(() => inTransaction(db, () => {
      db.prepare('INSERT INTO t VALUES (1)').run();
      throw new Error('boom');
    })).toThrow('boom');
    expect(count(db)).toBe(0);
    expect(db.isTransaction).toBe(false);
    inTransaction(db, () => db.prepare('INSERT INTO t VALUES (2)').run());
    expect(count(db)).toBe(1);
  });
});
