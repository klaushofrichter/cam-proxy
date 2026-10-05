import express, { type NextFunction, type Request, type Response } from 'express';
import { readFile } from 'fs/promises';
import { resolve, sep } from 'path';
import { summaryCategories as categories, summaryText as pct } from '../analytics/classes';
import { analysisCheckJson, checkFullJson, checkJson, checkSummaryJson, type CheckJson } from '../analytics/check-json';
import type { AnalyticsService, CheckOutcome } from '../analytics/service';
import type { AuditLog } from '../audit/audit-log';
import type { Catalog } from '../catalog/db';
import { checkById, checksInRange } from '../catalog/still-checks';
import type { Config } from '../config/defaults';
import { DAY, dayStart } from '../time-units';
import { clientIp } from './auth';
import { cameraParam, workerOf } from './camera-param';
import type { CameraRegistry } from '../cameras/registry';
import { bad, IMMUTABLE, intParam, perMinute } from './respond';

// Still checks (cams #179, spec 2026-10-04-still-checks-design §5.1, §6):
// Vision on a second picked by hand, stored apart from events. Auth (client
// token, admin, CSRF for sessions) is applied by the caller.
export const CHECKS_PER_MINUTE = 20;

export function stillChecksApi(d: { config: () => Config; catalog: Catalog; cameras: CameraRegistry; analytics: AnalyticsService; audit: AuditLog }): express.Router {
  const r = express.Router();
  // :cam → its worker, 404 or 503, before validAt and the limiter (spec 2026-10-05-multi-camera-host-design §6.1).
  r.param('cam', cameraParam(d.cameras));
  const cam = (res: Response) => workerOf(res).id;
  const maxOpenMs = () => d.config().events.maxOpenMin * 60_000;

  // `at`: a still's time, checked before anything is looked up (§6, ruling 25).
  const validAt = (req: Request, res: Response, next: NextFunction) => {
    const at: unknown = (req.body ?? {}).at;
    if (at === undefined) return bad(res, 'at (unix ms) is required');
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return bad(res, 'at is a whole number (unix ms)');
    if (at % 1000 !== 0) return bad(res, 'at is a whole second');
    const now = Date.now();
    if (at > now) return bad(res, 'at is in the future');
    const days = d.config().retention.stillsDays;
    if (at < dayStart(now - days * DAY)) return bad(res, `at is older than the stills kept (${days} days)`);
    res.locals.at = at;
    next();
  };
  // Requests that passed the input check, per client (ruling 33); the
  // general limiter counts every request.
  const limiter = perMinute(CHECKS_PER_MINUTE);

  r.post('/cameras/:cam/still-checks', validAt, limiter, async (req, res) => {
    const at = res.locals.at as number;
    const access = res.locals.access as { access?: string; viaCookie?: boolean } | undefined;
    const requestedBy = access?.viaCookie ? 'session' : 'token';
    const o = await d.analytics.check(at, requestedBy);
    if (o.outcome === 'refused' && o.status === 404) return void res.status(404).json({ error: o.error }); // like a bad request: no record
    const check: CheckJson | null =
      o.outcome === 'ok' || (o.outcome === 'reused' && o.source === 'check') ? checkJson(d.catalog, o.row, maxOpenMs())
      : o.outcome === 'reused' ? analysisCheckJson(d.catalog, cam(res), o.analysis, maxOpenMs())
      : null;
    audit(req, o, at, requestedBy, access?.access === 'admin' ? 'admin' : 'client', check);
    if (o.outcome === 'ok') return void res.status(201).json({ check, reused: false });
    if (o.outcome === 'reused') return void res.json({ check, reused: true, source: o.source });
    if (o.outcome === 'refused') {
      const { status, error, reason, until } = o;
      return void res.status(status).json({ error, ...(reason !== undefined ? { reason } : {}), ...(until !== undefined ? { until } : {}) });
    }
    if (o.reason === 'store_failed') return void res.status(500).json({ error: 'internal' });
    res.status(502).json({ error: 'provider_failed', reason: o.reason });
  });

  // One `still-check` record per request that reached the limits (§1.6):
  // never the image or the key.
  const audit = (req: Request, o: CheckOutcome, at: number, requestedBy: string, user: string, check: CheckJson | null) => {
    const when = new Date(at).toISOString();
    const found = check ? categories(check.summary) : [];
    const kind = o.outcome === 'reused' ? 'reused' : o.outcome;
    const reason = o.outcome === 'refused' ? (o.reason ?? o.error) : o.outcome === 'failed' ? o.reason : null;
    const cost = o.outcome === 'ok' ? 1 : o.outcome === 'failed' ? o.cost : 0;
    const tookMs = o.outcome === 'ok' ? o.tookMs : o.outcome === 'failed' ? o.tookMs : null;
    const message =
      o.outcome === 'ok' ? `Still check ${when}: ${pct(check!.summary)}`
      : o.outcome === 'reused' ? `Still check ${when}: stored answer (${o.source === 'event' ? `event ${o.analysis.event_id}` : `check ${o.row.id}`})`
      : o.outcome === 'refused' ? `Still check ${when} refused: ${o.error}${o.reason ? ` (${o.reason})` : ''}`
      : `Still check ${when} failed: ${o.reason}`;
    d.audit.write({
      action: 'still-check', category: ['host'], type: ['access'], outcome: o.outcome === 'ok' || o.outcome === 'reused' ? 'success' : 'failure',
      user, ip: clientIp(req), userAgent: req.get('user-agent'), message,
      ...(reason ? { error: reason } : {}),
      details: { stillTs: at, outcome: kind, ...(o.outcome === 'reused' ? { source: o.source } : {}), reason, cost, tookMs, found, requestedBy },
    });
  };

  r.get('/cameras/:cam/still-checks', (req, res) => {
    const from = intParam(req.query.from), to = intParam(req.query.to), limit = intParam(req.query.limit);
    if (from === undefined || to === undefined || from === null || to === null) return bad(res, 'from and to (unix ms) are required');
    if (limit === null) return bad(res, 'limit is a whole number');
    if (to < from) return bad(res, 'to is before from');
    if (to - from > 31 * DAY) return bad(res, 'at most 31 days per request');
    res.json(checksInRange(d.catalog, cam(res), from, to, limit ?? 1000).map((row) => checkSummaryJson(d.catalog, row, maxOpenMs())));
  });

  // One check (`<id>`, with the provider's raw answer) or its JPEG (`<id>.jpg`).
  r.get('/cameras/:cam/still-checks/:file', async (req, res) => {
    const m = /^(\d{1,12})(\.jpg)?$/.exec(req.params.file);
    if (!m) return bad(res, 'a check is <id>, its image <id>.jpg');
    const row = checkById(d.catalog, Number(m[1]));
    if (!row || row.cam !== cam(res)) return void res.status(404).json({ error: 'not_found' });
    if (!m[2]) return void res.json(checkFullJson(d.catalog, row, maxOpenMs()));
    // The file name comes from the row (written by the service), never from
    // the request; still, only a file inside this camera's still-checks folder.
    const root = resolve(d.config().server.dataDir, 'still-checks', cam(res));
    const path = row.image ? resolve(row.image) : null;
    if (!path || !path.startsWith(root + sep)) return void res.status(404).json({ error: 'not_found' });
    let jpeg: Buffer;
    try {
      jpeg = await readFile(path);
    } catch {
      return void res.status(404).json({ error: 'not_found' });
    }
    res.type('image/jpeg').setHeader('Cache-Control', IMMUTABLE);
    res.send(jpeg);
  });

  // The budget for cams's button (§2.4): never the key or its mask.
  r.get('/cameras/:cam/analytics', (req, res) => {
    res.json(d.analytics.usage());
  });
  return r;
}
