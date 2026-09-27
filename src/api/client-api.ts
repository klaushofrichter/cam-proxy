import express, { type Request, type Response } from 'express';
import type { Catalog } from '../catalog/db';
import { listEvents, type EventRow } from '../catalog/events';
import type { Config } from '../config/defaults';
import type { StatusPoller } from '../camera/status';
import type { sseHandler } from '../stream/sse';

const bad = (res: Response, detail: string) => void res.status(400).json({ error: 'invalid', detail });
const intParam = (v: unknown): number | undefined | null => (v === undefined ? undefined : typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : null);

export const eventJson = (e: EventRow) => ({ id: e.id, kind: e.kind, source: e.source, start: e.start_ts, end: e.end_ts, endReason: e.end_reason });

// The client API (spec §10); auth is applied by the caller.
export function clientApi(d: { config: () => Config; catalog: Catalog; status: () => StatusPoller; sse: ReturnType<typeof sseHandler> }): express.Router {
  const r = express.Router();
  const cam = () => d.config().camera;
  const known = (req: Request, res: Response) => {
    if (req.params.cam !== cam().id) return void res.status(404).json({ error: 'not_found' }), false;
    return true;
  };

  r.get('/cameras', (_req, res) => {
    const last = listEvents(d.catalog, { cam: cam().id, limit: 1 })[0];
    res.json([{ id: cam().id, name: cam().name, online: d.status().state().online, lastEventTs: last?.start_ts ?? null, stream: null }]);
  });

  r.get('/cameras/:cam/events', (req, res) => {
    if (!known(req, res)) return;
    const from = intParam(req.query.from), to = intParam(req.query.to), limit = intParam(req.query.limit);
    if (from === null || to === null || limit === null) return bad(res, 'from, to and limit are whole numbers (unix ms)');
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    res.json(listEvents(d.catalog, { cam: cam().id, from, to, kind, limit }).map(eventJson));
  });

  r.get('/stream', d.sse);
  return r;
}
