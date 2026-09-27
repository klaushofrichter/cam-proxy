import { createHash, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

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

export function bearerAuth(tokens: () => string[]): RequestHandler {
  return (req, res, next) => {
    const t = bearerOf(req);
    if (!t || !tokenMatches(t, tokens())) return void res.status(401).json({ error: 'unauthorized' });
    next();
  };
}
