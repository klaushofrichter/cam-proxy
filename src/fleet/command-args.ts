// Strict validators for command args (contract commands/<name>.args.schema.json,
// strict variant). Hand-written: no schema library at run time. A test runs
// them against the vendored strict schemas on the fixtures.
import type { ManagedToken, TokensApplyArgs } from './token-store';

export type ArgsVerdict<T> = { ok: true; args: T } | { ok: false; code: 'unsupported_version' | 'invalid_args'; detail: string };
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const TOK_ID = /^tok_[0-9A-HJKMNP-TV-Z]{20}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const LABEL = /^[^\u0000-\u001f\u007f]{1,64}$/u;

export function validateTokensApply(a: unknown): ArgsVerdict<TokensApplyArgs> {
  if (!isObj(a)) return { ok: false, code: 'invalid_args', detail: 'args: not an object' };
  if (a.v !== 1) return Number.isInteger(a.v) ? { ok: false, code: 'unsupported_version', detail: `args.v ${String(a.v)}` } : { ok: false, code: 'invalid_args', detail: 'args.v' };
  if (!only(a, ['v', 'revision', 'tokens'])) return { ok: false, code: 'invalid_args', detail: 'args: unknown field' };
  if (!Number.isSafeInteger(a.revision) || (a.revision as number) < 1) return { ok: false, code: 'invalid_args', detail: 'revision' };
  if (!Array.isArray(a.tokens) || a.tokens.length > 64) return { ok: false, code: 'invalid_args', detail: 'tokens' };
  const ids = new Set<string>();
  const hashes = new Set<string>();
  const out: ManagedToken[] = [];
  for (const [i, t] of a.tokens.entries()) {
    const bad = (f: string): ArgsVerdict<TokensApplyArgs> => ({ ok: false, code: 'invalid_args', detail: `tokens[${i}].${f}` });
    if (!isObj(t) || !only(t, ['id', 'kind', 'hash', 'label', 'retireAt'])) return bad('*');
    if (typeof t.id !== 'string' || !TOK_ID.test(t.id) || ids.has(t.id)) return bad('id');
    if (t.kind !== 'client' && t.kind !== 'admin') return bad('kind');
    if (typeof t.hash !== 'string' || !HASH.test(t.hash) || hashes.has(t.hash)) return bad('hash');
    if (typeof t.label !== 'string' || !LABEL.test(t.label)) return bad('label');
    if (t.retireAt !== null && !(Number.isSafeInteger(t.retireAt) && (t.retireAt as number) >= 0)) return bad('retireAt');
    ids.add(t.id);
    hashes.add(t.hash);
    out.push({ id: t.id, kind: t.kind, hash: t.hash, label: t.label, retireAt: t.retireAt as number | null });
  }
  return { ok: true, args: { v: 1, revision: a.revision as number, tokens: out } };
}

export const ARGS_VALIDATORS: Record<string, (a: unknown) => ArgsVerdict<unknown>> = { 'tokens.apply': validateTokensApply };
