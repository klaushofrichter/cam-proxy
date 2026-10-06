import type { AuditLog } from '../audit/audit-log';
import { RefusalThrottle } from '../audit/throttle';
import type { ClientLog } from './client';
import { checkCommand, CommandLimits, type CommandBody, type Nack, type SeenIds } from './command-check';
import type { Journal, JournalEntry } from './journal';
import { IMPLEMENTED, type CommandPolicy } from './policy';
import type { Envelope } from './protocol';
import type { ReplayGuard } from './replay';
import { ShadowsLocalToken, type TokenStore, type TokensApplyArgs } from './token-store';

// Commands from cams-admin (migration spec M §7, contract "The P2 contract"):
// the check (command-check.ts), `received`, the handler, the journal, `done`.
// One command at a time. Every answer is a signed result; a `done` that
// could not be sent goes out as a signed `command.done` event after the next
// welcome. Never logs or audits a token or a hash.

// One connection: its id, cams-admin's clock as this connection measured it
// (the signed challenge's serverTime plus monotonic time since; R2-4), and
// the envelope ids seen on it.
export interface ConnCtx { connId: string; serverNow: () => number; seen: SeenIds }
// False when the socket is gone (or not draining).
export type SignedSend = (type: 'result' | 'event', body: Record<string, unknown>, re?: string) => boolean;
export type Done = { status: 'ok' | 'failed' | 'conflict'; code?: string; result?: Record<string, unknown>; changed?: string[] };
export type Handler = (args: unknown, cmd: CommandBody) => Done | Promise<Done>;

export interface RunnerDeps {
  proxyId: () => string;
  serverKeys: () => string[];
  policy: CommandPolicy;
  journal: Journal;
  tokens: TokenStore;
  audit: Pick<AuditLog, 'write'>;
  log: ClientLog;
  now?: () => number;
  // cmdIds across connections and restarts (data/admin/replay.json).
  replay?: Pick<ReplayGuard, 'hasCmd' | 'addCmd'>;
  // The handlers by command name (default: tokens.apply on `tokens`).
  handlers?: Record<string, Handler>;
}

const NACKS_PER_MIN = 60;
const UNDELIVERED_MAX = 32;

export class CommandRunner {
  private running: string | null = null;
  private readonly limits: CommandLimits;
  private readonly nackAudit: RefusalThrottle;
  private nackWindow = { start: 0, n: 0, dropped: 0 };
  private readonly undelivered = new Map<string, Record<string, unknown>>();
  private readonly now: () => number;
  private readonly handlers: Record<string, Handler>;

  constructor(private readonly d: RunnerDeps) {
    this.now = d.now ?? Date.now;
    this.limits = new CommandLimits(this.now);
    this.nackAudit = new RefusalThrottle(600_000, this.now);
    this.handlers = d.handlers ?? { 'tokens.apply': (args) => this.tokensApply(args as TokensApplyArgs) };
  }

  // The heartbeat's proxy.commands block.
  status(): { enabled: boolean; paused: boolean; pauseReason: string | null; allow: string[]; seenWindow: 1000 } {
    const p = this.d.policy.effective();
    return { enabled: p.enabled, paused: p.paused, pauseReason: p.pauseReason, allow: p.allow.filter((a) => IMPLEMENTED.has(a)), seenWindow: 1000 };
  }

  recent(n: number): JournalEntry[] {
    return this.d.journal.recent(n);
  }

  // 'bad_message': the client answers `error bad_message` (no cmdId, no result).
  // 'bad_signature': refused before the signature held (the client counts it
  // against its unsupported-message limit).
  async onCommand(m: Envelope, conn: ConnCtx, send: SignedSend): Promise<'bad_message' | 'bad_signature' | void> {
    const p = this.d.policy.effective();
    const decision = checkCommand(m, {
      proxyId: this.d.proxyId(), connId: conn.connId, serverKeys: this.d.serverKeys(), serverNow: conn.serverNow(), seen: conn.seen,
      policy: { enabled: p.enabled, paused: p.paused, allow: p.allow },
      journal: (id) => (this.running === id ? 'running' : this.d.journal.get(id)),
      limits: this.limits, implemented: IMPLEMENTED,
      ...(this.d.replay ? { seenCmd: { has: (id: string) => this.d.replay!.hasCmd(id), add: (id: string, exp: number) => this.d.replay!.addCmd(id, exp) } } : {}),
    });
    const base = { proxyId: this.d.proxyId(), connId: conn.connId };
    switch (decision.kind) {
      case 'bad_message':
        return 'bad_message';
      case 'nack':
        this.nack(m, decision.cmdId, decision.code, decision.retryAfterS, base, send);
        return decision.code === 'bad_signature' ? 'bad_signature' : undefined;
      case 'duplicate': {
        const e = decision.entry;
        if (e === 'running') return void send('result', { ...base, cmdId: decision.cmdId, phase: 'received', duplicate: true }, m.id);
        return void send('result', { ...base, cmdId: decision.cmdId, phase: 'done', status: e.status, ...(e.code ? { code: e.code } : {}), duplicate: true, ...(e.result ? { result: e.result } : {}) }, m.id);
      }
      case 'run':
        if (this.running) return void this.nack(m, decision.cmd.cmdId, 'busy', undefined, base, send);
        return this.run(m, decision.cmd, decision.args, base, send);
    }
  }

  // After the next welcome: every done that never went out, as a signed event.
  afterWelcome(conn: ConnCtx, send: SignedSend): void {
    for (const [cmdId, body] of this.undelivered) {
      if (send('event', { ...body, kind: 'command.done', proxyId: this.d.proxyId(), connId: conn.connId })) this.undelivered.delete(cmdId);
      else return;
    }
  }

  private async run(m: Envelope, cmd: CommandBody, args: unknown, base: { proxyId: string; connId: string }, send: SignedSend): Promise<void> {
    this.running = cmd.cmdId;
    let done: Done;
    try {
      send('result', { ...base, cmdId: cmd.cmdId, phase: 'received' }, m.id);
      const h = this.handlers[cmd.command];
      done = h ? await h(args, cmd) : { status: 'failed', code: 'not_implemented' };
    } catch (err) {
      this.d.log.warn({ command: cmd.command, err: String((err as Error)?.message ?? err).slice(0, 200) }, 'admin_command_error');
      done = { status: 'failed', code: 'internal' };
    }
    const entry: JournalEntry = { cmdId: cmd.cmdId, command: cmd.command, actor: cmd.actor, at: this.now(), status: done.status, ...(done.code ? { code: done.code } : {}), ...(done.result ? { result: done.result } : {}), ...(done.changed ? { changed: done.changed } : {}) };
    try {
      this.d.journal.record(entry);
    } catch (err) {
      this.d.log.warn({ err: String((err as Error).message).slice(0, 200) }, 'admin_journal_error');
    } finally {
      this.running = null;
    }
    this.audit(cmd, done);
    const body = { proxyId: base.proxyId, connId: base.connId, cmdId: cmd.cmdId, phase: 'done', status: done.status, ...(done.code ? { code: done.code } : {}), ...(done.result ? { result: done.result } : {}) };
    if (!send('result', body, m.id)) {
      this.undelivered.set(cmd.cmdId, body);
      while (this.undelivered.size > UNDELIVERED_MAX) this.undelivered.delete(this.undelivered.keys().next().value as string);
    }
  }

  private tokensApply(args: TokensApplyArgs): Done {
    try {
      const r = this.d.tokens.apply(args);
      return { status: 'ok', result: { ...r }, changed: r.applied ? ['tokens'] : [] };
    } catch (err) {
      if (err instanceof ShadowsLocalToken) return { status: 'failed', code: 'shadows_local_token' };
      this.d.log.warn({ err: String((err as Error).message).slice(0, 200) }, 'admin_token_store_error');
      return { status: 'failed', code: 'store_error' };
    }
  }

  // At most 60 nack results a minute (the rest dropped and counted); one
  // admin-command failure record per code per 10 minutes.
  private nack(m: Envelope, cmdId: string, code: Nack, retryAfterS: number | undefined, base: { proxyId: string; connId: string }, send: SignedSend): void {
    const t = this.now();
    const w = this.nackWindow;
    if (t - w.start >= 60_000) {
      if (w.dropped) this.d.log.debug({ dropped: w.dropped }, 'admin_nack_dropped');
      this.nackWindow = { start: t, n: 0, dropped: 0 };
    }
    const b = m.body as { command?: unknown };
    // What was sent, only when it looks like a command name (it may be unsigned junk).
    const command = typeof b.command === 'string' && /^[a-z][a-z.:-]{0,31}$/.test(b.command) ? b.command : '';
    const a = this.nackAudit.take('cams-admin', code);
    if (a.record) {
      this.d.audit.write({
        action: 'admin-command', category: ['configuration'], type: ['denied'], outcome: 'failure', user: 'cams-admin',
        message: `cams-admin command ${command || '(none)'} refused: ${code}`, error: code,
        details: { cmdId, command, outcome: code, ...(a.suppressed ? { suppressed: a.suppressed } : {}) },
      });
    }
    if (this.nackWindow.n >= NACKS_PER_MIN) {
      this.nackWindow.dropped++;
      return;
    }
    this.nackWindow.n++;
    send('result', { ...base, cmdId, phase: 'done', status: 'refused', code, ...(retryAfterS !== undefined ? { retryAfterS } : {}) }, m.id);
  }

  private audit(cmd: CommandBody, done: Done): void {
    const ok = done.status === 'ok';
    const tokens = cmd.command === 'tokens.apply' && done.result ? { tokens: { revision: done.result.revision, client: done.result.client, admin: done.result.admin, ids: (Array.isArray(cmd.args.tokens) ? cmd.args.tokens : []).map((x: { id: string; kind: string; label: string }) => ({ id: x.id, kind: x.kind, label: x.label })) } } : {};
    this.d.audit.write({
      action: 'admin-command', category: ['configuration'], type: ['change'], outcome: ok ? 'success' : 'failure', user: 'cams-admin',
      message: `cams-admin (on behalf of ${cmd.actor}) ran ${cmd.command}: ${done.status}${done.code ? ` (${done.code})` : ''}`,
      ...(done.code ? { error: done.code } : {}),
      details: { cmdId: cmd.cmdId, command: cmd.command, actor: cmd.actor, outcome: done.status, ...(done.code ? { code: done.code } : {}), changed: done.changed ?? [], ...tokens },
    });
  }
}
