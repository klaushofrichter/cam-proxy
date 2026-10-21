import { createHash, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger, maskPath, withoutQuery } from '../log';
import { readCookie, SESSION_COOKIE } from './session';
import { NEVER_FROM_CAMS_ADMIN } from '../fleet/remote-settable';

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
type TokenKind = 'none' | 'invalid' | 'client' | 'admin' | 'audit' | 'session' | 'managed-client' | 'managed-admin';
// origin: local rights (CAMPROXY_* tokens, or a session they started) or
// managed ones (a cams-admin-managed token, or a session it started); null
// when nothing matched. Only local admin rights widen the command policy
// (migration P2, Ruling R2-3).
export interface AccessInfo { access: Access; viaCookie: boolean; tokenKind: TokenKind; origin: 'local' | 'managed' | null; tokenId?: string; tokenLabel?: string }
export type AccessNeed = 'client' | 'admin' | 'audit-read';

// The one access decision (spec 2026-10-05-multi-camera-host-design §6.6):
// today what the token kind allows, for any camera. A later roles project
// replaces this function and the principal's source; routes stay as they are.
export function can(principal: AccessInfo, need: AccessNeed, _cam?: string): boolean {
  const a = principal.access;
  if (need === 'admin') return a === 'admin';
  if (need === 'audit-read') return a === 'admin' || a === 'audit';
  return a === 'admin' || a === 'client';
}
export interface AccessDeps {
  tokens: () => string[];
  adminToken: () => string;
  // CAMPROXY_AUDIT_TOKEN: reads GET /control/audit, nothing else.
  auditToken: () => string | undefined;
  sessionValid: (v: string | undefined) => { origin: 'local' } | { origin: 'managed'; tokenId: string } | null;
  // A managed admin token by id: still in the set, not blocked, not retired.
  managedAdminLive?: (tokenId: string) => { label: string } | null;
  // The cams-admin-managed tokens (data/admin/tokens.json); absent = none.
  managed?: (bearer: string) => { id: string; kind: 'client' | 'admin'; label: string } | null;
  // The ui.* allow entries in effect (issue #227; src/fleet/policy.ts uiUnlocked); absent = none.
  managedUnlocked?: () => readonly string[];
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
// Order (M §10.2): local admin, managed admin, local client, managed client,
// audit. The bearer is hashed for the managed tokens once per request.
function accessOf(req: Request, d: AccessDeps): AccessInfo {
  const t = bearerOf(req);
  if (t !== undefined) {
    if (tokenMatches(t, [d.adminToken()])) return { access: 'admin', viaCookie: false, tokenKind: 'admin', origin: 'local' };
    const m = d.managed?.(t) ?? null;
    if (m?.kind === 'admin') return { access: 'admin', viaCookie: false, tokenKind: 'managed-admin', origin: 'managed', tokenId: m.id, tokenLabel: m.label };
    if (tokenMatches(t, d.tokens())) return { access: 'client', viaCookie: false, tokenKind: 'client', origin: 'local' };
    if (m?.kind === 'client') return { access: 'client', viaCookie: false, tokenKind: 'managed-client', origin: 'managed', tokenId: m.id, tokenLabel: m.label };
    const a = d.auditToken();
    if (a && tokenMatches(t, [a])) return { access: 'audit', viaCookie: false, tokenKind: 'audit', origin: 'local' };
    return { access: null, viaCookie: false, tokenKind: 'invalid', origin: null };
  }
  const s = d.sessionValid(readCookie(req.get('cookie'), SESSION_COOKIE));
  if (s?.origin === 'local') return { access: 'admin', viaCookie: true, tokenKind: 'session', origin: 'local' };
  if (s?.origin === 'managed') {
    // Ends with its token: blocked, removed or retired → no session.
    const t = d.managedAdminLive?.(s.tokenId) ?? null;
    if (t) return { access: 'admin', viaCookie: true, tokenKind: 'session', origin: 'managed', tokenId: s.tokenId, tokenLabel: t.label };
    return { access: null, viaCookie: false, tokenKind: 'invalid', origin: null };
  }
  return { access: null, viaCookie: false, tokenKind: 'none', origin: null };
}

// After requireAccess('admin'): 403 local_admin_only unless the rights are
// local (the CAMPROXY_ADMIN_TOKEN, or a session it started). Widening the
// command policy needs it (Ruling R2-3).
export function requireLocalAdmin(): RequestHandler {
  return (_req, res, next) => ((res.locals.access as AccessInfo | undefined)?.origin === 'local' ? next() : void res.status(403).json({ error: 'local_admin_only' }));
}

// The audit `user` of an admin request: 'admin' for local rights,
// `token:<label>` for a managed admin token, 'managed-admin' for a session a
// managed token started. Never a token or a hash.
export const actorOf = (a: AccessInfo | undefined): string => (a?.origin !== 'managed' ? 'admin' : a.tokenLabel ? `token:${a.tokenLabel}` : 'managed-admin');
// For an audit record's details: the ui.* entry that let a managed session do it (issue #227).
export const allowedByOf = (res: Response | undefined): { allowedBy?: string } => (typeof res?.locals.allowedBy === 'string' ? { allowedBy: res.locals.allowedBy } : {});

const WRITE = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// What managed admin rights (a cams-admin-managed admin token, or a session
// or sign-in link it started) may change (spec M2: sign-in links and camera
// rename; R2-3: only narrowing the command policy). Every other write to an
// admin route answers 403 local_admin_only: a new route is local-only unless
// it is added here (test/auth-managed-routes.test.ts).
export const MANAGED_ALLOWED: readonly (readonly [string, RegExp])[] = [
  ['POST', /^\/control\/login-links$/],
  ['PUT', /^\/control\/camera\/name$/],
  ['PUT', /^\/control\/cameras\/[^/]+\/name$/],
  ['PUT', /^\/control\/admin\/commands$/], // narrowing only (CommandPolicy.setAllow)
  ['POST', /^\/control\/admin\/commands\/pause$/],
  ['POST', /^\/control\/admin\/tokens\/[^/]+\/block$/],
];
const managedMay = (method: string, path: string) => !WRITE.has(method) || MANAGED_ALLOWED.some(([m, re]) => m === method && re.test(path));

// Issue #227 (Klaus, 2026-10-21): what the proxy's own allow-list may unlock
// for an admin UI session from a cams-admin sign-in link (never for a managed
// token itself), off by default; only the local admin adds an entry
// (CommandPolicy.setAllow). ui.config: the Settings page's writes; a reset
// only goes back to config.json, so only a PUT is checked against
// UI_CONFIG_LOCAL. ui.restart: the proxy restart and the camera-side restart.
export const UI_UNLOCKS: readonly (readonly [string, string, RegExp])[] = [
  ['ui.config', 'PUT', /^\/control\/config$/],
  ['ui.config', 'DELETE', /^\/control\/config(\/[^/]+)?$/],
  ['ui.restart', 'POST', /^\/control\/actions\/(restart|restart-proxy)$/],
  ['ui.restart', 'POST', /^\/control\/cameras\/[^/]+\/actions\/restart$/],
];
// Settings ui.config never sets (src/fleet/remote-settable.ts): addresses,
// ports, files, trust, users and the cams-admin connection; a new camera
// (it has an address) neither.
export const UI_CONFIG_LOCAL: readonly string[] = NEVER_FROM_CAMS_ADMIN;

// Every leaf path in a settings patch; dotted keys count as their parts.
function patchPaths(o: unknown, prefix = ''): string[] {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return prefix ? [prefix] : [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) out.push(...patchPaths(v, prefix ? `${prefix}.${k}` : k));
  return out.length || !prefix ? out : [prefix];
}
// A path as a pattern of UI_CONFIG_LOCAL: cameras.<id>.x and the legacy
// camera.x / ftp.user as cameras.*.x, camera.poeSwitch.x as poeSwitch.x.
function localPattern(p: string): string {
  if (p === 'ftp.user') return 'cameras.*.ftp.user';
  if (p.startsWith('camera.poeSwitch.')) return `poeSwitch.${p.slice('camera.poeSwitch.'.length)}`;
  if (p.startsWith('camera.')) return `cameras.*.${p.slice('camera.'.length)}`;
  return p.replace(/^cameras\.[^.]+(?=\.)/, 'cameras.*');
}
export function touchesLocal(body: unknown): boolean {
  return patchPaths(body).some((p) => /^cameras(\.[^.]+)?$/.test(p) || UI_CONFIG_LOCAL.some((x) => { const q = localPattern(p); return q === x || q.startsWith(`${x}.`); }));
}

// The ui.* entry that lets this managed request through, or null.
function uiUnlock(req: Request, a: AccessInfo, unlocked: (() => readonly string[]) | undefined): string | null {
  if (!a.viaCookie || !unlocked) return null;
  const path = withoutQuery(req.originalUrl);
  const hit = UI_UNLOCKS.find(([, m, re]) => m === req.method && re.test(path));
  if (!hit || !unlocked().includes(hit[0])) return null;
  if (hit[0] === 'ui.config' && req.method === 'PUT' && touchesLocal(req.body)) return null;
  return hit[0];
}

// `need`: 'client' lets clients and admins in; 'admin' only admins;
// 'audit-read' admins and the audit token, for GET (and HEAD) only. The audit token is
// no client credential: elsewhere it answers like an unknown token (401) or
// 403 admin_only, so an answer never tells which kind of token matched.
// Sets res.locals.access to the AccessInfo.
export function requireAccess(need: AccessNeed, d: AccessDeps): RequestHandler {
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
    if (!can(a, need)) return refuse(403, 'admin-only', 'admin_only');
    if (need === 'admin' && a.origin === 'managed' && !managedMay(req.method, withoutQuery(req.originalUrl))) {
      const entry = uiUnlock(req, a, d.managedUnlocked);
      if (!entry) return refuse(403, 'local-admin-only', 'local_admin_only');
      // The audit records of the route name the entry (allowedBy).
      res.locals.allowedBy = entry;
    }
    // HEAD too: Express answers it with the GET route, without the body.
    if (need === 'audit-read' && req.method !== 'GET' && req.method !== 'HEAD') return refuse(403, 'admin-only', 'admin_only');
    if (a.viaCookie && WRITE.has(req.method) && req.get('x-camproxy-ui') !== '1') return refuse(403, 'csrf', 'csrf');
    next();
  };
}
