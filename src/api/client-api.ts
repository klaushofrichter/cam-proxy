import express, { type Request, type Response } from 'express';
import { readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { analysesFor, analysesInRange, analysisFor, type AnalysisRow } from '../catalog/analyses';
import { summarize } from '../analytics/classes';
import type { Found } from '../analytics/providers';
import { clipById, clipsNear, listClips, oldestClip, overlappingEventsOf, type ClipRow } from '../catalog/clips';
import type { Catalog } from '../catalog/db';
import { lastLiveEventTs, listEvents, type EventRow } from '../catalog/events';
import type { Config } from '../config/defaults';
import { BaichuanError } from '../camera/baichuan/errors';
import { logger } from '../log';
import { isAbort } from '../async';
import { SearchError, type RecordingEntry } from '../recordings/list';
import { validId } from '../recordings/names';
import type { RecordingsSide } from '../recordings/side';
import type { CameraRegistry } from '../cameras/registry';
import type { CameraWorker } from '../cameras/worker';
import { cameraParam, workerOf } from './camera-param';
import { FEATURES, type SseHandler } from '../stream/sse';
import type { FrameGrabber } from '../stills/grabber';
import type { Go2rtc } from '../stills/go2rtc';
import type { MinuteStore } from '../stills/store';
import { DAY } from '../time-units';
import { bad, IMMUTABLE, intParam, sendFileOr } from './respond';

export interface StillsSide { go2rtc: Go2rtc; grabber: FrameGrabber; store: MinuteStore }

// A calendar date, YYYY-MM-DD (2026-02-30 is not one), in the years 2000 to
// 2099 (the camera's clock range; nothing else reaches a Search).
const validDate = (v: string): boolean => /^20\d{2}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

const eventJson = (e: EventRow) => ({ id: e.id, kind: e.kind, source: e.source, start: e.start_ts, end: e.end_ts, endReason: e.end_reason });

// Stored JSON; null when missing or corrupt (one bad row must not fail a list).
const parse = (s: string | null): unknown => {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const parseList = (s: string | null): unknown[] => {
  const v = parse(s);
  return Array.isArray(v) ? v : [];
};
// The summary to serve: the stored one; an ok row not yet backfilled is
// summarised from its objects (never served as "nothing found"); else [].
const summaryOf = (a: Pick<AnalysisRow, 'status' | 'objects' | 'summary'>): unknown[] => {
  try {
    if (a.summary !== null && a.summary !== undefined) return parseList(a.summary);
    if (a.status !== 'ok' || a.objects === null) return [];
    const objects: unknown = JSON.parse(a.objects);
    return Array.isArray(objects) ? summarize(objects as Found[]).summary : [];
  } catch {
    return [];
  }
};
const analysisSummary = (a: AnalysisRow | undefined) =>
  a ? { provider: a.provider, status: a.status, reason: a.reason, stillTs: a.still_ts, objects: parseList(a.objects), summary: summaryOf(a) } : null;

// The client API (spec §10); auth is applied by the caller.
export function clientApi(d: { config: () => Config; catalog: Catalog; cameras: CameraRegistry; sse: SseHandler }): express.Router {
  const r = express.Router();
  // Every /cameras/:cam route: the camera's worker, 404 or 503 (spec 2026-10-05-multi-camera-host-design §6.1).
  r.param('cam', cameraParam(d.cameras));

  // One camera's info. `name`: the camera's own name (camera-name design), the
  // configured name until first read. publicUrl: where people reach this
  // proxy's web UI (cams links to it). address: the camera's host as it runs
  // (cams reaches the camera there for what it asks the camera directly; no
  // secret). error: the worker's or the last check's error, null when fine
  // (spec §6.1).
  const info = (w: CameraWorker) => {
    const s = w.stills;
    const stream = s ? { up: s.grabber.up(), lastFrameTs: s.grabber.lastFrameTs() } : null;
    return { id: w.id, name: w.name(), online: w.status.state().online, lastEventTs: lastLiveEventTs(d.catalog, w.id), stream, publicUrl: d.config().server.publicUrl ?? null, address: w.cam().host, error: w.error(), features: [...FEATURES] };
  };
  r.get('/cameras', (_req, res) => void res.json(d.cameras.list().map(info)));
  r.get('/cameras/:cam', (_req, res) => void res.json(info(workerOf(res))));

  const sendJpeg = (res: Response, jpeg: Buffer | undefined, final: boolean) => {
    if (!jpeg) return void res.status(404).json({ error: 'not_found' });
    res.type('image/jpeg').setHeader('Cache-Control', final ? IMMUTABLE : 'no-store');
    res.send(jpeg);
  };

  // The from/to of a list over at most `maxMs` (a day by default); answers 400 itself otherwise.
  const range = (req: Request, res: Response, maxMs = DAY, tooLong = 'at most one day per request', missing = 'from and to (unix ms) are required'): [number, number] | undefined => {
    const from = intParam(req.query.from), to = intParam(req.query.to);
    if (from === undefined || to === undefined || from === null || to === null) return bad(res, missing), undefined;
    if (to < from) return bad(res, 'to is before from'), undefined;
    if (to - from > maxMs) return bad(res, tooLong), undefined;
    return [from, to];
  };

  r.get('/cameras/:cam/events', (req, res) => {
    const from = intParam(req.query.from), to = intParam(req.query.to), limit = intParam(req.query.limit);
    if (from === null || to === null || limit === null) return bad(res, 'from, to and limit are whole numbers (unix ms)');
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const rows = listEvents(d.catalog, { cam: workerOf(res).id, from, to, kind, limit });
    const an = analysesFor(d.catalog, rows.map((e) => e.id));
    res.json(rows.map((e) => ({ ...eventJson(e), analysis: analysisSummary(an.get(e.id)) })));
  });
  r.get('/cameras/:cam/events/:id/analysis', (req, res) => {
    const a = analysisFor(d.catalog, Number(req.params.id));
    if (!a) return void res.status(404).json({ error: 'not_found' });
    res.json({ eventId: a.event_id, provider: a.provider, status: a.status, reason: a.reason, stillTs: a.still_ts, requestedAt: a.requested_at, tookMs: a.took_ms, objects: parseList(a.objects), summary: summaryOf(a), raw: parse(a.raw) });
  });
  // A day of analyses in the stream message's shape (spec
  // 2026-09-30-analytics-in-cams-design), for cams when it loads a day.
  r.get('/cameras/:cam/analyses', (req, res) => {
    const rg = range(req, res);
    if (!rg) return;
    res.json(analysesInRange(d.catalog, workerOf(res).id, rg[0], rg[1]).map((a) => ({
      eventId: a.event_id, kind: a.kind, start: a.start_ts, end: a.end_ts, provider: a.provider, status: a.status, reason: a.reason,
      stillTs: a.still_ts, summary: summaryOf(a),
    })));
  });
  r.get('/cameras/:cam/events/:id/analysis.jpg', (req, res) => {
    const a = analysisFor(d.catalog, Number(req.params.id));
    let jpeg: Buffer | undefined;
    try {
      jpeg = a?.image ? readFileSync(a.image) : undefined;
    } catch {
      jpeg = undefined;
    }
    sendJpeg(res, jpeg, true);
  });

  // Stills and previews (spec §8, §10): lists over at most a day.
  const store = (_req: Request, res: Response) => {
    const s = workerOf(res).stills;
    if (!s) return void res.status(404).json({ error: 'stills_disabled' }), undefined;
    return s.store;
  };
  const jpegTs = (file: string) => (/^\d{1,15}\.jpg$/.test(file) ? Number(file.slice(0, -4)) : null);
  // How far back this proxy has content (the History strip's left edge):
  // the oldest clip, still minute and preview minute, each null when none.
  r.get('/cameras/:cam/extent', (_req, res) => {
    const w = workerOf(res);
    const s = w.stills?.store;
    res.json({ clips: oldestClip(d.catalog, w.id), stills: s?.oldest('stills') ?? null, previews: s?.oldest('previews') ?? null });
  });

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
    if (st && rg) res.json(st.listPreviews(rg[0], rg[1]).map((p) => ({ ...p, url: `/api/cameras/${encodeURIComponent(workerOf(res).id)}/previews/${p.minute}.jpg` })));
  });
  r.get('/cameras/:cam/previews/:file', async (req, res) => {
    const minute = jpegTs(req.params.file);
    if (minute === null || minute % 60_000 !== 0) return minute === null ? bad(res, 'a sprite is <minute unix ms>.jpg') : void res.status(404).json({ error: 'not_found' });
    const st = store(req, res);
    if (st) sendJpeg(res, await st.readSprite(minute), !st.isCurrent(minute));
  });

  // Clips (spec §9, §10): lists over at most 31 days; files with HTTP Range.
  const clipBase = (cam: string) => `/api/cameras/${encodeURIComponent(cam)}/clips`;
  const clipJson = (c: ClipRow, events: number[]) => ({
    id: c.id,
    start: c.start_ts,
    end: c.end_ts,
    stream: c.stream,
    size: c.size,
    origin: c.origin,
    events,
    url: `${clipBase(c.cam)}/${c.id}.mp4`,
    snapshotUrl: c.snapshot ? `${clipBase(c.cam)}/${c.id}.jpg` : null,
  });
  r.get('/cameras/:cam/clips', (req, res) => {
    const rg = range(req, res, 31 * DAY, 'at most 31 days per request');
    if (!rg) return;
    const cam = workerOf(res).id;
    const clips = listClips(d.catalog, cam, rg[0], rg[1]);
    const events = overlappingEventsOf(d.catalog, cam, clips.map((c) => ({ from: c.start_ts, to: c.end_ts ?? c.start_ts })));
    res.json(clips.map((c, i) => clipJson(c, events[i])));
  });
  r.get('/cameras/:cam/clips/:file', (req, res) => {
    const m = /^(\d{1,15})\.(mp4|jpg)$/.exec(req.params.file);
    if (!m) return bad(res, 'a clip is <id>.mp4, its snapshot <id>.jpg');
    const clip = clipById(d.catalog, Number(m[1]));
    const file = clip?.cam === workerOf(res).id ? (m[2] === 'mp4' ? clip.path : clip.snapshot) : null;
    if (!file) return void res.status(404).json({ error: 'not_found' });
    res.setHeader('Cache-Control', IMMUTABLE);
    sendFileOr(res, resolve(file), { headers: { 'Content-Type': m[2] === 'mp4' ? 'video/mp4' : 'image/jpeg' } }, 'not_found');
  });

  // Recordings on the camera's SD card (spec 2026-10-02-baichuan-recordings-design):
  // listed by HTTP Search, fetched over Baichuan into the cache. /days is
  // registered before /:id.
  const online = (res: Response) => workerOf(res).status.state().online;
  const offline = (res: Response) => void res.status(503).json({ error: 'camera_offline' });
  // 503 is for a camera that is offline: the status poller says so, or no
  // connection could be made. A connection lost mid-transfer is a 502 with
  // reason `offline` (the download's result on the Status line).
  const cameraOffline = (res: Response, err: unknown): boolean =>
    (err instanceof SearchError && err.code === 'camera_offline') || (err instanceof BaichuanError && err.code === 'offline' && (err.phase === 'connect' || !online(res)));
  // `detail` is for people: never a path, a password or a key.
  const recordingError = (res: Response, err: unknown): void => {
    if (res.headersSent || isAbort(err)) return void res.destroy();
    if (err instanceof SearchError) {
      if (err.code === 'camera_offline') return offline(res);
      if (err.code === 'busy') {
        // The Search queue is full (#99): nothing is wrong with the camera.
        res.setHeader('Retry-After', '5');
        return void res.status(503).json({ error: 'recordings_unavailable', reason: 'busy', detail: err.message });
      }
      return void res.status(502).json({ error: 'recordings_unavailable', reason: 'search_failed', detail: err.message });
    }
    if (err instanceof BaichuanError) {
      if (cameraOffline(res, err)) return offline(res);
      if (err.code === 'not_found') return void res.status(404).json({ error: 'unknown_recording' });
      return void res.status(502).json({ error: 'recordings_unavailable', reason: err.code, detail: err.message });
    }
    logger.error({ err: (err as Error).message }, 'recording_request_failed');
    res.status(500).json({ error: 'internal' });
  };
  // The file never changes: its ETag is its id and size, the same when it is
  // streamed and from the cache (not the mtime, which every read touches).
  const etagOf = (id: string, size: number) => `"${id}-${size.toString(16)}"`;
  const fileHeaders = (res: Response, id: string, size: number) => {
    res.setHeader('ETag', etagOf(id, size));
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', IMMUTABLE);
  };
  // From the cache, like clip files (Range, 416); pinned while it is read.
  const serveCached = (res: Response, side: RecordingsSide, id: string): boolean => {
    const unpin = side.cache.open(id);
    if (!unpin) return false;
    res.on('close', unpin);
    const path = resolve(side.cache.path(id));
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      unpin();
      return false; // gone between open and stat (budget run)
    }
    res.setHeader('Cache-Control', IMMUTABLE);
    // send answers If-None-Match (304) and If-Range from this header.
    res.setHeader('ETag', etagOf(id, size));
    sendFileOr(res, path, { etag: false, lastModified: false, headers: { 'Content-Type': 'video/mp4' } }, 'unknown_recording', unpin);
    return true;
  };
  const gone = (res: Response) => res.destroyed || res.writableEnded;
  // Aborted when the response closes (the client left, or it was answered).
  const leftSignal = (res: Response): AbortSignal => {
    const ac = new AbortController();
    res.once('close', () => ac.abort());
    return ac.signal;
  };

  // Either a window (from/to, unix ms, at most 48 h) or one camera-local day
  // (date=YYYY-MM-DD); both include a recording that starts the day before
  // and runs past midnight into it (#99).
  r.get('/cameras/:cam/recordings', async (req, res) => {
    // Checked before the list: it has no guard of its own (from=0 would mean
    // a Search per day since 1970).
    const date = req.query.date;
    let day: string | undefined;
    let from: number | undefined, to: number | undefined;
    if (date !== undefined) {
      if (req.query.from !== undefined || req.query.to !== undefined) return bad(res, 'date or from/to, not both');
      if (typeof date !== 'string' || !validDate(date)) return bad(res, 'date is YYYY-MM-DD');
      day = date;
    } else {
      const rg = range(req, res, 2 * DAY, 'at most 48 hours per request', 'from and to (unix ms), or date, are required');
      if (!rg) return;
      [from, to] = rg;
    }
    const stream = req.query.stream;
    if (stream !== 'sub' && stream !== 'main') return bad(res, 'stream is sub or main');
    if (!online(res)) return offline(res);
    const signal = leftSignal(res); // a Search still queued when the client leaves is dropped
    try {
      const w = workerOf(res);
      const list = day !== undefined ? await w.recordings.list.date(day, stream, signal) : await w.recordings.list.range(from!, to!, stream, signal);
      const near = clipsNear(d.catalog, w.id, list.map((e) => ({ stream: e.stream, ts: e.start })), 5000);
      res.json(list.map((e, i) => ({ id: e.id, start: e.start, end: e.end, stream: e.stream, size: e.size, kinds: e.kinds, clipId: near[i]?.id ?? null })));
    } catch (err) {
      recordingError(res, err);
    }
  });

  r.get('/cameras/:cam/recordings/days', async (req, res) => {
    const month = typeof req.query.month === 'string' ? req.query.month : '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return bad(res, 'month is YYYY-MM');
    if (!online(res)) return offline(res);
    try {
      res.json({ month, days: await workerOf(res).recordings.list.monthDays(month, leftSignal(res)) });
    } catch (err) {
      recordingError(res, err);
    }
  });

  // GET and HEAD (Express answers HEAD with this route).
  r.get('/cameras/:cam/recordings/:id', async (req, res) => {
    const id = req.params.id;
    if (!validId(id)) return bad(res, 'not a recording id'); // before the cache or the camera
    const side = workerOf(res).recordings;
    if (serveCached(res, side, id)) return; // the cache needs no camera
    if (!online(res)) return offline(res);
    let entry: RecordingEntry | undefined;
    try {
      entry = await side.list.find(id, leftSignal(res)); // the camera path comes from Search, never from the request
    } catch (err) {
      return recordingError(res, err);
    }
    if (gone(res)) return;
    if (!entry) return void res.status(404).json({ error: 'unknown_recording' });
    if (serveCached(res, side, id)) return;
    const size = entry.size;
    // A Range wholly past the end: 416 now (the size is in the name), no
    // download. Only when the Range applies (no If-Range, or ours).
    const ifRange = req.headers['if-range'];
    if (req.headers.range && (!ifRange || ifRange === etagOf(id, size)) && req.range(size) === -1) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return void res.status(416).end();
    }
    // HEAD answers from the list: never a camera download.
    if (req.method === 'HEAD') {
      fileHeaders(res, id, size);
      return void res.status(200).end();
    }
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    // A plain GET streams the file through the fetch's tee while it arrives
    // (when it is the fetch's first client and no byte has gone through yet).
    // So does `Range: bytes=0-` (every <video> opens with it): the whole file
    // as a 200, which RFC 9110 allows for a Range. Other ranges are served
    // only from the (complete) cached file: such a request waits for the
    // fetch, then reads the cache. When the file can't be kept (disk paused,
    // over the cap, no room beside the pinned files) a Range request gets the
    // whole file streamed as a 200 too. Any other request waits for
    // `done` and reads the cache. A fetch this request joined that failed or
    // wasn't kept (another client's abort, a full disk) is tried once more
    // for this client before an error is final.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (gone(res)) return;
      const { fetch, created } = side.fetcher.get(entry, { priority: 'high', signal: ac.signal });
      const streamIt = !req.headers.range || req.headers.range === 'bytes=0-' || !side.fetcher.canKeep(size) || attempt > 0;
      const live = streamIt && fetch.attach(res, () => (res.status(200), fileHeaders(res, id, size)));
      try {
        await fetch.done;
      } catch (err) {
        if (res.headersSent || gone(res)) return void res.destroy(); // a short body: the client sees the failure
        const final = (err instanceof BaichuanError && err.code === 'not_found') || cameraOffline(res, err);
        if (attempt === 0 && (isAbort(err) || (!created && !final))) continue; // not this client's failure: try again
        return recordingError(res, err);
      }
      if (live || res.headersSent || gone(res)) return; // the tee sent the whole file and ended the response
      if (serveCached(res, side, id)) return;
    }
    if (gone(res)) return;
    recordingError(res, new BaichuanError('protocol', 'the recording could not be kept or streamed'));
  });

  r.get('/stream', d.sse);
  return r;
}
