import { randomBytes } from 'crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { lstatSync, realpathSync } from 'fs';
import { join, sep } from 'path';
import type { AuditLog } from '../audit/audit-log';
import { logger } from '../log';
import { chunkManifest, chunkRows, CONTENT_FOLDERS, listChunks, parseChunkId, type InventoryDeps, type ManifestFile } from '../moves/inventory';
import type { MoveJournal, MoveRecord } from '../moves/journal';
import { ManifestCache } from '../moves/manifest-cache';
import { seal } from '../moves/seal';
import { moveTokenGuard } from '../moves/token-guard';
import type { MovePhaseName } from '../moves/types';
import { bad, intParam, sendFileOr } from './respond';

// The source's side of a camera move (camera-move plan Task 5, S §8.1, §9.3):
// the target pulls the camera's content and its sealed password from
// /api/moves/:id/... Mounted at /api AHEAD of the client auth: every route
// sits behind moveTokenGuard (src/moves/token-guard.ts), and nothing under
// /moves falls through to the client APIs. Content travels in clear on the
// LAN (Klaus); the password only sealed to the target's key.
export interface MovesSourceDeps {
  journal: Pick<MoveJournal, 'load' | 'save'>;
  audit: Pick<AuditLog, 'write'>;
  inventory: InventoryDeps;
  // Storage paused, or the load above the core count (S §8.3, B16): file and
  // chunk endpoints answer 503 busy; the target's copier halves its rate.
  busy: () => boolean;
  // The camera's proxy-user password as loadSecrets resolved it (P3: env,
  // then the store, then the default). Never logged, audited or sent unsealed.
  password: (cam: string) => string;
  now?: () => number;
  // The cached chunk manifests, shared with move.release's refreshManifest (one index of the listed paths).
  cache?: ManifestCache;
  // A valid move token from another address (B46): see moveTokenGuard.
  onWrongAddress?: (r: MoveRecord) => void;
}

const PROBE_MAX = 67_108_864;
// The source keeps serving after released (P12); there the chunks from the
// approval day on are listed once more.
const AFTER_RELEASE: readonly MovePhaseName[] = ['released', 'copying', 'copied'];
const SEGMENT = /^[^\x00-\x1f\x7f\\/]{1,255}$/;
const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const recordOf = (res: Response): MoveRecord => res.locals.move as MoveRecord;
const notReady = (res: Response) => void res.status(409).json({ error: 'not_ready' });

// The absolute path of a dataDir-relative posix path inside one of the
// camera's content folders (<folder>/<cam>/...), or null.
function contentPath(dataDir: string, cam: string, p: unknown): string | null {
  if (typeof p !== 'string' || p.length > 1024) return null;
  const parts = p.split('/');
  if (parts.length < 3 || !CONTENT_FOLDERS.includes(parts[0]) || parts[1] !== cam) return null;
  if (!parts.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')) return null;
  return join(dataDir, ...parts);
}

// The chunks from the approval day on, listed again once at released (P12):
// what the source captured during the overlap; their cached manifests go.
export function refreshManifest(d: Pick<MovesSourceDeps, 'journal' | 'inventory' | 'now'>, id: string, cache = new ManifestCache(d.inventory.dataDir)): MoveRecord | null {
  const r = d.journal.load(id);
  if (!r || r.role !== 'source' || !r.manifest || r.manifestRefreshedAt !== undefined) return r;
  const from = dayOf(r.approvedAt ?? r.startedAt);
  const kinds = r.plan?.kinds ?? [...new Set(r.manifest.map((c) => c.kind))];
  const fresh = listChunks(d.inventory, r.camera, kinds).filter((c) => c.day >= from);
  cache.drop(r.id, [...r.manifest, ...fresh].filter((c) => c.day >= from).map((c) => c.id));
  // Both lists are newest day first; the older days stay as frozen.
  r.manifest = [...fresh, ...r.manifest.filter((c) => c.day < from)];
  r.manifestRefreshedAt = (d.now ?? Date.now)();
  d.journal.save(r);
  return r;
}

export function movesSourceApi(d: MovesSourceDeps): express.Router {
  const router = express.Router();
  const inflight = new Map<string, Promise<{ files: ManifestFile[]; rows: number; expired: number }>>();
  const cache = d.cache ?? new ManifestCache(d.inventory.dataDir);
  const busyGate = (_req: Request, res: Response, next: NextFunction) => (d.busy() ? void res.status(503).json({ error: 'busy' }) : next());

  // The chunk id a request names, when it is one of the frozen manifest's.
  const chunkOf = (req: Request, res: Response): string | null => {
    const id = String(req.params.chunkId);
    try {
      parseChunkId(id);
    } catch {
      bad(res, 'chunkId');
      return null;
    }
    const r = recordOf(res);
    if (!r.manifest) return (notReady(res), null);
    if (!r.manifest.some((c) => c.id === id)) return (void res.status(404).json({ error: 'unknown_chunk' }), null);
    return id;
  };

  router.use('/moves/:id', moveTokenGuard({ journal: d.journal, audit: d.audit, now: d.now, onWrongAddress: d.onWrongAddress }), (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // N random bytes, for the target's rate probe (S §8.3).
  router.get('/moves/:id/probe', (req, res) => {
    const n = intParam(req.query.bytes);
    if (typeof n !== 'number' || n < 1 || n > PROBE_MAX) return bad(res, 'bytes');
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(n) });
    const block = randomBytes(Math.min(n, 1 << 20));
    let left = n;
    res.on('close', () => void (left = 0));
    const pump = () => {
      while (left > 0) {
        const part = left >= block.length ? block : block.subarray(0, left);
        left -= part.length;
        if (!res.write(part)) return void res.once('drain', pump);
      }
      res.end();
    };
    pump();
  });

  router.get('/moves/:id/manifest', (_req, res) => {
    let r = recordOf(res);
    if (!r.manifest) return notReady(res);
    if (AFTER_RELEASE.includes(r.phase) && r.manifestRefreshedAt === undefined) r = refreshManifest(d, r.id, cache) ?? r;
    res.json({ chunks: r.manifest });
  });

  router.get('/moves/:id/chunks/:chunkId', busyGate, async (req, res) => {
    const chunkId = chunkOf(req, res);
    if (!chunkId) return;
    const r = recordOf(res);
    let hit;
    try {
      hit = cache.get(r.id, chunkId);
    } catch (err) {
      logger.warn({ moveId: r.id, chunkId, code: (err as NodeJS.ErrnoException).code ?? 'error' }, 'move_manifest_cache_unreadable');
      return void res.status(500).json({ error: 'internal' });
    }
    if (hit) return void res.json(hit);
    const key = `${r.id}|${chunkId}`;
    let p = inflight.get(key);
    if (!p) {
      const refreshedAt = r.manifestRefreshedAt;
      p = chunkManifest(d.inventory, r.camera, chunkId)
        .then((m) => {
          // Cache it (P5), unless the chunk list was refreshed meanwhile.
          try {
            const fresh = d.journal.load(r.id);
            if (fresh && fresh.manifestRefreshedAt === refreshedAt) cache.set(r.id, chunkId, m);
          } catch (err) {
            logger.warn({ moveId: r.id, chunkId, code: (err as NodeJS.ErrnoException).code ?? 'error' }, 'move_manifest_not_cached');
          }
          return m;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    try {
      res.json(await p);
    } catch (err) {
      // Not cached: the target asks again.
      logger.warn({ moveId: r.id, chunkId, code: (err as NodeJS.ErrnoException).code ?? 'error' }, 'move_manifest_failed');
      res.status(500).json({ error: 'internal' });
    }
  });

  router.get('/moves/:id/chunks/:chunkId/rows', busyGate, (req, res) => {
    const chunkId = chunkOf(req, res);
    if (!chunkId) return;
    res.json(chunkRows(d.inventory, recordOf(res).camera, chunkId));
  });

  // A file of a chunk whose manifest the target has (Range via sendFileOr).
  router.get('/moves/:id/file', busyGate, (req, res) => {
    const r = recordOf(res);
    const rel = req.query.path;
    const abs = contentPath(d.inventory.dataDir, r.camera, rel);
    if (!abs) return bad(res, 'path');
    if (!cache.lists(r.id, rel as string)) return void res.status(404).json({ error: 'not_listed' });
    // No link anywhere on the way out of the camera's folder.
    let real: string;
    try {
      real = realpathSync(abs);
      if (!lstatSync(real).isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
    } catch {
      return void res.status(404).json({ error: 'expired' });
    }
    const root = (() => {
      try {
        return realpathSync(join(d.inventory.dataDir, (rel as string).split('/')[0], r.camera));
      } catch {
        return null;
      }
    })();
    if (!root || !real.startsWith(root + sep)) return bad(res, 'path');
    sendFileOr(res, real, { headers: { 'Content-Type': 'application/octet-stream' } }, 'expired');
  });

  // The camera's proxy-user password, sealed to the target's key (S §9.3).
  router.get('/moves/:id/secrets', (_req, res) => {
    const r = recordOf(res);
    if (!r.targetPublicSpki) return notReady(res);
    const plain = Buffer.from(d.password(r.camera), 'utf8');
    try {
      res.json({ sealed: seal(r.targetPublicSpki, plain) });
    } catch {
      logger.warn({ moveId: r.id }, 'move_seal_failed');
      res.status(500).json({ error: 'internal' });
    } finally {
      plain.fill(0);
    }
  });

  // Nothing under /moves reaches the client APIs.
  router.use('/moves', (_req, res) => void res.status(404).json({ error: 'not_found' }));
  return router;
}
