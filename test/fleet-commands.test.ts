import { createHash, randomBytes } from 'crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AdminClient, type ClientLog, type Timing } from '../src/fleet/client';
import { SeenIds } from '../src/fleet/command-check';
import { CommandRunner, type ConnCtx, type Done } from '../src/fleet/commands';
import { Journal } from '../src/fleet/journal';
import { CommandPolicy } from '../src/fleet/policy';
import { writePrivateJson } from '../src/fleet/private-file';
import { TokenStore } from '../src/fleet/token-store';
import { writeKeyFile } from '../src/fleet/keyfile';
import { readEnvLayer } from '../src/config/env';
import { buildHealth } from '../src/health/summary';
import { signEnvelope, type Envelope } from '../src/fleet/protocol';
import { input } from './helpers/health-input';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { strict, vectors, why } from './helpers/contract';
import { ADMIN_TOKEN, auth, CLIENT_TOKEN, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// Commands from cams-admin (migration P2, contract "The P2 contract"): the
// runner, the client wiring and tokens.apply end to end.
const tok = () => randomBytes(32).toString('base64url');
const hashOf = (t: string) => `sha256:${createHash('sha256').update(t).digest('hex')}`;
const TOK = (n: number) => `tok_${String(n).padStart(20, '0')}`;
const quiet: ClientLog = { info() {}, warn() {}, debug() {} };
const FAST: Partial<Timing> = { connectTimeoutMs: 1000, helloTimeoutMs: 500, closeGraceMs: 200, backoffCapMs: 300, minIntervalS: 0.2, jitterS: 0, byeWaitMs: 500 };
const argsOf = (revision: number, tokens: { id: string; kind: 'client' | 'admin'; t: string; label?: string; retireAt?: number | null }[] = []) => ({ v: 1, revision, tokens: tokens.map((x) => ({ id: x.id, kind: x.kind, hash: hashOf(x.t), label: x.label ?? 'cams test', retireAt: x.retireAt ?? null })) });
const bodyOf = (r: { msg: Envelope }) => r.msg.body as Record<string, any>;
const readdir = (d: string) => readdirSync(d).sort();

// A runner on its own (no socket): a temp data folder, the policy allowing tokens.apply.
function runnerFixture(o: { allow?: string[]; handlers?: Record<string, (args: unknown) => Done | Promise<Done>>; now?: () => number; localDigests?: Buffer[]; env?: NodeJS.ProcessEnv } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-'));
  const policy = new CommandPolicy({ base: () => ({ allow: o.allow ?? ['tokens.apply'], paused: false }), file: join(dir, 'admin', 'policy.json'), env: () => readEnvLayer(o.env ?? {}), log: quiet });
  const journal = new Journal(join(dir, 'admin', 'commands.json'));
  const tokens = new TokenStore({ file: join(dir, 'admin', 'tokens.json'), localDigests: () => o.localDigests ?? [] });
  const audit: Record<string, any>[] = [];
  const PRX = `prx_${'1'.repeat(20)}`;
  const runner = new CommandRunner({ proxyId: () => PRX, serverKeys: () => [vectors.keys.server.publicKey], policy, journal, tokens, audit: { write: (r: Record<string, any>) => (audit.push(r), r) as never }, log: quiet, handlers: o.handlers, now: o.now });
  const conn = (connId = `con_${'2'.repeat(20)}`): ConnCtx => ({ connId, serverNow: () => Date.now(), seen: new SeenIds() });
  const sent: { type: string; body: Record<string, any>; re?: string }[] = [];
  const send = (type: 'result' | 'event', body: Record<string, unknown>, re?: string) => (sent.push({ type, body, re }), true);
  let n = 0;
  const command = (command: string, args: Record<string, unknown>, c: ConnCtx, extra: Record<string, unknown> = {}): Envelope => {
    n++;
    const m = { v: 1 as const, type: 'command', id: `0000000000000000000000${String(n).padStart(4, '0')}`, seq: n, ts: Date.now(), body: { proxyId: PRX, connId: c.connId, cmdId: `cmd_${String(n).padStart(20, '0')}`, exp: Date.now() + 30_000, actor: 'ops@example.org', command, args, ...extra } };
    return { ...m, sig: signEnvelopeWith(vectors.keys.server.privateKey, m) };
  };
  return { dir, policy, journal, tokens, audit, runner, conn, sent, send, command };
}
const signEnvelopeWith = (k: string, m: Omit<Envelope, 'sig'>) => signEnvelope(k, m);

describe('the runner', () => {
  it('Done.after runs once the done result went out; a re-sent cmdId answers duplicate and never runs it again (R3-10); action is journaled', async () => {
    const order: string[] = [];
    const f = runnerFixture({ handlers: { 'tokens.apply': () => ({ status: 'ok', result: { restartAt: 1 }, action: 'camera-reboot', after: () => void order.push('after') }) } });
    const c = f.conn();
    const send = (type: 'result' | 'event', body: Record<string, unknown>) => (order.push(`${type}:${String(body.phase)}`), true);
    const m = f.command('tokens.apply', argsOf(1), c);
    await f.runner.onCommand(m, c, send);
    expect(order).toEqual(['result:received', 'result:done']);
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['result:received', 'result:done', 'after']);
    expect(f.journal.get((m.body as { cmdId: string }).cmdId)).toMatchObject({ action: 'camera-reboot' });
    const c2 = f.conn(`con_${'3'.repeat(20)}`);
    const again = { ...m, body: { ...(m.body as object), connId: c2.connId } } as Record<string, unknown>;
    delete again.sig;
    await f.runner.onCommand({ ...again, sig: signEnvelope(vectors.keys.server.privateKey, again as never) } as Envelope, c2, send);
    await new Promise((r) => setImmediate(r));
    expect(order.filter((x) => x === 'after')).toHaveLength(1);
    expect(order.at(-1)).toBe('result:done');
  });
  it('an after hook that throws is logged, never breaks the runner', async () => {
    const warned: string[] = [];
    const f = runnerFixture({ handlers: { 'tokens.apply': () => ({ status: 'ok', after: () => { throw new Error('boom'); } }) } });
    (f.runner as unknown as { d: { log: ClientLog } }).d.log = { info() {}, debug() {}, warn: (_o: object, msg: string) => void warned.push(msg) };
    const c = f.conn();
    await f.runner.onCommand(f.command('tokens.apply', argsOf(1), c), c, f.send);
    await new Promise((r) => setImmediate(r));
    expect(warned).toContain('admin_command_after_error');
  });
  it('received, then done; journaled; tokens applied; one admin-command record without any hash', async () => {
    const f = runnerFixture();
    const c = f.conn();
    const t = tok();
    const m = f.command('tokens.apply', argsOf(1, [{ id: TOK(1), kind: 'client', t, label: 'cams cluster' }]), c);
    await f.runner.onCommand(m, c, f.send);
    expect(f.sent.map((s) => [s.type, s.body.phase, s.re])).toEqual([['result', 'received', m.id], ['result', 'done', m.id]]);
    expect(f.sent[1].body).toMatchObject({ status: 'ok', result: { revision: 1, applied: true, stale: false, client: 1, admin: 0, blocked: [] } });
    expect(f.tokens.match(t)?.id).toBe(TOK(1));
    expect(f.journal.get((m.body as { cmdId: string }).cmdId)).toMatchObject({ status: 'ok', command: 'tokens.apply', actor: 'ops@example.org' });
    expect(f.audit).toHaveLength(1);
    expect(f.audit[0]).toMatchObject({ action: 'admin-command', outcome: 'success', user: 'cams-admin', details: { command: 'tokens.apply', actor: 'ops@example.org', tokens: { revision: 1, ids: [{ id: TOK(1), kind: 'client', label: 'cams cluster' }] } } });
    expect(JSON.stringify(f.audit)).not.toContain(hashOf(t).slice(7, 23));
  });
  it('a stale revision answers ok with stale and the proxy revision; nothing changes (a restored cams-admin)', async () => {
    const f = runnerFixture();
    const c = f.conn();
    await f.runner.onCommand(f.command('tokens.apply', argsOf(5), c), c, f.send);
    await f.runner.onCommand(f.command('tokens.apply', argsOf(3, [{ id: TOK(1), kind: 'client', t: tok() }]), c), c, f.send);
    expect(f.sent.at(-1)!.body).toMatchObject({ phase: 'done', status: 'ok', result: { revision: 5, applied: false, stale: true } });
    expect(f.tokens.counts().client).toBe(0);
  });
  it('a hash equal to a local token: failed shadows_local_token, nothing applied', async () => {
    const f = runnerFixture({ localDigests: [createHash('sha256').update(CLIENT_TOKEN).digest()] });
    const c = f.conn();
    await f.runner.onCommand(f.command('tokens.apply', argsOf(1, [{ id: TOK(1), kind: 'client', t: CLIENT_TOKEN }]), c), c, f.send);
    expect(f.sent.at(-1)!.body).toMatchObject({ phase: 'done', status: 'failed', code: 'shadows_local_token' });
    expect(f.tokens.revision()).toBe(0);
  });
  it('busy: a second command while one runs', async () => {
    let release!: () => void;
    const f = runnerFixture({ handlers: { 'tokens.apply': () => new Promise<Done>((r) => (release = () => r({ status: 'ok', result: {} }))) } });
    const c = f.conn();
    const first = f.runner.onCommand(f.command('tokens.apply', argsOf(1), c), c, f.send);
    const m2 = f.command('tokens.apply', argsOf(2), c);
    await f.runner.onCommand(m2, c, f.send);
    expect(f.sent.find((s) => s.re === m2.id)!.body).toMatchObject({ phase: 'done', status: 'refused', code: 'busy' });
    // The running one's cmdId again: received, duplicate.
    release();
    await first;
    expect(f.sent.filter((s) => s.body.phase === 'done' && s.body.status === 'ok')).toHaveLength(1);
  });
  it('the same cmdId while it runs: received with duplicate', async () => {
    let release!: () => void;
    const f = runnerFixture({ handlers: { 'tokens.apply': () => new Promise<Done>((r) => (release = () => r({ status: 'ok', result: {} }))) } });
    const c = f.conn();
    const m = f.command('tokens.apply', argsOf(1), c);
    const first = f.runner.onCommand(m, c, f.send);
    const again = { ...m, id: '00000000000000000000009999', sig: undefined } as Record<string, unknown>;
    delete again.sig;
    const resent = { ...again, sig: signEnvelopeWith(vectors.keys.server.privateKey, again as never) } as Envelope;
    await f.runner.onCommand(resent, c, f.send);
    expect(f.sent.find((s) => s.re === resent.id)!.body).toMatchObject({ phase: 'received', duplicate: true });
    release();
    await first;
  });
  it('nack results: at most 60 a minute (the rest dropped and counted); one audit record per code per 10 min', async () => {
    let now = 1_000_000;
    const f = runnerFixture({ allow: [], now: () => now });
    const c = f.conn();
    for (let i = 0; i < 80; i++) await f.runner.onCommand(f.command('tokens.apply', argsOf(1), c), c, f.send);
    expect(f.sent.filter((s) => s.body.code === 'not_allowed')).toHaveLength(60);
    expect(f.audit.filter((r) => r.action === 'admin-command')).toHaveLength(1);
    expect(f.audit[0]).toMatchObject({ outcome: 'failure', details: { outcome: 'not_allowed', command: 'tokens.apply' } });
    now += 61_000;
    await f.runner.onCommand(f.command('tokens.apply', argsOf(1), c), c, f.send);
    expect(f.sent.filter((s) => s.body.code === 'not_allowed')).toHaveLength(61);
    now += 600_000;
    await f.runner.onCommand(f.command('tokens.apply', argsOf(1), c), c, f.send);
    expect(f.audit.at(-1)).toMatchObject({ details: { outcome: 'not_allowed', suppressed: 80 } });
    // The suppressed refusals' cmdIds are kept (the first 50) for the next record.
    const ids = f.audit.at(-1)!.details.suppressedCmdIds as string[];
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe(`cmd_${String(2).padStart(20, '0')}`);
  });
  it('status(): the allow entries this version implements, with pause and enabled', () => {
    const f = runnerFixture({ allow: ['tokens.apply', 'config.get', 'camera.action:camera-reboot'] });
    expect(f.runner.status()).toEqual({ enabled: true, paused: false, pauseReason: null, allow: ['tokens.apply', 'config.get', 'camera.action:camera-reboot'], seenWindow: 1000 });
  });
});

// A pure revocation (cross-repo ruling): cams-admin can always revoke a token,
// even while paused or with tokens.apply not allowed (a leaked managed admin
// token could otherwise pause cams-admin out); only the kill switch stops it.
describe('revocationOnly tokens.apply', () => {
  const T1 = tok();
  const T2 = tok();
  const two = [{ id: TOK(1), kind: 'client' as const, t: T1 }, { id: TOK(2), kind: 'admin' as const, t: T2 }];
  const seeded = (o: Parameters<typeof runnerFixture>[0] = {}) => {
    const f = runnerFixture({ ...o, allow: ['tokens.apply', 'tokens.apply.admin'] });
    f.tokens.apply(argsOf(1, two) as never);
    return f;
  };
  const revoke = (f: ReturnType<typeof runnerFixture>, c: ConnCtx, args: Record<string, unknown>) => f.runner.onCommand(f.command('tokens.apply', args, c, { revocationOnly: true }), c, f.send);
  it('paused: a pure revocation is applied anyway', async () => {
    const f = seeded();
    f.policy.pause('incident', 'local');
    const c = f.conn();
    await revoke(f, c, argsOf(2, [two[0]]));
    expect(f.sent.at(-1)!.body).toMatchObject({ phase: 'done', status: 'ok', result: { revision: 2, applied: true, admin: 0, client: 1 } });
    expect(f.tokens.match(T2)).toBeNull();
    expect(f.audit.at(-1)).toMatchObject({ action: 'admin-command', outcome: 'success', details: { command: 'tokens.apply' } });
  });
  it('tokens.apply not allowed: a pure revocation is applied anyway', async () => {
    const f = seeded();
    f.policy.setAllow([], 'local');
    const c = f.conn();
    await revoke(f, c, argsOf(2, []));
    expect(f.sent.at(-1)!.body).toMatchObject({ phase: 'done', status: 'ok', result: { applied: true, client: 0, admin: 0 } });
  });
  it('a claim that adds or changes a token is refused invalid_args (the contract); nothing changes', async () => {
    const f = seeded();
    f.policy.pause('incident', 'local');
    const c = f.conn();
    await revoke(f, c, argsOf(2, [two[0], { id: TOK(3), kind: 'admin', t: tok() }]));
    expect(f.sent.at(-1)!.body).toMatchObject({ phase: 'done', status: 'refused', code: 'invalid_args' });
    await revoke(f, c, argsOf(3, [{ ...two[0], label: 'renamed' }]));
    expect(f.sent.at(-1)!.body).toMatchObject({ status: 'refused', code: 'invalid_args' });
    await revoke(f, c, argsOf(4, [{ ...two[0], retireAt: 5 }]));
    expect(f.sent.at(-1)!.body).toMatchObject({ status: 'refused', code: 'invalid_args' });
    expect(f.tokens.revision()).toBe(1);
  });
  it('revocationOnly inside args (not the contract field) is invalid_args', async () => {
    const f = seeded();
    const c = f.conn();
    await f.runner.onCommand(f.command('tokens.apply', { ...argsOf(2, []), revocationOnly: true }, c), c, f.send);
    expect(f.sent.at(-1)!.body).toMatchObject({ status: 'refused', code: 'invalid_args' });
  });
  it('the kill switch still refuses it (paused)', async () => {
    const f = seeded({ env: { CAMPROXY_ADMIN_COMMANDS: 'off' } });
    const c = f.conn();
    await revoke(f, c, argsOf(2, []));
    expect(f.sent.at(-1)!.body).toMatchObject({ status: 'refused', code: 'paused' });
    expect(f.tokens.revision()).toBe(1);
  });
  it('without the field it is a normal tokens.apply (paused → paused)', async () => {
    const f = seeded();
    f.policy.pause('incident', 'local');
    const c = f.conn();
    await f.runner.onCommand(f.command('tokens.apply', argsOf(2, []), c), c, f.send);
    expect(f.sent.at(-1)!.body).toMatchObject({ status: 'refused', code: 'paused' });
  });
});

// The client with a runner, against the fake cams-admin.
describe('the client with commands', () => {
  let fake: FakeAdmin;
  let client: AdminClient | undefined;
  afterEach(async () => {
    await client?.stop('shutdown');
    client = undefined;
    await fake?.close();
  });
  const make = (f: ReturnType<typeof runnerFixture>, o: { now?: () => number } = {}) => {
    const key = fake.keyFile();
    // The runner must speak for the enrolled proxy.
    (f.runner as unknown as { d: { proxyId: () => string } }).d.proxyId = () => key.proxyId;
    client = new AdminClient({ keyFile: key, health: async () => buildHealth(input({ now: Date.now() })), proxyInfo: () => ({ startedAt: 1, uptimeS: 2, configSchema: 2, tls: null, publicUrl: null }), version: 'test', log: quiet, timing: FAST, random: () => 0.5, now: o.now, commands: f.runner });
    client.start();
    return client;
  };

  it('hello says it takes commands; a command with a clock three years off is accepted (exp on the challenge time, R2-4)', async () => {
    fake = await startFakeAdmin();
    const f = runnerFixture();
    make(f, { now: () => Date.now() + 3 * 365 * 86_400_000 });
    await until(() => client!.view().state === 'connected');
    expect(fake.received.find((r) => r.msg.type === 'hello')!.msg.body).toMatchObject({ capabilities: ['status', 'commands'] });
    const { cmdId } = fake.sendCommand('tokens.apply', argsOf(1));
    await until(() => fake.results(cmdId).length === 2);
    expect(fake.results(cmdId).map(bodyOf).map((b) => b.phase)).toEqual(['received', 'done']);
    for (const r of fake.results(cmdId)) {
      expect(fake.verifyFromProxy(r.msg)).toBe(true);
      expect(strict('result')(r.msg), why(strict('result'))).toBe(true);
    }
  });
  it('a captured command replayed on the next connection is wrong_target; a re-sent cmdId is a duplicate', async () => {
    fake = await startFakeAdmin();
    const f = runnerFixture();
    make(f);
    await until(() => client!.view().state === 'connected');
    const { cmdId } = fake.sendCommand('tokens.apply', argsOf(1));
    await until(() => fake.results(cmdId).length === 2);
    const old = fake.connIds()[0];
    fake.destroyAll();
    await until(() => fake.open() === 1 && client!.view().state === 'connected' && fake.connIds().length === 2, 5000);
    const replay = fake.sendCommand('tokens.apply', argsOf(1), { connId: old });
    await until(() => fake.results(replay.cmdId).length === 1);
    expect(bodyOf(fake.results(replay.cmdId)[0])).toMatchObject({ phase: 'done', status: 'refused', code: 'wrong_target' });
    fake.sendCommand('tokens.apply', argsOf(1), { cmdId });
    await until(() => fake.results(cmdId).some((r) => bodyOf(r).duplicate));
    expect(bodyOf(fake.results(cmdId).find((r) => bodyOf(r).duplicate)!)).toMatchObject({ phase: 'done', status: 'ok', duplicate: true });
    expect(f.audit.filter((r) => r.action === 'admin-command' && r.outcome === 'success')).toHaveLength(1);
  });
  it('a done that could not be sent goes out as a signed event after the next welcome', async () => {
    fake = await startFakeAdmin();
    let release!: () => void;
    const f = runnerFixture({ handlers: { 'tokens.apply': () => new Promise<Done>((r) => (release = () => r({ status: 'ok', result: { revision: 1, applied: true, stale: false, client: 0, admin: 0, blocked: [] } }))) } });
    make(f);
    await until(() => client!.view().state === 'connected');
    fake.closeAfterReceived = true;
    const { cmdId } = fake.sendCommand('tokens.apply', argsOf(1));
    await until(() => fake.results(cmdId).length === 1 && fake.open() === 0);
    fake.closeAfterReceived = false;
    await until(() => client!.view().state !== 'connected');
    release();
    await until(() => fake.events().some((e) => bodyOf(e).cmdId === cmdId), 5000);
    const ev = fake.events().find((e) => bodyOf(e).cmdId === cmdId)!;
    expect(ev.msg.body).toMatchObject({ kind: 'command.done', phase: 'done', status: 'ok', connId: fake.connIds().at(-1) });
    expect(fake.verifyFromProxy(ev.msg)).toBe(true);
    expect(strict('event')(ev.msg), why(strict('event'))).toBe(true);
  });
  it('the replay mark cannot be saved: admin_replay_save_failed, no hello, the client retries', async () => {
    fake = await startFakeAdmin();
    const f = runnerFixture();
    const key = fake.keyFile();
    const lines: string[] = [];
    client = new AdminClient({ keyFile: key, health: async () => buildHealth(input({ now: Date.now() })), proxyInfo: () => ({ startedAt: 1, uptimeS: 2, configSchema: 2, tls: null, publicUrl: null }), version: 'test', log: { ...quiet, warn: (_o, m) => void lines.push(m) }, timing: FAST, random: () => 0.5, commands: f.runner, replay: { challenge: () => { throw new Error('EACCES: permission denied'); } } });
    client.start();
    await until(() => fake.connections >= 2, 5000);
    expect(lines).toContain('admin_replay_save_failed');
    expect(lines).not.toContain('admin_client_error');
    expect(fake.received.filter((r) => r.msg.type === 'hello')).toHaveLength(0);
  });
  it('a command without a readable cmdId: error bad_message with re, no result', async () => {
    fake = await startFakeAdmin();
    make(runnerFixture());
    await until(() => client!.view().state === 'connected');
    const { id } = fake.sendCommand('tokens.apply', argsOf(1), { cmdId: 'nope' });
    await until(() => fake.received.some((r) => r.msg.type === 'error' && r.msg.re === id));
    expect(fake.received.find((r) => r.msg.re === id)!.msg.body).toMatchObject({ code: 'bad_message' });
    expect(fake.results()).toHaveLength(0);
  });
  it('a flood of badly signed commands: each refused, then the connection closes (the unsupported limit)', async () => {
    fake = await startFakeAdmin();
    make(runnerFixture());
    await until(() => client!.view().state === 'connected');
    for (let i = 0; i < 25; i++) fake.sendCommand('tokens.apply', argsOf(1), { key: vectors.keys.other.privateKey });
    await until(() => fake.connections >= 2, 5000);
    expect(fake.results().filter((r) => bodyOf(r).code === 'bad_signature').length).toBeGreaterThanOrEqual(20);
  });
});

// The whole proxy, enrolled with the fake cams-admin.
const MARK = (n: string) => `SECRETMARKER${n}`.padEnd(40, 'Q');
const MARKERS = { CAMPROXY_AUDIT_TOKEN: MARK('audit'), CAMPROXY_FTP_PASSWORD: MARK('ftp'), CAMPROXY_POE_SWITCH_PASSWORD: MARK('poe') };
describe('tokens.apply through the proxy', () => {
  let sim: Awaited<ReturnType<typeof startSim>>;
  let fake: FakeAdmin;
  let p: Awaited<ReturnType<typeof startProxy>>;
  let key: ReturnType<FakeAdmin['keyFile']>;
  const policyFile = () => join(p.dir, 'data', 'admin', 'policy.json');
  const setPolicy = (o: Record<string, unknown>) => writePrivateJson(policyFile(), { v: 1, changedAt: Date.now(), changedBy: 'local', ...o });
  const t1 = tok();
  const t2 = tok();
  beforeAll(async () => {
    sim = await startSim();
    fake = await startFakeAdmin();
    fake.welcomeHeartbeatS = 1;
    fake.nextInS = 1;
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-cmd-'));
    key = fake.keyFile();
    writeKeyFile(join(dir, 'data', 'admin', 'key.json'), key);
    p = await startProxy(sim, { dir, settings: { camsAdmin: { url: fake.url } }, env: MARKERS, proxy: { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200 } } } });
    await until(() => fake.open() === 1 && fake.heartbeats().length >= 1, 10_000);
  }, 60_000);
  afterAll(async () => {
    await p?.proxy.stop();
    await fake?.close();
    await sim?.close();
  });

  it('commands are off by default: not_allowed, nothing written', async () => {
    const { cmdId } = fake.sendCommand('tokens.apply', argsOf(1, [{ id: TOK(1), kind: 'client', t: t1 }]));
    await until(() => fake.results(cmdId).length === 1);
    expect(bodyOf(fake.results(cmdId)[0])).toMatchObject({ phase: 'done', status: 'refused', code: 'not_allowed' });
    expect(fake.verifyFromProxy(fake.results(cmdId)[0].msg)).toBe(true);
    expect((await request(p.base).get('/api/cameras').set(auth(t1))).status).toBe(401);
  });
  it('allowed locally: received then done ok, the token works at once, CAMPROXY_TOKENS too', async () => {
    setPolicy({ allow: ['tokens.apply'] });
    const { cmdId } = fake.sendCommand('tokens.apply', argsOf(1, [{ id: TOK(1), kind: 'client', t: t1 }]));
    await until(() => fake.results(cmdId).length === 2);
    expect(bodyOf(fake.results(cmdId)[1])).toMatchObject({ status: 'ok', result: { revision: 1, applied: true, client: 1 } });
    await request(p.base).get('/api/cameras').set(auth(t1)).expect(200);
    await request(p.base).get('/api/cameras').set(auth(CLIENT_TOKEN)).expect(200);
  });
  it('an admin entry needs tokens.apply.admin (R2-2)', async () => {
    const { cmdId } = fake.sendCommand('tokens.apply', argsOf(2, [{ id: TOK(1), kind: 'client', t: t1 }, { id: TOK(2), kind: 'admin', t: t2 }]));
    await until(() => fake.results(cmdId).length === 1);
    expect(bodyOf(fake.results(cmdId)[0])).toMatchObject({ code: 'not_allowed' });
    expect((await request(p.base).get('/control/status').set(auth(t2))).status).toBe(401);
  });
  it('every refusal is a signed result with its code; nothing applied', async () => {
    const cases = [[{ key: vectors.keys.other.privateKey }, 'bad_signature'], [{ connId: `con_${'9'.repeat(20)}` }, 'wrong_target'], [{ exp: 'past' as const }, 'expired'], [{ exp: 'far' as const }, 'expired']] as const;
    for (const [o, code] of cases) {
      const { cmdId } = fake.sendCommand('tokens.apply', argsOf(9), o);
      await until(() => fake.results(cmdId).length === 1);
      expect(bodyOf(fake.results(cmdId)[0]), code).toMatchObject({ phase: 'done', status: 'refused', code });
      expect(fake.verifyFromProxy(fake.results(cmdId)[0].msg)).toBe(true);
    }
    const st = (await request(p.base).get('/control/status').set(auth(ADMIN_TOKEN))).status;
    expect(st).toBe(200);
    await request(p.base).get('/api/cameras').set(auth(t1)).expect(200);
  });
  it('the heartbeat carries commands, tokens and configRevision (strict schema)', async () => {
    const n = fake.heartbeats().length;
    await until(() => fake.heartbeats().length > n + 1, 10_000);
    const hb = fake.heartbeats().at(-1)!.msg;
    expect(strict('heartbeat')(hb), why(strict('heartbeat'))).toBe(true);
    expect((hb.body as Record<string, any>).proxy).toMatchObject({ commands: { enabled: true, paused: false, pauseReason: null, allow: ['tokens.apply'], seenWindow: 1000 }, tokens: { revision: 1, client: 1, admin: 0, blocked: [] }, configRevision: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
  });
  it('paused locally: paused, and the heartbeat says so', async () => {
    setPolicy({ allow: ['tokens.apply'], paused: true, pauseReason: 'incident' });
    const { cmdId } = fake.sendCommand('tokens.apply', argsOf(3));
    await until(() => fake.results(cmdId).length === 1);
    expect(bodyOf(fake.results(cmdId)[0])).toMatchObject({ code: 'paused' });
    const n = fake.heartbeats().length;
    await until(() => fake.heartbeats().length > n + 1, 10_000);
    expect((fake.heartbeats().at(-1)!.msg.body as Record<string, any>).proxy.commands).toMatchObject({ paused: true, pauseReason: 'incident' });
    setPolicy({ allow: ['tokens.apply'] });
  });
  it('the results, events and heartbeats pass the strict schemas; no secret, token or hash in anything sent or audited', async () => {
    for (const r of fake.received.filter((x) => ['result', 'event', 'heartbeat', 'hello'].includes(x.msg.type))) {
      const v = strict(r.msg.type);
      expect(v(r.msg), `${r.msg.type}: ${why(v)}`).toBe(true);
    }
    const sent = JSON.stringify(fake.received);
    const audit = readFileSync(join(p.dir, 'data', 'audit', readdir(join(p.dir, 'data', 'audit')).at(-1)!), 'utf8');
    for (const s of [...Object.values(MARKERS), CLIENT_TOKEN, ADMIN_TOKEN, t1, t2, hashOf(t1).slice(7, 23), hashOf(t2).slice(7, 23), key.privateKey]) {
      expect(sent.includes(s), s.slice(0, 12)).toBe(false);
      expect(audit.includes(s), s.slice(0, 12)).toBe(false);
    }
    expect(audit).toContain('"admin-command"');
  });
});

describe('CAMPROXY_ADMIN_COMMANDS=off', () => {
  let sim: Awaited<ReturnType<typeof startSim>>;
  let fake: FakeAdmin;
  let p: Awaited<ReturnType<typeof startProxy>>;
  beforeAll(async () => {
    sim = await startSim();
    fake = await startFakeAdmin();
    fake.welcomeHeartbeatS = 1;
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-cmdoff-'));
    writeKeyFile(join(dir, 'data', 'admin', 'key.json'), fake.keyFile());
    writePrivateJson(join(dir, 'data', 'admin', 'policy.json'), { v: 1, allow: ['tokens.apply'], changedAt: 1, changedBy: 'local' });
    writeFileSync(join(dir, '.env'), 'CAMPROXY_ADMIN_COMMANDS=off\n', { mode: 0o600 });
    p = await startProxy(sim, { dir, settings: { camsAdmin: { url: fake.url } }, env: { CAMPROXY_ENV_FILE: join(dir, '.env'), CAMPROXY_ADMIN_COMMANDS: 'on' }, proxy: { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0 } } } });
    await until(() => fake.heartbeats().length >= 1, 10_000);
  }, 60_000);
  afterAll(async () => {
    await p?.proxy.stop();
    await fake?.close();
    await sim?.close();
  });
  it('the hello does not announce commands (cams-admin sends none)', () => {
    expect(fake.received.find((r) => r.msg.type === 'hello')!.msg.body).toMatchObject({ capabilities: ['status'] });
  });
  it('enabled false in the heartbeat; every command paused', async () => {
    expect((fake.heartbeats()[0].msg.body as Record<string, any>).proxy.commands).toMatchObject({ enabled: false, allow: ['tokens.apply'] });
    const { cmdId } = fake.sendCommand('tokens.apply', argsOf(1));
    await until(() => fake.results(cmdId).length === 1);
    expect(bodyOf(fake.results(cmdId)[0])).toMatchObject({ code: 'paused' });
  });
});
