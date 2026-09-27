import { createHash, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger, withoutQuery } from '../log';
import { readCookie, SESSION_COOKIE } from './session';

const digest = (s: string) => createHash('sha256').update(s).digest();

// True if `given` equals one of `tokens`, compared in constant time.
export function tokenMatches(given: string, tokens: string[]): boolean {
  const g = digest(given);
  let ok = false;
  for (const t of tokens) ok = timingSafeEqual(g, digest(t)) || ok;
  return ok;
}

export function bearerOf(req: Request): string | undefined {
  const m = /^Bearer ([^\s]{1,512})$/.exec(req.get('authorization') ?? '');
  return m?.[1];
}

// Tokens never travel in URLs: a query token answers 400 before anything else.
export function refuseTokenInUrl(req: Request, res: Response, next: NextFunction): void {
  if (req.query.token !== undefined || req.query.access_token !== undefined) return void res.status(400).json({ error: 'token_in_url' });
  next();
}

export type Access = 'admin' | 'client' | null;
export interface AccessDeps { tokens: () => string[]; adminToken: () => string; sessionValid: (v: string | undefined) => boolean }

// Who is asking: the admin token or an admin UI session is 'admin', a client
// token is 'client'. `viaCookie` marks a session (writes then need the CSRF
// header).
export function accessOf(req: Request, d: AccessDeps): { access: Access; viaCookie: boolean } {
  const t = bearerOf(req);
  if (t) {
    if (tokenMatches(t, [d.adminToken()])) return { access: 'admin', viaCookie: false };
    if (tokenMatches(t, d.tokens())) return { access: 'client', viaCookie: false };
    return { access: null, viaCookie: false };
  }
  if (d.sessionValid(readCookie(req.get('cookie'), SESSION_COOKIE))) return { access: 'admin', viaCookie: true };
  return { access: null, viaCookie: false };
}

const WRITE = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// `need`: 'client' lets clients and admins in; 'admin' only admins.
export function requireAccess(need: 'client' | 'admin', d: AccessDeps): RequestHandler {
  return (req, res, next) => {
    const { access, viaCookie } = accessOf(req, d);
    if (!access) {
      logger.warn({ path: withoutQuery(req.originalUrl) }, 'unauthorized');
      return void res.status(401).json({ error: 'unauthorized' });
    }
    if (need === 'admin' && access !== 'admin') return void res.status(403).json({ error: 'admin_only' });
    if (viaCookie && WRITE.has(req.method) && req.get('x-camproxy-ui') !== '1') return void res.status(403).json({ error: 'csrf' });
    next();
  };
}
