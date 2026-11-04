import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CamsAdmin } from '../src/fleet/service';
import { writeKeyFile } from '../src/fleet/keyfile';
import { privateFileHooks } from '../src/fleet/private-file';
import { buildHealth } from '../src/health/summary';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { input } from './helpers/health-input';
import { until } from './helpers/proxy';

// What the health item gets from cams-admin's owner: its connection, whatever
// holds it up. Off or disabled: nothing to show. Configured but the key file
// isn't usable: down, for that reason, the time kept across its re-reads.
const log = { info: () => undefined, warn: () => undefined, debug: () => undefined };
let dir: string;
let fake: FakeAdmin;
let svc: CamsAdmin;
let settings: { url?: string; keyFile: string; enabled: boolean };
const make = () => {
  svc = new CamsAdmin({
    settings: () => settings, dataDir: () => dir, version: 'v1', cameraIds: () => ['cam1'],
    health: async () => buildHealth(input({ now: Date.now() })),
    proxyInfo: () => ({ startedAt: 1, uptimeS: 2, configSchema: 1, tls: null, publicUrl: null }),
    log, setUrl: async () => undefined, recheckMs: 50,
    timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200 },
  });
  return svc;
};
const keyPath = () => join(dir, settings.keyFile);
const writeKey = () => {
  mkdirSync(dirname(keyPath()), { recursive: true, mode: 0o700 });
  writeKeyFile(keyPath(), fake.keyFile());
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cp-conn-'));
  fake = await startFakeAdmin();
  settings = { keyFile: 'admin/key.json', enabled: true };
});
afterEach(async () => {
  await svc.stop();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the connection for the health item', () => {
  it('no camsAdmin.url: none, so no item', async () => {
    const s = make();
    expect(s.connection()).toBeNull();
    await s.apply();
    expect(s.connection()).toBeNull();
  });
  it('switched off with camsAdmin.enabled: none', async () => {
    settings = { ...settings, url: fake.url, enabled: false };
    writeKey();
    const s = make();
    await s.apply();
    expect(s.view().state).toBe('disabled');
    expect(s.connection()).toBeNull();
  });
  it('a URL but no key file: down (not enrolled), the time kept across re-reads', async () => {
    settings = { ...settings, url: fake.url };
    const s = make();
    await s.apply();
    const first = s.connection();
    expect(first).toMatchObject({ connected: false, reason: 'not enrolled' });
    await new Promise((r) => setTimeout(r, 150)); // several rechecks
    expect(s.connection()).toEqual(first);
  });
  it('a key file that is not safe: down for that', async () => {
    settings = { ...settings, url: fake.url };
    writeKey();
    chmodSync(keyPath(), 0o644);
    privateFileHooks.fchmod = () => undefined; // the chmod does not take
    try {
      const s = make();
      await s.apply();
      expect(s.connection()).toMatchObject({ connected: false, reason: 'key file unsafe' });
    } finally {
      delete privateFileHooks.fchmod;
    }
  });
  it('a key file that is not valid: down for that; repaired and connected: the time ran on until the welcome', async () => {
    settings = { ...settings, url: fake.url };
    mkdirSync(dirname(keyPath()), { recursive: true, mode: 0o700 });
    writeFileSync(keyPath(), 'not json', { mode: 0o600 });
    const s = make();
    await s.apply();
    const first = s.connection() as { connected: false; downSince: number; reason: string };
    expect(first).toMatchObject({ connected: false, reason: 'key file invalid' });
    fake.mode = 'silent';
    await new Promise((r) => setTimeout(r, 5));
    writeKey();
    await until(() => s.active());
    expect(s.connection()).toMatchObject({ connected: false, downSince: first.downSince });
    fake.mode = 'normal';
    fake.destroyAll();
    await until(() => s.connection()?.connected === true, 5000);
    // Connected once: the old time is gone. Silent first: a quick reconnect could slip between two polls.
    fake.mode = 'silent';
    fake.closeAll(1001);
    await until(() => !s.connection()?.connected);
    expect((s.connection() as { downSince: number }).downSince).toBeGreaterThan(first.downSince);
  });
  it('the URL taken away: none again', async () => {
    settings = { ...settings, url: fake.url };
    writeKey();
    const s = make();
    await s.apply();
    await until(() => s.connection()?.connected === true);
    settings = { keyFile: settings.keyFile, enabled: true };
    await s.apply();
    expect(s.connection()).toBeNull();
  });
});
