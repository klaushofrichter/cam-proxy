import { mkdtempSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrollWithCode, EnrollError } from '../src/fleet/enroll';
import { readKeyFile, writeKeyFile } from '../src/fleet/keyfile';
import { fingerprint } from '../src/fleet/protocol';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { strict, why } from './helpers/contract';

// Enrollment with a one-time code (spec 2026-10-06-cams-admin-phase1-design §8.2, §9.2).
const CODE = 'CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B';
let fake: FakeAdmin;
beforeAll(async () => {
  fake = await startFakeAdmin();
});
afterAll(() => fake.close());
const keyPath = () => join(mkdtempSync(join(tmpdir(), 'camproxy-enroll-')), 'admin', 'key.json');
const enroll = (path: string, code = CODE, url = fake.url) => enrollWithCode({ url, code, keyPath: path, version: 'v2026.10.06.1', cameraIds: ['cam1', 'cam3'] });

describe('enrollment', () => {
  it('redeems the code, writes the key file (600) and pins the server key', async () => {
    fake.enrollReply = null;
    fake.codes.add(CODE);
    const path = keyPath();
    const k = await enroll(path, 'cae1 7q2m k9xd 4hpa w3zt rn6b');
    expect(k).toMatchObject({ v: 1, url: fake.url, connectUrl: fake.connectUrl, account: 'home', serverKeys: [fake.server.publicKey] });
    expect(k.proxyId).toMatch(/^prx_/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readKeyFile(path)).toEqual(k);
    expect(fingerprint(k.publicKey)).toMatch(/^SHA256:[0-9A-F]{64}$/);
    const req = fake.enrollRequests.at(-1)!;
    const v = strict('enroll-request');
    expect(v(req), why(v)).toBe(true);
    expect(req).toMatchObject({ code: CODE, publicKey: k.publicKey, proxy: { version: 'v2026.10.06.1', cameraIds: ['cam1', 'cam3'] } });
  });

  it('not a code: refused before anything is sent', async () => {
    const n = fake.enrollRequests.length;
    await expect(enroll(keyPath(), 'hello')).rejects.toMatchObject({ code: 'not_a_code' });
    expect(fake.enrollRequests.length).toBe(n);
  });

  it.each([
    [401, { error: 'invalid_code' }, 'invalid_code'],
    [400, { error: 'bad_proof' }, 'bad_proof'],
    [400, { error: 'bad_request' }, 'bad_request'],
    [400, { error: 'unsupported_version' }, 'unsupported_version'],
    [413, {}, 'too_large'],
    [429, { error: 'rate_limited', retryAfterS: 42 }, 'rate_limited'],
    [500, {}, 'server_error'],
    [201, { v: 1, proxyId: 'nope' }, 'bad_answer'],
  ])('%i %j → %s, without the code in the message; an existing key file stays', async (status, body, code) => {
    fake.enrollReply = { status, body };
    const path = keyPath();
    const old = { ...fake.keyFile(), account: 'old' };
    writeKeyFile(path, old);
    const before = readFileSync(path, 'utf8');
    const err = await enroll(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnrollError);
    expect((err as EnrollError).code).toBe(code);
    expect((err as Error).message).not.toMatch(/CAE1|7Q2M/i);
    if (code === 'rate_limited') expect((err as EnrollError).retryAfterS).toBe(42);
    expect(readFileSync(path, 'utf8')).toBe(before);
    fake.enrollReply = null;
  });

  it('a connectUrl that breaks the transport rule (plain ws to a LAN host) is refused', async () => {
    fake.enrollReply = { status: 201, body: { v: 1, proxyId: 'prx_0123456789ABCDEFGHJK', keyId: 'key_0123456789ABCDEFGHJK', account: 'home', connectUrl: 'ws://192.168.1.10/proxy/v1/connect', serverKeys: [fake.server.publicKey], heartbeatS: 30 } };
    await expect(enroll(keyPath())).rejects.toMatchObject({ code: 'bad_answer' });
    fake.enrollReply = null;
  });

  it('cams-admin unreachable: a clear error', async () => {
    await expect(enroll(keyPath(), CODE, 'http://127.0.0.1:9')).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('a URL against the transport rule is refused before sending', async () => {
    await expect(enroll(keyPath(), CODE, 'http://cams-admin.example')).rejects.toMatchObject({ code: 'bad_url' });
  });

  it('re-enrollment replaces the old key file atomically', async () => {
    const path = keyPath();
    writeKeyFile(path, { ...fake.keyFile(), account: 'old' });
    fake.codes.add(CODE);
    const k = await enroll(path);
    expect(readKeyFile(path)).toEqual(k);
    expect(k.account).toBe('home');
  });
});
