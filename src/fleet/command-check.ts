import type { Envelope } from './protocol';
import { verifyEnvelope } from './protocol';
import { jcs } from './jcs';
import type { TokensApplyArgs } from './token-store';
import { ARGS_VALIDATORS } from './command-args';
import type { JournalEntry } from './journal';

export type Nack = 'bad_signature' | 'wrong_target' | 'expired' | 'replayed' | 'not_allowed' | 'paused' | 'rate_limited' | 'invalid_args' | 'unsupported_version' | 'busy' | 'not_revocation_only';
export interface CommandBody { proxyId: string; connId: string; cmdId: string; exp: number; actor: string; command: string; args: Record<string, unknown> }
export type Decision =
  | { kind: 'bad_message' }
  | { kind: 'nack'; cmdId: string; code: Nack; retryAfterS?: number }
  | { kind: 'duplicate'; cmdId: string; entry: JournalEntry | 'running' }
  | { kind: 'run'; cmd: CommandBody; args: unknown };

const CMD_ID = /^cmd_[0-9A-HJKMNP-TV-Z]{20}$/;
const SLACK_MS = 120_000;
const MAX_LIFETIME_MS = 60_000;
const MAX_ARGS_BYTES = 16_384;
const argsBytes = (a: unknown): number => {
  try {
    return Buffer.byteLength(jcs(a));
  } catch {
    return Infinity;
  }
};
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export class SeenIds {
  private m = new Map<string, number>();
  constructor(private readonly ttlMs = 300_000, private readonly cap = 4096) {}
  has(id: string, now: number): boolean { this.prune(now); return this.m.has(id); }
  add(id: string, now: number): void {
    this.prune(now);
    this.m.set(id, now);
    while (this.m.size > this.cap) this.m.delete(this.m.keys().next().value as string);
  }
  private prune(now: number): void { for (const [k, t] of this.m) { if (now - t < this.ttlMs) break; this.m.delete(k); } }
}

class Window { constructor(readonly ms: number, readonly cap: number, public start = 0, public n = 0) {} }
export class CommandLimits {
  private total = [new Window(60_000, 30), new Window(86_400_000, 300)];
  private per: Record<string, Window[]> = { 'tokens.apply': [new Window(3_600_000, 6)] };
  constructor(private readonly now: () => number) {}
  take(command: string): { ok: true } | { ok: false; retryAfterS: number } {
    const t = this.now();
    const ws = [...this.total, ...(this.per[command] ?? [])];
    for (const w of ws) if (t - w.start >= w.ms) { w.start = t; w.n = 0; }
    const full = ws.find((w) => w.n >= w.cap);
    if (full) return { ok: false, retryAfterS: Math.max(1, Math.ceil((full.start + full.ms - t) / 1000)) };
    for (const w of ws) w.n++;
    return { ok: true };
  }
}

export interface CheckContext {
  proxyId: string; connId: string; serverKeys: string[]; serverNow: number; seen: SeenIds;
  policy: { enabled: boolean; paused: boolean; allow: string[] };
  journal: (cmdId: string) => JournalEntry | 'running' | undefined;
  limits: CommandLimits; implemented: ReadonlySet<string>;
  // cmdIds seen on any connection since before a restart (ReplayGuard): a
  // replayed session can't run a command again, refused or not. Optional for
  // cams-admin's cross-check.
  seenCmd?: { has(cmdId: string): boolean; add(cmdId: string, exp: number): void };
  // A tokens.apply claiming revocationOnly: true when its set only removes
  // entries from the stored one. Absent = every claim is refused.
  isRevocation?: (args: TokensApplyArgs) => boolean;
}

// The contract's check order, steps 1-11 (the runner adds 12, busy).
export function checkCommand(m: Envelope, c: CheckContext): Decision {
  const b = m.body as Record<string, unknown>;
  if (typeof b.cmdId !== 'string' || !CMD_ID.test(b.cmdId)) return { kind: 'bad_message' };
  const cmdId = b.cmdId;
  const nack = (code: Nack, retryAfterS?: number): Decision => ({ kind: 'nack', cmdId, code, ...(retryAfterS !== undefined ? { retryAfterS } : {}) });
  if (typeof m.sig !== 'string' || !verifyEnvelope(c.serverKeys, m)) return nack('bad_signature');
  if (b.proxyId !== c.proxyId || b.connId !== c.connId) return nack('wrong_target');
  if (c.seen.has(m.id, c.serverNow)) return nack('replayed');
  c.seen.add(m.id, c.serverNow);
  const exp = b.exp;
  if (!Number.isSafeInteger(exp) || (exp as number) - m.ts < 1 || (exp as number) - m.ts > MAX_LIFETIME_MS || (exp as number) + SLACK_MS < c.serverNow) return nack('expired');
  const j = c.journal(cmdId);
  if (j) return { kind: 'duplicate', cmdId, entry: j };
  // Seen before (on another connection, or before a restart) and not
  // journaled: refused then, or a replay. cams-admin never re-sends a refused cmdId (R2-8).
  if (c.seenCmd?.has(cmdId)) return nack('replayed');
  c.seenCmd?.add(cmdId, exp as number);
  const command = typeof b.command === 'string' ? b.command : '';
  // A pure revocation (cross-repo ruling) passes a pause and the allow-list
  // once its claim holds (checked below); only the env kill switch stops it.
  const claim = command === 'tokens.apply' && isObj(b.args) && b.args.revocationOnly === true;
  if (!c.policy.enabled || (c.policy.paused && !claim)) return nack('paused');
  if (!c.implemented.has(command) || (!claim && !c.policy.allow.includes(command))) return nack('not_allowed');
  const t = c.limits.take(command);
  if (!t.ok) return nack('rate_limited', t.retryAfterS);
  // The contract bound: jcs(args) at most 16384 bytes (UTF-8), before any validator.
  if (!isObj(b.args) || argsBytes(b.args) > MAX_ARGS_BYTES) return nack('invalid_args');
  const v = ARGS_VALIDATORS[command]?.(b.args);
  if (!v || !v.ok) return nack(v && !v.ok ? v.code : 'invalid_args');
  if (claim && !c.isRevocation?.(v.args as TokensApplyArgs)) return nack('not_revocation_only');
  if (!claim && command === 'tokens.apply' && (v.args as { tokens: { kind: string }[] }).tokens.some((x) => x.kind === 'admin') && !c.policy.allow.includes('tokens.apply.admin')) return nack('not_allowed');
  if (typeof b.actor !== 'string' || !isObj(b.args)) return nack('invalid_args');
  return { kind: 'run', cmd: { proxyId: c.proxyId, connId: c.connId, cmdId, exp: exp as number, actor: (b.actor as string).slice(0, 200), command, args: b.args as Record<string, unknown> }, args: v.args };
}
