import express, { type NextFunction, type Request, type Response } from 'express';
import { createReadStream, readFileSync, statSync } from 'fs';
import { Readable } from 'stream';
import { crc32 } from 'zlib';
import type { TimeInfo } from '../camera/time';
import { ARCHIVE_SORTS, archiveById, archiveByIds, listArchive, type ArchiveRow, type ArchiveSort } from '../catalog/archive';
import { clipById } from '../catalog/clips';
import type { Catalog } from '../catalog/db';
import type { Config } from '../config/defaults';
import type { createComposer } from '../compose/jobs';
import { BaichuanError } from '../camera/baichuan/errors';
import { SearchError, type RecordingEntry } from '../recordings/list';
import { parseSdName, recordingTimes, stillRecording, validId } from '../recordings/names';
import type { RecordingsSide } from '../recordings/side';
import { logger } from '../log';
import { filesOf, itemJson, metadataJson } from '../archive/json';
import { createStatus, type ArchiveRequest } from '../archive/jobs';
import { checkLabels, checkName, checkRetention, contentDisposition, onBehalfOf, RETENTION_DEFAULT_DAYS, RuleError, safeFileName } from '../archive/rules';
import type { Archive, Who } from '../archive/service';
import { ArchiveJobError, fileSource, recordingSource } from '../archive/sources';
import { planZip, writeZip, type ZipEntry } from '../archive/zip';
import { CAM_ID } from '../archive/paths';
import { clientIp } from './auth';
import { bad, IMMUTABLE, intParam, perMinute, sendFileOr } from './respond';

// The Archive's client API (docs/archive.md, spec 2026-10-05-archive-design
// §2–4). Auth (client token or admin; CSRF for sessions) is applied by the
// caller. Ids only, never paths: every file comes from a row through the
// store's path guard.
export const ARCHIVE_ADDS_PER_MINUTE = 10;
export const ZIPS_PER_MINUTE = 4;
export const ZIP_MAX_IDS = 200;
export const DELETE_MAX_IDS = 500;
const WAIT_MS = 3000; // a create answers 201 when its job ends within this
const JOB_ID = /^[A-Za-z0-9_-]{22}$/;
const QUALITIES = ['sd', '360p', '720p', '1080p', '4k'];

class Bad extends Error {}
const notFound = (res: Response) => void res.status(404).json({ error: 'not_found' });
const ID = /^\d{1,15}$/; // an archive id in a path or a list
const listParam = (v: unknown): string[] | undefined | null => (v === undefined ? undefined : typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);

type Composer = Pick<ReturnType<typeof createComposer>, 'get' | 'file' | 'request'>;
export interface ArchiveApiDeps {
  config: () => Config;
  catalog: Catalog;
  archive: Archive;
  composer: Composer;
  recordings: () => RecordingsSide;
  online: () => boolean;
  timeInfo: () => TimeInfo | undefined;
}

export function archiveApi(d: ArchiveApiDeps): express.Router {
  const r = express.Router();
  const cam = () => d.config().camera.id;

  const who = (req: Request, res: Response): Who => {
    const a = res.locals.access as { access?: string; viaCookie?: boolean } | undefined;
    const behalf = onBehalfOf(req.get('x-on-behalf-of'));
    return { user: a?.access === 'admin' ? 'admin' : 'client', ip: clientIp(req), userAgent: req.get('user-agent'), requestedBy: a?.viaCookie ? 'session' : 'token', ...(behalf ? { onBehalfOf: behalf } : {}) };
  };
  const rule = <T>(res: Response, f: () => T): T | undefined => {
    try {
      return f();
    } catch (err) {
      if (err instanceof RuleError || err instanceof Bad) return bad(res, err.message), undefined;
      throw err;
    }
  };

  // --- create -------------------------------------------------------------
  interface Checked { source: { type: 'composition' | 'clip' | 'recording'; id?: string; clipId?: number }; name?: string; labels: string[]; retentionDays: number | null; thumbnailAt?: number }
  const validate = (req: Request, res: Response, next: NextFunction) => {
    if (req.params.cam !== cam()) return notFound(res);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const c = rule(res, (): Checked => {
      const s = b.source as Record<string, unknown> | undefined;
      if (!s || typeof s !== 'object') throw new Bad('source is {type: composition, id} or {type: clip, clipId} or {type: recording, id}');
      let source: Checked['source'];
      if (s.type === 'composition') {
        if (typeof s.id !== 'string' || !JOB_ID.test(s.id)) throw new Bad('source.id is a composition job id');
        source = { type: 'composition', id: s.id };
      } else if (s.type === 'clip') {
        if (!Number.isSafeInteger(s.clipId) || (s.clipId as number) < 1) throw new Bad('source.clipId is a whole number');
        source = { type: 'clip', clipId: s.clipId as number };
      } else if (s.type === 'recording') {
        if (typeof s.id !== 'string' || !validId(s.id)) throw new Bad('source.id is an SD recording id');
        source = { type: 'recording', id: s.id };
      } else throw new Bad('source.type is composition, clip or recording');
      const name = b.name === undefined ? undefined : checkName(b.name);
      const labels = b.labels === undefined ? [] : checkLabels(b.labels);
      const retentionDays = b.retentionDays === undefined ? RETENTION_DEFAULT_DAYS : checkRetention(b.retentionDays);
      if (b.thumbnailAt !== undefined && (!Number.isSafeInteger(b.thumbnailAt) || (b.thumbnailAt as number) < 0)) throw new Bad('thumbnailAt is a time (unix ms)');
      return { source, name, labels, retentionDays, ...(b.thumbnailAt !== undefined ? { thumbnailAt: b.thumbnailAt as number } : {}) };
    });
    if (!c) return;
    if (!d.config().archive.enabled) return void res.status(503).json({ error: 'archive_off' });
    res.locals.archive = c;
    next();
  };
  const addLimiter = perMinute(ARCHIVE_ADDS_PER_MINUTE);

  // A recording's entry: from its name when it is cached and the camera's
  // time is known (no camera needed), else from the camera's list.
  const recordingEntry = async (id: string, res: Response): Promise<RecordingEntry | undefined> => {
    const side = d.recordings();
    const n = parseSdName(id);
    const ti = d.timeInfo();
    if (n && ti && side.cache.has(id) && !stillRecording(n)) {
      const t = recordingTimes(n, ti);
      const size = sizeOf(side.cache.path(id));
      if (size !== null) return { id, path: '', start: t.start, end: t.end, stream: n.stream, size, kinds: n.kinds };
      // evicted since has(): ask the camera's list as for one not cached
    }
    if (!d.online()) return void res.status(503).json({ error: 'camera_offline' }), undefined;
    const ac = new AbortController();
    res.once('close', () => ac.abort());
    try {
      const e = await side.list.find(id, ac.signal);
      if (!e) return void res.status(404).json({ error: 'unknown_recording' }), undefined;
      return e;
    } catch (err) {
      if (err instanceof SearchError && err.code === 'camera_offline') return void res.status(503).json({ error: 'camera_offline' }), undefined;
      if (err instanceof SearchError && err.code === 'busy') {
        res.setHeader('Retry-After', '5');
        return void res.status(503).json({ error: 'recordings_unavailable', reason: 'busy' }), undefined;
      }
      if (err instanceof BaichuanError && err.code === 'offline') return void res.status(503).json({ error: 'camera_offline' }), undefined;
      logger.warn({ err: (err as Error).message }, 'archive_recording_lookup_failed');
      return void res.status(502).json({ error: 'recordings_unavailable', reason: 'search_failed' }), undefined;
    }
  };

  // The request's file and facts, or an answer sent (404, 409, 503).
  const resolveSource = async (c: Checked, res: Response, base: Omit<ArchiveRequest, 'source' | 'kind' | 'window' | 'quality' | 'original' | 'size' | 'durationS' | 'obtain'>): Promise<ArchiveRequest | undefined> => {
    const s = c.source;
    if (s.type === 'composition') {
      const creq = d.composer.request(cam(), s.id!);
      const job = d.composer.get(cam(), s.id!);
      if (!creq || !job) return notFound(res), undefined;
      const file = d.composer.file(cam(), s.id!);
      if (job.state !== 'done' || !file) return void res.status(409).json({ error: 'not_ready', state: job.state }), undefined;
      const size = sizeOf(file);
      if (size === null) return void res.status(404).json({ error: 'source_gone' }), undefined; // swept since file()
      return {
        ...base, kind: 'composition', source: { type: 'composition', jobId: s.id, ...(creq.asked ?? {}), size: creq.size, badge: creq.badge },
        window: { from: creq.plan.start, to: creq.plan.end }, quality: creq.size, original: false, size, durationS: creq.plan.durationS, obtain: fileSource(file),
      };
    }
    if (s.type === 'clip') {
      const row = clipById(d.catalog, s.clipId!);
      if (!row || row.cam !== cam() || row.end_ts === null) return notFound(res), undefined;
      const size = sizeOf(row.path);
      if (size === null) return notFound(res), undefined;
      return {
        ...base, kind: 'clip', source: { type: 'clip', clipId: row.id, stream: row.stream },
        window: { from: row.start_ts, to: row.end_ts }, quality: row.stream === 'main' ? '4k' : 'sd', original: true, size, durationS: (row.end_ts - row.start_ts) / 1000, obtain: fileSource(row.path),
      };
    }
    const entry = await recordingEntry(s.id!, res);
    if (!entry) return undefined;
    const side = d.recordings();
    return {
      ...base, kind: 'recording', source: { type: 'recording', recording: entry.id, stream: entry.stream },
      window: { from: entry.start, to: entry.end }, quality: entry.stream === 'main' ? '4k' : 'sd', original: true, size: entry.size, durationS: (entry.end - entry.start) / 1000,
      obtain: recordingSource({ entry: entry.path ? entry : { ...entry, path: entry.id }, cache: side.cache, fetcher: side.fetcher }),
    };
  };

  r.post('/cameras/:cam/archive', validate, addLimiter, async (req, res) => {
    const c = res.locals.archive as Checked;
    const w = who(req, res);
    const a = res.locals.access as { access?: string } | undefined;
    const ar = await resolveSource(c, res, { cam: cam(), name: c.name, labels: c.labels, retentionDays: c.retentionDays, thumbnailAt: c.thumbnailAt, createdBy: a?.access === 'admin' ? 'admin' : 'client' });
    if (!ar || res.headersSent) return;
    try {
      d.archive.checkSpace(ar.size);
    } catch (err) {
      if (!(err instanceof ArchiveJobError)) throw err;
      d.archive.refused(ar, w, err);
      return void res.status(507).json({ error: 'insufficient_space', ...err.extra });
    }
    const job = d.archive.create(ar, w);
    if (job === 'busy') return void res.status(429).json({ error: 'busy' });
    const v = (await d.archive.jobs.wait(job.id, WAIT_MS)) ?? job;
    res.status(createStatus(v)).json(v);
  });

  r.get('/archive/jobs/:job', (req, res) => {
    const v = JOB_ID.test(req.params.job) ? d.archive.jobs.get(req.params.job) : undefined;
    if (!v) return notFound(res);
    res.setHeader('Cache-Control', 'no-store');
    res.json(v);
  });
  r.delete('/archive/jobs/:job', (req, res) => {
    if (!JOB_ID.test(req.params.job) || !d.archive.jobs.cancel(req.params.job)) return notFound(res);
    res.status(204).end();
  });

  // --- read -----------------------------------------------------------------
  r.get('/archive/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(d.archive.status());
  });

  r.get('/archive', (req, res) => {
    const q = req.query;
    const p = rule(res, () => {
      const camQ = q.cam === undefined ? undefined : String(q.cam);
      if (camQ !== undefined && !CAM_ID.test(camQ)) throw new Bad('cam is a camera id');
      const labels = listParam(q.labels);
      if (labels === null) throw new Bad('labels is a comma-separated list');
      if (labels) checkLabels(labels);
      const text = q.q === undefined ? undefined : String(q.q);
      if (text !== undefined && text.length > 120) throw new Bad('q is at most 120 characters');
      const from = intParam(q.from), to = intParam(q.to), limit = intParam(q.limit), offset = intParam(q.offset);
      if ([from, to, limit, offset].includes(null)) throw new Bad('from, to, limit and offset are whole numbers');
      if (limit !== undefined && (limit! < 1 || limit! > 500)) throw new Bad('limit is 1 to 500');
      const quality = listParam(q.quality);
      if (quality === null || quality?.some((x) => !QUALITIES.includes(x))) throw new Bad(`quality is a list of ${QUALITIES.join(', ')}`);
      const sort = q.sort === undefined ? undefined : String(q.sort);
      if (sort !== undefined && !(ARCHIVE_SORTS as string[]).includes(sort)) throw new Bad(`sort is one of ${ARCHIVE_SORTS.join(', ')}`);
      const order = q.order === undefined ? undefined : String(q.order);
      if (order !== undefined && order !== 'asc' && order !== 'desc') throw new Bad('order is asc or desc');
      return { cam: camQ, labels, q: text, from: from ?? undefined, to: to ?? undefined, limit: limit ?? 100, offset: offset ?? 0, quality, sort: sort as ArchiveSort | undefined, order: order as 'asc' | 'desc' | undefined };
    });
    if (!p) return;
    const { total, rows } = listArchive(d.catalog, p);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ total, offset: p.offset, limit: p.limit, items: rows.map(itemJson) });
  });

  // ZIP of several clips (§4.4): planned first, then streamed.
  const zipLimiter = perMinute(ZIPS_PER_MINUTE);
  r.get('/archive/zip', (req, res, next) => {
    const ids = listParam(req.query.ids);
    if (!ids || !ids.length || ids.some((x) => !ID.test(x))) return bad(res, 'ids is a comma-separated list of archive ids');
    const unique = [...new Set(ids.map(Number))];
    if (unique.length > ZIP_MAX_IDS) return bad(res, `at most ${ZIP_MAX_IDS} ids`);
    res.locals.zipIds = unique;
    next();
  }, zipLimiter, async (req, res) => {
    const ids = res.locals.zipIds as number[];
    const rows = new Map(archiveByIds(d.catalog, ids).map((x) => [x.id, x]));
    const entries: ZipEntry[] = [];
    const missing: number[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      const e = row && (await zipEntries(row));
      if (!e) missing.push(id);
      else entries.push(...e);
    }
    if (missing.length) return void res.status(404).json({ error: 'not_found', missing });
    const layout = planZip(entries);
    if (req.method === 'HEAD') return void res.status(200).set({ 'Content-Type': 'application/zip', 'Content-Length': String(layout.total) }).end();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    res.status(200).set({ 'Content-Type': 'application/zip', 'Content-Length': String(layout.total), 'Content-Disposition': contentDisposition(`archive-${cam()}-${stamp}.zip`), 'Cache-Control': 'no-store' });
    writeZip(res, entries, layout).then(
      () => res.end(),
      (err: Error) => {
        logger.warn({ err: err.message }, 'archive_zip_failed');
        res.destroy();
      },
    );
  });

  // A clip's three entries, or undefined when its file is gone or changed.
  const zipEntries = async (row: ArchiveRow): Promise<ZipEntry[] | undefined> => {
    const files = filesOf(row);
    const store = d.archive.store;
    let clip: string;
    try {
      clip = store.file(row, 'clip.mp4');
    } catch {
      return undefined;
    }
    const size = sizeOf(clip);
    if (size === null) return undefined;
    const base = `${safeFileName(row.name)} (${row.id})`;
    const json = Buffer.from(JSON.stringify(metadataJson(row), null, 2));
    const mem = (name: string, data: Buffer): ZipEntry => ({ name, size: data.length, crc32: crc32(data), mtime: row.created_at, open: () => bufferStream(data) });
    // No stored CRC (or the file changed): one read more.
    const crc = files && files.clip.bytes === size ? files.clip.crc32 : await fileCrc(clip);
    const out: ZipEntry[] = [{ name: `${base}.mp4`, size, crc32: crc, mtime: row.created_at, open: () => createReadStream(clip) }, mem(`${base}.json`, json)];
    if (row.thumb_from !== 'none') {
      try {
        out.push(mem(`${base}.jpg`, readFileSync(store.file(row, 'thumb.jpg'))));
      } catch {
        // no thumbnail file: the clip and its metadata still go
      }
    }
    return out;
  };

  r.post('/archive/delete', (req, res) => {
    const ids: unknown = req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > DELETE_MAX_IDS || ids.some((x) => !Number.isSafeInteger(x) || (x as number) < 1)) return bad(res, `ids is a list of 1 to ${DELETE_MAX_IDS} archive ids`);
    res.json(d.archive.delete([...new Set(ids as number[])], who(req, res)));
  });

  // --- one item ---------------------------------------------------------------
  const rowOf = (req: Request, res: Response): ArchiveRow | undefined => {
    const id = String(req.params.id);
    if (!ID.test(id)) return bad(res, 'id is a whole number'), undefined;
    const row = archiveById(d.catalog, Number(id));
    if (!row) return notFound(res), undefined;
    return row;
  };
  r.get('/archive/:id', (req, res) => {
    const row = rowOf(req, res);
    if (row) res.json(itemJson(row));
  });
  r.patch('/archive/:id', (req, res) => {
    if (!ID.test(req.params.id)) return bad(res, 'id is a whole number');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch = rule(res, () => {
      if (b.name === undefined && b.labels === undefined && b.retentionDays === undefined) throw new Bad('name, labels or retentionDays');
      return {
        ...(b.name !== undefined ? { name: checkName(b.name) } : {}),
        ...(b.labels !== undefined ? { labels: checkLabels(b.labels) } : {}),
        ...(b.retentionDays !== undefined ? { retentionDays: checkRetention(b.retentionDays) } : {}),
      };
    });
    if (!patch) return;
    const row = d.archive.update(Number(req.params.id), patch, who(req, res));
    if (!row) return notFound(res);
    res.json(itemJson(row));
  });
  r.delete('/archive/:id', (req, res) => {
    if (!ID.test(req.params.id)) return bad(res, 'id is a whole number');
    const { deleted } = d.archive.delete([Number(req.params.id)], who(req, res));
    if (!deleted.length) return notFound(res);
    res.status(204).end();
  });

  r.get('/archive/:id/video', (req, res) => {
    const row = rowOf(req, res);
    if (!row) return;
    const path = d.archive.store.file(row, 'clip.mp4');
    res.setHeader('Cache-Control', IMMUTABLE);
    if (req.query.download === '1') res.setHeader('Content-Disposition', contentDisposition(`${safeFileName(row.name)}.mp4`));
    sendFileOr(res, path, { headers: { 'Content-Type': 'video/mp4' } }, 'not_found'); // the path comes from the row and the guard
  });
  r.get('/archive/:id/thumbnail', (req, res) => {
    const row = rowOf(req, res);
    if (!row) return;
    if (row.thumb_from === 'none') return notFound(res);
    let jpeg: Buffer;
    try {
      jpeg = readFileSync(d.archive.store.file(row, 'thumb.jpg'));
    } catch {
      return notFound(res);
    }
    res.type('image/jpeg').setHeader('Cache-Control', IMMUTABLE);
    res.send(jpeg);
  });
  r.get('/archive/:id/metadata', (req, res) => {
    const row = rowOf(req, res);
    if (!row) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(metadataJson(row));
  });
  return r;
}

const bufferStream = (data: Buffer) => Readable.from([data]);

// A file's size, or null when it is gone (a race with a sweep or an eviction).
function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

// A file's CRC-32, read in chunks (a row without its stored CRC).
async function fileCrc(path: string): Promise<number> {
  let c = 0;
  for await (const chunk of createReadStream(path)) c = crc32(chunk as Buffer, c);
  return c;
}
