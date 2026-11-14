import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { LEFTOVERS_MAX, LeftoversFile, passwordEnvItems } from '../src/moves/leftovers';

type E = { camera: string; n: number };
const ok = (e: unknown): e is E => !!e && typeof (e as E).camera === 'string' && typeof (e as E).n === 'number';
class Probe extends LeftoversFile<E> {
  all() {
    return this.read();
  }
}

describe('LeftoversFile', () => {
  const file = () => {
    const d = mkdtempSync(join(tmpdir(), 'cp-leftovers-'));
    mkdirSync(join(d, 'admin'), { mode: 0o700 });
    return join(d, 'admin', 'x.json');
  };

  it('keeps one entry per camera, the newest LEFTOVERS_MAX, copies only the known fields', () => {
    const f = new Probe(file(), ok, (e) => ({ camera: e.camera, n: e.n }));
    f.add({ camera: 'a', n: 1 });
    f.add({ camera: 'b', n: 2 });
    f.add({ camera: 'a', n: 3, extra: true } as E);
    expect(f.all()).toEqual([{ camera: 'b', n: 2 }, { camera: 'a', n: 3 }]);
    for (let i = 0; i < LEFTOVERS_MAX + 3; i++) f.add({ camera: `c${i}`, n: i });
    expect(f.all()).toHaveLength(LEFTOVERS_MAX);
    expect(f.all().at(-1)).toEqual({ camera: `c${LEFTOVERS_MAX + 2}`, n: LEFTOVERS_MAX + 2 });
  });

  it('reads a missing or corrupt file as none, and drops bad entries', () => {
    const path = file();
    const f = new Probe(path, ok, (e) => e);
    expect(f.all()).toEqual([]);
    writeFileSync(path, '{not json');
    expect(f.all()).toEqual([]);
    writeFileSync(path, JSON.stringify({ v: 1, entries: [{ camera: 'a', n: 1 }, { camera: 2 }, null] }));
    expect(f.all()).toEqual([{ camera: 'a', n: 1 }]);
    f.add({ camera: 'b', n: 2 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 1, entries: [{ camera: 'a', n: 1 }, { camera: 'b', n: 2 }] });
  });
});

describe('passwordEnvItems', () => {
  it('names a set (not blank) variable and its _FILE form', () => {
    expect(passwordEnvItems({ P: 'x', P_FILE: '/run/s' }, 'P')).toEqual(['env P', 'env P_FILE']);
    expect(passwordEnvItems({ P: '  ', P_FILE: '' }, 'P')).toEqual(['env P_FILE']);
    expect(passwordEnvItems({}, 'P')).toEqual([]);
  });
});
