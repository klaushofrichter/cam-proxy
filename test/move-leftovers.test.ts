// What a proxy a camera left can't remove itself (plan D Task 7, spec
// 2026-10-30-ptz-capabilities-design §7). Made-up values only.
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { applyOverrides, loadConfig, type Loaded } from '../src/config/load';
import { leftoverItems, LEFTOVERS_MAX, MoveLeftovers, removePasswordLine } from '../src/moves/leftovers';

const MOVE = 'mv_0123456789ABCDEFGHJK';
const BASE = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'x' };
const PW = 'CAMPROXY_CAMERA_PASSWORD_CAM4';

function loadedWith(o: { env?: Record<string, string>; added?: boolean; moved?: boolean; envFile?: string } = {}): { loaded: Loaded; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-leftovers-'));
  const cam4 = { id: 'cam4', host: '192.0.2.4', protocol: 'https', user: 'proxy' };
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ cameras: [{ id: 'cam1', host: '' }, ...(o.added ? [] : [cam4])] }));
  let loaded = loadConfig({ ...BASE, ...(o.env ?? {}), ...(o.envFile ? { CAMPROXY_ENV_FILE: o.envFile } : {}) }, { cwd: dir });
  if (o.added) loaded = applyOverrides(loaded, { cameras: { cam4: { host: '192.0.2.4', protocol: 'https', user: 'proxy' } } });
  if (o.moved !== false) loaded = o.added ? loaded : applyOverrides(loaded, { cameras: { cam4: { moved: MOVE } } });
  return { loaded, dir };
}

describe('leftoverItems', () => {
  it('a hidden config.json entry, an env password, an env _FILE', () => {
    const base = loadedWith({ env: { [PW]: 'x' } }).loaded;
    // The _FILE secret as the process has it (loadConfig would read the file).
    const loaded = { ...base, env: { ...base.env, [`${PW}_FILE`]: '/run/secrets/x' } } as Loaded;
    expect(leftoverItems(loaded, 'cam4', MOVE)).toEqual(['config.json entry', `env ${PW}`, `env ${PW}_FILE`]);
    expect(leftoverItems(loaded, 'cam4', 'mv_ZZZZZZZZZZZZZZZZZZZZ')).toEqual([`env ${PW}`, `env ${PW}_FILE`]);
  });
  it('an overrides-added camera has no config.json entry; a blank password is none', () => {
    const { loaded } = loadedWith({ added: true, env: { [PW]: '  ' } });
    expect(leftoverItems(loaded, 'cam4', MOVE)).toEqual([]);
  });
});

describe('MoveLeftovers', () => {
  it('current drops resolved items and a camera running here again', () => {
    const { loaded, dir } = loadedWith({ env: { [PW]: 'x' } });
    const store = new MoveLeftovers(join(dir, 'data'));
    store.add({ camera: 'cam4', moveId: MOVE, items: ['config.json entry', `env ${PW}`] });
    expect(store.current(loaded)).toEqual([{ camera: 'cam4', moveId: MOVE, items: ['config.json entry', `env ${PW}`] }]);
    // The env value gone (a recreated container): only the entry is left.
    expect(store.current(loadedWith().loaded)).toEqual([{ camera: 'cam4', moveId: MOVE, items: ['config.json entry'] }]);
    // Running here again (not hidden): nothing.
    expect(store.current(loadedWith({ env: { [PW]: 'x' }, moved: false }).loaded)).toEqual([]);
  });
  it('add keeps one entry per camera and at most 16', () => {
    const { loaded, dir } = loadedWith();
    const env = { ...loaded, env: { ...loaded.env } } as Loaded;
    const store = new MoveLeftovers(join(dir, 'data'));
    for (let i = 0; i < 20; i++) {
      const cam = `cam${i + 10}`;
      env.env[`CAMPROXY_CAMERA_PASSWORD_CAM${i + 10}`] = 'x';
      store.add({ camera: cam, moveId: MOVE, items: [`env CAMPROXY_CAMERA_PASSWORD_CAM${i + 10}`] });
    }
    store.add({ camera: 'cam29', moveId: MOVE, items: ['env CAMPROXY_CAMERA_PASSWORD_CAM29'] });
    const cur = store.current(env);
    expect(cur).toHaveLength(LEFTOVERS_MAX);
    expect(cur.map((e) => e.camera)).toEqual([...Array.from({ length: 15 }, (_, i) => `cam${i + 14}`), 'cam29']);
  });
  it('the store file is 0600 and survives a new instance', () => {
    const { loaded, dir } = loadedWith({ env: { [PW]: 'x' } });
    new MoveLeftovers(join(dir, 'data')).add({ camera: 'cam4', moveId: MOVE, items: [`env ${PW}`] });
    const path = join(dir, 'data', 'admin', 'move-leftovers.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain('"x"');
    expect(new MoveLeftovers(join(dir, 'data')).current(loaded)).toEqual([{ camera: 'cam4', moveId: MOVE, items: [`env ${PW}`] }]);
  });
});

describe('removePasswordLine', () => {
  const at = new Date(Date.UTC(2026, 9, 30, 9, 0, 0));
  const envDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'camproxy-leftovers-env-'));
    const f = join(d, '.env');
    writeFileSync(f, `A=1\n${PW}=test-only\nB=2\n`);
    return { d, f };
  };
  it('removed / not_in_file', () => {
    const { f } = envDir();
    const { loaded } = loadedWith({ envFile: f });
    expect(removePasswordLine(loaded, 'cam4', at)).toEqual({ outcome: 'removed', key: PW });
    expect(readFileSync(f, 'utf8')).toBe('A=1\nB=2\n');
    expect(removePasswordLine(loaded, 'cam4', at)).toEqual({ outcome: 'not_in_file', key: PW });
  });
  it('not_managed without CAMPROXY_ENV_FILE', () => {
    expect(removePasswordLine(loadedWith().loaded, 'cam4', at)).toEqual({ outcome: 'not_managed', key: PW });
  });
  it('failed in a read-only directory, the file unchanged', () => {
    if (process.getuid?.() === 0) return;
    const { d, f } = envDir();
    const { loaded } = loadedWith({ envFile: f });
    chmodSync(d, 0o500);
    try {
      expect(removePasswordLine(loaded, 'cam4', at)).toEqual({ outcome: 'failed', key: PW, code: 'not_writable' });
    } finally {
      chmodSync(d, 0o700);
    }
    expect(readFileSync(f, 'utf8')).toBe(`A=1\n${PW}=test-only\nB=2\n`);
  });
});
