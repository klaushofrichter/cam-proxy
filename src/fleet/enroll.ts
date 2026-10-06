import { writeKeyFile, type AdminKeyFile } from './keyfile';
import { adminUrlProblem, enrollRequest, generateKeyPair, normaliseCode, trimSlashes } from './protocol';

// Enrollment with a one-time code (spec 2026-10-06-cams-admin-phase1-design
// §8.2, §9.2), shared by the CLI and the admin UI: a new Ed25519 key, the
// code redeemed, the key file written only after a 201. The code is never in
// a message, a log line or an audit record.
export type EnrollErrorCode =
  | 'not_a_code' | 'bad_url' | 'unreachable' | 'invalid_code' | 'bad_proof' | 'bad_request' | 'unsupported_version'
  | 'too_large' | 'rate_limited' | 'server_error' | 'bad_answer';

const TEXT: Record<EnrollErrorCode, string> = {
  not_a_code: 'that is not an enrollment code (CAE1-XXXX-XXXX-XXXX-XXXX-XXXX)',
  bad_url: 'the cams-admin URL must be https:// (plain http only for loopback and *.svc.cluster.local)',
  unreachable: 'cams-admin could not be reached',
  invalid_code: 'cams-admin refused the code: unknown, used, cancelled or expired; create a new one',
  bad_proof: 'cams-admin refused the key proof',
  bad_request: 'cams-admin refused the request as malformed',
  unsupported_version: 'cams-admin does not speak enrollment v1',
  too_large: 'cams-admin refused the request as too large',
  rate_limited: 'cams-admin asks to wait before trying again',
  server_error: 'cams-admin failed to answer',
  bad_answer: 'cams-admin answered something this proxy cannot use',
};

export class EnrollError extends Error {
  constructor(readonly code: EnrollErrorCode, readonly retryAfterS?: number, detail?: string) {
    super(`${TEXT[code]}${retryAfterS ? ` (${retryAfterS} s)` : ''}${detail ? `: ${detail}` : ''}`);
  }
}

const ID = (p: string) => new RegExp(`^${p}_[0-9A-HJKMNP-TV-Z]{20}$`);
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

function answerOf(url: string, b: Record<string, unknown>, k: { privateKey: string; publicKey: string }): AdminKeyFile {
  const bad = (what: string) => new EnrollError('bad_answer', undefined, what);
  if (b.v !== 1) throw bad('version');
  if (typeof b.proxyId !== 'string' || !ID('prx').test(b.proxyId)) throw bad('proxyId');
  if (typeof b.keyId !== 'string' || !ID('key').test(b.keyId)) throw bad('keyId');
  if (typeof b.account !== 'string' || !b.account || b.account.length > 64) throw bad('account');
  if (typeof b.connectUrl !== 'string' || !/^wss?:\/\//.test(b.connectUrl) || adminUrlProblem(b.connectUrl)) throw bad('connectUrl');
  const keys = b.serverKeys;
  if (!Array.isArray(keys) || !keys.length || keys.length > 4 || !keys.every((x) => typeof x === 'string' && x.length <= 100 && B64.test(x))) throw bad('serverKeys');
  return { v: 1, url, connectUrl: b.connectUrl, proxyId: b.proxyId, keyId: b.keyId, privateKey: k.privateKey, publicKey: k.publicKey, serverKeys: [...(keys as string[])], account: b.account, enrolledAt: Date.now() };
}

export async function enrollWithCode(o: { url: string; code: string; keyPath: string; version: string; cameraIds: string[]; fetchImpl?: typeof fetch }): Promise<AdminKeyFile> {
  const url = trimSlashes(o.url);
  if (!normaliseCode(o.code)) throw new EnrollError('not_a_code');
  if (adminUrlProblem(url) || !/^https?:/.test(url)) throw new EnrollError('bad_url');
  const k = generateKeyPair();
  const body = enrollRequest({ code: o.code, privateKey: k.privateKey, publicKey: k.publicKey, version: o.version, cameraIds: o.cameraIds });
  let r: Response;
  try {
    r = await (o.fetchImpl ?? fetch)(`${url}/proxy/v1/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error' });
  } catch {
    throw new EnrollError('unreachable');
  }
  let answer: Record<string, unknown> = {};
  try {
    const text = await r.text();
    if (text.length <= 64 * 1024) answer = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // not JSON: the status decides
  }
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) answer = {};
  if (r.status !== 201) {
    const e = typeof answer.error === 'string' ? answer.error : '';
    if (r.status === 401) throw new EnrollError('invalid_code');
    if (r.status === 413) throw new EnrollError('too_large');
    if (r.status === 429) throw new EnrollError('rate_limited', typeof answer.retryAfterS === 'number' ? answer.retryAfterS : undefined);
    if (r.status === 400) throw new EnrollError(e === 'bad_proof' ? 'bad_proof' : e === 'unsupported_version' ? 'unsupported_version' : 'bad_request');
    throw new EnrollError('server_error', undefined, `HTTP ${r.status}`);
  }
  const key = answerOf(url, answer, k);
  writeKeyFile(o.keyPath, key);
  return key;
}
