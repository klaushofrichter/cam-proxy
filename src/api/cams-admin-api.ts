import express from 'express';
import type { AuditLog } from '../audit/audit-log';
import { EnrollError } from '../fleet/enroll';
import { adminUrlProblem, normaliseCode } from '../fleet/protocol';
import type { CamsAdmin } from '../fleet/service';
import { clientIp } from './auth';

// The Status page's cams-admin card (spec 2026-10-06-cams-admin-phase1-design
// §9.2): mounted behind requireAccess('admin') (the admin session with the
// CSRF header, or the admin token). The enrollment code is never logged,
// audited or answered; no key material is ever served.
export function camsAdminApi(d: { camsAdmin: CamsAdmin; audit: AuditLog }): express.Router {
  const r = express.Router();
  const who = (req: express.Request) => ({ user: 'admin', ip: clientIp(req), userAgent: req.get('user-agent') });

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
      if (e) return void res.status(e.code === 'unreachable' || e.code === 'server_error' || e.code === 'bad_answer' ? 502 : e.code === 'rate_limited' ? 429 : 400).json({ error: e.code, message: e.message, ...(e.retryAfterS ? { retryAfterS: e.retryAfterS } : {}) });
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
  return r;
}
