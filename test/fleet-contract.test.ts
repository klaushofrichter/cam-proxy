import { describe, expect, it } from 'vitest';
import { adminUrlProblem, buildEnvelope, enrollRequest, fingerprint, normaliseCode, parseEnvelope, sign, signedText, ulid, verify } from '../src/fleet/protocol';
import { fixtures, strict, vectors, why } from './helpers/contract';

// cam-proxy against the vendored cams-admin contract v1 (spec
// 2026-10-06-cams-admin-phase1-design §15.4): the signed strings and
// signatures byte for byte, the enrollment request and hello on the strict schemas.
const k = vectors.keys;

describe('the contract vectors', () => {
  it('the vendored fixtures agree with the strict schemas (the copy is whole)', () => {
    for (const { name, f } of fixtures()) {
      const v = strict(f.schema);
      const ok = v(f.message);
      if (name.startsWith('valid-')) expect(ok, `${name}: ${why(v)}`).toBe(true);
      else expect(ok, name).toBe(false);
    }
  });

  it('every signed string and signature, byte for byte', () => {
    for (const s of vectors.signatures) {
      const text = (signedText[s.kind] as (...a: (string | number)[]) => string)(...s.args);
      expect(text).toBe(s.text);
      // Ed25519 is deterministic: the proxy's own signatures equal the vectors'.
      if (s.key === 'proxy') expect(sign(k.proxy.privateKey, text)).toBe(s.sig);
      expect(verify(k[s.key].publicKey, text, s.sig)).toBe(true);
      expect(verify(k.other.publicKey, text, s.sig)).toBe(false);
    }
  });

  it('the challenge signature verifies against the server key and nothing else', () => {
    const c = vectors.signatures.find((s) => s.kind === 'challenge')!;
    expect(verify(k.server.publicKey, c.text, c.sig)).toBe(true);
    expect(verify(k.server.publicKey, `${c.text}x`, c.sig)).toBe(false);
    expect(verify(k.server.publicKey, c.text, 'not a signature')).toBe(false);
    expect(verify('not a key', c.text, c.sig)).toBe(false);
  });

  it('key fingerprints', () => {
    for (const x of Object.values(k)) expect(fingerprint(x.publicKey)).toBe(x.fingerprint);
  });
});

describe('enrollment codes', () => {
  it('normalised: case, spaces, dashes, O→0, I/L→1', () => {
    expect(normaliseCode('CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B')).toBe('CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B');
    expect(normaliseCode(' cae1 7q2m k9xd 4hpa w3zt rn6b\n')).toBe('CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B');
    expect(normaliseCode('CAE17Q2MK9XD4HPAW3ZTRN6B')).toBe('CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B');
    expect(normaliseCode('cae1-ooii-llll-0000-1111-2222')).toBe('CAE1-0011-1111-0000-1111-2222');
  });
  it('anything else is no code', () => {
    for (const s of ['', 'CAE1', 'CAE2-7Q2M-K9XD-4HPA-W3ZT-RN6B', 'CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6', 'CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6BB', 'CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6U', 'x'.repeat(100)]) expect(normaliseCode(s), s).toBeNull();
  });
});

describe('messages on the strict schemas', () => {
  it('the enrollment request', () => {
    const body = enrollRequest({ code: 'cae1 7q2m k9xd 4hpa w3zt rn6b', privateKey: k.proxy.privateKey, publicKey: k.proxy.publicKey, version: 'v2026.10.06.1', cameraIds: ['cam1'] });
    const v = strict('enroll-request');
    expect(v(body), why(v)).toBe(true);
    const e = vectors.signatures.find((s) => s.kind === 'enroll')!;
    expect(body).toEqual({ v: 1, code: 'CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B', publicKey: k.proxy.publicKey, proof: e.sig, proxy: { version: 'v2026.10.06.1', cameraIds: ['cam1'] } });
  });

  it('a hello envelope, signed as in the vectors', () => {
    const h = vectors.signatures.find((s) => s.kind === 'hello' && s.args[4] !== 0)!;
    const [connId, nonce, proxyId, keyId, ts] = h.args as [string, string, string, string, number];
    const m = buildEnvelope('hello', 1, { proxyId, keyId, connId, nonce, ts, version: 'dev', capabilities: ['status'] }, { now: ts, sig: sign(k.proxy.privateKey, signedText.hello(connId, nonce, proxyId, keyId, ts)) });
    const v = strict('hello');
    expect(v(m), why(v)).toBe(true);
    expect(m.sig).toBe(h.sig);
  });

  it('envelope ids are ULID-shaped; seq and ts as given', () => {
    const m = buildEnvelope('bye', 3, { reason: 'shutdown' }, { now: 1791273600000 });
    expect(m).toMatchObject({ v: 1, type: 'bye', seq: 3, ts: 1791273600000 });
    expect(m.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ulid(0)).toMatch(/^0{10}[0-9A-HJKMNP-TV-Z]{16}$/);
    const v = strict('bye');
    expect(v(m), why(v)).toBe(true);
  });
});

describe('parsing what cams-admin sends', () => {
  it('a valid envelope', () => {
    const m = parseEnvelope(JSON.stringify({ v: 1, type: 'ack', id: ulid(1), seq: 2, ts: 5, re: ulid(1), body: { nextInS: 30 }, extra: 'ignored' }));
    expect(m).toMatchObject({ type: 'ack', seq: 2, body: { nextInS: 30 } });
  });
  it('garbage, a wrong version, a missing body or seq: an error', () => {
    for (const s of ['nope', '[]', '{}', JSON.stringify({ v: 2, type: 'ack', id: 'x', seq: 1, ts: 1, body: {} }), JSON.stringify({ v: 1, type: 'ack', id: 'x', seq: 1, ts: 1 }), JSON.stringify({ v: 1, type: 'ack', id: 'x', ts: 1, body: {} }), JSON.stringify({ v: 1, type: 'ack', id: 'x', seq: 1, ts: 1, body: [] })]) {
      expect(() => parseEnvelope(s), s).toThrow();
    }
  });
});

describe('the cams-admin URL (spec §8.9)', () => {
  it('https anywhere; http only for loopback and *.svc.cluster.local', () => {
    for (const u of ['https://cams-admin.skylar.technology', 'http://127.0.0.1:29000', 'http://localhost:29000', 'http://[::1]:29000', 'http://cams-admin.cams-admin.svc.cluster.local:8080', 'wss://x.example/proxy/v1/connect', 'ws://127.0.0.1:1/proxy/v1/connect']) expect(adminUrlProblem(u), u).toBeNull();
    for (const u of ['http://cams-admin.example', 'http://192.168.1.10:29000', 'ftp://x', 'not a url', 'http://evil.svc.cluster.local.example.com', 'ws://10.0.0.1/proxy/v1/connect', 'https://user:pw@x.example']) expect(adminUrlProblem(u), u).toEqual(expect.any(String));
  });
});
