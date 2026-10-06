import { createHash, randomBytes } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeKeyFile } from '../src/fleet/keyfile';
import { writePrivateJson } from '../src/fleet/private-file';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { CLIENT_TOKEN, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// A token rotation while cams is busy (plan Review Focus 4): requests with
// the old token keep working until retireAt, the new one works as soon as
// `done` is sent; zero failures for the token cams uses and for
// CAMPROXY_TOKENS. A replay of the old set (a restored cams-admin) is stale.
const tok = () => randomBytes(32).toString('base64url');
const hashOf = (t: string) => `sha256:${createHash('sha256').update(t).digest('hex')}`;
const ID1 = `tok_${'1'.repeat(20)}`;
const ID2 = `tok_${'2'.repeat(20)}`;
const T1 = tok();
const T2 = tok();

let sim: Awaited<ReturnType<typeof startSim>>;
let fake: FakeAdmin;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  sim = await startSim();
  fake = await startFakeAdmin();
  fake.welcomeHeartbeatS = 1;
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-rot-'));
  writeKeyFile(join(dir, 'data', 'admin', 'key.json'), fake.keyFile());
  writePrivateJson(join(dir, 'data', 'admin', 'policy.json'), { v: 1, allow: ['tokens.apply'], changedAt: 1, changedBy: 'local' });
  p = await startProxy(sim, { dir, settings: { camsAdmin: { url: fake.url } }, proxy: { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0 } } } });
  await until(() => fake.open() === 1 && p.proxy.camsAdmin.view().state === 'connected', 10_000);
}, 60_000);
afterAll(async () => {
  await p?.proxy.stop();
  await fake?.close();
  await sim?.close();
});

const rev1 = { v: 1, revision: 1, tokens: [{ id: ID1, kind: 'client', hash: hashOf(T1), label: 'cams', retireAt: null }] };
const get = async (t: string) => (await request(p.base).get('/api/cameras').set('Authorization', `Bearer ${t}`)).status;

describe('token rotation without downtime', () => {
  it('rev 1 installs T1', async () => {
    const { cmdId } = fake.sendCommand('tokens.apply', rev1);
    await until(() => fake.results(cmdId).length === 2);
    expect(await get(T1)).toBe(200);
  });

  it('rev 2 (T1 retiring in 3 s, T2 new) under a request loop: no failure for the current token or CAMPROXY_TOKENS; T1 refused after retireAt', async () => {
    let current = T1;
    let stop = false;
    const failures: string[] = [];
    let n = 0;
    const loop = (async () => {
      while (!stop) {
        const t = n++ % 2 === 0 ? CLIENT_TOKEN : current;
        const s = await get(t);
        if (s !== 200) failures.push(`${t === CLIENT_TOKEN ? 'CAMPROXY_TOKENS' : t === T1 ? 'T1' : 'T2'}: ${s}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    await new Promise((r) => setTimeout(r, 300));
    const retireAt = Date.now() + 3000;
    const { cmdId } = fake.sendCommand('tokens.apply', { v: 1, revision: 2, tokens: [{ ...rev1.tokens[0], retireAt }, { id: ID2, kind: 'client', hash: hashOf(T2), label: 'cams', retireAt: null }] });
    await until(() => fake.results(cmdId).some((r) => (r.msg.body as { phase: string }).phase === 'done'));
    expect((fake.results(cmdId).at(-1)!.msg.body as { result: unknown }).result).toMatchObject({ revision: 2, applied: true, client: 2 });
    current = T2; // cams switches when done arrives
    await until(() => Date.now() > retireAt + 200, 6000);
    stop = true;
    await loop;
    expect(n).toBeGreaterThan(50);
    expect(failures).toEqual([]);
    expect(await get(T1)).toBe(401);
    expect(await get(T2)).toBe(200);
  }, 20_000);

  it('a replay of rev 1 (cams-admin restored from an older backup): stale, T1 stays refused, T2 keeps working', async () => {
    const { cmdId } = fake.sendCommand('tokens.apply', rev1);
    await until(() => fake.results(cmdId).length === 2);
    expect((fake.results(cmdId)[1].msg.body as { result: unknown }).result).toMatchObject({ revision: 2, applied: false, stale: true });
    expect(await get(T1)).toBe(401);
    expect(await get(T2)).toBe(200);
  });
});
