import express from 'express';
import type { HealthSummary } from '../health/summary';

// GET /api/local/health (spec 2026-10-03-health-summary-design A4): the
// health summary for the e-paper display on the Pi, without a key, to
// loopback callers only. With network_mode: host the display connects from
// 127.0.0.1; in a pod only the pod itself is loopback.
//
// The check uses the TCP socket's address only: never req.ip, X-Forwarded-For
// or `trust proxy` (an ingress in front would make every client look local).
// Any other caller goes on as if the route did not exist, so it answers as an
// unknown /api route does (401 without a token, 404 with one) and is not
// advertised. Read-only, GET (and HEAD) only: no CSRF surface.

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK.has(address);
}

export function localApi(d: { health: () => Promise<HealthSummary> }): express.Router {
  const r = express.Router();
  // In front of the route, so no method (not even Express's automatic
  // OPTIONS with its Allow header) answers a non-loopback caller here.
  r.use((req, _res, next) => (isLoopback(req.socket.remoteAddress) ? next() : next('router')));
  r.get('/local/health', async (_req, res) => {
    const h = await d.health();
    res.set('Cache-Control', 'no-store').json(h);
  });
  return r;
}
