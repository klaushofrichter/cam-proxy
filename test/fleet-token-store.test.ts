import { createHash, randomBytes } from 'crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ShadowsLocalToken, TokenStore } from '../src/fleet/token-store';
import { validateTokensApply } from '../src/fleet/command-args';

const tok = () => randomBytes(32).toString('base64url');
const hashOf = (t: string) => `sha256:${createHash('sha256').update(t).digest('hex')}`;
const id = (n: number) => `tok_${String(n).padStart(20, '0')}`;
const LOCAL_ADMIN = 'local-admin-token-'.padEnd(40, 'x');
const store = (now = () => 1_000) => {
  const d = mkdtempSync(join(tmpdir(), 'tokens-'));
  const file = join(d, 'admin', 'tokens.json');
  return { file, s: new TokenStore({ file, now, localDigests: () => [createHash('sha256').update(LOCAL_ADMIN).digest()] }) };
};

describe('tokens.apply args', () => {
  it('accepts the contract fixture shape; refuses every malformed entry', () => {
    const good = { v: 1, revision: 1, tokens: [{ id: id(1), kind: 'client', hash: hashOf(tok()), label: 'cams cluster', retireAt: null }] };
    expect(validateTokensApply(good).ok).toBe(true);
    expect(validateTokensApply({ ...good, v: 2 })).toMatchObject({ ok: false, code: 'unsupported_version' });
    const bad = [
      { ...good, revision: 0 }, { ...good, tokens: 'x' }, { ...good, extra: 1 },
      { ...good, tokens: [{ ...good.tokens[0], hash: good.tokens[0].hash.toUpperCase() }] },
      { ...good, tokens: [{ ...good.tokens[0], kind: 'audit' }] },
      { ...good, tokens: [{ ...good.tokens[0], label: '' }] }, { ...good, tokens: [{ ...good.tokens[0], label: 'a\nb' }] },
      { ...good, tokens: [good.tokens[0], { ...good.tokens[0], hash: hashOf(tok()) }] }, // duplicate id
      { ...good, tokens: [good.tokens[0], { ...good.tokens[0], id: id(2) }] }, // duplicate hash
      { ...good, tokens: Array.from({ length: 65 }, (_, i) => ({ ...good.tokens[0], id: id(i), hash: hashOf(tok()) })) },
    ];
    for (const b of bad) expect(validateTokensApply(b), JSON.stringify(b).slice(0, 120)).toMatchObject({ ok: false, code: 'invalid_args' });
  });
});

describe('TokenStore', () => {
  it('applies a newer revision, matches by hash, survives a restart; file 600', () => {
    const { s, file } = store();
    const t = tok();
    const r = s.apply({ v: 1, revision: 3, tokens: [{ id: id(1), kind: 'client', hash: hashOf(t), label: 'cams cluster', retireAt: null }] });
    expect(r).toEqual({ revision: 3, applied: true, stale: false, client: 1, admin: 0, blocked: [] });
    expect(s.match(t)).toEqual({ id: id(1), kind: 'client', label: 'cams cluster' });
    expect(s.match(tok())).toBeNull();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain(t);
    const again = new TokenStore({ file, now: () => 1_000, localDigests: () => [] });
    expect(again.match(t)?.id).toBe(id(1));
  });
  it('an older or equal revision is stale: nothing changes (a replay or a restored cams-admin)', () => {
    const { s } = store();
    const t = tok();
    s.apply({ v: 1, revision: 5, tokens: [] });
    expect(s.apply({ v: 1, revision: 5, tokens: [{ id: id(1), kind: 'client', hash: hashOf(t), label: 'x', retireAt: null }] })).toMatchObject({ revision: 5, applied: false, stale: true });
    expect(s.apply({ v: 1, revision: 4, tokens: [] })).toMatchObject({ stale: true });
    expect(s.match(t)).toBeNull();
  });
  it('a retiring token stops matching at retireAt', () => {
    let now = 1_000;
    const { s } = store(() => now);
    const t = tok();
    s.apply({ v: 1, revision: 1, tokens: [{ id: id(1), kind: 'client', hash: hashOf(t), label: 'x', retireAt: 2_000 }] });
    expect(s.match(t)).not.toBeNull();
    now = 2_000;
    expect(s.match(t)).toBeNull();
    expect(s.counts()).toMatchObject({ client: 0 });
  });
  it('refuses a set that shadows a local token; applies nothing', () => {
    const { s } = store();
    expect(() => s.apply({ v: 1, revision: 1, tokens: [{ id: id(1), kind: 'admin', hash: hashOf(LOCAL_ADMIN), label: 'x', retireAt: null }] })).toThrow(ShadowsLocalToken);
    expect(s.revision()).toBe(0);
  });
  it('a locally blocked id never comes back through tokens.apply (R2-6)', () => {
    const { s } = store();
    const t = tok();
    s.apply({ v: 1, revision: 1, tokens: [{ id: id(1), kind: 'admin', hash: hashOf(t), label: 'cams', retireAt: null }] });
    s.block(id(1));
    expect(s.match(t)).toBeNull();
    expect(s.apply({ v: 1, revision: 2, tokens: [{ id: id(1), kind: 'admin', hash: hashOf(t), label: 'cams', retireAt: null }] })).toMatchObject({ applied: true, admin: 0, blocked: [id(1)] });
    expect(s.match(t)).toBeNull();
    s.unblock(id(1));
    expect(s.match(t)).toBeNull(); // unblocking doesn't resurrect: the next tokens.apply decides
  });
  it('a corrupt or unsafe tokens.json: no managed token matches, the error is visible', () => {
    const { s, file } = store();
    s.apply({ v: 1, revision: 1, tokens: [] });
    writeFileSync(file, '{', { mode: 0o600 });
    const fresh = new TokenStore({ file, now: () => 1_000, localDigests: () => [] });
    expect(fresh.match(tok())).toBeNull();
    expect(fresh.problem()).toMatch(/tokens\.json/);
  });
  it('list() never shows a hash beyond 8 hex', () => {
    const { s } = store();
    const t = tok();
    s.apply({ v: 1, revision: 1, tokens: [{ id: id(1), kind: 'client', hash: hashOf(t), label: 'x', retireAt: null }] });
    expect(JSON.stringify(s.list())).not.toContain(hashOf(t).slice(7, 7 + 9));
    expect(s.list()[0].hashPrefix).toBe(hashOf(t).slice(0, 15));
  });
});
