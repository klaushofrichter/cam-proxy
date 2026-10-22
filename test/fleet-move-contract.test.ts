import { afterEach, describe, expect, it } from 'vitest';
import { checkCommand, CommandLimits, SeenIds, type CheckContext } from '../src/fleet/command-check';
import { ARGS_VALIDATORS } from '../src/fleet/command-args';
import { AdminClient, type ClientLog, type Timing } from '../src/fleet/client';
import { ALLOW_ENTRIES, entryFor, ENTRY_TEXT, IMPLEMENTED } from '../src/fleet/policy';
import { newId } from '../src/fleet/protocol';
import { moveHandlers } from '../src/moves/commands';
import type { MoveEvent } from '../src/moves/types';
import { buildHealth } from '../src/health/summary';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CONTRACT, fixtures, pending, strict, why, type Fixture } from './helpers/contract';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { input } from './helpers/health-input';
import { until } from './helpers/proxy';

// The camera-move group of the cams-admin contract (cams-admin contract/README
// "Camera moves"; cam-proxy plan 2026-10-21-camera-move-cam-proxy Task 1): the
// nine commands, their two allow entries, the signed events.
const MOVE = ['move.targets', 'move.open', 'move.offer', 'move.answer', 'move.start', 'move.go', 'move.release', 'move.finish', 'move.cancel'];
const quiet: ClientLog = { info() {}, warn() {}, debug() {} };
const FAST: Partial<Timing> = { connectTimeoutMs: 1000, helloTimeoutMs: 500, closeGraceMs: 200, backoffCapMs: 300, minIntervalS: 0.2, jitterS: 0, byeWaitMs: 500 };
const isMove = (f: Fixture) => f.schema === 'command' && MOVE.includes((f.message as { body: { command: string } }).body.command);
const ctxOf = (f: Fixture, allow?: string[]): CheckContext => {
  const c = f.$context!;
  const seen = new SeenIds();
  for (const id of c.seen ?? []) seen.add(id, c.now);
  return { proxyId: c.proxyId, connId: c.connId, serverKeys: c.serverKeys, serverNow: c.now, seen, policy: { enabled: c.enabled !== false, paused: !!c.paused, allow: allow ?? c.allow ?? [] }, journal: () => undefined, limits: new CommandLimits(() => c.now), implemented: IMPLEMENTED };
};
const verdict = (f: Fixture, allow?: string[]) => {
  const d = checkCommand(f.message as never, ctxOf(f, allow));
  return d.kind === 'nack' ? d.code : d.kind;
};
const fixture = (name: string): Fixture => fixtures().find((x) => x.name === name)!.f;
// A fixture's command with its args changed, signed again with the contract's server key is not possible here:
// the verdict of args is judged on the validators directly.
const argsOfFixture = (name: string) => ((fixture(name).message as { body: { args: Record<string, unknown> } }).body.args);

describe('the move commands against the vendored contract', () => {
  it('every move fixture validates against IMPLEMENTED (no pending fixtures)', () => {
    const moves = fixtures().filter(({ f }) => isMove(f));
    expect(moves.length).toBeGreaterThanOrEqual(11);
    expect(moves.filter(({ f }) => pending(f, IMPLEMENTED)).map((x) => x.name)).toEqual([]);
    for (const { name, f } of moves) {
      const want = name.startsWith('valid-') ? 'run' : f.$expect!.runtime;
      expect(verdict(f), name).toBe(want);
    }
    // each of the nine has a valid fixture and a validator
    for (const c of MOVE) {
      expect(moves.some(({ name }) => name === `valid-command-${c.replace('.', '-')}`), c).toBe(true);
      expect(ARGS_VALIDATORS[c], c).toBeTypeOf('function');
      expect(IMPLEMENTED.has(c), c).toBe(true);
    }
  });

  it('move.offer without move.receive is refused not_allowed', () => {
    const f = fixture('valid-command-move-offer');
    expect(verdict(f, ['move.receive'])).toBe('run');
    expect(verdict(f, ['move.send'])).toBe('not_allowed');
    expect(verdict(f, [])).toBe('not_allowed');
    expect(verdict(fixture('refused-move-offer-not-allowed'))).toBe('not_allowed');
  });

  it('move.cancel role source needs move.send; role target needs move.receive and copied', () => {
    const f = fixture('valid-command-move-cancel');
    const base = argsOfFixture('valid-command-move-cancel');
    expect(base.role).toBe('target');
    expect(verdict(f, ['move.receive'])).toBe('run');
    // the same fixture with only move.send passes step 8 (either entry) and fails at step 11 for role target
    expect(verdict(f, ['move.send'])).toBe('not_allowed');
    // role source: needs move.send, never move.receive (checked on entryFor, which step 11 uses)
    const source = { v: 1, moveId: base.moveId, role: 'source' };
    expect(ARGS_VALIDATORS['move.cancel'](source)).toMatchObject({ ok: true });
    expect(entryFor('move.cancel', source)).toBe('move.send');
    expect(entryFor('move.cancel', base)).toBe('move.receive');
    expect(verdict(fixture('refused-move-cancel-target-no-copied'))).toBe('invalid_args');
  });

  it('the entry each command needs; the other commands need themselves', () => {
    for (const c of ['move.targets', 'move.open', 'move.answer', 'move.go', 'move.release']) expect(entryFor(c, { v: 1 }), c).toBe('move.send');
    for (const c of ['move.offer', 'move.start']) expect(entryFor(c, { v: 1 }), c).toBe('move.receive');
    expect(entryFor('move.finish', { role: 'source' })).toBe('move.send');
    expect(entryFor('move.finish', { role: 'target' })).toBe('move.receive');
    expect(entryFor('config.get', { v: 1 })).toBe('config.get');
    expect(entryFor('camera.action', { action: 'camera-test' })).toBe('camera.action:camera-test');
    for (const e of ['move.send', 'move.receive']) {
      expect(ALLOW_ENTRIES).toContain(e);
      expect(IMPLEMENTED.has(e), e).toBe(true);
    }
    expect(ENTRY_TEXT['move.send']).toBe('cams-admin may move a camera from this proxy to another proxy of the account, after you approve the move here or in a cams-admin sign-in');
    expect(ENTRY_TEXT['move.receive']).toBe('cams-admin may hand this proxy a camera from another proxy of the account: it adds the camera, its password and certificate, and copies its content');
  });

  it('a role other than source or target, or a missing one, is invalid_args; move.finish role decides its entry', () => {
    const f = fixture('valid-command-move-finish');
    expect(verdict(f, ['move.send'])).toBe('run');
    expect(verdict(f, ['move.receive'])).toBe('not_allowed');
    const a = argsOfFixture('valid-command-move-finish');
    for (const bad of [{ ...a, role: 'both' }, { ...a, role: undefined }, { ...a, abandoned: 'no' }, { ...a, extra: 1 }]) expect(ARGS_VALIDATORS['move.finish'](JSON.parse(JSON.stringify(bad)))).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(ARGS_VALIDATORS['move.finish']({ ...a, v: 2 })).toMatchObject({ ok: false, code: 'unsupported_version' });
  });

  it('the validators agree with the strict schemas on the fixtures and refuse their mutations', () => {
    for (const c of MOVE) {
      const a = argsOfFixture(`valid-command-${c.replace('.', '-')}`);
      expect(ARGS_VALIDATORS[c](a), c).toMatchObject({ ok: true });
      const v = strict(`commands/${c}.args`);
      expect(v(a), `${c}: ${why(v)}`).toBe(true);
      expect(ARGS_VALIDATORS[c]({ ...a, surprise: 1 }), `${c} unknown field`).toMatchObject({ ok: false });
      if (c !== 'move.targets') expect(ARGS_VALIDATORS[c]({ ...a, moveId: 'mv_short' }), `${c} moveId`).toMatchObject({ ok: false });
      expect(ARGS_VALIDATORS[c]('x'), c).toMatchObject({ ok: false });
    }
    const go = argsOfFixture('valid-command-move-go');
    expect(ARGS_VALIDATORS['move.go']({ ...go, targetPublicKey: 'MCowBQYDK2VuAyEA' })).toMatchObject({ ok: false });
    expect(ARGS_VALIDATORS['move.go']({ ...go, expectedLeaf: 'SHA256:abc' })).toMatchObject({ ok: false });
    const start = argsOfFixture('valid-command-move-start') as { done: string[] };
    expect(ARGS_VALIDATORS['move.start']({ ...start, done: Array.from({ length: 512 }, (_, i) => `stills:2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`) })).toMatchObject({ ok: true });
    expect(ARGS_VALIDATORS['move.start']({ ...start, done: Array.from({ length: 513 }, () => 'stills:2026-01-01') })).toMatchObject({ ok: false });
    expect(ARGS_VALIDATORS['move.start']({ ...start, done: ['stills:today'] })).toMatchObject({ ok: false });
    const offer = argsOfFixture('valid-command-move-offer');
    expect(ARGS_VALIDATORS['move.offer']({ ...offer, token: 'short' })).toMatchObject({ ok: false });
    // targetIp is loose in the contract: the validator keeps its pattern, it is not IP validation
    const open = argsOfFixture('valid-command-move-open');
    expect(ARGS_VALIDATORS['move.open']({ ...open, targetIp: 'ab' })).toMatchObject({ ok: true });
    expect(ARGS_VALIDATORS['move.open']({ ...open, targetIp: 'not an ip' })).toMatchObject({ ok: false });
  });

  it('move.answer takes every reason the contract lists (not_registered and internal included), nothing else', () => {
    const a = argsOfFixture('valid-command-move-answer');
    const schema = JSON.parse(readFileSync(join(CONTRACT, 'strict', 'commands', 'move.answer.args.schema.json'), 'utf8')) as { properties: { reason: { enum: string[] } } };
    const reasons = schema.properties.reason.enum;
    expect(reasons).toContain('not_registered');
    expect(reasons).toContain('internal');
    for (const reason of reasons) expect(ARGS_VALIDATORS['move.answer']({ ...a, accept: false, reason }), reason).toMatchObject({ ok: true });
    expect(ARGS_VALIDATORS['move.answer']({ ...a, accept: false, reason: 'no_such_reason' })).toMatchObject({ ok: false, code: 'invalid_args' });
  });

  it('move.* commands are rate limited (the overall 30 a minute binds below the move window of 60) and need no journal budget', () => {
    let t = 1_000_000;
    const l = new CommandLimits(() => t);
    for (let i = 0; i < 30; i++) expect(l.take(MOVE[i % 9]).ok, String(i)).toBe(true);
    expect(l.take('move.go').ok).toBe(false);
    t += 60_000;
    expect(l.take('move.go').ok).toBe(true);
  });

  it('the handlers: one per command name, each a stub answering failed/internal', async () => {
    const emitted: MoveEvent[] = [];
    const h = moveHandlers({ emit: (e) => void emitted.push(e), audit: { write: (r: never) => r } as never });
    expect(Object.keys(h).sort()).toEqual([...MOVE].sort());
    for (const c of MOVE) expect(await h[c]({ v: 1 }, { cmdId: 'cmd_x' } as never), c).toEqual({ status: 'failed', code: 'internal' });
    expect(emitted).toEqual([]);
  });

  it('request and move ids are prefix + 20 Crockford characters', () => {
    for (const p of ['rq_', 'mv_']) expect(newId(p)).toMatch(new RegExp(`^${p}[0-9A-HJKMNP-TV-Z]{20}$`));
    expect(newId('rq_')).not.toBe(newId('rq_'));
  });
});

// emitEvent: signed `event`s without a cmdId, buffered while offline.
describe('emitEvent', () => {
  let fake: FakeAdmin;
  let client: AdminClient | undefined;
  afterEach(async () => {
    await client?.stop('shutdown');
    client = undefined;
    await fake?.close();
  });
  let proxyId = '';
  const make = (o: { log?: ClientLog; onWelcome?: () => void } = {}) => {
    const key = fake.keyFile();
    proxyId = key.proxyId;
    client = new AdminClient({ keyFile: key, health: async () => buildHealth(input({ now: Date.now() })), proxyInfo: () => ({ startedAt: 1, uptimeS: 2, configSchema: 2, tls: null, publicUrl: null }), version: 'test', log: o.log ?? quiet, timing: FAST, random: () => 0.5, onWelcome: o.onWelcome });
    return client;
  };
  const phase = (n: number): MoveEvent => ({ kind: 'move.phase', moveId: `mv_${String(n).padStart(20, '0')}`, role: 'source', phase: 'opened', ok: true, detail: `n${n}` });
  const moves = () => fake.events().map((e) => e.msg.body as Record<string, any>).filter((b) => b.kind === 'move.phase');

  it('emitEvent while offline is sent after welcome, in order', async () => {
    fake = await startFakeAdmin();
    const c = make();
    c.emitEvent(phase(1));
    c.emitEvent({ kind: 'move.progress', moveId: `mv_${'1'.padStart(20, '0')}`, chunks: [{ id: 'stills:2026-10-01', state: 'copied' }], bytesDone: 1, bytesTotal: 2, rateBps: 3, etaS: 4 });
    c.emitEvent(phase(3));
    expect(fake.events()).toHaveLength(0);
    c.start();
    await until(() => fake.events().length === 3, 5000);
    const got = fake.events().map((e) => e.msg.body as Record<string, any>);
    expect(got.map((b) => b.kind)).toEqual(['move.phase', 'move.progress', 'move.phase']);
    expect(got.map((b) => b.detail)).toEqual(['n1', undefined, 'n3']);
    for (const [i, e] of fake.events().entries()) {
      expect(fake.verifyFromProxy(e.msg), String(i)).toBe(true);
      expect(strict('event')(e.msg), `${i}: ${why(strict('event'))}`).toBe(true);
      expect(e.msg.body, 'no cmdId').not.toHaveProperty('cmdId');
      expect(e.msg.body).toMatchObject({ proxyId, connId: fake.connIds().at(-1) });
    }
    // while connected it goes out at once
    c.emitEvent(phase(4));
    await until(() => fake.events().length === 4, 5000);
    expect((fake.events()[3].msg.body as Record<string, any>).detail).toBe('n4');
  });

  it('emitEvent buffer keeps the newest 256 and says so in the log', async () => {
    fake = await startFakeAdmin();
    const lines: { m: string; o: Record<string, unknown> }[] = [];
    const c = make({ log: { ...quiet, warn: (o, m) => void lines.push({ m, o: o as Record<string, unknown> }) } });
    for (let i = 1; i <= 300; i++) c.emitEvent(phase(i));
    c.start();
    await until(() => moves().length === 256, 8000);
    const details = moves().map((b) => b.detail);
    expect(details[0]).toBe('n45');
    expect(details.at(-1)).toBe('n300');
    expect(details).toEqual(Array.from({ length: 256 }, (_, i) => `n${45 + i}`));
    expect(lines.some((l) => l.m === 'admin_event_dropped' && (l.o.dropped as number) >= 1)).toBe(true);
    expect(lines.filter((l) => l.m === 'admin_event_dropped').length).toBeLessThanOrEqual(2);
  });

  it('a refused send (backpressure) is retried on the next heartbeat tick, without a new emit', async () => {
    fake = await startFakeAdmin();
    fake.welcomeHeartbeatS = 0.2;
    fake.nextInS = 0.2;
    const c = make();
    c.start();
    await until(() => fake.heartbeats().length >= 1, 5000);
    const t = (c as unknown as { t: { maxBufferedBytes: number } }).t;
    const limit = t.maxBufferedBytes;
    t.maxBufferedBytes = -1;
    c.emitEvent(phase(7));
    await new Promise((r) => setTimeout(r, 100));
    expect(moves()).toHaveLength(0);
    t.maxBufferedBytes = limit;
    await until(() => moves().length === 1, 5000);
    expect(moves()[0].detail).toBe('n7');
  });

  it('a failed phase event without a code is invalid on the strict schema; with one it is valid', () => {
    const ev = (body: Record<string, unknown>) => ({ v: 1, type: 'event', id: '01K60000000000000000000003', seq: 3, ts: 1791273600003, sig: `${'A'.repeat(86)}==`, body: { proxyId: 'prx_0123456789ABCDEFGHJK', connId: 'con_0123456789ABCDEFGHJK', kind: 'move.phase', moveId: 'mv_0123456789ABCDEFGHJK', role: 'target', ok: false, ...body } });
    const v = strict('event');
    expect(v(ev({ phase: 'failed' }))).toBe(false);
    expect(v(ev({ phase: 'failed', code: 'token_address' })), why(v)).toBe(true);
    expect(v(ev({ phase: 'copying', ok: true }))).toBe(true);
    // and the type refuses it at compile time
    // @ts-expect-error a failed phase needs a code
    const bad: MoveEvent = { kind: 'move.phase', moveId: 'mv_x', role: 'target', phase: 'failed', ok: false };
    expect(bad.kind).toBe('move.phase');
  });

  it('onWelcome runs after every welcome, after the buffered events (B2: re-emit the current phase)', async () => {
    fake = await startFakeAdmin();
    let n = 0;
    const c = make({ onWelcome: () => void c.emitEvent(phase(100 + ++n)) });
    c.emitEvent(phase(1));
    c.start();
    await until(() => moves().length === 2, 5000);
    expect(moves().map((b) => b.detail)).toEqual(['n1', 'n101']);
    fake.destroyAll();
    await until(() => moves().length === 3, 8000);
    expect(moves().map((b) => b.detail)).toEqual(['n1', 'n101', 'n102']);
  });
});
