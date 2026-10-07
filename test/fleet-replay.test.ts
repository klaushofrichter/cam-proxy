import { createHash, randomBytes } from 'crypto';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeKeyFile } from '../src/fleet/keyfile';
import { writePrivateJson } from '../src/fleet/private-file';
import { ReplayGuard } from '../src/fleet/replay';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// Replays across connections (security review of PR #186): a MITM on the
// plain-http *.svc.cluster.local path replays a recorded session, its signed
// challenge and its commands. The proxy keeps a high-water mark of the signed
// serverTime and every cmdId that passed the signature (accepted or refused)
// until it can no longer be fresh, across connections and restarts.
const quiet = { warn() {} };
const dir = () => join(mkdtempSync(join(tmpdir(), 'replay-')), 'admin', 'replay.json');
const KEY = 'key_AAAAAAAAAAAAAAAAAAAA';

describe('ReplayGuard', () => {
  it('a challenge older than the high-water mark minus the slack is refused; newer ones move the mark', () => {
    const g = new ReplayGuard({ file: dir(), slackMs: 1000, log: quiet });
    expect(g.challenge(KEY, 10_000)).toBe(true);
    expect(g.challenge(KEY, 9_500)).toBe(true); // within the slack (cams-admin's clock may step back a little)
    expect(g.challenge(KEY, 8_999)).toBe(false);
    expect(g.challenge(KEY, 20_000)).toBe(true);
    expect(g.challenge(KEY, 10_000)).toBe(false);
  });
  it('another key (enrolled again) starts afresh', () => {
    const g = new ReplayGuard({ file: dir(), slackMs: 1000, log: quiet });
    g.challenge(KEY, 50_000);
    expect(g.challenge('key_BBBBBBBBBBBBBBBBBBBB', 1_000)).toBe(true);
  });
  it('cmdIds and the mark survive a restart (file 600); expired ones are pruned; bounded', () => {
    const f = dir();
    const g = new ReplayGuard({ file: f, slackMs: 1000, log: quiet, cap: 3 });
    g.challenge(KEY, 10_000);
    g.addCmd('cmd_1', 10_500);
    g.flush();
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const h = new ReplayGuard({ file: f, slackMs: 1000, log: quiet, cap: 3 });
    expect(h.hasCmd('cmd_1')).toBe(true);
    expect(h.challenge(KEY, 8_000)).toBe(false);
    // exp + 120 s + slack before the mark: it could never be fresh again.
    h.challenge(KEY, 10_500 + 120_000 + 1000 + 1);
    h.addCmd('cmd_2', 200_000);
    expect(h.hasCmd('cmd_1')).toBe(false);
    for (const c of ['cmd_3', 'cmd_4', 'cmd_5']) h.addCmd(c, 200_000);
    expect(h.hasCmd('cmd_2')).toBe(false);
    expect(h.hasCmd('cmd_5')).toBe(true);
  });
  it('fails closed: replay.json unusable → the mark from replay-mark.json; both unusable → every challenge refused until a local fix', () => {
    const f = dir();
    const g = new ReplayGuard({ file: f, slackMs: 1000, log: quiet });
    g.challenge(KEY, 10_000);
    g.flush();
    const mark = join(f, '..', 'replay-mark.json');
    expect(statSync(mark).mode & 0o777).toBe(0o600);
    writeFileSync(f, '{', { mode: 0o600 });
    const lines: string[] = [];
    const log = { warn: (_o: object, m: string) => void lines.push(m) };
    const h = new ReplayGuard({ file: f, slackMs: 1000, log });
    expect(h.challenge(KEY, 1)).toBe(false);
    expect(h.challenge(KEY, 10_000)).toBe(true);
    writeFileSync(f, '{', { mode: 0o600 });
    writeFileSync(mark, '{', { mode: 0o600 });
    const k = new ReplayGuard({ file: f, slackMs: 1000, log });
    expect(k.challenge(KEY, 99_999_999)).toBe(false);
    expect(k.problem()).toMatch(/replay/);
    expect(lines).toContain('admin_replay_unusable');
    // The local fix: remove both files (a fresh start).
    rmSync(f);
    rmSync(mark);
    expect(new ReplayGuard({ file: f, slackMs: 1000, log }).challenge(KEY, 5)).toBe(true);
  });
  it('unusable files are read again: a local fix needs no restart; the warning is logged once', () => {
    const f = dir();
    const g = new ReplayGuard({ file: f, slackMs: 1000, log: quiet });
    g.challenge(KEY, 10_000);
    g.flush();
    const mark = join(f, '..', 'replay-mark.json');
    writeFileSync(f, '{', { mode: 0o600 });
    writeFileSync(mark, '{', { mode: 0o600 });
    const lines: string[] = [];
    const k = new ReplayGuard({ file: f, slackMs: 1000, log: { warn: (_o: object, m: string) => void lines.push(m) } });
    expect(k.challenge(KEY, 20_000)).toBe(false);
    expect(k.challenge(KEY, 20_000)).toBe(false);
    expect(lines.filter((l) => l === 'admin_replay_unusable')).toHaveLength(1);
    rmSync(f);
    rmSync(mark);
    expect(k.problem()).toBeNull();
    expect(k.challenge(KEY, 20_000)).toBe(true);
  });
  it('ours with 660 (the cluster volume under fsGroup): tightened to 600 and used', () => {
    const f = dir();
    const g = new ReplayGuard({ file: f, slackMs: 1000, log: quiet });
    g.challenge(KEY, 10_000_000);
    g.flush();
    const mark = join(f, '..', 'replay-mark.json');
    chmodSync(f, 0o660);
    chmodSync(mark, 0o660);
    const h = new ReplayGuard({ file: f, slackMs: 1000, log: quiet });
    expect(h.problem()).toBeNull();
    expect(h.challenge(KEY, 1)).toBe(false); // the mark held: older than it
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(mark).mode & 0o777).toBe(0o600);
  });
  it('a failed coalesced write is logged (admin_replay_save_failed), never thrown from the timer', async () => {
    const blocker = join(mkdtempSync(join(tmpdir(), 'replay-')), 'file');
    writeFileSync(blocker, 'x');
    const lines: string[] = [];
    const g = new ReplayGuard({ file: join(blocker, 'admin', 'replay.json'), slackMs: 1000, log: { warn: (_o: object, m: string) => void lines.push(m) } });
    g.addCmd('cmd_1', 1);
    await new Promise((r) => setTimeout(r, 1300));
    expect(lines).toContain('admin_replay_save_failed');
  });
});

const tok = () => randomBytes(32).toString('base64url');
const hashOf = (t: string) => `sha256:${createHash('sha256').update(t).digest('hex')}`;
const args = (t: string) => ({ v: 1, revision: 1, tokens: [{ id: `tok_${'4'.repeat(20)}`, kind: 'client', hash: hashOf(t), label: 'x', retireAt: null }] });
describe('a replayed session through the proxy', () => {
  let sim: Awaited<ReturnType<typeof startSim>>;
  let fake: FakeAdmin;
  let p: Awaited<ReturnType<typeof startProxy>>;
  const policy = (o: Record<string, unknown>) => writePrivateJson(join(p.dir, 'data', 'admin', 'policy.json'), { v: 1, changedAt: Date.now(), changedBy: 'local', allow: ['tokens.apply'], ...o });
  beforeAll(async () => {
    sim = await startSim();
    fake = await startFakeAdmin();
    fake.welcomeHeartbeatS = 1;
    const d = mkdtempSync(join(tmpdir(), 'camproxy-replay-'));
    writeKeyFile(join(d, 'data', 'admin', 'key.json'), fake.keyFile());
    p = await startProxy(sim, { dir: d, settings: { camsAdmin: { url: fake.url } }, proxy: { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200 }, replaySlackMs: 1500 } } });
    await until(() => p.proxy.camsAdmin.view().state === 'connected', 10_000);
  }, 60_000);
  afterAll(async () => {
    await p?.proxy.stop();
    await fake?.close();
    await sim?.close();
  });
  const reconnect = async (replay: number | null = null) => {
    const n = fake.connections;
    fake.replayConn = replay;
    fake.destroyAll();
    await until(() => fake.connections > n, 10_000);
  };

  it('a command refused while paused, replayed after resume with its recorded challenge: replayed, nothing runs', async () => {
    policy({ paused: true });
    const conn = fake.connections;
    const t = tok();
    const { cmdId } = fake.sendCommand('tokens.apply', args(t));
    await until(() => fake.results(cmdId).length === 1);
    expect(fake.results(cmdId)[0].msg.body).toMatchObject({ code: 'paused' });
    policy({ paused: false });
    await reconnect(conn);
    await until(() => fake.results(cmdId).length === 2, 10_000);
    expect(fake.results(cmdId)[1].msg.body).toMatchObject({ phase: 'done', status: 'refused', code: 'replayed' });
    expect((await request(p.base).get('/api/cameras').set(auth(t))).status).toBe(401);
  });
  it('a recorded challenge older than the newest one minus the slack: refused, no hello', async () => {
    const old = fake.connections;
    await new Promise((r) => setTimeout(r, 2000));
    await reconnect();
    await until(() => p.proxy.camsAdmin.view().state === 'connected', 10_000);
    await reconnect(old);
    const replayed = fake.connections;
    await new Promise((r) => setTimeout(r, 1000));
    expect(fake.received.filter((r) => r.conn === replayed && r.msg.type === 'hello')).toHaveLength(0);
    await until(() => /stale challenge/.test(p.proxy.camsAdmin.view().lastError ?? ''), 10_000);
  });
});
void writeFileSync;
