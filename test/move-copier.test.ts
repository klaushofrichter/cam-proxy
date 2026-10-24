// The copier on the target (camera-move plan Task 9, S §8.2–8.4, §10, §12;
// Review Focus 1–3; rulings B13, B23, B34, B35, X17/B47): per chunk, newest
// first, the files streamed to a temporary name through the rate, checked
// against size and SHA-256 and renamed, then the rows imported; progress and
// audit records; resumable from the journal. Part 1 drives a Copier against a
// fake source; part 2 copies from the real source endpoints over HTTP.
// Documentation addresses (RFC 5737) and made-up tokens only.
import { createHash } from 'crypto';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { movesSourceApi } from '../src/api/moves-api';
import { AuditLog } from '../src/audit/audit-log';
import { openCatalog, type Catalog } from '../src/catalog/db';
import type { Config } from '../src/config/defaults';
import type { Loaded } from '../src/config/load';
import { setLogLevel } from '../src/log';
import { Copier, CopyRunner, removeMoveParts, type CopierDeps, type SourceClient } from '../src/moves/copier';
import { listChunks, type TableRows } from '../src/moves/inventory';
import { chunkPartsDir, readChunkPart } from '../src/moves/chunk-parts';
import { MoveJournal, type MoveRecord } from '../src/moves/journal';
import { landedFiles, removeImported } from '../src/moves/purge';
import { TokenBucket } from '../src/moves/rate';
import { MoveTarget, type TargetDeps } from '../src/moves/target';
import { hashMoveToken } from '../src/moves/token';
import type { MoveCheck, MoveEvent, MoveKind, MovePlan } from '../src/moves/types';
import { Storage } from '../src/storage';
import type { StreamLog } from '../src/stream/log';
import { strict, why } from './helpers/contract';

beforeAll(() => setLogLevel('silent'));

const MOVE = 'mv_0123456789ABCDEFGHJK';
const TOKEN = 'copy-token-'.padEnd(43, 'q');
const CAM = 'cam9';
const PLAN: MovePlan = { transfer: true, kinds: ['stills', 'clips', 'events', 'checks', 'archive'], space: 'all', targetSettings: null, budgetS: 3600, estimateS: 60 };
const APPROVED = Date.UTC(2026, 9, 21, 8, 0);
const day = (d: number) => `2026-10-${String(d).padStart(2, '0')}`;
const ts = (d: number, h = 12, m = 0) => Date.UTC(2026, 9, d, h, m);
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// ---- the fake source ----

interface FakeChunk { id: string; files: string[]; rows?: TableRows[] }
interface Fake {
  client: SourceClient;
  requests: string[];
  files: Record<string, string>;
  // per path: answers left that cut the stream half way, or send other bytes
  cut: Map<string, number>;
  corrupt: Map<string, number>;
  expired: Set<string>;
  busy: number;
  refreshed: boolean;
  chunks: FakeChunk[];
  onFile?: (rel: string) => void;
  // requests left that get no answer at all (the source down), each called with onDown first
  down: number;
  onDown?: () => void;
  // files answer 404 not_listed until the chunk manifest is asked for again (release dropped the cache)
  unlisted: boolean;
  // /rows answers left that are a 404, then one that is not a list
  rowsFail: number;
  // /rows answers left that are 404 unknown_chunk
  rowsUnknown: number;
  // files that always answer 404 not_listed
  neverListed: Set<string>;
  // every second request (but the manifest) answers 503 busy
  busyEveryOther: boolean;
}

function fakeSource(files: Record<string, string>, chunks: FakeChunk[]): Fake {
  const f: Fake = { requests: [], files, cut: new Map(), corrupt: new Map(), expired: new Set(), busy: 0, refreshed: true, chunks, down: 0, unlisted: false, rowsFail: 0, rowsUnknown: 0, neverListed: new Set(), busyEveryOther: false, client: null as unknown as SourceClient };
  const json = (status: number, v: unknown) => ({ status, body: (async function* () { yield Buffer.from(JSON.stringify(v)); })() });
  const meta = (c: FakeChunk) => {
    const [kind, d] = c.id.split(':');
    return { id: c.id, kind, day: d, files: c.files.length, bytes: c.files.reduce((n, p) => n + Buffer.byteLength(f.files[p] ?? ''), 0), rows: (c.rows ?? []).reduce((n, t) => n + t.rows.length, 0) };
  };
  f.client = {
    get: async (path) => {
      f.requests.push(path);
      if (f.down > 0) {
        f.down--;
        f.onDown?.();
        throw new Error('source not reachable');
      }
      const base = `/api/moves/${MOVE}`;
      if (!path.startsWith(base)) return json(404, { error: 'not_found' });
      const rest = path.slice(base.length);
      if (rest === '/manifest') return json(200, { chunks: f.chunks.map(meta), refreshed: f.refreshed });
      if (f.busyEveryOther && rest !== '/manifest' && (f.requests.length % 2 === 0)) return json(503, { error: 'busy' });
      if (f.busy > 0 && rest !== '/manifest') {
        f.busy--;
        return json(503, { error: 'busy' });
      }
      const m = /^\/chunks\/([^/]+)(\/rows)?$/.exec(rest);
      if (m) {
        const c = f.chunks.find((x) => x.id === decodeURIComponent(m[1]));
        if (!c) return json(404, { error: 'unknown_chunk' });
        if (m[2]) {
          if (f.rowsUnknown > 0) return (f.rowsUnknown--, json(404, { error: 'unknown_chunk' }));
          if (f.rowsFail > 0) return f.rowsFail-- > 1 ? json(404, { error: 'unknown_chunk' }) : json(200, { not: 'a list' });
          return json(200, c.rows ?? []);
        }
        f.unlisted = false;
        const present = c.files.filter((p) => f.files[p] !== undefined);
        return json(200, { files: present.map((p) => ({ path: p, size: Buffer.byteLength(f.files[p]), sha256: sha(f.files[p]) })), rows: meta(c).rows, expired: c.files.length - present.length });
      }
      const q = /^\/file\?path=(.*)$/.exec(rest);
      if (q) {
        const rel = decodeURIComponent(q[1]);
        f.onFile?.(rel);
        if (f.unlisted || f.neverListed.has(rel)) return json(404, { error: 'not_listed' });
        if (f.expired.has(rel) || f.files[rel] === undefined) return json(404, { error: 'expired' });
        const content = Buffer.from(f.files[rel]);
        const cutLeft = f.cut.get(rel) ?? 0;
        const badLeft = f.corrupt.get(rel) ?? 0;
        if (cutLeft > 0) f.cut.set(rel, cutLeft - 1);
        if (badLeft > 0) f.corrupt.set(rel, badLeft - 1);
        return {
          status: 200,
          body: (async function* () {
            const half = Math.max(1, Math.floor(content.length / 2));
            yield content.subarray(0, half);
            // The source restarts while serving the file (Review Focus 1).
            if (cutLeft > 0) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
            const restPart = content.subarray(half);
            yield badLeft > 0 ? Buffer.from(restPart.toString().replace(/./g, 'X')) : restPart;
          })(),
        };
      }
      return json(404, { error: 'not_found' });
    },
  };
  return f;
}

// ---- the target ----

const fakeLoaded = (): Loaded => ({ config: { storage: { minFreeBytes: 0 }, stills: {}, previews: {}, ftp: {} } } as unknown as Loaded);

const record = (over: Partial<MoveRecord> = {}): MoveRecord => ({
  v: 1, id: MOVE, role: 'target', camera: CAM, phase: 'copying', plan: PLAN,
  peer: { proxyId: 'prx_1123456789ABCDEFGHJK', name: 'een', url: 'http://198.51.100.7:8480', caFingerprints: [`SHA256:${'A'.repeat(64)}`], tlsServername: 'proxy.s.internal', ip: '198.51.100.7' },
  token: TOKEN, chunks: {}, bytesDone: 0, startedAt: 1, approvedAt: APPROVED, budgetS: 3600, probeBps: 0, done: [], ...over,
});

interface Unit {
  deps: CopierDeps;
  dataDir: string;
  catalog: Catalog;
  journal: MoveJournal;
  events: MoveEvent[];
  audits: { action: string; outcome: string; message: string; details?: Record<string, any> }[];
  phases: { phase: string; detail: string; extra: Record<string, unknown>; check?: MoveCheck }[];
  state: { paused: boolean; now: number; free: number };
  run: (signal?: AbortSignal) => Promise<void>;
  rec: () => MoveRecord;
}

function unit(fake: Fake, over: Partial<MoveRecord> = {}, o: { dataDir?: string; deps?: Partial<CopierDeps> } = {}): Unit {
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), 'camproxy-copier-'));
  const catalog = openCatalog(join(dataDir, 'catalog.db'));
  const journal = new MoveJournal(join(dataDir, 'admin', 'moves'));
  if (!o.dataDir) journal.save(record(over));
  const events: MoveEvent[] = [];
  const audits: Unit['audits'] = [];
  const phases: Unit['phases'] = [];
  const state = { paused: false, now: APPROVED + 60_000, free: 1e12 };
  const deps: CopierDeps = {
    journal, catalog, dataDir,
    audit: { write: (r) => (audits.push(r as Unit['audits'][number]), null) },
    emit: (e) => events.push(e),
    client: () => fake.client,
    paused: () => state.paused,
    cpuBusy: () => false,
    space: { loaded: fakeLoaded, usage: () => ({ stills: 0, previews: 0, clips: 0, used: 0, budget: 1e15 }), freeBytes: () => state.free },
    setPhase: (r, phase, p) => {
      r.phase = phase;
      journal.save(r);
      phases.push({ phase, detail: p.detail ?? '', extra: p.extra ?? {}, ...(p.check ? { check: p.check } : {}) });
    },
    proxyId: () => 'prx_2123456789ABCDEFGHJK',
    now: () => state.now,
    sleep: async () => undefined,
    // The bucket never waits for real here ('holds the stream to the rate' uses the copier's own).
    bucket: new TokenBucket({ now: () => state.now, sleep: async () => undefined }),
    timing: { retryMs: 1, retryCapMs: 2, pausedPollMs: 2, refreshPollMs: 2, refreshWaitMs: 50, saveEveryMs: 0 },
    ...o.deps,
  };
  return {
    deps, dataDir, catalog, journal, events, audits, phases, state,
    run: (signal) => new Copier(deps, journal.load(MOVE)!).run(signal ?? new AbortController().signal),
    rec: () => journal.load(MOVE)!,
  };
}

const chunkStates = (u: Unit) => Object.fromEntries(Object.entries(u.rec().chunks).map(([id, c]) => [id, c.state]));
const fileRequests = (f: Fake) => f.requests.filter((r) => r.includes('/file?')).map((r) => decodeURIComponent(r.split('path=')[1]));
const parts = (dir: string): string[] => {
  const out: string[] = [];
  const go = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) go(join(d, e.name));
      else if (e.name.endsWith('.part')) out.push(join(d, e.name));
    }
  };
  go(dir);
  return out;
};
const envelope = (body: object) => ({ v: 1, type: 'event', id: '01K60000000000000000000003', seq: 3, ts: 1791273600003, body: { proxyId: 'prx_0123456789ABCDEFGHJK', connId: 'con_0123456789ABCDEFGHJK', ...body }, sig: 'JojJ327EFbgVe76kOH467QFrkhQ65wwqRg5NhfAxO7okv/1ohIH+jMV0iNBquQLoWaHyOEe5qJ+wvykQ/qwUDw==' });

const clipRow = (id: number, t: number, path: string) => ({ id, cam: 'cam1', start_ts: t, end_ts: t + 10_000, path, stream: 'sub', size: 4, received_at: t + 11_000, snapshot: null, origin: 'ftp' });

// Three days of a camera: clips and stills each day, events on the newest.
function threeDays(): { files: Record<string, string>; chunks: FakeChunk[] } {
  const files: Record<string, string> = {};
  const chunks: FakeChunk[] = [];
  for (const d of [18, 19, 20]) {
    const clip = `clips/cam9/2026/10/${d}/1200-1.mp4`;
    const pack = `stills/cam9/2026/10/${d}/1200.pack`;
    files[clip] = `clip-of-day-${d}`;
    files[pack] = `stills-pack-of-day-${d}`;
    chunks.push({ id: `clips:${day(d)}`, files: [clip], rows: [{ table: 'clips', rows: [clipRow(100 + d, ts(d), clip)] }] });
    chunks.push({ id: `stills:${day(d)}`, files: [pack] });
  }
  files['analytics/cam9/77.jpg'] = 'analysis-image';
  chunks.push({
    id: `events:${day(20)}`, files: ['analytics/cam9/77.jpg'],
    rows: [
      { table: 'events', rows: [{ id: 77, cam: 'cam1', source: 'onvif', kind: 'person', start_ts: ts(20, 9), end_ts: null, end_reason: null, raw: null }] },
      { table: 'analyses', rows: [{ id: 5, event_id: 77, provider: 'google-vision', status: 'ok', reason: null, still_ts: ts(20, 9), image: 'analytics/cam9/77.jpg', requested_at: 1, took_ms: 1, objects: '[]', raw: null, summary: '[]' }] },
    ],
  });
  return { files, chunks };
}

describe('Copier', () => {
  it('newest chunk first', async () => {
    const { files, chunks } = threeDays();
    // The source's order does not matter: newest day first, then clips, events, checks, archive, stills (P11).
    const f = fakeSource(files, [...chunks].sort((a, b) => (a.id < b.id ? -1 : 1)));
    const u = unit(f);
    await u.run();
    const order = f.requests.filter((r) => /\/chunks\/[^/]+$/.test(r)).map((r) => decodeURIComponent(r.split('/chunks/')[1]));
    const want = [`clips:${day(20)}`, `events:${day(20)}`, `stills:${day(20)}`, `clips:${day(19)}`, `stills:${day(19)}`, `clips:${day(18)}`, `stills:${day(18)}`];
    // The copy, then the completeness check lists each chunk once more (same order); nothing was missing.
    expect(order).toEqual([...want, ...want]);
    expect(fileRequests(f)).toHaveLength(Object.keys(files).length);
    expect(Object.values(chunkStates(u)).every((s) => s === 'verified')).toBe(true);
    for (const [rel, content] of Object.entries(files).filter(([p]) => !p.startsWith('analytics/'))) expect(readFileSync(join(u.dataDir, rel), 'utf8')).toBe(content);
    expect((u.catalog.db.prepare('SELECT COUNT(*) AS n FROM clips WHERE cam = ?').get(CAM) as { n: number }).n).toBe(3);
    // End: the counts, and the phase copied.
    expect(u.phases).toEqual([{ phase: 'copied', detail: expect.stringContaining('7 chunks'), extra: expect.objectContaining({ counts: { verified: 7, skipped: 0, failed: 0, bytes: Object.values(files).reduce((n, c) => n + c.length, 0) } }), check: { complete: true, missing: {}, recovered: {}, failed: {}, expired: {} } }]);
    // move.progress matches the contract; the last one has every chunk verified.
    const progress = u.events.filter((e) => e.kind === 'move.progress');
    expect(progress.length).toBeGreaterThan(0);
    for (const p of progress) expect(strict('event')(envelope(p)), why(strict('event'))).toBe(true);
    const last = progress.at(-1) as Extract<MoveEvent, { kind: 'move.progress' }>;
    expect(last.chunks.every((c) => c.state === 'verified')).toBe(true);
    expect(last.bytesDone).toBe(last.bytesTotal);
    expect(parts(u.dataDir)).toEqual([]);
  });

  it('file hash mismatch retried 3 times then failed', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const bad = 'clips/cam9/2026/10/19/1200-1.mp4';
    f.corrupt.set(bad, 10);
    const u = unit(f);
    await u.run();
    expect(fileRequests(f).filter((p) => p === bad)).toHaveLength(3);
    // "copied with failures" is `failed` in move.progress (X17/B47).
    expect(chunkStates(u)[`clips:${day(19)}`]).toBe('failed');
    expect(existsSync(join(u.dataDir, bad))).toBe(false);
    expect(parts(u.dataDir)).toEqual([]);
    const failed = u.audits.filter((a) => a.action === 'move-file-failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ outcome: 'failure', details: { moveId: MOVE, camera: CAM, chunk: `clips:${day(19)}`, failed: 1, paths: [bad] } });
    // Its row is not imported (B35); the other days' are.
    expect((u.catalog.db.prepare('SELECT start_ts FROM clips WHERE cam = ? ORDER BY start_ts').all(CAM) as { start_ts: number }[]).map((r) => r.start_ts)).toEqual([ts(18), ts(20)]);
    expect(u.phases[0].extra).toMatchObject({ counts: { verified: 6, skipped: 0, failed: 1 } });
    const last = u.events.filter((e) => e.kind === 'move.progress').at(-1) as Extract<MoveEvent, { kind: 'move.progress' }>;
    expect(last.chunks.find((c) => c.id === `clips:${day(19)}`)?.state).toBe('failed');
  });

  it('one recovery pass fetches only the missing files, never a failed one again', async () => {
    const a = 'clips/cam9/2026/10/20/1200-1.mp4';
    const b = 'clips/cam9/2026/10/20/1210-1.mp4';
    const c = 'clips/cam9/2026/10/20/1220-1.mp4';
    const f = fakeSource({ [a]: 'clip-a', [b]: 'clip-b', [c]: 'clip-c' }, [{ id: `clips:${day(20)}`, files: [a, b, c] }]);
    // b always answers with a wrong hash; the target loses its copy of c (storage, say) before the check.
    f.corrupt.set(b, 100);
    const u = unit(f);
    const get = f.client.get;
    let listings = 0;
    f.client = { get: async (path, signal) => {
      if (path === `/api/moves/${MOVE}/chunks/${encodeURIComponent(`clips:${day(20)}`)}` && ++listings === 2) rmSync(join(u.dataDir, c));
      return get(path, signal);
    } };
    await u.run();
    const fetched = (p: string) => fileRequests(f).filter((x) => x === p).length;
    expect(fetched(a)).toBe(1);
    expect(fetched(b)).toBe(3);
    expect(fetched(c)).toBe(2);
    expect(readFileSync(join(u.dataDir, c), 'utf8')).toBe('clip-c');
    expect(u.phases.at(-1)).toMatchObject({ phase: 'copied', check: { complete: false, missing: {}, recovered: { clips: 1 }, failed: { clips: 1 }, expired: {} } });
    const checks = u.audits.filter((x) => x.action === 'move-check');
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ outcome: 'failure', details: { moveId: MOVE, check: { complete: false, recovered: { clips: 1 }, failed: { clips: 1 } } } });
    // The failure of b is audited once (the pass), not again in the recovery.
    expect(u.audits.filter((x) => x.action === 'move-file-failed')).toHaveLength(1);
    // The part keeps the full failed list.
    expect(readChunkPart(u.dataDir, MOVE, `clips:${day(20)}`)?.ff).toEqual([b]);
  });

  it('a complete copy reports a complete check; a file expired at the source counts as expired', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const rel = 'clips/cam9/2026/10/19/1200-1.mp4';
    // The source's retention removes it; the source's manifest cache still lists it (moves-api ManifestCache).
    f.onFile = (p) => void (p === rel && f.expired.add(rel));
    const u = unit(f);
    await u.run();
    // Reported expired, not fetched again in a recovery.
    expect(fileRequests(f).filter((p) => p === rel)).toHaveLength(1);
    expect(readChunkPart(u.dataDir, MOVE, `clips:${day(19)}`)?.xf).toEqual([rel]);
    expect(u.phases).toMatchObject([{ phase: 'copied', check: { complete: true, missing: {}, recovered: {}, failed: {}, expired: { clips: 1 } } }]);
    expect(u.audits.filter((x) => x.action === 'move-check')).toMatchObject([{ outcome: 'success' }]);
  });

  it("the target's own still pack of the overlap minute counts as present, and the source keeps its own", async () => {
    const own = 'stills/cam9/2026/10/20/1200.pack';
    const other = 'stills/cam9/2026/10/20/1201.pack';
    const f = fakeSource({ [own]: 'from-source', [other]: 'other-minute' }, [{ id: `stills:${day(20)}`, files: [own, other] }]);
    const u = unit(f);
    mkdirSync(join(u.dataDir, 'stills/cam9/2026/10/20'), { recursive: true });
    writeFileSync(join(u.dataDir, own), 'target-own');
    // The target loses its copy of the other minute before the check: the recovery runs with `only` = that file.
    const get = f.client.get;
    let listings = 0;
    f.client = { get: async (path, signal) => {
      if (path === `/api/moves/${MOVE}/chunks/${encodeURIComponent(`stills:${day(20)}`)}` && ++listings === 2) rmSync(join(u.dataDir, other));
      return get(path, signal);
    } };
    const cp = new Copier(u.deps, u.journal.load(MOVE)!);
    await cp.run(new AbortController().signal);
    expect(readFileSync(join(u.dataDir, own), 'utf8')).toBe('target-own');
    expect(fileRequests(f).filter((p) => p === own)).toHaveLength(0);
    expect(u.phases.at(-1)?.check).toEqual({ complete: true, missing: {}, recovered: { stills: 1 }, failed: {}, expired: {} });
    // Not verified (the recovery's files outside `only` stay as they were), kept at the source.
    expect(readChunkPart(u.dataDir, MOVE, `stills:${day(20)}`)?.of).toEqual([own]);
    expect(u.rec().chunks[`stills:${day(20)}`]).toMatchObject({ v: 1, s: 1 });
    const { perChunk } = await cp.completeness();
    expect(perChunk.get(`stills:${day(20)}`)).toEqual({ missing: [], failed: [], own: [own] });
  });

  it('a chunk the source no longer lists at the check is kept whole and not complete', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const id = `clips:${day(19)}`;
    const get = f.client.get;
    let listings = 0;
    f.client = { get: async (path, signal) => {
      if (path === `/api/moves/${MOVE}/chunks/${encodeURIComponent(id)}` && ++listings >= 2) return { status: 404, body: (async function* () { yield Buffer.from('{"error":"unknown_chunk"}'); })() };
      return get(path, signal);
    } };
    const u = unit(f);
    const cp = new Copier(u.deps, u.journal.load(MOVE)!);
    await cp.run(new AbortController().signal);
    expect(u.phases.at(-1)?.check).toEqual({ complete: false, missing: { clips: 1 }, recovered: {}, failed: {}, expired: {} });
    expect((await cp.completeness()).perChunk.get(id)).toEqual({ missing: [], failed: [], all: true });
  });

  it('a chunk whose rows did not import counts its rows as failed', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    // The commit of a transaction that wrote an event fails, every time.
    const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-copier-'));
    const real = openCatalog(join(dataDir, 'catalog.db'));
    new MoveJournal(join(dataDir, 'admin', 'moves')).save(record());
    let wroteEvent = false;
    const db = new Proxy(real.db, {
      get: (t, p) => {
        if (p === 'exec') return (sql: string) => {
          if (sql === 'BEGIN') wroteEvent = false;
          if (sql === 'COMMIT' && wroteEvent) throw new Error('disk I/O error');
          return t.exec(sql);
        };
        if (p === 'prepare') return (sql: string) => {
          if (sql.startsWith('INSERT INTO events')) wroteEvent = true;
          return t.prepare(sql);
        };
        const v = (t as any)[p];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const u = unit(f, {}, { dataDir, deps: { catalog: { db } } });
    await u.run();
    expect(chunkStates(u)[`events:${day(20)}`]).toBe('failed');
    // 2 rows (the event and its analysis) failed; the analysis image (staged, removed with the failed import) was
    // fetched once more in the recovery, whose import failed again: still missing.
    expect(fileRequests(f).filter((p) => p === 'analytics/cam9/77.jpg')).toHaveLength(2);
    expect(u.phases.at(-1)?.check).toEqual({ complete: false, missing: { events: 1 }, recovered: {}, failed: { events: 2 }, expired: {} });
  });

  it('source restart mid-file', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const rel = 'clips/cam9/2026/10/20/1200-1.mp4';
    f.cut.set(rel, 1);
    let partSeen = false;
    f.onFile = () => void (partSeen ||= parts(u.dataDir).length > 0);
    const u = unit(f);
    await u.run();
    // The cut answer's partial file was discarded (a temporary name), the file fetched again and verified.
    expect(fileRequests(f).filter((p) => p === rel)).toHaveLength(2);
    expect(partSeen).toBe(false);
    expect(readFileSync(join(u.dataDir, rel), 'utf8')).toBe(files[rel]);
    expect(chunkStates(u)[`clips:${day(20)}`]).toBe('verified');
    expect(parts(u.dataDir)).toEqual([]);
    expect(u.audits.filter((a) => a.action === 'move-file-failed')).toHaveLength(0);
  });

  it('expired file is skipped', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const rel = 'clips/cam9/2026/10/19/1200-1.mp4';
    // Listed in the chunk manifest, removed by the source's retention before it was fetched.
    f.onFile = (p) => void (p === rel && f.expired.add(rel));
    const u = unit(f);
    await u.run();
    expect(fileRequests(f).filter((p) => p === rel)).toHaveLength(1);
    expect(chunkStates(u)[`clips:${day(19)}`]).toBe('verified');
    expect(u.rec().chunks[`clips:${day(19)}`]).toMatchObject({ s: 1, v: 0, f: 0 });
    // Its row is not imported (skipped too).
    expect((u.catalog.db.prepare('SELECT COUNT(*) AS n FROM clips WHERE start_ts = ?').get(ts(19)) as { n: number }).n).toBe(0);
    expect(u.phases[0].extra).toMatchObject({ counts: { verified: 6, skipped: 1, failed: 0 } });
    expect(u.audits.filter((a) => a.action === 'move-file-failed')).toHaveLength(0);
  });

  it('a 404 that is not expired is retried, never read as gone (N1)', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const rel = 'clips/cam9/2026/10/19/1200-1.mp4';
    const get = f.client.get;
    let odd = 2;
    f.client = { get: async (path, signal) => {
      if (path.includes('/file?') && decodeURIComponent(path.split('path=')[1]) === rel && odd-- > 0) {
        return { status: 404, body: (async function* () { yield Buffer.from(odd ? '<html>not found</html>' : '{"error":"not_found"}'); })() };
      }
      return get(path, signal);
    } };
    const u = unit(f);
    await u.run();
    // Two odd 404s (not counted as the source's), then the file.
    expect(odd).toBeLessThan(0);
    expect(fileRequests(f).filter((p) => p === rel)).toHaveLength(1);
    expect(readFileSync(join(u.dataDir, rel), 'utf8')).toBe(files[rel]);
    expect(u.rec().chunks[`clips:${day(19)}`]).toMatchObject({ v: 1, s: 0, f: 0 });
  });

  it('the copier reports what to keep to the source before copied; the report is kept in the journal', async () => {
    const a = 'archive/cam9/5/clip.mp4';
    const b = 'clips/cam9/2026/10/20/1210-1.mp4';
    const ok = 'clips/cam9/2026/10/20/1200-1.mp4';
    const f = fakeSource({ [a]: 'archive-clip', [b]: 'clip-b', [ok]: 'clip-ok' }, [{ id: `archive:${day(20)}`, files: [a] }, { id: `clips:${day(20)}`, files: [ok, b] }]);
    f.corrupt.set(b, 100);
    const puts: { path: string; body: any; phase: string }[] = [];
    const statuses = [503, 204];
    f.client.put = async (path, body) => {
      puts.push({ path, body, phase: u.rec().phase });
      return { status: statuses.shift() ?? 204, body: (async function* () { /* empty */ })() };
    };
    const u = unit(f);
    await u.run();
    // Retried after the 503; both before copied.
    expect(puts).toHaveLength(2);
    expect(puts.every((p) => p.path === `/api/moves/${MOVE}/outcome` && p.phase === 'copying')).toBe(true);
    expect(puts[1].body).toEqual({ keep: { [`clips:${day(20)}`]: [b] }, copied: { [`archive:${day(20)}`]: { files: 1, bytes: Buffer.byteLength('archive-clip'), rows: 0 } } });
    expect(u.phases.at(-1)?.phase).toBe('copied');
    expect(u.rec().keep).toEqual({ [`clips:${day(20)}`]: [b] });
    expect(u.rec().manifest?.map((c) => c.id)).toEqual([`archive:${day(20)}`, `clips:${day(20)}`]);
  });

  it('a 409 from the source ends the outcome retries; the refusal is audited and the record holds no outcome', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    let n = 0;
    f.client.put = async () => (n++, { status: 409, body: (async function* () { yield Buffer.from('{"error":"wrong_phase"}'); })() });
    const u = unit(f);
    await u.run();
    expect(n).toBe(1);
    expect(u.phases.at(-1)?.phase).toBe('copied');
    const refused = u.audits.filter((a) => a.action === 'move-outcome-refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ outcome: 'failure', details: { moveId: MOVE, camera: CAM, role: 'target', status: 409 } });
    expect(Object.keys(refused[0].details!).sort()).toEqual(['camera', 'moveId', 'role', 'source', 'status', 'target']);
    // As if none was sent: the source keeps every Archive item, the rest goes (ruling 5).
    expect(u.rec().keep).toBeUndefined();
    expect(u.rec().keepCopied).toBeUndefined();
  });

  it('a done-list Archive chunk not verified here never counts as copied and stays whole at the source (I1)', async () => {
    const a = 'archive/cam9/5/clip.mp4';
    const f = fakeSource({ [a]: 'archive-clip' }, [{ id: `archive:${day(19)}`, files: [a] }]);
    const puts: any[] = [];
    f.client.put = async (_path, body) => (puts.push(body), { status: 204, body: (async function* () { /* empty */ })() });
    // cams-admin reports the chunk done (B34); the target holds none of its files (a reset journal, say).
    const u = unit(f, { done: [`archive:${day(19)}`] });
    await u.run();
    expect(fileRequests(f)).toEqual([]);
    expect(existsSync(join(u.dataDir, 'archive'))).toBe(false);
    expect(puts).toHaveLength(1);
    expect(puts[0].keep).toEqual({ [`archive:${day(19)}`]: 'all' });
    expect(puts[0].copied ?? {}).toEqual({});
  });

  it('a row whose file is not in the chunk manifest is skipped', async () => {
    const { files, chunks } = threeDays();
    delete files['clips/cam9/2026/10/18/1200-1.mp4'];
    const f = fakeSource(files, chunks);
    const u = unit(f);
    await u.run();
    expect(chunkStates(u)[`clips:${day(18)}`]).toBe('verified');
    expect((u.catalog.db.prepare('SELECT COUNT(*) AS n FROM clips WHERE start_ts = ?').get(ts(18)) as { n: number }).n).toBe(0);
    expect(u.rec().chunks[`clips:${day(18)}`]).toMatchObject({ rowsSkipped: 1 });
  });

  it('pauses while storage is paused', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const u = unit(f, {}, { deps: { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) } });
    u.state.paused = true;
    const running = u.run();
    await new Promise((r) => setTimeout(r, 60));
    expect(fileRequests(f)).toEqual([]);
    // Paused half way through a file: that answer is dropped, not counted as a failure.
    let pausedOnce = false;
    f.onFile = () => {
      if (!pausedOnce) {
        pausedOnce = true;
        u.state.paused = true;
        setTimeout(() => (u.state.paused = false), 30);
      }
    };
    u.state.paused = false;
    await running;
    expect(Object.values(chunkStates(u)).every((s) => s === 'verified')).toBe(true);
    expect(u.phases[0].extra).toMatchObject({ counts: { verified: 7, skipped: 0, failed: 0 } });
    expect(parts(u.dataDir)).toEqual([]);
  });

  it('halves the rate while the source answers 503 busy, and keeps going', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    f.busy = 4;
    const u = unit(f);
    await u.run();
    expect(Object.values(chunkStates(u)).every((s) => s === 'verified')).toBe(true);
    expect(u.phases[0].extra).toMatchObject({ counts: { failed: 0 } });
  });

  it('resume after a target restart skips verified files and re-imports nothing twice', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const u = unit(f);
    // The process stops while the third chunk (stills of the 20th) is in flight.
    const stop = new AbortController();
    f.onFile = (p) => void (p === 'stills/cam9/2026/10/20/1200.pack' && stop.abort());
    await u.run(stop.signal);
    expect(u.phases).toEqual([]);
    const before = f.requests.length;
    const firstFiles = fileRequests(f);
    expect(chunkStates(u)).toMatchObject({ [`clips:${day(20)}`]: 'verified', [`events:${day(20)}`]: 'verified' });
    // A new process: a new Copier from the journal.
    f.onFile = undefined;
    const again = unit(f, {}, { dataDir: u.dataDir });
    await again.run();
    const second = fileRequests({ ...f, requests: f.requests.slice(before) });
    // Verified chunks are not copied again, nor their files: listed once only, by the completeness check.
    expect(f.requests.slice(before).filter((r) => r.includes(`/chunks/${encodeURIComponent(`clips:${day(20)}`)}`) || r.includes(`/chunks/clips:${day(20)}`))).toEqual([`/api/moves/${MOVE}/chunks/${encodeURIComponent(`clips:${day(20)}`)}`]);
    for (const p of firstFiles.filter((x) => x !== 'stills/cam9/2026/10/20/1200.pack')) expect(second).not.toContain(p);
    expect(Object.values(chunkStates(again)).every((s) => s === 'verified')).toBe(true);
    expect((again.catalog.db.prepare('SELECT COUNT(*) AS n FROM clips').get() as { n: number }).n).toBe(3);
    expect((again.catalog.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(1);
    expect((again.catalog.db.prepare('SELECT COUNT(*) AS n FROM analyses').get() as { n: number }).n).toBe(1);
    expect(again.phases).toHaveLength(1);
    expect(parts(u.dataDir)).toEqual([]);
  });

  it('a chunk cams-admin reported done is not copied again (B34)', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const u = unit(f, { done: [`clips:${day(19)}`, `clips:${day(18)}`], chunks: { [`clips:${day(18)}`]: { state: 'pending' } } });
    await u.run();
    expect(fileRequests(f)).not.toContain('clips/cam9/2026/10/19/1200-1.mp4');
    // The journal knows better than the done list: a pending chunk is copied.
    expect(fileRequests(f)).toContain('clips/cam9/2026/10/18/1200-1.mp4');
    expect(chunkStates(u)[`clips:${day(19)}`]).toBe('verified');
  });

  it('budget exceeded is audited once', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const u = unit(f, { budgetS: 60 });
    // Each file takes 30 s here: the budget runs out half way.
    f.onFile = () => void (u.state.now += 30_000);
    await u.run();
    expect(u.audits.filter((a) => a.action === 'move-budget-exceeded')).toHaveLength(1);
    expect(u.audits.find((a) => a.action === 'move-budget-exceeded')).toMatchObject({ details: { moveId: MOVE, camera: CAM, budgetS: 60 } });
    expect(u.rec().budgetExceeded).toBe(true);
    // A resumed copier does not audit it again.
    const again = unit(f, {}, { dataDir: u.dataDir });
    const r = again.rec();
    r.phase = 'copying';
    r.chunks = {};
    again.journal.save(r);
    await again.run();
    expect(again.audits.filter((a) => a.action === 'move-budget-exceeded')).toHaveLength(0);
    // Every move.progress stays inside the contract (integers).
    for (const p of u.events.filter((e) => e.kind === 'move.progress')) expect(strict('event')(envelope(p)), why(strict('event'))).toBe(true);
  });

  it('audits move-progress at 10 % steps', async () => {
    const files: Record<string, string> = {};
    const chunks: FakeChunk[] = [];
    for (let d = 1; d <= 20; d++) {
      const p = `stills/cam9/2026/10/${String(d).padStart(2, '0')}/1200.pack`;
      files[p] = 'x'.repeat(100);
      chunks.push({ id: `stills:${day(d)}`, files: [p] });
    }
    const u = unit(fakeSource(files, chunks));
    await u.run();
    const steps = u.audits.filter((a) => a.action === 'move-progress').map((a) => a.details!.percent);
    expect(steps).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  it('holds the stream to the rate: under the probe, and halved while the source is busy', async () => {
    const files: Record<string, string> = {};
    const chunks: FakeChunk[] = [];
    for (const d of [18, 19, 20]) {
      const p = `stills/cam9/2026/10/${d}/1200.pack`;
      files[p] = 'p'.repeat(40_000);
      chunks.push({ id: `stills:${day(d)}`, files: [p] });
    }
    const f = fakeSource(files, chunks);
    // The short budget asks for more than the probe measured: the probe (1000 B/s) caps it.
    const u = unit(f, { probeBps: 1000, budgetS: 10 }, { deps: { bucket: undefined, sleep: async (ms) => void (u.state.now += ms) } });
    const t0 = u.state.now;
    await u.run();
    const took = (u.state.now - t0) / 1000;
    // 120 kB at 1000 B/s, one second's burst at the start.
    expect(took).toBeGreaterThanOrEqual(115);
    expect(took).toBeLessThan(130);
    for (const p of u.events.filter((e) => e.kind === 'move.progress') as Extract<MoveEvent, { kind: 'move.progress' }>[]) expect(p.rateBps).toBeLessThanOrEqual(1000);

    // The source answering 503 busy: half the rate for a minute.
    const g = fakeSource({ 'stills/cam9/2026/10/20/1200.pack': 'q'.repeat(30_000) }, [{ id: `stills:${day(20)}`, files: ['stills/cam9/2026/10/20/1200.pack'] }]);
    g.busy = 1;
    const v = unit(g, { probeBps: 1000, budgetS: 10 }, { deps: { bucket: undefined, sleep: async (ms) => void (v.state.now += ms) } });
    const t1 = v.state.now;
    await v.run();
    expect((v.state.now - t1) / 1000).toBeGreaterThanOrEqual(55);
  });

  it('a move with a switch-over delay finishes within its budget: the budget counts from approval, the copier aims at 80 % of it', async () => {
    const files: Record<string, string> = {};
    const chunks: FakeChunk[] = [];
    for (const d of [16, 17, 18, 19, 20]) {
      const p = `stills/cam9/2026/10/${d}/1200.pack`;
      files[p] = 'p'.repeat(30_000);
      chunks.push({ id: `stills:${day(d)}`, files: [p] });
    }
    const f = fakeSource(files, chunks);
    // Approved at APPROVED, the copy starts 60 s later (the switch-over); a budget of 300 s from approval, no probe.
    const u = unit(f, { probeBps: 0, budgetS: 300 }, { deps: { bucket: undefined, sleep: async (ms) => void (u.state.now += ms) } });
    expect(u.state.now - APPROVED).toBe(60_000);
    await u.run();
    expect(u.rec().phase).toBe('copied');
    const tookS = (u.state.now - APPROVED) / 1000;
    expect(tookS).toBeLessThanOrEqual(300);
    // Paced, not at full speed: about 80 % of the budget (240 s from approval).
    expect(tookS).toBeGreaterThanOrEqual(200);
    expect(tookS).toBeLessThanOrEqual(250);
    expect(u.audits.filter((a) => a.action === 'move-budget-exceeded')).toHaveLength(0);
  });

  it('fit counts Archive first: an old Archive chunk is copied, the newest stills day skipped', async () => {
    const { files, chunks } = threeDays();
    files['archive/cam9/5/clip.mp4'] = 'archived-long-ago';
    chunks.push({ id: `archive:${day(1)}`, files: ['archive/cam9/5/clip.mp4'] });
    const f = fakeSource(files, chunks);
    const u = unit(f, { plan: { ...PLAN, kinds: ['archive', 'clips', 'stills'] as MoveKind[], space: 'fit' } });
    // Room for the Archive item and one clips day, nothing more.
    const room = files['archive/cam9/5/clip.mp4'].length + files['clips/cam9/2026/10/20/1200-1.mp4'].length + 2;
    u.deps.space.freeBytes = () => room - Object.keys(files).filter((p) => existsSync(join(u.dataDir, p))).reduce((n, p) => n + files[p].length, 0);
    await u.run();
    const st = chunkStates(u);
    expect(st[`archive:${day(1)}`]).toBe('verified');
    expect(st[`clips:${day(20)}`]).toBe('verified');
    expect(st[`stills:${day(20)}`]).toBe('skipped');
  });

  it('plan.kinds limits what is copied; space fit stops when the target is full', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const u = unit(f, { plan: { ...PLAN, kinds: ['clips', 'stills'] as MoveKind[], space: 'fit' } });
    // Room for about one day: the older chunks are skipped, newest first.
    const perDay = files['clips/cam9/2026/10/20/1200-1.mp4'].length + files['stills/cam9/2026/10/20/1200.pack'].length;
    u.state.free = perDay + 2;
    u.deps.space.freeBytes = () => u.state.free - Object.keys(files).filter((p) => existsSync(join(u.dataDir, p))).reduce((n, p) => n + files[p].length, 0);
    await u.run();
    const st = chunkStates(u);
    expect(st[`events:${day(20)}`]).toBe('skipped');
    expect(st[`clips:${day(20)}`]).toBe('verified');
    expect(st[`stills:${day(20)}`]).toBe('verified');
    for (const d of [18, 19]) {
      expect(st[`clips:${day(d)}`]).toBe('skipped');
      expect(st[`stills:${day(d)}`]).toBe('skipped');
    }
    expect(fileRequests(f)).toEqual(['clips/cam9/2026/10/20/1200-1.mp4', 'stills/cam9/2026/10/20/1200.pack']);
  });

  it('the switch-over day is fetched again once the source listed it anew (P12)', async () => {
    const files: Record<string, string> = { 'stills/cam9/2026/10/21/0700.pack': 'before' };
    const chunks: FakeChunk[] = [{ id: `stills:${day(21)}`, files: ['stills/cam9/2026/10/21/0700.pack'] }];
    const f = fakeSource(files, chunks);
    f.refreshed = false;
    const u = unit(f, {}, { deps: { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), timing: { retryMs: 1, retryCapMs: 2, pausedPollMs: 2, refreshPollMs: 2, refreshWaitMs: 10_000, saveEveryMs: 0 } } });
    const running = u.run();
    await new Promise((r) => setTimeout(r, 15));
    // The source releases the camera: what it stored in the overlap is listed.
    files['stills/cam9/2026/10/21/0805.pack'] = 'overlap';
    chunks[0].files.push('stills/cam9/2026/10/21/0805.pack');
    f.refreshed = true;
    await running;
    expect(readFileSync(join(u.dataDir, 'stills/cam9/2026/10/21/0805.pack'), 'utf8')).toBe('overlap');
    expect(fileRequests(f).filter((p) => p.endsWith('0700.pack'))).toHaveLength(1);
    expect(chunkStates(u)[`stills:${day(21)}`]).toBe('verified');
  });

  it('never overwrites a file the target stored itself (still packs by file name)', async () => {
    const files: Record<string, string> = { 'stills/cam9/2026/10/20/1200.pack': 'from-source' };
    const f = fakeSource(files, [{ id: `stills:${day(20)}`, files: ['stills/cam9/2026/10/20/1200.pack'] }]);
    const u = unit(f);
    mkdirSync(join(u.dataDir, 'stills/cam9/2026/10/20'), { recursive: true });
    writeFileSync(join(u.dataDir, 'stills/cam9/2026/10/20/1200.pack'), 'target-own');
    await u.run();
    expect(readFileSync(join(u.dataDir, 'stills/cam9/2026/10/20/1200.pack'), 'utf8')).toBe('target-own');
    expect(u.rec().chunks[`stills:${day(20)}`]).toMatchObject({ state: 'verified', s: 1 });
    expect(parts(u.dataDir)).toEqual([]);
  });

  it('refuses manifest paths outside the camera folders', async () => {
    const files: Record<string, string> = { '../escape.bin': 'x', 'stills/cam4/2026/10/20/1200.pack': 'y' };
    const f = fakeSource(files, [{ id: `stills:${day(20)}`, files: ['../escape.bin', 'stills/cam4/2026/10/20/1200.pack'] }]);
    const u = unit(f);
    await u.run();
    expect(fileRequests(f)).toEqual([]);
    expect(chunkStates(u)[`stills:${day(20)}`]).toBe('failed');
  });

  it('no transfer: copied at once', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const u = unit(f, { plan: { ...PLAN, transfer: false } });
    await u.run();
    expect(f.requests).toEqual([]);
    expect(u.phases).toMatchObject([{ phase: 'copied', extra: { counts: { verified: 0, skipped: 0, failed: 0, bytes: 0 } } }]);
  });
});

describe('CopyRunner and MoveTarget.stop', () => {
  it('startCopy is idempotent and stop ends the copier', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    let clients = 0;
    const u = unit(f, {}, { deps: { client: () => (clients++, f.client), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) } });
    u.state.paused = true;
    const runner = new CopyRunner(u.deps);
    runner.start(MOVE);
    runner.start(MOVE);
    await new Promise((r) => setTimeout(r, 20));
    expect(clients).toBe(1);
    expect(runner.running(MOVE)).toBe(true);
    await runner.stop(MOVE);
    expect(runner.running(MOVE)).toBe(false);
    expect(u.phases).toEqual([]);
    // Started again later (a resent move.start): runs to the end.
    u.state.paused = false;
    runner.start(MOVE);
    await runner.idle(MOVE);
    expect(u.phases).toHaveLength(1);
    // A move not copying is not started.
    runner.start(MOVE);
    expect(runner.running(MOVE)).toBe(false);
  });

  it('stopAll waits at most its cap for a copier that ignores the abort (step 4 Task 11)', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    // A request in flight that never ends and does not listen to the abort.
    const hang = { get: () => new Promise<never>(() => undefined) };
    const u = unit(f, {}, { deps: { client: () => hang as never } });
    const runner = new CopyRunner(u.deps);
    runner.start(MOVE);
    await new Promise((r) => setTimeout(r, 20));
    expect(runner.running(MOVE)).toBe(true);
    const t0 = Date.now();
    await runner.stopAll(50);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('MoveTarget.stop stops the copier too', async () => {
    const stopped: string[] = [];
    const t = new MoveTarget({ journal: { load: () => null, save: () => undefined, active: () => [] }, stopCopy: async (id: string) => void stopped.push(id) } as unknown as TargetDeps);
    await t.stop(MOVE);
    expect(stopped).toEqual([MOVE]);
  });
});

describe('temporary files', () => {
  it('are not content for storage nor for the inventory, and removeMoveParts clears them', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-parts-'));
    const put = (rel: string, c: string) => {
      mkdirSync(dirname(join(dataDir, rel)), { recursive: true });
      writeFileSync(join(dataDir, rel), c);
    };
    put('stills/cam9/2026/10/20/1200.pack', 'pack');
    put(`stills/cam9/2026/10/20/1201.pack.move-${MOVE}.part`, 'partial');
    put(`clips/cam9/2026/10/20/1200-1.mp4.move-${MOVE}.part`, 'partial');
    put(`move-staging/${MOVE}/analytics/cam9/7.jpg`, 'staged');
    const storage = new Storage({ catalog: { sizeBytes: () => 0 } as unknown as Catalog, log: {} as StreamLog, config: () => ({ server: { dataDir }, recordings: {} }) as unknown as Config });
    storage.recount();
    expect(storage.usageByCamera()[CAM].stills).toEqual({ bytes: 4, files: 1 });
    expect(storage.usageByCamera()[CAM].clips).toEqual({ bytes: 0, files: 0 });
    const catalog = openCatalog(join(dataDir, 'catalog.db'));
    expect(listChunks({ catalog, dataDir }, CAM, ['stills'])).toEqual([{ id: `stills:${day(20)}`, kind: 'stills', day: day(20), files: 1, bytes: 4, rows: 0 }]);
    removeMoveParts(dataDir, MOVE, CAM);
    expect(parts(dataDir)).toEqual([]);
    expect(existsSync(join(dataDir, 'move-staging', MOVE))).toBe(false);
    expect(existsSync(join(dataDir, 'stills/cam9/2026/10/20/1200.pack'))).toBe(true);
  });
});

// The fake source behind a real socket (the default HTTP client).
async function serve(fake: Fake): Promise<string> {
  const server = createServer((req, res) => {
    void (async () => {
      const a = await fake.client.get(req.url ?? '', new AbortController().signal);
      res.statusCode = a.status;
      try {
        for await (const b of a.body) res.write(b);
      } catch {
        res.destroy();
        return;
      }
      res.end();
    })();
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const peerAt = (url: string) => ({ proxyId: 'prx_1123456789ABCDEFGHJK', name: 'een', url, caFingerprints: [], tlsServername: 'proxy.s.internal', ip: '127.0.0.1' });
const REAL = { timing: { retryMs: 1, retryCapMs: 2, pausedPollMs: 2, refreshPollMs: 2, refreshWaitMs: 50, saveEveryMs: 0, idleMs: 200 } };

describe('Copier fix round 1', () => {
  it('a slow rate does not trip the idle timeout (a real socket)', async () => {
    const rel = 'stills/cam9/2026/10/20/1200.pack';
    const content = 's'.repeat(3 * 1024 * 1024);
    const f = fakeSource({ [rel]: content }, [{ id: `stills:${day(20)}`, files: [rel] }]);
    // The budget is long over: the rate is the probe, 2 MB/s. The file is larger than the socket buffers, so the
    // socket stays silent while the bucket holds a 64 kB read back (~32 ms), longer than the 20 ms idle window.
    const u = unit(f, { peer: peerAt(await serve(f)), probeBps: 2 * 1024 * 1024, budgetS: 1, copyStartedAt: 1, budgetExceeded: true }, { deps: { client: undefined, bucket: undefined, sleep: undefined, now: undefined, timing: { ...REAL.timing, idleMs: 20 } } });
    await u.run();
    expect(chunkStates(u)[`stills:${day(20)}`]).toBe('verified');
    expect(fileRequests(f)).toEqual([rel]);
    expect(readFileSync(join(u.dataDir, rel), 'utf8')).toBe(content);
  }, 20_000);

  it('a stream cut again and again is retried, not failed (only a mismatch counts)', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const rel = 'clips/cam9/2026/10/20/1200-1.mp4';
    f.cut.set(rel, 5);
    const u = unit(f);
    await u.run();
    expect(fileRequests(f).filter((p) => p === rel)).toHaveLength(6);
    expect(chunkStates(u)[`clips:${day(20)}`]).toBe('verified');
  });

  it('404 not_listed (the source re-listed the day): the chunk manifest is fetched again, every file ends verified', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    let once = false;
    f.onFile = () => void (!once && (once = true) && (f.unlisted = true));
    const u = unit(f);
    await u.run();
    expect(Object.values(chunkStates(u)).every((s) => s === 'verified')).toBe(true);
    expect(u.phases[0].extra).toMatchObject({ counts: { verified: 7, skipped: 0, failed: 0 } });
  });

  it('rows answering 404 or not a list are asked for again: never verified without its rows', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    f.rowsFail = 3;
    const u = unit(f);
    await u.run();
    expect((u.catalog.db.prepare('SELECT COUNT(*) AS n FROM clips WHERE cam = ?').get(CAM) as { n: number }).n).toBe(3);
    expect((u.catalog.db.prepare('SELECT COUNT(*) AS n FROM analyses').get() as { n: number }).n).toBe(1);
    expect(Object.values(chunkStates(u)).every((s) => s === 'verified')).toBe(true);
  });

  it('an import error is retried in the same run; one that persists fails the chunk, audited, its staging removed', async () => {
    const failingDb = (db: Catalog['db'], times: number) => {
      let left = times;
      return new Proxy(db, {
        get: (t, p) => (p === 'exec' ? (sql: string) => { if (sql === 'COMMIT' && left-- > 0) throw new Error('disk I/O error'); return t.exec(sql); } : typeof (t as any)[p] === 'function' ? (t as any)[p].bind(t) : (t as any)[p]),
      });
    };
    // Once: the retry imports it.
    {
      const { files, chunks } = threeDays();
      const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-copier-'));
      const real = openCatalog(join(dataDir, 'catalog.db'));
      new MoveJournal(join(dataDir, 'admin', 'moves')).save(record());
      const u = unit(fakeSource(files, chunks), {}, { dataDir, deps: { catalog: { db: failingDb(real.db, 1) } } });
      await u.run();
      expect(Object.values(chunkStates(u)).every((st) => st === 'verified')).toBe(true);
      expect((real.db.prepare('SELECT COUNT(*) AS n FROM clips').get() as { n: number }).n).toBe(3);
    }
    // Always (a full disk under the catalog, say): every chunk fails, audited, nothing left staged.
    const { files, chunks } = threeDays();
    const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-copier-'));
    const real = openCatalog(join(dataDir, 'catalog.db'));
    new MoveJournal(join(dataDir, 'admin', 'moves')).save(record());
    const u = unit(fakeSource(files, chunks), {}, { dataDir, deps: { catalog: { db: failingDb(real.db, 1e9) } } });
    await u.run();
    expect(chunkStates(u)[`events:${day(20)}`]).toBe('failed');
    expect(chunkStates(u)[`clips:${day(20)}`]).toBe('failed');
    expect(existsSync(join(dataDir, 'move-staging', MOVE))).toBe(false);
    const rec = u.audits.find((a) => a.action === 'move-file-failed' && a.details?.chunk === `events:${day(20)}`);
    expect(rec).toMatchObject({ outcome: 'failure', details: { import: 'failed' } });
    expect(rec!.message).toContain('could not be imported');
    // The phase is copied (not forced), the counts include the failed imports.
    expect(u.phases).toHaveLength(1);
    expect((u.phases[0].extra as { counts: { failed: number } }).counts.failed).toBe(7);
  });

  it('stop() returns promptly in the middle of a slow take', async () => {
    const rel = 'stills/cam9/2026/10/20/1200.pack';
    const f = fakeSource({ [rel]: 'z'.repeat(1000) }, [{ id: `stills:${day(20)}`, files: [rel] }]);
    // 10 B/s: the bucket would hold the second half back for about 49 s.
    const u = unit(f, { probeBps: 10, budgetS: 1, copyStartedAt: 1, budgetExceeded: true }, { deps: { bucket: undefined, sleep: undefined, now: undefined } });
    const runner = new CopyRunner(u.deps);
    runner.start(MOVE);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await runner.stop(MOVE);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(parts(u.dataDir)).toEqual([]);
  }, 5000);

  it('audits move-source-unreachable at the first failure and every 6 h', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const u = unit(f);
    // The source gives no answer for 13 hours (one try an hour here).
    f.down = 13;
    f.onDown = () => void (u.state.now += 3_600_000);
    await u.run();
    const recs = u.audits.filter((a) => a.action === 'move-source-unreachable');
    expect(recs).toHaveLength(3);
    expect(recs[0]).toMatchObject({ outcome: 'failure', details: { moveId: MOVE, camera: CAM, failures: 1 } });
    expect(recs[1].details).toMatchObject({ failures: 7 });
    expect(recs[2].details).toMatchObject({ failures: 13 });
    expect(Object.values(chunkStates(u)).every((s) => s === 'verified')).toBe(true);
  });
});

describe('Copier fix round 2', () => {
  it('503 busy is pressure only: no move-source-unreachable records, the rate halves', async () => {
    const files: Record<string, string> = {};
    const chunks: FakeChunk[] = [];
    for (let d = 1; d <= 9; d++) {
      const p = `stills/cam9/2026/10/0${d}/1200.pack`;
      files[p] = 'b'.repeat(100);
      chunks.push({ id: `stills:${day(d)}`, files: [p] });
    }
    const f = fakeSource(files, chunks);
    f.busyEveryOther = true;
    const u = unit(f, { probeBps: 1000, budgetS: 1, copyStartedAt: 1, budgetExceeded: true });
    await u.run();
    expect(f.requests.length).toBeGreaterThan(20);
    expect(u.audits.filter((a) => a.action === 'move-source-unreachable')).toEqual([]);
    expect(Object.values(chunkStates(u)).every((st) => st === 'verified')).toBe(true);
    const rates = (u.events.filter((e) => e.kind === 'move.progress') as Extract<MoveEvent, { kind: 'move.progress' }>[]).map((p) => p.rateBps);
    expect(rates).toContain(500);
  });

  it('rows answering unknown_chunk: the chunk is listed again, then the source is reported, and the rows still come', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    f.rowsUnknown = 6;
    const u = unit(f);
    await u.run();
    const listings = f.requests.filter((r) => r === `/api/moves/${MOVE}/chunks/${encodeURIComponent(`clips:${day(20)}`)}`);
    // 4 by the copy, 1 by the completeness check.
    expect(listings).toHaveLength(5);
    expect(u.audits.filter((a) => a.action === 'move-source-unreachable')).toHaveLength(1);
    expect((u.catalog.db.prepare('SELECT COUNT(*) AS n FROM clips').get() as { n: number }).n).toBe(3);
    expect(Object.values(chunkStates(u)).every((st) => st === 'verified')).toBe(true);
  });

  it('a file that stays not_listed after 3 listings counts as a failure (3 of them fail it)', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const rel = 'clips/cam9/2026/10/19/1200-1.mp4';
    f.neverListed.add(rel);
    const u = unit(f);
    await u.run();
    expect(chunkStates(u)[`clips:${day(19)}`]).toBe('failed');
    expect(u.rec().chunks[`clips:${day(19)}`]).toMatchObject({ f: 1 });
    expect(fileRequests(f).filter((p) => p === rel).length).toBeLessThanOrEqual(7);
  });
});

// ---- Part 2: the real source endpoints over HTTP ----

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe('Copier against the real source endpoints', () => {
  it('copies a camera from movesSourceApi over HTTP', async () => {
    // The source.
    const src = mkdtempSync(join(tmpdir(), 'camproxy-copysrc-'));
    const srcCatalog = openCatalog(join(src, 'catalog.db'));
    const put = (rel: string, c: string) => {
      mkdirSync(dirname(join(src, rel)), { recursive: true });
      writeFileSync(join(src, rel), c);
    };
    put('stills/cam9/2026/10/20/1200.pack', 'pack-20');
    put('previews/cam9/2026/10/20/1200.jpg', 'sprite');
    put('clips/cam9/2026/10/19/1200-1.mp4', 'clip-19');
    srcCatalog.db.prepare("INSERT INTO clips (cam, start_ts, path, stream, size, received_at) VALUES ('cam9', ?, ?, 'sub', 7, 1)").run(ts(19), join(src, 'clips/cam9/2026/10/19/1200-1.mp4'));
    const ev = srcCatalog.db.prepare("INSERT INTO events (cam, source, kind, start_ts) VALUES ('cam9', 'onvif', 'person', ?) RETURNING id").get(ts(20, 9)) as { id: number };
    put(`analytics/cam9/${ev.id}.jpg`, 'vision');
    srcCatalog.db.prepare("INSERT INTO analyses (event_id, provider, status, image, requested_at, objects) VALUES (?, 'google-vision', 'ok', ?, 1, '[]')").run(ev.id, join(src, `analytics/cam9/${ev.id}.jpg`));
    const inventory = { catalog: srcCatalog, dataDir: src };
    const srcJournal = new MoveJournal(join(src, 'admin', 'moves'));
    srcJournal.save({
      v: 1, id: MOVE, role: 'source', camera: CAM, phase: 'released', plan: PLAN,
      peer: { proxyId: 'prx_2123456789ABCDEFGHJK', name: 'mini', ip: '127.0.0.1' },
      tokenHash: hashMoveToken(TOKEN), manifest: listChunks(inventory, CAM, PLAN.kinds), manifestRefreshedAt: 1,
      chunks: {}, bytesDone: 0, startedAt: 1, approvedAt: APPROVED,
    });
    const app = express();
    app.use('/api', movesSourceApi({ journal: srcJournal, audit: new AuditLog({ dir: join(src, 'audit'), version: 'test' }), inventory, busy: () => false, password: () => 'unused' }));
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;

    // The target, with the default (HTTP) client.
    const fake = fakeSource({}, []);
    const u = unit(fake, { peer: { proxyId: 'prx_1123456789ABCDEFGHJK', name: 'een', url: `http://127.0.0.1:${port}`, caFingerprints: [], tlsServername: 'proxy.s.internal', ip: '127.0.0.1' } }, { deps: { client: undefined } });
    await u.run();
    expect(Object.values(chunkStates(u)).every((s) => s === 'verified')).toBe(true);
    for (const rel of ['stills/cam9/2026/10/20/1200.pack', 'previews/cam9/2026/10/20/1200.jpg', 'clips/cam9/2026/10/19/1200-1.mp4']) {
      expect(readFileSync(join(u.dataDir, rel), 'utf8')).toBe(readFileSync(join(src, rel), 'utf8'));
    }
    const an = u.catalog.db.prepare('SELECT a.image, e.id FROM analyses a JOIN events e ON e.id = a.event_id WHERE e.cam = ?').get(CAM) as { image: string; id: number };
    expect(an.image).toBe(join(u.dataDir, 'analytics', CAM, `${an.id}.jpg`));
    expect(readFileSync(an.image, 'utf8')).toBe('vision');
    expect((u.catalog.db.prepare('SELECT path FROM clips WHERE cam = ?').get(CAM) as { path: string }).path).toBe(join(u.dataDir, 'clips/cam9/2026/10/19/1200-1.mp4'));
    expect(u.phases).toHaveLength(1);
    expect(parts(u.dataDir)).toEqual([]);
    expect(existsSync(join(u.dataDir, 'move-staging', MOVE))).toBe(false);
  });
});

// Task 10 fix round 1: a cancel with copied `delete` removes what the move
// brought, never what the target captured itself after the switch-over.
describe('what a move imported', () => {
  const count = (u: Unit, sql: string) => (u.catalog.db.prepare(sql).get(CAM) as { n: number }).n;
  it("a reused rowid is the target's own row: the delete-cancel keeps it (final review 3)", async () => {
    const { files, chunks } = threeDays();
    const u = unit(fakeSource(files, chunks));
    await u.run();
    // The target's retention deletes the newest imported clip; SQLite gives its id to the target's next clip.
    const top = u.catalog.db.prepare('SELECT id, path FROM clips WHERE cam = ? ORDER BY id DESC LIMIT 1').get(CAM) as { id: number; path: string };
    u.catalog.db.prepare('DELETE FROM clips WHERE id = ?').run(top.id);
    rmSync(top.path, { force: true });
    const ownClip = join(u.dataDir, 'clips/cam9/2026/10/21/0930-1.mp4');
    mkdirSync(dirname(ownClip), { recursive: true });
    writeFileSync(ownClip, 'own-clip');
    u.catalog.db.prepare("INSERT INTO clips (id, cam, start_ts, path, stream, size, received_at) VALUES (?, ?, ?, ?, 'sub', 8, 1)").run(top.id, CAM, ts(21, 9) + 30 * 60_000, ownClip);
    removeImported({ catalog: u.catalog, dataDir: u.dataDir, storage: { recount: () => undefined } }, u.rec());
    expect(u.catalog.db.prepare('SELECT id, start_ts FROM clips WHERE cam = ?').all(CAM)).toEqual([{ id: top.id, start_ts: ts(21, 9) + 30 * 60_000 }]);
    expect(readFileSync(ownClip, 'utf8')).toBe('own-clip');
  });

  it('the journal record stays small as chunks complete: the import maps and verified lists live in per-chunk files (final review 6)', async () => {
    const files: Record<string, string> = {};
    const list: FakeChunk[] = [];
    for (const d of [18, 19, 20]) {
      const paths: string[] = [];
      const rowsOf: ReturnType<typeof clipRow>[] = [];
      for (let i = 0; i < 150; i++) {
        const p = `clips/cam9/2026/10/${d}/${String(1000 + i).padStart(4, '0')}-1.mp4`;
        files[p] = `clip-${d}-${i}`;
        paths.push(p);
        rowsOf.push(clipRow(1000 * d + i, ts(d) + i * 60_000, p));
      }
      list.push({ id: `clips:${day(d)}`, files: paths, rows: [{ table: 'clips', rows: rowsOf }] });
    }
    const u = unit(fakeSource(files, list));
    const sizes: number[] = [];
    const save = u.journal.save.bind(u.journal);
    u.deps.journal = { load: (id) => u.journal.load(id), save: (r) => (save(r), sizes.push(readFileSync(join(u.dataDir, 'admin', 'moves', `${MOVE}.json`)).length)) };
    await u.run();
    expect(count(u, 'SELECT COUNT(*) AS n FROM clips WHERE cam = ?')).toBe(450);
    const text = readFileSync(join(u.dataDir, 'admin', 'moves', `${MOVE}.json`), 'utf8');
    expect(text).not.toContain('imported');
    expect(text).not.toContain('"vf"');
    // Compact JSON, and no larger with 450 rows than a record of a few chunks needs.
    expect(text).not.toContain('\n  ');
    expect(Math.max(...sizes)).toBeLessThan(4096);
    // The maps beside it (600 in a 700 folder), per chunk.
    const dir = chunkPartsDir(u.dataDir, MOVE);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    expect(readChunkPart(u.dataDir, MOVE, `clips:${day(19)}`)!.imported!.clips).toHaveLength(150);
    // A delete-cancel still finds every imported row.
    removeImported({ catalog: u.catalog, dataDir: u.dataDir, storage: { recount: () => undefined } }, u.rec());
    expect(count(u, 'SELECT COUNT(*) AS n FROM clips WHERE cam = ?')).toBe(0);
  });
  it("a delete-cancel removes only the imported rows and files; the target's own capture stays", async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const u = unit(f);
    // The target's own capture since the switch-over: the overlap minute's pack (same name as the source's), another minute, a clip, an event.
    const own = (rel: string, body: string) => {
      mkdirSync(dirname(join(u.dataDir, rel)), { recursive: true });
      writeFileSync(join(u.dataDir, rel), body);
      return join(u.dataDir, rel);
    };
    own('stills/cam9/2026/10/20/1200.pack', 'target-own');
    own('stills/cam9/2026/10/21/0900.pack', 'target-own-2');
    const ownClip = own('clips/cam9/2026/10/21/0900-1.mp4', 'own-clip');
    u.catalog.db.prepare("INSERT INTO clips (cam, start_ts, path, stream, size, received_at) VALUES (?, ?, ?, 'sub', 8, 1)").run(CAM, ts(21, 9), ownClip);
    u.catalog.db.prepare("INSERT INTO events (cam, source, kind, start_ts) VALUES (?, 'onvif', 'person', ?)").run(CAM, ts(21, 9));
    await u.run();
    // The files it landed at their own paths, never one the target stored itself.
    const landed = landedFiles(u.dataDir, MOVE);
    expect([...landed].sort()).toEqual(['clips/cam9/2026/10/18/1200-1.mp4', 'clips/cam9/2026/10/19/1200-1.mp4', 'clips/cam9/2026/10/20/1200-1.mp4', 'stills/cam9/2026/10/18/1200.pack', 'stills/cam9/2026/10/19/1200.pack']);
    expect(count(u, 'SELECT COUNT(*) AS n FROM clips WHERE cam = ?')).toBe(4);
    expect(count(u, 'SELECT COUNT(*) AS n FROM events WHERE cam = ?')).toBe(2);
    const imported = u.catalog.db.prepare('SELECT a.image FROM analyses a JOIN events e ON e.id = a.event_id WHERE e.cam = ?').get(CAM) as { image: string };
    expect(existsSync(imported.image)).toBe(true);

    const r = removeImported({ catalog: u.catalog, dataDir: u.dataDir, storage: { recount: () => undefined } }, u.rec());
    expect(r.deleted).toEqual({
      stills: { files: 2, bytes: files['stills/cam9/2026/10/18/1200.pack'].length + files['stills/cam9/2026/10/19/1200.pack'].length },
      clips: { files: 3, bytes: [18, 19, 20].reduce((n, d) => n + files[`clips/cam9/2026/10/${d}/1200-1.mp4`].length, 0) },
      events: { files: 1, bytes: 'analysis-image'.length },
      checks: { files: 0, bytes: 0 },
      archive: { files: 0, bytes: 0 },
    });
    // Imported: gone.
    for (const d of [18, 19, 20]) expect(existsSync(join(u.dataDir, `clips/cam9/2026/10/${d}/1200-1.mp4`))).toBe(false);
    for (const d of [18, 19]) expect(existsSync(join(u.dataDir, `stills/cam9/2026/10/${d}/1200.pack`))).toBe(false);
    expect(existsSync(imported.image)).toBe(false);
    expect(count(u, 'SELECT COUNT(*) AS n FROM analyses a JOIN events e ON e.id = a.event_id WHERE e.cam = ?')).toBe(0);
    // The target's own: all there.
    expect(readFileSync(join(u.dataDir, 'stills/cam9/2026/10/20/1200.pack'), 'utf8')).toBe('target-own');
    expect(readFileSync(join(u.dataDir, 'stills/cam9/2026/10/21/0900.pack'), 'utf8')).toBe('target-own-2');
    expect(readFileSync(ownClip, 'utf8')).toBe('own-clip');
    expect(u.catalog.db.prepare('SELECT start_ts FROM clips WHERE cam = ?').all(CAM)).toEqual([{ start_ts: ts(21, 9) }]);
    expect(u.catalog.db.prepare('SELECT start_ts FROM events WHERE cam = ?').all(CAM)).toEqual([{ start_ts: ts(21, 9) }]);
    // Twice: nothing more.
    expect(removeImported({ catalog: u.catalog, dataDir: u.dataDir, storage: { recount: () => undefined } }, u.rec()).deleted.clips).toEqual({ files: 0, bytes: 0 });
    expect(readFileSync(ownClip, 'utf8')).toBe('own-clip');
  });
});

describe('a return (step 4 Task 10: the original copies back)', () => {
  const RETURN_OF = 'mv_9123456789ABCDEFGHJK';
  const RETURN: MovePlan = { transfer: true, kinds: ['stills', 'clips', 'events', 'checks', 'archive'], space: 'all', targetSettings: null, budgetS: 3600, estimateS: 0 };

  it('waits when the next chunk does not fit: no chunk skipped, nothing evicted, no_space once, on when room appears', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const paused: boolean[] = [];
    let polls = 0;
    const u = unit(f, { returnOf: RETURN_OF, plan: RETURN }, {
      deps: {
        notePaused: (_r, p) => void paused.push(p),
        sleep: async () => {
          // Room appears after a few polls (the host's own retention made it, not the copy).
          if (++polls === 5) u.state.free = 1e12;
        },
      },
    });
    u.state.free = 0;
    await u.run();
    expect(polls).toBeGreaterThanOrEqual(5);
    expect(paused).toEqual([true, false]);
    const st = chunkStates(u);
    expect(Object.values(st).every((s) => s === 'verified')).toBe(true);
    expect(Object.keys(st)).toHaveLength(chunks.length);
    expect(u.phases.map((p) => p.phase)).toEqual(['copied']);
  });

  it('a return that fits never pauses', async () => {
    const { files, chunks } = threeDays();
    const paused: boolean[] = [];
    const u = unit(fakeSource(files, chunks), { returnOf: RETURN_OF, plan: RETURN }, { deps: { notePaused: (_r, p) => void paused.push(p) } });
    await u.run();
    expect(paused).toEqual([]);
    expect(Object.values(chunkStates(u)).every((s) => s === 'verified')).toBe(true);
  });

  it('a return over its 3600 s writes no move-budget-exceeded (and goes on, never faster)', async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    const u = unit(f, { returnOf: RETURN_OF, plan: RETURN, budgetS: 3600 });
    f.onFile = () => void (u.state.now += 1000_000);
    await u.run();
    expect(u.audits.filter((a) => a.action === 'move-budget-exceeded')).toHaveLength(0);
    expect(u.rec().budgetExceeded).toBe(true);
    expect(u.phases.map((p) => p.phase)).toEqual(['copied']);
  });

  it("a return's outcome report answered 403 (the source re-keyed) waits for the new start, never counts as refused", async () => {
    const { files, chunks } = threeDays();
    const f = fakeSource(files, chunks);
    let puts = 0;
    const empty = (async function* () {})();
    f.client.put = async () => (++puts < 3 ? { status: 403, body: empty } : { status: 204, body: empty });
    const u = unit(f, { returnOf: RETURN_OF, plan: RETURN });
    await u.run();
    expect(puts).toBe(3);
    expect(u.audits.filter((a) => a.action === 'move-outcome-refused')).toHaveLength(0);
    expect(u.rec().keep).toBeDefined();
  });
});
