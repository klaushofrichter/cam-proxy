import type { Response } from 'express';
import { rateLimit } from 'express-rate-limit';

// Answers and parameters the client APIs share.

// Files that never change (final stills and sprites, clips, recordings, archived clips).
export const IMMUTABLE = 'private, max-age=604800, immutable';

export const bad = (res: Response, detail: string) => void res.status(400).json({ error: 'invalid', detail });

// A whole-number query parameter: undefined when absent, null when not one.
export const intParam = (v: unknown): number | undefined | null => (v === undefined ? undefined : typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : null);

// At most `limit` requests per client and minute; 429 {error: rate_limited}.
export const perMinute = (limit: number) => rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited' } });

// sendFile with Range; a failure before any byte is 416 (it carries its
// Content-Range, bytes */size), 404 `notFound`, or 500 (without a
// Content-Disposition set for the file). dotfiles: the data folder may sit
// under a dot folder (~/.cam-proxy/data); callers pass paths they built.
export const sendFileOr = (res: Response, path: string, opts: object, notFound: string, after: () => void = () => undefined) =>
  res.sendFile(path, { cacheControl: false, acceptRanges: true, dotfiles: 'allow', ...opts }, (err) => {
    after();
    if (!err || res.headersSent) return;
    const status = (err as { status?: number }).status;
    if (status === 416) return void res.status(416).end();
    res.removeHeader('Content-Disposition');
    res.status(status === 404 ? 404 : 500).json({ error: status === 404 ? notFound : 'internal' });
  });
