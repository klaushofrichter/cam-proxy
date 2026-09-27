import express, { type Request, type Response } from 'express';
import { resolve } from 'path';
import { clipById, listClips, overlappingEvents, type ClipRow } from '../catalog/clips';
import type { Catalog } from '../catalog/db';
import { listEvents, type EventRow } from '../catalog/events';
import type { Config } from '../config/defaults';
import type { StatusPoller } from '../camera/status';
import type { SseHandler } from '../stream/sse';
import type { FrameGrabber } from '../stills/grabber';
import type { Go2rtc } from '../stills/go2rtc';
import type { MinuteStore } from '../stills/store';

export interface StillsSide { go2rtc: Go2rtc; grabber: FrameGrabber; store: MinuteStore }
const DAY = 86_400_000;

const bad = (res: Response, detail: string) => void res.status(400).json({ error: 'invalid', detail });
const intParam = (v: unknown): number | undefined | null => (v === undefined ? undefined : typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : null);

export const eventJson = (e: EventRow) => ({ id: e.id, kind: e.kind, source: e.source, start: e.start_ts, end: e.end_ts, endReason: e.end_reason });

// The client API (spec §10); auth is applied by the caller.
export function clientApi(d: { config: () => Config; catalog: Catalog; status: () => StatusPoller; sse: SseHandler; stills: () => StillsSide | undefined }): express.Router {
  const r = express.Router();
  const cam = () => d.config().camera;
  const known = (req: Request, res: Response) => {
    if (req.params.cam !== cam().id) return void res.status(404).json({ error: 'not_found' }), false;
    return true;
  };

  r.get('/cameras', (_req, res) => {
    const last = listEvents(d.catalog, { cam: cam().id, limit: 1 })[0];
    const s = d.stills();
    const stream = s ? { up: s.grabber.up(), lastFrameTs: s.grabber.lastFrameTs() } : null;
    res.json([{ id: cam().id, name: cam().name, online: d.status().state().online, lastEventTs: last?.start_ts ?? null, stream }]);
  });

  r.get('/cameras/:cam/events', (req, res) => {
    if (!known(req, res)) return;
    const from = intParam(req.query.from), to = intParam(req.query.to), limit = intParam(req.query.limit);
    if (from === null || to === null || limit === null) return bad(res, 'from, to and limit are whole numbers (unix ms)');
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    res.json(listEvents(d.catalog, { cam: cam().id, from, to, kind, limit }).map(eventJson));
  });

  // Stills and previews (spec §8, §10): lists over at most a day.
  const range = (req: Request, res: Response): [number, number] | undefined => {
    const from = intParam(req.query.from), to = intParam(req.query.to);
    if (from === undefined || to === undefined || from === null || to === null || to < from) return bad(res, 'from and to (unix ms) are required'), undefined;
    if (to - from > DAY) return bad(res, 'at most one day per request'), undefined;
    return [from, to];
  };
  const store = (req: Request, res: Response) => {
    if (!known(req, res)) return undefined;
    const s = d.stills();
    if (!s) return void res.status(404).json({ error: 'stills_disabled' }), undefined;
    return s.store;
  };
  const jpegTs = (file: string) => (/^\d{1,15}\.jpg$/.test(file) ? Number(file.slice(0, -4)) : null);
  const sendJpeg = (res: Response, jpeg: Buffer | undefined, final: boolean) => {
    if (!jpeg) return void res.status(404).json({ error: 'not_found' });
    res.type('image/jpeg').setHeader('Cache-Control', final ? 'private, max-age=604800, immutable' : 'no-store');
    res.send(jpeg);
  };

  r.get('/cameras/:cam/stills', (req, res) => {
    const st = store(req, res);
    const rg = st && range(req, res);
    if (st && rg) res.json(st.listStills(rg[0], rg[1]));
  });
  r.get('/cameras/:cam/stills/:file', async (req, res) => {
    const ts = jpegTs(req.params.file);
    if (ts === null) return bad(res, 'a still is <unix ms>.jpg');
    const st = store(req, res);
    if (st) sendJpeg(res, await st.readStill(ts), !st.isCurrent(ts));
  });
  r.get('/cameras/:cam/previews', (req, res) => {
    const st = store(req, res);
    const rg = st && range(req, res);
    if (st && rg) res.json(st.listPreviews(rg[0], rg[1]).map((p) => ({ ...p, url: `/api/cameras/${encodeURIComponent(cam().id)}/previews/${p.minute}.jpg` })));
  });
  r.get('/cameras/:cam/previews/:file', async (req, res) => {
    const minute = jpegTs(req.params.file);
    if (minute === null || minute % 60_000 !== 0) return minute === null ? bad(res, 'a sprite is <minute unix ms>.jpg') : void res.status(404).json({ error: 'not_found' });
    const st = store(req, res);
    if (st) sendJpeg(res, await st.readSprite(minute), !st.isCurrent(minute));
  });

  // Clips (spec §9, §10): lists over at most 31 days; files with HTTP Range.
  const clipBase = () => `/api/cameras/${encodeURIComponent(cam().id)}/clips`;
  const clipJson = (c: ClipRow) => ({
    id: c.id,
    start: c.start_ts,
    end: c.end_ts,
    stream: c.stream,
    size: c.size,
    events: overlappingEvents(d.catalog, c.cam, c.start_ts, c.end_ts ?? c.start_ts),
    url: `${clipBase()}/${c.id}.mp4`,
    snapshotUrl: c.snapshot ? `${clipBase()}/${c.id}.jpg` : null,
  });
  r.get('/cameras/:cam/clips', (req, res) => {
    if (!known(req, res)) return;
    const from = intParam(req.query.from), to = intParam(req.query.to);
    if (from === undefined || to === undefined || from === null || to === null || to < from) return bad(res, 'from and to (unix ms) are required');
    if (to - from > 31 * DAY) return bad(res, 'at most 31 days per request');
    res.json(listClips(d.catalog, cam().id, from, to).map(clipJson));
  });
  r.get('/cameras/:cam/clips/:file', (req, res) => {
    const m = /^(\d{1,15})\.(mp4|jpg)$/.exec(req.params.file);
    if (!m) return bad(res, 'a clip is <id>.mp4, its snapshot <id>.jpg');
    if (!known(req, res)) return;
    const clip = clipById(d.catalog, Number(m[1]));
    const file = clip?.cam === cam().id ? (m[2] === 'mp4' ? clip.path : clip.snapshot) : null;
    if (!file) return void res.status(404).json({ error: 'not_found' });
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.sendFile(resolve(file), { cacheControl: false, acceptRanges: true, dotfiles: 'allow', headers: { 'Content-Type': m[2] === 'mp4' ? 'video/mp4' : 'image/jpeg' } }, (err) => {
      if (!err || res.headersSent) return;
      const status = (err as { status?: number }).status;
      // 416 carries its Content-Range (bytes */size) already.
      if (status === 416) return void res.status(416).end();
      res.status(status === 404 ? 404 : 500).json({ error: status === 404 ? 'not_found' : 'internal' });
    });
  });

  r.get('/stream', d.sse);
  return r;
}
