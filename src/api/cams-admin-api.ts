import express from 'express';
import type { AuditLog } from '../audit/audit-log';
import { EnrollError } from '../fleet/enroll';
import { adminUrlProblem, normaliseCode } from '../fleet/protocol';
import type { CamsAdmin } from '../fleet/service';
import { actorOf, clientIp, requireLocalAdmin, type AccessInfo } from './auth';
import { ConfigError } from '../config/load-error';
import type { CommandRunner } from '../fleet/commands';
import { ALLOW_ENTRIES, ENTRY_TEXT, IMPLEMENTED, WideningRefused, type CommandPolicy } from '../fleet/policy';
import { TooManyBlocks, type TokenStore } from '../fleet/token-store';

// The Status page's cams-admin card (spec 2026-10-06-cams-admin-phase1-design
// §9.2): mounted behind requireAccess('admin') (the admin session with the
// CSRF header, or the admin token). The enrollment code is never logged,
// audited or answered; no key material is ever served.
export interface CommandsApiDeps {
  policy: CommandPolicy;
  tokens: TokenStore;
  runner: CommandRunner;
}

export function camsAdminApi(d: { camsAdmin: CamsAdmin; audit: AuditLog; commands?: CommandsApiDeps }): express.Router {
  const r = express.Router();
  const who = (req: express.Request) => ({ user: actorOf(req.res?.locals.access as AccessInfo | undefined), ip: clientIp(req), userAgent: req.get('user-agent') });

  r.get('/admin', (_req, res) => void res.json(d.camsAdmin.view()));

  r.post('/admin/enroll', async (req, res) => {
    const { url, code } = (req.body ?? {}) as { url?: unknown; code?: unknown };
    if (typeof url !== 'string' || !/^https?:\/\//.test(url) || adminUrlProblem(url)) return void res.status(400).json({ error: 'bad_url', message: 'the cams-admin URL must be https:// (plain http only for loopback and *.svc.cluster.local)' });
    if (!normaliseCode(code)) return void res.status(400).json({ error: 'not_a_code', message: 'that is not an enrollment code (CAE1-XXXX-XXXX-XXXX-XXXX-XXXX)' });
    try {
      const key = await d.camsAdmin.enroll(url, code as string);
      const v = d.camsAdmin.view();
      d.audit.write({ action: 'admin-enroll', category: ['configuration'], type: ['creation'], outcome: 'success', ...who(req), message: `Enrolled with cams-admin ${key.url} as ${key.proxyId} (account ${key.account})`, details: { url: key.url, proxyId: key.proxyId, account: key.account, fingerprint: v.fingerprint } });
      res.json(v);
    } catch (err) {
      const e = err instanceof EnrollError ? err : null;
      d.audit.write({ action: 'admin-enroll', category: ['configuration'], type: ['creation'], outcome: 'failure', ...who(req), message: `Enrollment with cams-admin ${url} failed: ${e?.code ?? 'error'}`, error: e?.code ?? 'error', details: { url, reason: e?.code ?? 'error' } });
      if (e) return void res.status(e.code === 'unreachable' || e.code === 'server_error' || e.code === 'bad_answer' ? 502 : e.code === 'rate_limited' ? 429 : e.code === 'busy' ? 409 : 400).json({ error: e.code, message: e.message, ...(e.retryAfterS ? { retryAfterS: e.retryAfterS } : {}) });
      res.status(500).json({ error: 'internal', message: (err as Error).message.slice(0, 200) });
    }
  });

  r.post('/admin/reconnect', (_req, res) => {
    if (!d.camsAdmin.active()) return void res.status(409).json({ error: 'not_connecting', message: 'no cams-admin connection to restart', state: d.camsAdmin.view().state });
    d.camsAdmin.reconnect();
    res.json(d.camsAdmin.view());
  });

  r.post('/admin/unenroll', async (req, res) => {
    const before = d.camsAdmin.view();
    const { wasEnrolled } = await d.camsAdmin.unenroll();
    d.audit.write({ action: 'admin-unenroll', category: ['configuration'], type: ['deletion'], outcome: 'success', ...who(req), message: wasEnrolled ? `Unenrolled from cams-admin ${before.url ?? ''} (${before.proxyId ?? 'no key'})` : 'Unenrolled from cams-admin (nothing was enrolled)', details: { url: before.url, proxyId: before.proxyId, fingerprint: before.fingerprint, wasEnrolled } });
    res.json(d.camsAdmin.view());
  });

  // Commands from cams-admin and managed tokens (migration P2): any admin
  // narrows (removes entries, pauses, blocks); widening (adds entries,
  // resumes, unblocks) needs local admin rights (Ruling R2-3).
  const c = d.commands;
  if (c) {
    const origin = (res: express.Response) => ((res.locals.access as AccessInfo | undefined)?.origin === 'local' ? 'local' : 'managed');
    const policyOf = () => {
      const p = c.policy.effective();
      return { allow: p.allow, paused: p.paused, pauseReason: p.pauseReason };
    };
    const commandsView = () => ({ ...c.policy.effective(), implemented: ALLOW_ENTRIES.filter((e) => IMPLEMENTED.has(e)), known: ALLOW_ENTRIES.map((entry) => ({ entry, text: ENTRY_TEXT[entry] })), recent: c.runner.recent(20) });
    const policyRecord = (req: express.Request, before: ReturnType<typeof policyOf>, message: string) =>
      d.audit.write({ action: 'admin-policy', category: ['configuration'], type: ['change'], outcome: 'success', ...who(req), message, details: { from: before, to: policyOf(), requestedBy: req.res?.locals.access?.viaCookie ? 'session' : 'token' } });
    const failed = (res: express.Response, err: unknown) => {
      if (err instanceof WideningRefused) return void res.status(403).json({ error: 'local_admin_only', message: err.message });
      if (err instanceof ConfigError) return void res.status(400).json({ error: 'invalid', detail: err.message });
      throw err;
    };

    r.get('/admin/commands', (_req, res) => void res.json(commandsView()));
    r.put('/admin/commands', (req, res) => {
      const before = policyOf();
      try {
        c.policy.setAllow((req.body ?? {}).allow, origin(res));
      } catch (err) {
        return failed(res, err);
      }
      policyRecord(req, before, `Allowed cams-admin commands: ${c.policy.effective().allow.join(', ') || 'none'}`);
      res.json(commandsView());
    });
    r.post('/admin/commands/pause', (req, res) => {
      const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : null;
      const before = policyOf();
      try {
        c.policy.pause(reason, origin(res));
      } catch (err) {
        return failed(res, err);
      }
      policyRecord(req, before, `cams-admin commands paused${reason ? `: ${reason.slice(0, 200)}` : ''}`);
      res.json(commandsView());
    });
    r.post('/admin/commands/resume', requireLocalAdmin(), (req, res) => {
      const before = policyOf();
      try {
        c.policy.resume('local');
      } catch (err) {
        return failed(res, err);
      }
      policyRecord(req, before, 'cams-admin commands resumed');
      res.json(commandsView());
    });

    const TOK_ID = /^tok_[0-9A-HJKMNP-TV-Z]{20}$/;
    const tokensView = () => ({ revision: c.tokens.revision(), problem: c.tokens.problem(), items: c.tokens.list() });
    const tokenOp = (op: 'block' | 'unblock') => (req: express.Request, res: express.Response) => {
      const id = String(req.params.id);
      if (!TOK_ID.test(id)) return void res.status(400).json({ error: 'invalid', detail: 'not a token id' });
      const t = c.tokens.list().find((x) => x.id === id);
      // Managed rights block only tokens that exist (they can't fill the list).
      if (!t && origin(res) !== 'local') return void res.status(404).json({ error: 'unknown_token' });
      try {
        if (op === 'block') c.tokens.block(id);
        else c.tokens.unblock(id);
      } catch (err) {
        if (err instanceof TooManyBlocks) return void res.status(409).json({ error: 'too_many_blocks', message: err.message });
        return void res.status(500).json({ error: 'store_error' });
      }
      d.audit.write({ action: 'admin-token', category: ['configuration'], type: ['change'], outcome: 'success', ...who(req), message: `Managed token ${id}${t ? ` (${t.label})` : ''} ${op === 'block' ? 'blocked' : 'unblocked'}`, details: { op, id, label: t?.label ?? null, kind: t?.kind ?? null } });
      res.json(tokensView());
    };
    r.get('/admin/tokens', (_req, res) => void res.json(tokensView()));
    r.post('/admin/tokens/:id/block', tokenOp('block'));
    r.post('/admin/tokens/:id/unblock', requireLocalAdmin(), tokenOp('unblock'));
  }

  return r;
}
