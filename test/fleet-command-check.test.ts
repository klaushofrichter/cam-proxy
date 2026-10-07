import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { checkCommand, CommandLimits, journalBudgetOf, SeenIds, type CheckContext } from '../src/fleet/command-check';
import { Journal, type JournalEntry } from '../src/fleet/journal';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ALLOW_ENTRIES, IMPLEMENTED, NEVER_REMOTE_ACTIONS } from '../src/fleet/policy';
import { generateKeyPair, signEnvelope, type Envelope } from '../src/fleet/protocol';
import { fixtures, pending, vectors, type FixtureContext } from './helpers/contract';

// The command check (contract P2, "Check order on the proxy"), steps 1-11.
const SERVER = generateKeyPair();
const OTHER = generateKeyPair();
const PRX = `prx_${'1'.repeat(20)}`;
const CON = `con_${'2'.repeat(20)}`;
const NOW = 1_800_000_000_000;
const hash = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const TOKENS = { v: 1, revision: 2, tokens: [{ id: `tok_${'3'.repeat(20)}`, kind: 'client', hash: hash('x'), label: 'cams cluster', retireAt: null }] };
let n = 0;
const cmd = (patch: (b: Record<string, any>, e: Record<string, any>) => void = () => {}, key = SERVER.privateKey): Envelope => {
  n++;
  const e: Record<string, any> = { v: 1, type: 'command', id: `msg_${String(n).padStart(22, '0')}`, seq: n, ts: NOW, body: { proxyId: PRX, connId: CON, cmdId: `cmd_${String(n).padStart(20, '0')}`, exp: NOW + 30_000, actor: 'ops@example.com', command: 'tokens.apply', args: structuredClone(TOKENS) } };
  patch(e.body, e);
  return { ...e, sig: signEnvelope(key, e as never) } as Envelope;
};
const ctx = (extra: Partial<CheckContext> = {}): CheckContext => ({
  proxyId: PRX, connId: CON, serverKeys: [SERVER.publicKey], serverNow: NOW, seen: new SeenIds(),
  policy: { enabled: true, paused: false, allow: ['tokens.apply'] }, journal: () => undefined, limits: new CommandLimits(() => NOW), implemented: IMPLEMENTED, ...extra,
});
const code = (m: Envelope, c: CheckContext) => {
  const d = checkCommand(m, c);
  return d.kind === 'nack' ? d.code : d.kind;
};

// The journal budget over a list of entries (a fixture's $context.journal).
const countOf = (list: { command: string; at: number; action?: string }[]) => (pred: (e: JournalEntry) => boolean, since: number) => {
  const hits = list.filter((e) => e.at >= since && pred({ cmdId: '', actor: '', status: 'ok', ...e } as JournalEntry));
  return { n: hits.length, oldest: hits.length ? Math.min(...hits.map((e) => e.at)) : null };
};

describe('each refusal', () => {
  it('runs a good command', () => {
    const d = checkCommand(cmd(), ctx());
    expect(d).toMatchObject({ kind: 'run', cmd: { command: 'tokens.apply', actor: 'ops@example.com', proxyId: PRX, connId: CON }, args: TOKENS });
  });
  it('bad_signature: another key, no sig, a changed field', () => {
    expect(code(cmd(undefined, OTHER.privateKey), ctx())).toBe('bad_signature');
    const { sig: _s, ...unsignedCmd } = cmd();
    expect(code(unsignedCmd as Envelope, ctx())).toBe('bad_signature');
    const m = cmd();
    expect(code({ ...m, body: { ...m.body, actor: 'mallory' } }, ctx())).toBe('bad_signature');
  });
  it('wrong_target: another proxy, another connection', () => {
    expect(code(cmd((b) => (b.proxyId = 'prx_ZZZZZZZZZZZZZZZZZZZZ')), ctx())).toBe('wrong_target');
    expect(code(cmd(), ctx({ connId: 'con_ZZZZZZZZZZZZZZZZZZZZ' }))).toBe('wrong_target');
  });
  it('expired: exp too far, not after ts, or older than the slack', () => {
    expect(code(cmd((b) => (b.exp = NOW + 60_001)), ctx())).toBe('expired');
    expect(code(cmd((b) => (b.exp = NOW)), ctx())).toBe('expired');
    expect(code(cmd((b) => (b.exp = 'soon')), ctx())).toBe('expired');
    expect(code(cmd((b) => (b.exp = NOW + 1000)), ctx({ serverNow: NOW + 1000 + 120_001 }))).toBe('expired');
  });
  it('paused: paused, or the env switch off', () => {
    expect(code(cmd(), ctx({ policy: { enabled: true, paused: true, allow: ['tokens.apply'] } }))).toBe('paused');
    expect(code(cmd(), ctx({ policy: { enabled: false, paused: false, allow: ['tokens.apply'] } }))).toBe('paused');
  });
  it('not_allowed: not in the allow-list, unknown, or not implemented by this version', () => {
    expect(code(cmd(), ctx({ policy: { enabled: true, paused: false, allow: [] } }))).toBe('not_allowed');
    expect(code(cmd((b) => (b.command = 'frobnicate')), ctx())).toBe('not_allowed');
    expect(code(cmd((b) => (b.command = 'camera.action')), ctx({ policy: { enabled: true, paused: false, allow: ['tokens.apply'] } }))).toBe('not_allowed');
  });
  it('args over 16384 bytes of canonical JSON are invalid_args (the contract bound), checked before the validator', () => {
    // 64 tokens with 64-character labels of 4-byte characters: each entry valid, the whole too big.
    const big = (b: Record<string, any>) => (b.args.tokens = Array.from({ length: 64 }, (_, i) => ({ id: `tok_${String(i).padStart(20, '0')}`, kind: 'client', hash: hash(`t${i}`), label: '\u{1F600}'.repeat(64), retireAt: null })));
    expect(code(cmd(big), ctx())).toBe('invalid_args');
    expect(code(cmd((b) => (b.args = 'not an object')), ctx())).toBe('invalid_args');
  });
  it('unsupported_version and invalid_args', () => {
    expect(code(cmd((b) => (b.args.v = 2)), ctx())).toBe('unsupported_version');
    expect(code(cmd((b) => (b.args.tokens[0].hash = b.args.tokens[0].hash.toUpperCase())), ctx())).toBe('invalid_args');
  });
  it('an admin entry needs tokens.apply.admin too (R2-2); removing admins needs only tokens.apply', () => {
    const admin = (b: Record<string, any>) => (b.args.tokens[0].kind = 'admin');
    expect(code(cmd(admin), ctx())).toBe('not_allowed');
    expect(code(cmd(admin), ctx({ policy: { enabled: true, paused: false, allow: ['tokens.apply', 'tokens.apply.admin'] } }))).toBe('run');
    expect(code(cmd((b) => (b.args.tokens = [])), ctx())).toBe('run');
  });
});

describe('the check order', () => {
  it('a bad signature wins over a wrong target and an expired exp', () => {
    expect(code(cmd((b) => { b.proxyId = 'prx_ZZZZZZZZZZZZZZZZZZZZ'; b.exp = 1; }, OTHER.privateKey), ctx())).toBe('bad_signature');
  });
  it('replay on the same connection; the same envelope on another connection is wrong_target', () => {
    const m = cmd();
    const c = ctx();
    expect(code(m, c)).toBe('run');
    expect(code(m, c)).toBe('replayed');
    expect(code(m, ctx({ connId: 'con_ZZZZZZZZZZZZZZZZZZZZ' }))).toBe('wrong_target');
  });
  it('a journaled cmdId is a duplicate even when paused (nothing runs)', () => {
    const m = cmd();
    const entry = { cmdId: (m.body as { cmdId: string }).cmdId, command: 'tokens.apply', actor: 'a', at: 1, status: 'ok' as const, result: { revision: 1 } };
    expect(checkCommand(m, ctx({ journal: () => entry, policy: { enabled: true, paused: true, allow: [] } }))).toMatchObject({ kind: 'duplicate', entry });
    expect(checkCommand(cmd(), ctx({ journal: () => 'running' }))).toMatchObject({ kind: 'duplicate', entry: 'running' });
  });
  it('env off beats the allow-list; not allowed beats rate limits; rate limits beat bad args', () => {
    expect(code(cmd(), ctx({ policy: { enabled: false, paused: false, allow: [] } }))).toBe('paused');
    const limits = new CommandLimits(() => NOW);
    for (let i = 0; i < 6; i++) limits.take('tokens.apply');
    expect(code(cmd(), ctx({ limits, policy: { enabled: true, paused: false, allow: [] } }))).toBe('not_allowed');
    expect(checkCommand(cmd((b) => (b.args.v = 'x')), ctx({ limits }))).toMatchObject({ code: 'rate_limited', retryAfterS: expect.any(Number) });
  });
  it('exp is judged on the server clock from the challenge (R2-4): the proxy clock never enters', () => {
    expect(code(cmd(), ctx({ serverNow: NOW + 30_000 + 119_000 }))).toBe('run');
    expect(code(cmd(), ctx({ serverNow: NOW + 30_000 + 121_000 }))).toBe('expired');
  });
  it('a body without a readable cmdId is bad_message (no result), before the signature', () => {
    expect(checkCommand(cmd((b) => (b.cmdId = 7)), ctx())).toEqual({ kind: 'bad_message' });
    expect(checkCommand(cmd((b) => (b.cmdId = 'cmd_x'), OTHER.privateKey), ctx())).toEqual({ kind: 'bad_message' });
  });
});

describe('limits and the seen set', () => {
  it('30/min, 300/day, tokens.apply 6/h', () => {
    let now = 0;
    const l = new CommandLimits(() => now);
    for (let i = 0; i < 6; i++) expect(l.take('tokens.apply').ok).toBe(true);
    expect(l.take('tokens.apply')).toMatchObject({ ok: false });
    for (let i = 0; i < 24; i++) expect(l.take('config.get').ok).toBe(true);
    expect(l.take('config.get')).toMatchObject({ ok: false, retryAfterS: 60 });
    now += 60_000;
    expect(l.take('config.get').ok).toBe(true);
    for (let d = 0; d < 9; d++) {
      now += 60_000;
      for (let i = 0; i < 30; i++) l.take('config.get');
    }
    now += 60_000;
    expect(l.take('config.get')).toMatchObject({ ok: false });
  });
  it('seen ids expire after their ttl and stay bounded', () => {
    const s = new SeenIds(1000, 3);
    s.add('a', 0);
    expect(s.has('a', 999)).toBe(true);
    expect(s.has('a', 1000)).toBe(false);
    for (const x of ['b', 'c', 'd', 'e']) s.add(x, 1000);
    expect(s.has('b', 1000)).toBe(false);
    expect(s.has('e', 1000)).toBe(true);
  });
});

describe('every contract fixture for the proxy', () => {
  const ctxOf = (c: FixtureContext): CheckContext => {
    const seen = new SeenIds();
    for (const s of c.seen ?? []) seen.add(s, c.now);
    return { proxyId: c.proxyId, connId: c.connId, serverKeys: c.serverKeys, serverNow: c.now, seen, policy: { enabled: c.enabled ?? true, paused: !!c.paused, allow: c.allow ?? [] }, journal: () => undefined, limits: new CommandLimits(() => c.now), implemented: IMPLEMENTED, currentTokens: c.tokens ?? [], journalBudget: journalBudgetOf(countOf(c.journal ?? []), c.now) };
  };
  const cmds = fixtures().filter(({ f }) => f.schema === 'command' && f.$context);
  it('there are command fixtures (the vendored copy is P2, with revocationOnly)', () => {
    expect(cmds.length).toBeGreaterThanOrEqual(17);
    expect(cmds.map((x) => x.name)).toContain('valid-command-revocation-while-paused');
  });
  for (const { name, f } of cmds) {
    if (pending(f, IMPLEMENTED)) {
      it.skip(`${name} (pending: not implemented yet)`, () => {});
      continue;
    }
    it(name, () => {
      const d = checkCommand(f.message as never, ctxOf(f.$context!));
      if (name.startsWith('valid-')) expect(d.kind).toBe('run');
      else {
        expect(f.$expect?.receiver, name).toBe('proxy');
        expect(d.kind === 'nack' ? d.code : d.kind, name).toBe(f.$expect!.runtime);
      }
    });
  }
  it('the fixture command, re-signed with a changed field, is checked in contract order', () => {
    const base = fixtures().find((x) => x.name === 'valid-command-tokens-apply')!;
    const c = base.f.$context!;
    const m = structuredClone(base.f.message) as Record<string, any>;
    delete m.sig;
    m.body.proxyId = 'prx_ZZZZZZZZZZZZZZZZZZZZ';
    expect(checkCommand({ ...m, sig: signEnvelope(vectors.keys.other.privateKey, m as never) } as never, ctxOf(c))).toMatchObject({ code: 'bad_signature' });
    expect(checkCommand({ ...m, sig: signEnvelope(vectors.keys.server.privateKey, m as never) } as never, ctxOf(c))).toMatchObject({ code: 'wrong_target' });
  });
});

// P3 (contract "The P3 contract", check-order changes at steps 8, 9, 10, 11).
const P3 = ['config.get', 'config.set', 'config.unset', 'config.rollback', 'camera.action', 'camera.name.set', 'proxy.restart'];
const P3_IMPLEMENTED: ReadonlySet<string> = new Set([...IMPLEMENTED, ...P3]);
describe('P3: entries, args and budgets', () => {
  const allowAll = [...ALLOW_ENTRIES];
  const c3 = (allow: string[], extra: Partial<CheckContext> = {}) => ctx({ policy: { enabled: true, paused: false, allow }, implemented: P3_IMPLEMENTED, ...extra });
  const p3 = (command: string, args: unknown) => cmd((b) => { b.command = command; b.args = args; });
  const kind = (command: string, args: unknown, c: CheckContext) => code(p3(command, args), c);
  const REV = `sha256:${'a'.repeat(64)}`;
  const CMD = `cmd_${'0'.repeat(20)}`;

  it('camera.action passes step 8 with any camera.action:* entry, then needs its own entry at step 11', () => {
    expect(kind('camera.action', { v: 1, camera: 'cam1', action: 'camera-test' }, c3(['camera.action:camera-test']))).toBe('run');
    expect(kind('camera.action', { v: 1, camera: 'cam1', action: 'camera-reboot' }, c3(['camera.action:camera-test']))).toBe('not_allowed');
    expect(kind('camera.action', { v: 1, camera: 'cam1', action: 'camera-test' }, c3(['config.get']))).toBe('not_allowed');
  });
  it('a never-remote action is not_allowed whatever the allow-list says; an unknown one is invalid_args', () => {
    for (const a of NEVER_REMOTE_ACTIONS) expect(kind('camera.action', { v: 1, camera: 'cam1', action: a }, c3(allowAll)), a).toBe('not_allowed');
    expect(kind('camera.action', { v: 1, camera: 'cam1', action: 'restart-proxy' }, c3(allowAll))).toBe('not_allowed');
    expect(kind('camera.action', { v: 1, camera: 'cam1', action: 'frobnicate' }, c3(allowAll))).toBe('invalid_args');
  });
  it('M5: camera-ftp-off is never remote (it would stop clip intake): not_allowed, not an allow entry', () => {
    expect(ALLOW_ENTRIES).not.toContain('camera.action:camera-ftp-off');
    expect(kind('camera.action', { v: 1, camera: 'cam1', action: 'camera-ftp-off' }, c3([...allowAll, 'camera.action:camera-ftp-off']))).toBe('not_allowed');
  });
  it('M2: the actor loses control, bidi and format characters before anything prints or audits it', () => {
    const d = checkCommand(cmd((b) => { b.command = 'config.get'; b.args = { v: 1 }; b.actor = 'ops\u001b]52;c;QUJD\u0007\u202e@example.org\u0085x'; }), c3(['config.get']));
    expect(d.kind).toBe('run');
    expect((d as { cmd: { actor: string } }).cmd.actor).toBe('ops ]52;c;QUJD  @example.org x');
  });
  it('camera null only for retention-run; retention-run with a camera is invalid; input only for inventory', () => {
    expect(kind('camera.action', { v: 1, camera: null, action: 'camera-reboot' }, c3(allowAll))).toBe('invalid_args');
    expect(kind('camera.action', { v: 1, camera: null, action: 'retention-run' }, c3(allowAll))).toBe('run');
    expect(kind('camera.action', { v: 1, camera: 'cam1', action: 'retention-run' }, c3(allowAll))).toBe('invalid_args');
    expect(kind('camera.action', { v: 1, camera: 'Cam1', action: 'camera-test' }, c3(allowAll))).toBe('invalid_args');
    expect(kind('camera.action', { v: 1, camera: 'cam1', action: 'inventory', input: { kind: 'stills', camera: true } }, c3(allowAll))).toBe('run');
    expect(kind('camera.action', { v: 1, camera: 'cam1', action: 'camera-test', input: { kind: 'stills' } }, c3(allowAll))).toBe('invalid_args');
    expect(kind('camera.action', { v: 1, camera: 'cam1', action: 'inventory', input: { kind: '' } }, c3(allowAll))).toBe('invalid_args');
    expect(kind('camera.action', { v: 1, camera: 'cam1', action: 'inventory', input: { kind: 'x', other: 1 } }, c3(allowAll))).toBe('invalid_args');
  });
  it('config.set args: dotted paths only, leaf values only, 1–64 entries, a revision', () => {
    const base = { v: 1, dryRun: true, baseRevision: REV };
    const ok = (set: object) => kind('config.set', { ...base, set }, c3(['config.set']));
    expect(ok({ 'sse.pingS': 5 })).toBe('run');
    expect(ok({ 'cameras.cam-1.name': 'x', 'ftp.enabled': false })).toBe('run');
    for (const bad of [{}, { 'Sse.pingS': 5 }, { '__proto__.x': 1 }, { 'sse..pingS': 1 }, { 'sse.pingS': null }, { 'sse.pingS': { a: 1 } }, { 'sse.pingS': [1] }, { 'sse.pingS': 1.5 }, { 'x.y': 'z'.repeat(513) }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`a.b${i}`, 1]))])
      expect(ok(bad), JSON.stringify(bad).slice(0, 60)).toBe('invalid_args');
    expect(kind('config.set', { ...base, baseRevision: 'sha256:XYZ', set: { 'sse.pingS': 5 } }, c3(['config.set']))).toBe('invalid_args');
    expect(kind('config.set', { ...base, dryRun: 'yes', set: { 'sse.pingS': 5 } }, c3(['config.set']))).toBe('invalid_args');
    expect(kind('config.set', { ...base, set: { 'sse.pingS': 5 }, extra: 1 }, c3(['config.set']))).toBe('invalid_args');
    expect(kind('config.set', { ...base, v: 2, set: { 'sse.pingS': 5 } }, c3(['config.set']))).toBe('unsupported_version');
  });
  it('config.unset: unique paths; config.rollback: a cmd id; config.get and proxy.restart: exactly {v: 1}; camera.name.set: a name', () => {
    const u = (paths: unknown) => kind('config.unset', { v: 1, dryRun: false, baseRevision: REV, paths }, c3(['config.unset']));
    expect(u(['sse.pingS'])).toBe('run');
    expect(u([])).toBe('invalid_args');
    expect(u(['sse.pingS', 'sse.pingS'])).toBe('invalid_args');
    expect(u(['sse.PingS.'])).toBe('invalid_args');
    expect(u(Array.from({ length: 65 }, (_, i) => `a.b${i}`))).toBe('invalid_args');
    expect(kind('config.rollback', { v: 1, dryRun: false, cmdId: CMD }, c3(['config.rollback']))).toBe('run');
    expect(kind('config.rollback', { v: 1, dryRun: false, cmdId: '../x' }, c3(['config.rollback']))).toBe('invalid_args');
    expect(kind('config.rollback', { v: 1, cmdId: CMD }, c3(['config.rollback']))).toBe('invalid_args');
    expect(kind('config.get', { v: 1 }, c3(['config.get']))).toBe('run');
    expect(kind('config.get', { v: 1, x: 1 }, c3(['config.get']))).toBe('invalid_args');
    expect(kind('proxy.restart', { v: 1 }, c3(['proxy.restart']))).toBe('run');
    expect(kind('proxy.restart', { v: 1, now: true }, c3(['proxy.restart']))).toBe('invalid_args');
    expect(kind('camera.name.set', { v: 1, camera: 'cam1', name: 'Front door' }, c3(['camera.name.set']))).toBe('run');
    expect(kind('camera.name.set', { v: 1, camera: 'cam1', name: 'a\nb' }, c3(['camera.name.set']))).toBe('invalid_args');
    expect(kind('camera.name.set', { v: 1, camera: 'cam1', name: 'x'.repeat(65) }, c3(['camera.name.set']))).toBe('invalid_args');
    expect(kind('camera.name.set', { v: 1, camera: 'cam1', name: '' }, c3(['camera.name.set']))).toBe('invalid_args');
    // CAMERA_NAME_PATTERN (contract, security review M3): no C1, bidi, separator or zero-width characters.
    for (const bad of ['a\u202eb', 'a\u2066b', 'a\u200bb', 'a\u2028b', 'a\u0085b', 'a\ufeffb']) expect(kind('camera.name.set', { v: 1, camera: 'cam1', name: bad }, c3(['camera.name.set'])), JSON.stringify(bad)).toBe('invalid_args');
    expect(kind('camera.name.set', { v: 1, camera: 'cam1', name: 'Garten Süd' }, c3(['camera.name.set']))).toBe('run');
    for (const bad of ['a\u061Cb', 'a\u{E0041}b', 'a\uD800b', 'a\u00ADb', 'a\u180Eb']) expect(kind('camera.name.set', { v: 1, camera: 'cam1', name: bad }, c3(['camera.name.set'])), JSON.stringify(bad)).toBe('invalid_args');
  });
  it('step 9: config.set/unset/rollback share 6 a minute (dry runs count); camera.action 12, camera.name.set 6', () => {
    const limits = new CommandLimits(() => NOW);
    const c = () => c3(['config.set', 'config.unset', 'config.rollback'], { limits });
    for (let i = 0; i < 3; i++) expect(kind('config.set', { v: 1, dryRun: true, baseRevision: REV, set: { 'sse.pingS': 5 } }, c())).toBe('run');
    for (let i = 0; i < 2; i++) expect(kind('config.unset', { v: 1, dryRun: true, baseRevision: REV, paths: ['sse.pingS'] }, c())).toBe('run');
    expect(kind('config.rollback', { v: 1, dryRun: true, cmdId: CMD }, c())).toBe('run');
    expect(kind('config.set', { v: 1, dryRun: true, baseRevision: REV, set: { 'sse.pingS': 5 } }, c())).toBe('rate_limited');
    expect(kind('config.rollback', { v: 1, dryRun: true, cmdId: CMD }, c())).toBe('rate_limited');
    const l2 = new CommandLimits(() => NOW);
    for (let i = 0; i < 12; i++) expect(l2.take('camera.action').ok).toBe(true);
    expect(l2.take('camera.action').ok).toBe(false);
    for (let i = 0; i < 6; i++) expect(l2.take('camera.name.set').ok).toBe(true);
    expect(l2.take('camera.name.set').ok).toBe(false);
  });
  it('step 11: proxy.restart at most 2 an hour from the journal (a restart does not reset it)', () => {
    const journal = [{ command: 'proxy.restart', at: NOW - 10 * 60_000 }, { command: 'proxy.restart', at: NOW - 5 * 60_000 }];
    const d = checkCommand(p3('proxy.restart', { v: 1 }), c3(['proxy.restart'], { journalBudget: journalBudgetOf(countOf(journal), NOW) }));
    expect(d).toMatchObject({ kind: 'nack', code: 'rate_limited', retryAfterS: 50 * 60 });
    // From the journal file: a new Journal (a restarted proxy) on the same file counts the same.
    const file = join(mkdtempSync(join(tmpdir(), 'budget-')), 'admin', 'commands.json');
    const j = new Journal(file, () => NOW);
    for (const [i, e] of journal.entries()) j.record({ cmdId: `cmd_${String(i).padStart(20, '0')}`, actor: 'a', status: 'ok', ...e });
    const again = new Journal(file, () => NOW);
    expect(checkCommand(p3('proxy.restart', { v: 1 }), c3(['proxy.restart'], { journalBudget: journalBudgetOf(again.countSince.bind(again), NOW) }))).toMatchObject({ code: 'rate_limited' });
    expect(kind('proxy.restart', { v: 1 }, c3(['proxy.restart'], { journalBudget: journalBudgetOf(countOf(journal.slice(1)), NOW) }))).toBe('run');
    expect(kind('proxy.restart', { v: 1 }, c3(['proxy.restart'], { journalBudget: journalBudgetOf(countOf(journal), NOW + 51 * 60_000) }))).toBe('run');
  });
  it('step 11: six disruptive camera actions an hour per proxy, any camera; non-disruptive ones are not counted', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ command: 'camera.action', action: i % 2 ? 'camera-reboot' : 'camera-ntp-set', at: NOW - (i + 1) * 60_000 }));
    const b = journalBudgetOf(countOf(six), NOW);
    expect(kind('camera.action', { v: 1, camera: 'cam2', action: 'camera-powercycle' }, c3(allowAll, { journalBudget: b }))).toBe('rate_limited');
    expect(kind('camera.action', { v: 1, camera: 'cam2', action: 'camera-test' }, c3(allowAll, { journalBudget: b }))).toBe('run');
    const tests = Array.from({ length: 20 }, (_, i) => ({ command: 'camera.action', action: 'camera-test', at: NOW - (i + 1) * 1000 }));
    expect(kind('camera.action', { v: 1, camera: 'cam2', action: 'camera-reboot' }, c3(allowAll, { journalBudget: journalBudgetOf(countOf([...tests, ...six.slice(1)]), NOW) }))).toBe('run');
  });
  it('the fixtures: every P3 refused-* and valid-command-* fixture as the contract says', () => {
    const p3fx = fixtures().filter(({ f }) => f.schema === 'command' && f.$context && P3.includes((f.message as { body: { command: string } }).body.command));
    expect(p3fx.length).toBeGreaterThanOrEqual(19);
    for (const { name, f } of p3fx) {
      const c = f.$context!;
      const seen = new SeenIds();
      for (const x of c.seen ?? []) seen.add(x, c.now);
      const d = checkCommand(f.message as Envelope, { proxyId: c.proxyId, connId: c.connId, serverKeys: c.serverKeys, serverNow: c.now, seen, policy: { enabled: c.enabled ?? true, paused: !!c.paused, allow: c.allow ?? [] }, journal: () => undefined, limits: new CommandLimits(() => c.now), implemented: P3_IMPLEMENTED, currentTokens: [], journalBudget: journalBudgetOf(countOf(c.journal ?? []), c.now) });
      expect(d.kind === 'nack' ? d.code : d.kind, name).toBe(name.startsWith('valid-') ? 'run' : f.$expect!.runtime);
    }
  });
});
