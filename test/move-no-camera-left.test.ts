// A proxy whose only camera moved away (camera-move plan Task 12, found by the
// end-to-end move test): with no camera running it must keep going, since
// cams-admin still has to finish the move there (S §1: "retire a proxy").
// The archive cleanup's timer used to throw (an uncaught exception ends the
// process), the health summary threw (the cams-admin connection reconnected
// in a loop), and the Status page answered 500.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeKeyFile } from '../src/fleet/keyfile';
import { strict, why } from './helpers/contract';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { ADMIN_TOKEN, auth, until } from './helpers/proxy';

const MOVE = 'mv_0123456789ABCDEFGHJK';
let sims: Sim[];
let fake: FakeAdmin;
let p: Awaited<ReturnType<typeof startMultiProxy>>;

beforeAll(async () => {
  sims = await startSims(1);
  fake = await startFakeAdmin();
  fake.welcomeHeartbeatS = 1;
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-nocam-'));
  writeKeyFile(join(dir, 'data', 'admin', 'key.json'), fake.keyFile());
  p = await startMultiProxy(sims, { dir, proxy: { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200 } } }, settings: { camsAdmin: { url: fake.url } } });
  await until(() => fake.open() === 1, 20_000);
  // The move hides the camera (move.release does the same through overrides).
  await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ cameras: { cam3: { moved: MOVE } } }).expect(200);
  await until(() => !p.proxy.cameras.get('cam3') && p.proxy.cameras.list().length === 0, 10_000);
}, 60_000);
afterAll(async () => {
  await p?.proxy.stop();
  await fake?.close();
  await Promise.all((sims ?? []).map((s) => s.close()));
});

describe('no camera left on the proxy', () => {
  it('the cams-admin connection stays up and its heartbeats are valid', async () => {
    const conns = fake.connIds().length;
    const beats = fake.heartbeats().length;
    await until(() => fake.heartbeats().length >= beats + 2, 10_000);
    expect(fake.connIds().length).toBe(conns);
    const hb = fake.heartbeats().at(-1)!;
    expect(strict('heartbeat')(hb.msg), why(strict('heartbeat'))).toBe(true);
    const summary = (hb.msg.body as { summary: { cameras: unknown[]; camera: { online: boolean; error: string } } }).summary;
    expect(summary.cameras).toEqual([]);
    expect(summary.camera).toMatchObject({ online: false, error: 'no camera runs on this proxy' });
  });

  it('the archive cleanup tick does not throw', () => {
    expect(() => p.proxy.archive.cleanup.tick()).not.toThrow();
  });

  it('the Status page and the local health answer', async () => {
    const s = await request(p.base).get('/control/status').set(auth(ADMIN_TOKEN)).expect(200);
    expect(s.body).toMatchObject({ camera: { online: false, error: 'no camera runs on this proxy' }, intake: { onvif: 'down' }, stream: { enabled: false }, ftp: { enabled: false }, cameras: [] });
    const h = await request(p.base).get('/api/local/health').expect(200);
    expect(h.body.cameras).toEqual([]);
  });

  it('a restart with no camera works', async () => {
    await p.proxy.restart();
    await request(p.base).get('/control/status').set(auth(ADMIN_TOKEN)).expect(200);
    expect(p.proxy.cameras.list()).toEqual([]);
  });
});
