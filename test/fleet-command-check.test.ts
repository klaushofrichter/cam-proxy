import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { checkCommand, CommandLimits, SeenIds, type CheckContext } from '../src/fleet/command-check';
import { IMPLEMENTED } from '../src/fleet/policy';
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
    expect(code(cmd((b) => (b.command = 'config.get')), ctx({ policy: { enabled: true, paused: false, allow: ['config.get'] } }))).toBe('not_allowed');
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
    return { proxyId: c.proxyId, connId: c.connId, serverKeys: c.serverKeys, serverNow: c.now, seen, policy: { enabled: c.enabled ?? true, paused: !!c.paused, allow: c.allow ?? [] }, journal: () => undefined, limits: new CommandLimits(() => c.now), implemented: IMPLEMENTED, currentTokens: c.tokens ?? [] };
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
