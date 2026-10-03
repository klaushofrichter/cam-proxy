import { createHash, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger, maskPath, withoutQuery } from '../log';
import { readCookie, SESSION_COOKIE } from './session';

const digest = (s: string) => createHash('sha256').update(s).digest();

// True if `given` equals one of `tokens`, compared in constant time.
export function tokenMatches(given: string, tokens: string[]): boolean {
  const g = digest(given);
  let ok = false;
  for (const t of tokens) ok = timingSafeEqual(g, digest(t)) || ok;
  return ok;
}

function bearerOf(req: Request): string | undefined {
  const m = /^Bearer ([^\s]{1,512})$/.exec(req.get('authorization') ?? '');
  return m?.[1];
}

// Tokens never travel in URLs: a query token answers 400 before anything else.
export function refuseTokenInUrl(req: Request, res: Response, next: NextFunction): void {
  if (req.query.token !== undefined || req.query.access_token !== undefined) return void res.status(400).json({ error: 'token_in_url' });
  next();
}

type Access = 'admin' | 'client' | 'audit' | null;
type TokenKind = 'none' | 'invalid' | 'client' | 'admin' | 'audit' | 'session';
interface AccessInfo { access: Access; viaCookie: boolean; tokenKind: TokenKind }
export interface AccessDeps {
  tokens: () => string[];
  adminToken: () => string;
  // CAMPROXY_AUDIT_TOKEN: reads GET /control/audit, nothing else.
  auditToken: () => string | undefined;
  sessionValid: (v: string | undefined) => boolean;
  // Every 401/403 answered here, with why (the audit log records them).
  onRefused?: (req: Request, info: { status: 401 | 403; reason: string; tokenKind: TokenKind }) => void;
}

// The client's address, without the IPv4-mapped prefix (::ffff:10.0.0.1).
export function clientIp(req: Request): string {
  return (req.ip ?? '').replace(/^::ffff:/, '');
}

// Who is asking: the admin token or an admin UI session is 'admin', a client
// token is 'client', the audit token 'audit'. `viaCookie` marks a session
// (writes then need the CSRF header). `tokenKind` says which credential
// matched, for the audit log only; answers never tell it.
function accessOf(req: Request, d: AccessDeps): AccessInfo {
  const t = bearerOf(req);
  if (t !== undefined) {
    if (tokenMatches(t, [d.adminToken()])) return { access: 'admin', viaCookie: false, tokenKind: 'admin' };
    if (tokenMatches(t, d.tokens())) return { access: 'client', viaCookie: false, tokenKind: 'client' };
    const a = d.auditToken();
    if (a && tokenMatches(t, [a])) return { access: 'audit', viaCookie: false, tokenKind: 'audit' };
    return { access: null, viaCookie: false, tokenKind: 'invalid' };
  }
  if (d.sessionValid(readCookie(req.get('cookie'), SESSION_COOKIE))) return { access: 'admin', viaCookie: true, tokenKind: 'session' };
  return { access: null, viaCookie: false, tokenKind: 'none' };
}

const WRITE = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// `need`: 'client' lets clients and admins in; 'admin' only admins;
// 'audit-read' admins and the audit token, for GET (and HEAD) only. The audit token is
// no client credential: elsewhere it answers like an unknown token (401) or
// 403 admin_only, so an answer never tells which kind of token matched.
// Sets res.locals.access to the AccessInfo.
export function requireAccess(need: 'client' | 'admin' | 'audit-read', d: AccessDeps): RequestHandler {
  return (req, res, next) => {
    const a = accessOf(req, d);
    res.locals.access = a;
    const refuse = (status: 401 | 403, reason: string, error: string) => {
      d.onRefused?.(req, { status, reason, tokenKind: a.tokenKind });
      res.status(status).json({ error });
    };
    if (!a.access || (need === 'client' && a.access === 'audit')) {
      logger.warn({ path: maskPath(withoutQuery(req.originalUrl)) }, 'unauthorized');
      return refuse(401, a.tokenKind === 'none' ? 'no-token' : 'wrong-token', 'unauthorized');
    }
    if (need === 'admin' && a.access !== 'admin') return refuse(403, 'admin-only', 'admin_only');
    // HEAD too: Express answers it with the GET route, without the body.
    if (need === 'audit-read' && ((a.access !== 'admin' && a.access !== 'audit') || (req.method !== 'GET' && req.method !== 'HEAD'))) return refuse(403, 'admin-only', 'admin_only');
    if (a.viaCookie && WRITE.has(req.method) && req.get('x-camproxy-ui') !== '1') return refuse(403, 'csrf', 'csrf');
    next();
  };
}
