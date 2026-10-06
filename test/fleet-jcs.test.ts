import { describe, expect, it } from 'vitest';
import { jcs } from '../src/fleet/jcs';
import { generateKeyPair, sign, signEnvelope, unsigned, verifyEnvelope } from '../src/fleet/protocol';
import { vectors } from './helpers/contract';

describe('JCS (RFC 8785)', () => {
  it('reproduces every contract vector', () => {
    expect(vectors.jcs.length).toBeGreaterThanOrEqual(4);
    for (const v of vectors.jcs) expect(jcs(v.input), v.name).toBe(v.text);
  });
  it('sorts keys by UTF-16 code units, not by code point (RFC 8785 §3.2.3)', () => {
    // The RFC's example; U+FB33 (Hebrew) sorts after the smiley's surrogate pair D83D DE00.
    const input = { '\u20ac': 'Euro Sign', '\r': 'Carriage Return', '\ufb33': 'Hebrew Letter Dalet With Dagesh', '1': 'One', '\ud83d\ude00': 'Emoji: Grinning Face', '\u0080': 'Control', '\u00f6': 'Latin Small Letter O With Diaeresis' };
    expect(jcs(input)).toBe('{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}');
  });
  it('writes numbers as ES does: -0 → 0, 1e21, 0.1', () => {
    expect(jcs([-0, 1e21, 0.1, 100])).toBe('[0,1e+21,0.1,100]');
  });
  it('refuses what JSON cannot say', () => {
    // eslint-disable-next-line no-sparse-arrays
    for (const bad of [undefined, NaN, Infinity, () => 1, new Date(0), { a: undefined }, [1, , 2]]) expect(() => jcs(bad), String(bad)).toThrow();
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(() => jcs(deep)).toThrow(/too deep/);
  });
});

describe('signed envelopes (round trip; the contract vectors are checked below once vendored)', () => {
  const k = generateKeyPair();
  const other = generateKeyPair();
  const env = { v: 1 as const, type: 'result', id: 'msg_01', seq: 3, ts: 1_700_000_000_000, re: 'msg_00', body: { b: 1, a: [true, null, 'x'] } };
  it('signs jcs(envelope without sig); verifies with the key, not with another', () => {
    const sig = signEnvelope(k.privateKey, env);
    expect(sig).toBe(sign(k.privateKey, jcs(env)));
    expect(verifyEnvelope([other.publicKey, k.publicKey], { ...env, sig })).toBe(true);
    expect(verifyEnvelope([other.publicKey], { ...env, sig })).toBe(false);
  });
  it('an added unknown field breaks the signature (it is covered); unsigned() drops only sig', () => {
    const sig = signEnvelope(k.privateKey, env);
    expect(verifyEnvelope([k.publicKey], { ...env, sig, extra: 1 } as never)).toBe(false);
    expect(unsigned({ ...env, sig })).toEqual(env);
  });
  it('a message JCS cannot canonicalise never verifies (no throw)', () => {
    expect(verifyEnvelope([k.publicKey], { v: 1, type: 'command', id: 'x', seq: 1, ts: 1, body: { n: Infinity }, sig: 'A'.repeat(86) + '==' } as never)).toBe(false);
  });
});

describe('signed envelopes: the contract vectors', () => {
  it('every envelope vector: canonical text and signature, byte for byte', () => {
    expect([...new Set(vectors.envelopes.map((e) => e.kind))].sort()).toEqual(['command', 'event', 'result']);
    for (const e of vectors.envelopes) {
      expect(jcs(e.envelope)).toBe(e.text);
      const key = vectors.keys[e.key];
      expect(signEnvelope(key.privateKey, e.envelope as never)).toBe(e.sig);
      expect(verifyEnvelope([key.publicKey], { ...(e.envelope as Record<string, unknown>), sig: e.sig } as never)).toBe(true);
      expect(verifyEnvelope([vectors.keys.other.publicKey], { ...(e.envelope as Record<string, unknown>), sig: e.sig } as never)).toBe(false);
    }
  });
  it('an added unknown field breaks the command vector\'s signature', () => {
    const e = vectors.envelopes.find((x) => x.kind === 'command')!;
    const m = { ...(e.envelope as Record<string, unknown>), sig: e.sig, extra: 1 };
    expect(verifyEnvelope([vectors.keys.server.publicKey], m as never)).toBe(false);
    expect(unsigned({ ...(e.envelope as Record<string, unknown>), sig: e.sig } as never)).toEqual(e.envelope);
  });
});
