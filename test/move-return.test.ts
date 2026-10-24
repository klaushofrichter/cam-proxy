// The copy back after a cancel after the switch-over (step 4 Task 9): the new
// proxy is the return's source and serves only what it captured itself
// (spec §1, rulings 1, 2, 7, 20; Review Focus 1 and 3).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import type { MoveReturnOpenArgs, MoveReturnStartArgs } from '../src/fleet/command-args';
import type { Loaded } from '../src/config/load';
import { CopyRunner, type CopierDeps, type SourceClient } from '../src/moves/copier';
import { movesSourceApi } from '../src/api/moves-api';
import { capturedMark } from '../src/moves/captured';
import { writeChunkPart } from '../src/moves/chunk-parts';
import { moveHandlers } from '../src/moves/commands';
import { MoveJournal, type MoveRecord } from '../src/moves/journal';
import { noteLanded } from '../src/moves/purge';
import { MoveReturns, RETURN_PLAN } from '../src/moves/returns';
import { MoveTarget, type TargetDeps } from '../src/moves/target';
import { hashMoveToken } from '../src/moves/token';
import type { MoveEvent } from '../src/moves/types';
import { strict, why } from './helpers/contract';

const CANCELLED = 'mv_0123456789ABCDEFGHJK';
const RETURN = 'mv_1123456789ABCDEFGHJK';
const ORIGINAL = 'prx_1123456789ABCDEFGHJK';
const SELF = 'prx_2123456789ABCDEFGHJK';
const T1 = 'return-token-one-'.padEnd(43, 'a');
const T2 = 'return-token-two-'.padEnd(43, 'b');
const H1 = hashMoveToken(T1);
const H2 = hashMoveToken(T2);
const MIN = 60_000;
// Day A: the original's (imported by the move); day B: the overlap and the
// new proxy's own capture; day C: after the cancel (a camera re-added under the same id).
const A = Date.UTC(2026, 9, 20, 12, 0);
const B8 = Date.UTC(2026, 9, 21, 8, 0);
const B9 = Date.UTC(2026, 9, 21, 9, 0);
const C = Date.UTC(2026, 9, 22, 10, 0);
const CANCEL_AT = Date.UTC(2026, 9, 21, 18, 0);
const IMPORTED_CLIP = 'clips/cam1/2026/10/20/1200-1.mp4';
const IMPORTED_B_CLIP = 'clips/cam1/2026/10/21/0800-1.mp4';
const OWN_CLIP = 'clips/cam1/2026/10/21/0900-1.mp4';
const RENAMED_ARCHIVE_ITEM = 'archive/cam1/1/clip.mp4';
const LANDED_STILL = 'stills/cam1/2026/10/21/0800.pack';
const OWN_STILL = 'stills/cam1/2026/10/21/0900.pack';
const LATE_STILL = 'stills/cam1/2026/10/22/1000.pack';
const LATE_CLIP = 'clips/cam1/2026/10/22/1000-1.mp4';

type Audit = { action: string; message: string; details?: Record<string, unknown> };

function fixture(o: { captured?: boolean; phase?: MoveRecord['phase']; returnPending?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-return-'));
  const catalog = openCatalog(join(dataDir, 'catalog.db'));
  const db = catalog.db;
  const journal = new MoveJournal(join(dataDir, 'admin', 'moves'));
  const abs = (rel: string) => join(dataDir, ...rel.split('/'));
  const put = (rel: string, content: string, mtime = CANCEL_AT - 60 * MIN) => {
    mkdirSync(dirname(abs(rel)), { recursive: true });
    writeFileSync(abs(rel), content);
    utimesSync(abs(rel), mtime / 1000, mtime / 1000);
  };
  const clip = (start: number, rel: string, content: string, received = start) => {
    put(rel, content);
    return Number(db.prepare("INSERT INTO clips (cam, start_ts, path, stream, size, received_at) VALUES ('cam1', ?, ?, 'sub', ?, ?)").run(start, abs(rel), content.length, received).lastInsertRowid);
  };
  // Imported by the move (rows in the import maps, files in the landed log).
  const c1 = clip(A, IMPORTED_CLIP, 'imported-a');
  const c2 = clip(B8, IMPORTED_B_CLIP, 'imported-b');
  noteLanded(dataDir, CANCELLED, IMPORTED_CLIP);
  noteLanded(dataDir, CANCELLED, IMPORTED_B_CLIP);
  put(LANDED_STILL, 'landed');
  noteLanded(dataDir, CANCELLED, LANDED_STILL);
  // An imported Archive item renamed here: its key no longer matches, it goes back.
  const ar = Number(db.prepare("INSERT INTO archive (cam, name, labels, created_at, recorded_from, recorded_to, quality, original, duration_s, bytes, files, source, thumb_from, created_by, metadata) VALUES ('cam1', 'renamed', '[]', ?, 1, 2, 'sub', 1, 1, 5, '[]', 's', 'f', 'u', '{}')").run(A).lastInsertRowid);
  put(`archive/cam1/${ar}/clip.mp4`, 'archived');
  writeChunkPart(dataDir, CANCELLED, 'clips:2026-10-20', { imported: { clips: [[501, c1, String(A)]] } });
  writeChunkPart(dataDir, CANCELLED, 'clips:2026-10-21', { imported: { clips: [[502, c2, String(B8)]] } });
  writeChunkPart(dataDir, CANCELLED, 'archive:2026-10-20', { imported: { archive: [[503, ar, `${A}|original name`]] } });
  // The new proxy's own capture after the switch-over: a clip, an event with its analysis, a still.
  const own = clip(B9, OWN_CLIP, 'own-clip-data', B9 + MIN);
  const ev = Number(db.prepare("INSERT INTO events (cam, source, kind, start_ts) VALUES ('cam1', 'onvif', 'person', ?)").run(B9).lastInsertRowid);
  put(`analytics/cam1/${ev}.jpg`, 'analysis');
  db.prepare("INSERT INTO analyses (event_id, provider, status, requested_at, image) VALUES (?, 'vision', 'done', ?, ?)").run(ev, B9 + MIN, abs(`analytics/cam1/${ev}.jpg`));
  put(OWN_STILL, 'own-still');
  // The high water at the cancel (Task 8).
  const captured = capturedMark(catalog, 'cam1', CANCEL_AT);
  const cancelled: MoveRecord = {
    v: 1, id: CANCELLED, role: 'target', camera: 'cam1', phase: o.phase ?? 'cancelled', plan: null,
    peer: { proxyId: ORIGINAL, name: 'Original', url: 'https://original.example.org:8443' },
    chunks: {}, bytesDone: 0, startedAt: A - DAY, switchedOver: true,
    ...(o.returnPending === false ? {} : { returnPending: true, cancelClosed: true }),
    ...(o.captured === false ? {} : { captured }),
  };
  journal.save(cancelled);
  // After the cancel: a camera re-added under the same id (Review Focus 1).
  const late = () => {
    clip(C, LATE_CLIP, 'late-clip', C);
    put(LATE_STILL, 'late-still', CANCEL_AT + 5 * MIN);
  };
  const events: MoveEvent[] = [];
  const audits: Audit[] = [];
  const inventory = { catalog, dataDir };
  const recounts: number[] = [];
  const deps = {
    journal, audit: { write: (r: unknown) => (audits.push(r as Audit), null) }, emit: (e: MoveEvent) => void events.push(e), inventory, proxyId: () => SELF, now: () => CANCEL_AT + 30 * MIN,
    storage: { recount: () => void recounts.push(1) }, retention: () => RETENTION,
  };
  const returns = new MoveReturns(deps);
  const manifestPaths = async (id: string) => {
    const r = journal.load(id)!;
    const out: string[] = [];
    for (const c of r.manifest!) {
      const res = await request(app(T1)).get(`/api/moves/${id}/chunks/${c.id}`).set('Authorization', `Bearer ${T1}`);
      out.push(...(res.body.files as { path: string }[]).map((f) => f.path));
    }
    return out;
  };
  let router: express.Express | null = null;
  const app = (_t?: string) => {
    if (!router) {
      router = express();
      router.use('/api', movesSourceApi({ journal, audit: deps.audit, inventory, busy: () => false, password: () => 'x', now: deps.now }));
    }
    return router;
  };
  return { dataDir, catalog, db, journal, events, audits, returns, deps, late, own, ev, ar, abs, put, clip, app, manifestPaths, captured, recounts };
}
const DAY = 86_400_000;
const RETENTION = { stillsDays: 3, previewsDays: 2, clipsDays: 14, eventsDays: 30 };
const open = (o: Partial<MoveReturnOpenArgs> = {}): MoveReturnOpenArgs => ({ v: 1, moveId: RETURN, returnOf: CANCELLED, tokenHash: H1, targetIp: '127.0.0.1', ...o });
const size = (s: string) => Buffer.byteLength(s);
// archive clip, own clip, analysis image, own still
const CAPTURED_BYTES = size('archived') + size('own-clip-data') + size('analysis') + size('own-still');

describe('move.return.open on the new proxy (the return source)', () => {
  it('return.open lists only what this proxy captured itself', async () => {
    const f = fixture();
    const res = f.returns.open(open());
    expect(res).toEqual({ status: 'ok', result: { chunks: 4, bytes: CAPTURED_BYTES } });
    const v = strict('commands/move.return.open.result');
    expect(v(res.result), why(v)).toBe(true);
    const r = f.journal.load(RETURN)!;
    expect(r).toMatchObject({ role: 'source', id: RETURN, returnOf: CANCELLED, camera: 'cam1', phase: 'released', tokenHash: H1, manifestRefreshedAt: CANCEL_AT + 30 * MIN, peer: { proxyId: ORIGINAL, name: 'Original', ip: '127.0.0.1' } });
    expect(r.manifest!.map((c) => c.id)).toEqual(['archive:2026-10-20', 'clips:2026-10-21', 'events:2026-10-21', 'stills:2026-10-21']);
    const paths = await f.manifestPaths(RETURN);
    expect(paths).not.toContain(IMPORTED_CLIP);
    expect(paths).not.toContain(IMPORTED_B_CLIP);
    expect(paths).not.toContain(LANDED_STILL);
    expect(paths).toContain(RENAMED_ARCHIVE_ITEM); // imported, renamed here: key differs
    expect(paths).toContain(OWN_CLIP);
    expect(paths).toContain(OWN_STILL);
    expect(paths).toContain(`analytics/cam1/${f.ev}.jpg`);
    // The cancelled record stays as it was (its import log is the filter).
    expect(f.journal.load(CANCELLED)).toMatchObject({ role: 'target', phase: 'cancelled', returnPending: true });
    expect(f.events).toEqual([{ kind: 'move.phase', moveId: RETURN, role: 'source', phase: 'released', ok: true }]);
    const a = f.audits.find((x) => x.action === 'move-return')!;
    expect(a.details).toMatchObject({ moveId: RETURN, returnOf: CANCELLED, camera: 'cam1', source: SELF, target: ORIGINAL, role: 'source', step: 'open', chunks: 4, bytes: CAPTURED_BYTES });
    expect(JSON.stringify(f.audits)).not.toContain(H1.slice(7));
    // Busy (one move at a time): the return counts as open.
    expect(f.journal.active().map((x) => x.id).sort()).toEqual([CANCELLED, RETURN]);
  });

  it('return manifest leaves out rows above the cancel high water', async () => {
    // Review Focus 1: a camera re-added under the same id after the cancel; its clip and still stay out.
    const f = fixture();
    f.late();
    expect(f.returns.open(open())).toEqual({ status: 'ok', result: { chunks: 4, bytes: CAPTURED_BYTES } });
    const paths = await f.manifestPaths(RETURN);
    expect(paths).not.toContain(LATE_CLIP);
    expect(paths).not.toContain(LATE_STILL);
    expect(f.journal.load(RETURN)!.manifest!.some((c) => c.day === '2026-10-22')).toBe(false);
  });

  it('return manifest leaves out a re-added camera\'s rows that got a reused low id (rows above the mark aged out)', async () => {
    // clips/events/analyses/still_checks have no AUTOINCREMENT: once the rows at
    // the high water are gone, a new row can get an id at or below the mark.
    const f = fixture();
    const evId = f.ev;
    f.db.prepare('DELETE FROM clips WHERE id = ?').run(f.own);
    f.db.prepare('DELETE FROM events WHERE id = ?').run(evId);
    const reused = f.clip(C, LATE_CLIP, 'late-clip', C);
    expect(reused).toBeLessThanOrEqual(f.captured.maxIds.clips!);
    const ev2 = Number(f.db.prepare("INSERT INTO events (cam, source, kind, start_ts) VALUES ('cam1', 'onvif', 'person', ?)").run(C).lastInsertRowid);
    expect(ev2).toBeLessThanOrEqual(f.captured.maxIds.events!);
    const res = f.returns.open(open());
    expect(res.status).toBe('ok');
    const r = f.journal.load(RETURN)!;
    expect(r.manifest!.map((c) => c.id)).toEqual(['archive:2026-10-20', 'stills:2026-10-21']);
    const paths = await f.manifestPaths(RETURN);
    expect(paths).not.toContain(LATE_CLIP);
  });

  it('return.open before the cancel landed answers wrong_phase', () => {
    expect(fixture({ phase: 'copied', returnPending: false }).returns.open(open())).toEqual({ status: 'failed', code: 'wrong_phase' });
    // A cancel before the switch-over (no copy back) or a record without its high water.
    expect(fixture({ returnPending: false }).returns.open(open())).toEqual({ status: 'failed', code: 'wrong_phase' });
    expect(fixture({ captured: false }).returns.open(open())).toEqual({ status: 'failed', code: 'wrong_phase' });
    const f = fixture();
    expect(f.returns.open(open({ returnOf: 'mv_9123456789ABCDEFGHJK' }))).toEqual({ status: 'failed', code: 'unknown_move' });
    // The return's id naming the cancelled move itself, or another source record: refused.
    expect(f.returns.open(open({ moveId: CANCELLED }))).toEqual({ status: 'failed', code: 'wrong_phase' });
    expect(f.journal.load(RETURN)).toBeNull();
    expect(f.events).toEqual([]);
  });

  it('return.open while the cancel has not closed yet (no cancelClosed) answers wrong_phase (Task 9 review minor 1)', () => {
    const f = fixture();
    const c = f.journal.load(CANCELLED)!;
    delete c.cancelClosed;
    f.journal.save(c);
    expect(f.returns.open(open())).toEqual({ status: 'failed', code: 'wrong_phase' });
    expect(f.journal.load(RETURN)).toBeNull();
  });

  it('a second return of the same cancelled move under another id answers wrong_phase (Task 9 review minor 4)', () => {
    const f = fixture();
    expect(f.returns.open(open()).status).toBe('ok');
    const OTHER = 'mv_2123456789ABCDEFGHJK';
    expect(f.returns.open(open({ moveId: OTHER, tokenHash: H2 }))).toEqual({ status: 'failed', code: 'wrong_phase' });
    expect(f.journal.load(OTHER)).toBeNull();
    // The first return answers as before.
    expect(f.returns.open(open()).status).toBe('ok');
  });

  it('a repeated return.open with a new tokenHash re-keys; the old token is refused', async () => {
    const f = fixture();
    const first = f.returns.open(open());
    const app = f.app();
    expect((await request(app).get(`/api/moves/${RETURN}/manifest`).set('Authorization', `Bearer ${T1}`)).status).toBe(200);
    // The same hash again (cams-admin missed the answer): the same answer, nothing changes.
    const saved = f.journal.load(RETURN)!;
    expect(f.returns.open(open())).toEqual(first);
    expect(f.journal.load(RETURN)).toEqual(saved);
    // cams-admin restarted (the plaintext token lived in memory only): a new token.
    f.late(); // the manifest is not listed again
    expect(f.returns.open(open({ tokenHash: H2 }))).toEqual(first);
    const r = f.journal.load(RETURN)!;
    expect(r.tokenHash).toBe(H2);
    expect(r.manifest).toEqual(saved.manifest);
    expect((await request(app).get(`/api/moves/${RETURN}/manifest`).set('Authorization', `Bearer ${T1}`)).status).toBe(403);
    expect((await request(app).get(`/api/moves/${RETURN}/manifest`).set('Authorization', `Bearer ${T2}`)).status).toBe(200);
    const re = f.audits.filter((x) => x.action === 'move-return');
    expect(re.map((x) => x.details!.rekeyed)).toEqual([false, false, true]);
    for (const x of re) expect(JSON.stringify(x)).not.toMatch(/sha256:/);
  });

  it('chunks and rows endpoints serve the filtered lists for a return', async () => {
    const f = fixture();
    f.returns.open(open());
    const app = f.app();
    const auth = { Authorization: `Bearer ${T1}` };
    const m = await request(app).get(`/api/moves/${RETURN}/manifest`).set(auth);
    expect(m.body).toEqual({ chunks: f.journal.load(RETURN)!.manifest, refreshed: true });
    const c = await request(app).get(`/api/moves/${RETURN}/chunks/clips:2026-10-21`).set(auth);
    expect(c.status).toBe(200);
    expect(c.body.files.map((x: { path: string }) => x.path)).toEqual([OWN_CLIP]);
    expect(c.body.rows).toBe(1);
    const rows = await request(app).get(`/api/moves/${RETURN}/chunks/clips:2026-10-21/rows`).set(auth);
    expect(rows.body).toEqual([{ table: 'clips', rows: [expect.objectContaining({ id: f.own, path: OWN_CLIP })] }]);
    const st = await request(app).get(`/api/moves/${RETURN}/chunks/stills:2026-10-21`).set(auth);
    expect(st.body.files.map((x: { path: string }) => x.path)).toEqual([OWN_STILL]);
    // An imported file is not listed, so not served either.
    expect((await request(app).get(`/api/moves/${RETURN}/file`).query({ path: IMPORTED_B_CLIP }).set(auth)).status).toBe(404);
    const own = await request(app).get(`/api/moves/${RETURN}/file`).query({ path: OWN_CLIP }).set(auth);
    expect(own.status).toBe(200);
    expect(Buffer.from(own.body as Buffer).toString()).toBe('own-clip-data');
    // A chunk of only imported content is not in the return's manifest.
    expect((await request(app).get(`/api/moves/${RETURN}/chunks/clips:2026-10-20`).set(auth)).status).toBe(404);
  });

  it('moveHandlers registers move.return.open and .start and routes a return finish to the returns side', async () => {
    const f = fixture();
    const h = moveHandlers({ emit: () => undefined, audit: { write: () => null }, returns: f.returns });
    expect(await h['move.return.open'](open(), {} as never)).toMatchObject({ status: 'ok', result: { chunks: 4 } });
    expect(typeof h['move.return.start']).toBe('function');
    let routed = 0;
    const g = moveHandlers({ emit: () => undefined, audit: { write: () => null }, returns: Object.assign(Object.create(f.returns), { finish: async () => (routed++, { status: 'ok', result: { deleted: {} } }) }) });
    await g['move.finish']({ v: 1, moveId: RETURN, role: 'source', abandoned: false, return: true }, {} as never);
    expect(routed).toBe(1);
    // Not a return: not the returns side (no source side wired here).
    expect(await g['move.finish']({ v: 1, moveId: RETURN, role: 'source', abandoned: false }, {} as never)).toEqual({ status: 'failed', code: 'internal' });
    expect(routed).toBe(1);
  });
});

// ---- the original proxy: the return's target (step 4 Task 10) ----

const SOURCE_ARG = { proxyId: SELF, name: 'New', url: 'https://new.example.org:8443', caFingerprints: [`SHA256:${'A'.repeat(64)}`], tlsServername: 'proxy.s.internal' };
const start = (o: Partial<MoveReturnStartArgs> = {}): MoveReturnStartArgs => ({ v: 1, moveId: RETURN, returnOf: CANCELLED, token: T1, source: SOURCE_ARG, done: [], ...o });

// The return source's endpoints (the new proxy's fixture) as the copier's client, with the record's token.
function clientFor(app: express.Express, token: string): SourceClient {
  const answer = (res: request.Response) => ({ status: res.status, body: (async function* () { yield Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.text ?? ''); })() });
  const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
    const parts: Buffer[] = [];
    res.on('data', (b: Buffer) => parts.push(b));
    res.on('end', () => cb(null, Buffer.concat(parts)));
  };
  return {
    get: async (path) => answer(await request(app).get(path).set('Authorization', `Bearer ${token}`).buffer(true).parse(binary as never)),
    put: async (path, body) => answer(await request(app).put(path).set('Authorization', `Bearer ${token}`).send(body as object)),
  };
}

function original(f: ReturnType<typeof fixture>, o: { free?: number; tombstone?: boolean; stoneAt?: number; runner?: Pick<CopyRunner, 'start' | 'stop'> } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-original-'));
  const catalog = openCatalog(join(dataDir, 'catalog.db'));
  const journal = new MoveJournal(join(dataDir, 'admin', 'moves'), undefined, { now: () => CANCEL_AT + 30 * MIN });
  // The cancelled move ended here with the camera back (its tombstone names it).
  if (o.tombstone !== false) journal.bury({ moveId: CANCELLED, role: 'source', phase: 'cancelled', camera: 'cam1', endedAt: o.stoneAt ?? CANCEL_AT });
  const events: MoveEvent[] = [];
  const audits: Audit[] = [];
  const audit = { write: (r: unknown) => (audits.push(r as Audit), null) };
  const emit = (e: MoveEvent) => void events.push(e);
  const state = { free: o.free ?? 1e12, clients: [] as string[] };
  const target = new MoveTarget({ journal, audit, emit, proxyId: () => ORIGINAL, retention: () => RETENTION } as unknown as TargetDeps);
  const copyDeps: CopierDeps = {
    journal, audit, emit, catalog, dataDir,
    client: (r) => (state.clients.push(r.token!), clientFor(f.app(), r.token!)),
    paused: () => false,
    space: { loaded: () => ({ config: { storage: { minFreeBytes: 0 }, stills: {}, previews: {}, ftp: {} } }) as unknown as Loaded, usage: () => ({ stills: 0, previews: 0, clips: 0, used: 0, budget: 1e15 }), freeBytes: () => state.free },
    setPhase: (r, phase, p) => target.setPhase(r, phase, p),
    notePaused: (r, paused) => target.notePaused(r, paused),
    proxyId: () => ORIGINAL,
    now: () => CANCEL_AT + 30 * MIN,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    timing: { retryMs: 1, retryCapMs: 2, pausedPollMs: 2, refreshPollMs: 2, refreshWaitMs: 10, saveEveryMs: 0 },
  };
  const runner = new CopyRunner(copyDeps);
  const copy = o.runner ?? runner;
  const returns = new MoveReturns({
    journal, audit, emit, inventory: { catalog, dataDir }, proxyId: () => ORIGINAL, now: () => CANCEL_AT + 30 * MIN,
    copy, setPhase: (r, phase, p) => target.setPhase(r, phase, p), retention: () => RETENTION,
  });
  return { dataDir, catalog, journal, events, audits, state, runner, returns, rec: () => journal.load(RETURN)! };
}

const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('move.return.start on the original proxy (the return target)', () => {
  it('start answers ok, makes a copy-only target record and copies the new proxy\'s capture back', async () => {
    const f = fixture();
    f.returns.open(open());
    const o = original(f);
    // The switch-over minute's still pack the original holds itself (P12): never overwritten.
    mkdirSync(dirname(join(o.dataDir, ...OWN_STILL.split('/'))), { recursive: true });
    writeFileSync(join(o.dataDir, ...OWN_STILL.split('/')), 'the-originals-own-pack');
    const res = await o.returns.start(start());
    expect(res).toEqual({ status: 'ok', result: {} });
    const v = strict('commands/move.return.start.result');
    expect(v(res.status === 'ok' ? res.result : null), why(v)).toBe(true);
    const r0 = o.journal.load(RETURN)!;
    expect(r0).toMatchObject({ role: 'target', id: RETURN, returnOf: CANCELLED, camera: 'cam1', plan: RETURN_PLAN, token: T1, done: [], approvedAt: CANCEL_AT + 30 * MIN, peer: { proxyId: SELF, name: 'New', url: SOURCE_ARG.url } });
    // Copy only: no switch-over step, no key pair, no leaf, no camera node written.
    for (const k of ['step', 'leaf', 'x25519', 'cameraWritten', 'passwordWritten', 'expectedLeaf'] as const) expect(r0[k], k).toBeUndefined();
    expect(RETURN_PLAN).toEqual({ transfer: true, kinds: ['stills', 'clips', 'events', 'checks', 'archive'], space: 'all', targetSettings: null, budgetS: 3600, estimateS: 0 });
    await until(() => o.rec().phase === 'copied');
    await o.runner.idle(RETURN);
    expect(existsSync(join(o.dataDir, ...OWN_CLIP.split('/')))).toBe(true);
    expect(readFileSync(join(o.dataDir, ...OWN_STILL.split('/')), 'utf8')).toBe('the-originals-own-pack');
    expect(existsSync(join(o.dataDir, ...IMPORTED_B_CLIP.split('/')))).toBe(false);
    // The imported Archive item carries the move note: from the new proxy.
    const arc = o.catalog.db.prepare("SELECT metadata FROM archive WHERE cam = 'cam1'").all() as { metadata: string }[];
    expect(arc).toHaveLength(1);
    expect(JSON.parse(arc[0].metadata).move).toMatchObject({ moveId: RETURN, from: { proxyId: SELF, name: 'New' } });
    const phases = o.events.filter((e) => e.kind === 'move.phase').map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(['copying', 'copied']);
    expect(o.events.find((e) => e.kind === 'move.phase' && e.phase === 'copied')).toMatchObject({ role: 'target', ok: true, check: { complete: true } });
    // Never the token in an event or an audit record.
    expect(JSON.stringify([o.events, o.audits])).not.toContain(T1);
    // A repeated start after copied: the same answer, nothing restarts; `copied`
    // goes out again with its check (cams-admin may have missed it, Task 11).
    const n = o.events.length;
    const copiedEvent = o.events.find((e) => e.kind === 'move.phase' && e.phase === 'copied');
    expect(await o.returns.start(start())).toEqual({ status: 'ok', result: {} });
    expect(o.rec().phase).toBe('copied');
    expect(o.events.length).toBe(n + 1);
    expect(o.events.at(-1)).toEqual({ kind: 'move.phase', moveId: RETURN, role: 'target', phase: 'copied', ok: true, check: (copiedEvent as { check: unknown }).check });
  });

  it('start without the cancelled move here (no tombstone naming the camera) answers unknown_move; another record wrong_phase', async () => {
    const f = fixture();
    const o = original(f, { tombstone: false });
    expect(await o.returns.start(start())).toEqual({ status: 'failed', code: 'unknown_move' });
    expect(o.journal.load(RETURN)).toBeNull();
    const p = original(f);
    p.journal.save({ v: 1, id: RETURN, role: 'source', camera: 'cam1', phase: 'released', plan: null, peer: { proxyId: SELF, name: 'New' }, chunks: {}, bytesDone: 0, startedAt: 1 });
    expect(await p.returns.start(start())).toEqual({ status: 'failed', code: 'wrong_phase' });
    // A cancel before the switch-over (the tombstone names no camera): nothing to copy back.
    const q = original(f, { tombstone: false });
    q.journal.bury({ moveId: CANCELLED, role: 'source', phase: 'cancelled' });
    expect(await q.returns.start(start())).toEqual({ status: 'failed', code: 'wrong_phase' });
  });

  it('a repeated start with a new token replaces r.token and restarts the copier; after a failure it copies again', async () => {
    const f = fixture();
    const calls: string[] = [];
    const runner = { start: (id: string) => void calls.push(`start ${id}`), stop: async (id: string) => void calls.push(`stop ${id}`) };
    const o = original(f, { runner: runner as never });
    expect(await o.returns.start(start())).toEqual({ status: 'ok', result: {} });
    expect(calls).toEqual([`start ${RETURN}`]);
    // The same start again (cams-admin missed the answer): the copier is not restarted.
    expect(await o.returns.start(start())).toEqual({ status: 'ok', result: {} });
    expect(calls).toEqual([`start ${RETURN}`, `start ${RETURN}`]);
    // cams-admin restarted and re-keyed the source: the new token, the copier restarted with it.
    expect(await o.returns.start(start({ token: T2, done: ['clips:2026-10-21'] }))).toEqual({ status: 'ok', result: {} });
    expect(o.rec()).toMatchObject({ token: T2, done: ['clips:2026-10-21'], phase: 'copying' });
    expect(calls.slice(2)).toEqual([`stop ${RETURN}`, `start ${RETURN}`]);
    // A failed return (the copier crashed): start again copies on with the chunk states it has.
    const r = o.rec();
    r.chunks = { 'archive:2026-10-20': { state: 'verified', v: 1, s: 0, f: 0, vb: 8, b: 8 } };
    o.journal.save(r);
    const target = new MoveTarget({ journal: o.journal, audit: { write: () => null }, emit: () => undefined } as unknown as TargetDeps);
    target.setPhase(o.rec(), 'failed', { code: 'copy_failed' });
    calls.length = 0;
    const n = o.events.length;
    expect(await o.returns.start(start({ token: T2, done: ['archive:2026-10-20'] }))).toEqual({ status: 'ok', result: {} });
    expect(o.rec()).toMatchObject({ phase: 'copying', token: T2, done: ['archive:2026-10-20'], chunks: { 'archive:2026-10-20': { state: 'verified' } } });
    expect(o.rec().failure).toBeUndefined();
    expect(calls).toEqual([`stop ${RETURN}`, `start ${RETURN}`]);
    expect(o.events.slice(n)).toEqual([{ kind: 'move.phase', moveId: RETURN, role: 'target', phase: 'copying', ok: true }]);
    expect(JSON.stringify(o.audits)).not.toContain(T2);
  });

  it('a 403 after the source was re-keyed waits for the new start, then the copy goes on with the new token', async () => {
    const f = fixture();
    f.returns.open(open());
    // cams-admin restarted: the source has a new token before the original got it.
    f.returns.open(open({ tokenHash: H2 }));
    const o = original(f);
    expect(await o.returns.start(start({ token: T1 }))).toEqual({ status: 'ok', result: {} });
    await new Promise((r) => setTimeout(r, 80));
    expect(o.rec().phase).toBe('copying');
    expect(o.events.some((e) => e.kind === 'move.phase' && e.phase === 'failed')).toBe(false);
    expect(o.audits.some((a) => a.action === 'move-source-unreachable')).toBe(true);
    expect(await o.returns.start(start({ token: T2 }))).toEqual({ status: 'ok', result: {} });
    await until(() => o.rec().phase === 'copied');
    expect(o.state.clients).toEqual([T1, T2]);
    expect(existsSync(join(o.dataDir, ...OWN_CLIP.split('/')))).toBe(true);
  });

  it('resume() restarts the copier of a return in copying after a restart (MoveTarget.resume leaves it alone)', async () => {
    const f = fixture();
    f.returns.open(open());
    const calls: string[] = [];
    const runner = { start: (id: string) => void calls.push(`start ${id}`), stop: async () => undefined };
    const o = original(f, { runner: runner as never });
    await o.returns.start(start());
    calls.length = 0;
    o.returns.resume();
    expect(calls).toEqual([`start ${RETURN}`]);
    // The switch-over runner does not take it (no camera, leaf or FTP steps).
    const ran: string[] = [];
    const t = new MoveTarget({ journal: o.journal, audit: { write: () => null }, emit: () => undefined, stageLeaf: () => undefined, startCopy: (id: string) => void ran.push(id) } as unknown as TargetDeps);
    t.resume();
    await t.idle(RETURN);
    expect(ran).toEqual([]);
    // Copied or failed: not restarted.
    const target = new MoveTarget({ journal: o.journal, audit: { write: () => null }, emit: () => undefined } as unknown as TargetDeps);
    target.setPhase(o.rec(), 'failed', { code: 'copy_failed' });
    calls.length = 0;
    o.returns.resume();
    expect(calls).toEqual([]);
  });
});

// ---- the return's end (step 4 Task 11) ----

const finishArgs = (role: 'source' | 'target', abandoned = false) => ({ v: 1 as const, moveId: RETURN, role, abandoned, return: true });
const has = (f: { dataDir: string }, rel: string) => existsSync(join(f.dataDir, ...rel.split('/')));
const count = (db: ReturnType<typeof openCatalog>["db"], sql: string, ...a: (string | number)[]) => (db.prepare(sql).get(...a) as { n: number }).n;

// The new proxy opened, the original copied it back (real copier, the new proxy's endpoints).
async function copiedBack(f: ReturnType<typeof fixture>) {
  expect(f.returns.open(open()).status).toBe('ok');
  const o = original(f);
  expect(await o.returns.start(start())).toEqual({ status: 'ok', result: {} });
  await until(() => o.rec().phase === 'copied');
  await o.runner.idle(RETURN);
  return o;
}

describe('the return\'s finish (step 4 Task 11)', () => {
  it('return finish deletes what the return verified and what the move imported', async () => {
    const f = fixture();
    const o = await copiedBack(f);
    // The original verified it all; one clip failed its checks there (the check names it: the new proxy keeps it).
    const rep = await request(f.app()).put(`/api/moves/${RETURN}/outcome`).set('Authorization', `Bearer ${T1}`).send({ keep: { 'clips:2026-10-21': [OWN_CLIP] }, copied: f.journal.load(RETURN)!.keepCopied });
    expect(rep.status).toBe(204);
    const d = await f.returns.finish(finishArgs('source'));
    expect(d.status).toBe('ok');
    expect(strict('commands/move.finish.result')(d.status === 'ok' ? d.result : null), why(strict('commands/move.finish.result'))).toBe(true);
    const res = { deleted: (d as unknown as { result: { deleted: Record<string, { files: number }> } }).result.deleted, kept: f.journal.ended(RETURN, 'source')!.kept! };
    // Captured and verified on the original: gone here.
    expect(has(f, OWN_STILL)).toBe(false);
    expect(has(f, `analytics/cam1/${f.ev}.jpg`)).toBe(false);
    expect(has(f, RENAMED_ARCHIVE_ITEM)).toBe(false);
    expect(count(f.db, 'SELECT COUNT(*) AS n FROM events WHERE id = ?', f.ev)).toBe(0);
    expect(count(f.db, 'SELECT COUNT(*) AS n FROM archive WHERE id = ?', f.ar)).toBe(0);
    // Imported by the move: gone (rows and landed files).
    for (const p of [IMPORTED_CLIP, IMPORTED_B_CLIP, LANDED_STILL]) expect(has(f, p), p).toBe(false);
    expect(count(f.db, "SELECT COUNT(*) AS n FROM clips WHERE cam = 'cam1' AND path <> ?", f.abs(OWN_CLIP))).toBe(0);
    // The failed one stays, with its row, and is named in `kept`.
    expect(has(f, OWN_CLIP)).toBe(true);
    expect(count(f.db, 'SELECT COUNT(*) AS n FROM clips WHERE id = ?', f.own)).toBe(1);
    expect(res.kept.clips.files).toBe(1);
    expect(res.deleted.stills.files).toBe(2); // own still (verified) + the landed one (imported)
    expect(res.deleted.clips.files).toBe(2); // the two imported clips
    expect(res.deleted.events.files).toBe(1);
    expect(res.deleted.archive.files).toBe(1);
    // Both records end, the proxy is no longer busy, the import log goes.
    expect(f.journal.load(RETURN)).toBeNull();
    expect(f.journal.load(CANCELLED)).toBeNull();
    expect(f.journal.active()).toEqual([]);
    expect(f.journal.ended(RETURN, 'source')).toMatchObject({ phase: 'finished', deleted: res.deleted, kept: res.kept });
    expect(f.journal.ended(CANCELLED, 'target')).toMatchObject({ phase: 'cancelled' });
    expect(existsSync(join(f.dataDir, 'admin', 'moves', `${CANCELLED}.chunks`))).toBe(false);
    expect(existsSync(join(f.dataDir, 'admin', 'moves', `${CANCELLED}.landed`))).toBe(false);
    expect(f.events.at(-1)).toEqual({ kind: 'move.phase', moveId: RETURN, role: 'source', phase: 'finished', ok: true, keepDays: 30 });
    const a = f.audits.filter((x) => x.action === 'move-return').at(-1)!;
    expect(a.details).toMatchObject({ moveId: RETURN, returnOf: CANCELLED, role: 'source', step: 'finish', abandoned: false, deleted: res.deleted, kept: res.kept });
    expect(f.recounts.length).toBeGreaterThan(0);
    // The token is refused once the return ended.
    expect((await request(f.app()).get(`/api/moves/${RETURN}/manifest`).set('Authorization', `Bearer ${T1}`)).status).toBe(403);
    // Again (cams-admin missed the answer): the same answer from the tombstone, the end reported again.
    const n = f.events.length;
    expect(await f.returns.finish(finishArgs('source'))).toEqual(d);
    expect(f.events.length).toBe(n + 1);
    expect(f.events.at(-1)).toMatchObject({ moveId: RETURN, role: 'source', phase: 'finished' });
    expect(await new MoveReturns(f.deps).finish(finishArgs('source'))).toEqual(d);

    // The original's side: its temporary files, landed log and parts go; finished with keepDays.
    const t = await o.returns.finish(finishArgs('target'));
    expect(t).toEqual({ status: 'ok', result: { deleted: expect.any(Object) } });
    expect(o.journal.load(RETURN)).toBeNull();
    expect(existsSync(join(o.dataDir, 'admin', 'moves', `${RETURN}.chunks`))).toBe(false);
    expect(existsSync(join(o.dataDir, 'admin', 'moves', `${RETURN}.landed`))).toBe(false);
    expect(existsSync(join(o.dataDir, ...OWN_STILL.split('/')))).toBe(true); // what it copied back stays
    expect(o.events.at(-1)).toEqual({ kind: 'move.phase', moveId: RETURN, role: 'target', phase: 'finished', ok: true, keepDays: 30 });
    expect(o.journal.ended(RETURN, 'target')).toMatchObject({ phase: 'finished' });
    // The cancelled move's tombstone records the copy back as done: no second return of it.
    expect(o.journal.ended(CANCELLED, 'source')).toMatchObject({ phase: 'cancelled', camera: 'cam1', returned: true });
    const m = o.events.length;
    expect(await o.returns.finish(finishArgs('target'))).toEqual(t);
    expect(o.events.length).toBe(m + 1);
    expect(await o.returns.start(start())).toEqual({ status: 'ok', result: {} });
    expect(o.journal.load(RETURN)).toBeNull();
    expect(await o.returns.start(start({ moveId: 'mv_3123456789ABCDEFGHJK' }))).toEqual({ status: 'failed', code: 'wrong_phase' });
    expect(o.audits.filter((x) => x.action === 'move-return').at(-1)!.details).toMatchObject({ role: 'target', step: 'finish', abandoned: false });
  });

  it('return finish keeps a re-added camera\'s capture', async () => {
    // Review Focus 1: a camera re-added under the same id after the cancel; its clip (id above the high water) and still stay.
    const f = fixture();
    await copiedBack(f);
    f.late();
    const lateId = Number((f.db.prepare("SELECT id FROM clips WHERE path = ?").get(f.abs(LATE_CLIP)) as { id: number }).id);
    expect(lateId).toBeGreaterThan(f.captured.maxIds.clips!);
    expect((await f.returns.finish(finishArgs('source'))).status).toBe('ok');
    expect(has(f, LATE_CLIP)).toBe(true);
    expect(has(f, LATE_STILL)).toBe(true);
    expect(count(f.db, 'SELECT COUNT(*) AS n FROM clips WHERE id = ?', lateId)).toBe(1);
    expect(has(f, OWN_CLIP)).toBe(false);
  });

  it('an abandoned return finish deletes nothing on either side', async () => {
    const f = fixture();
    const o = await copiedBack(f);
    const before = [OWN_CLIP, OWN_STILL, IMPORTED_CLIP, IMPORTED_B_CLIP, LANDED_STILL, RENAMED_ARCHIVE_ITEM, `analytics/cam1/${f.ev}.jpg`];
    const rows = count(f.db, "SELECT COUNT(*) AS n FROM clips WHERE cam = 'cam1'");
    const d = await f.returns.finish(finishArgs('source', true));
    expect(d.status).toBe('ok');
    const res = (d as unknown as { result: { deleted: Record<string, { files: number }> } }).result;
    expect(Object.values(res.deleted).every((k) => k.files === 0)).toBe(true);
    for (const p of before) expect(has(f, p), p).toBe(true);
    expect(count(f.db, "SELECT COUNT(*) AS n FROM clips WHERE cam = 'cam1'")).toBe(rows);
    expect(count(f.db, 'SELECT COUNT(*) AS n FROM events WHERE id = ?', f.ev)).toBe(1);
    // The records close: not busy any more (Give up is the exit, ruling 10/11).
    expect(f.journal.load(RETURN)).toBeNull();
    expect(f.journal.load(CANCELLED)).toBeNull();
    expect(f.journal.active()).toEqual([]);
    expect(f.audits.filter((x) => x.action === 'move-return').at(-1)!.details).toMatchObject({ step: 'finish', abandoned: true });
    // The original: what it copied stays, the record closes.
    expect((await o.returns.finish(finishArgs('target', true))).status).toBe('ok');
    expect(existsSync(join(o.dataDir, ...OWN_CLIP.split('/')))).toBe(true);
    expect(o.journal.load(RETURN)).toBeNull();
    expect(o.journal.active()).toEqual([]);
  });

  it('an abandoned return still copying on the original: the copier stops, nothing is deleted, the record closes', async () => {
    const f = fixture();
    f.returns.open(open());
    const calls: string[] = [];
    const runner = { start: (id: string) => void calls.push(`start ${id}`), stop: async (id: string) => void calls.push(`stop ${id}`) };
    const o = original(f, { runner: runner as never });
    await o.returns.start(start());
    // Not abandoned while still copying: refused.
    expect(await o.returns.finish(finishArgs('target'))).toEqual({ status: 'failed', code: 'wrong_phase' });
    expect((await o.returns.finish(finishArgs('target', true))).status).toBe('ok');
    expect(calls).toContain(`stop ${RETURN}`);
    expect(o.journal.load(RETURN)).toBeNull();
    expect(o.journal.ended(CANCELLED, 'source')).toMatchObject({ returned: true });
  });

  it('a finish without the original\'s report (no keep list) deletes none of the capture, only what the move imported', async () => {
    const f = fixture();
    f.returns.open(open());
    expect(f.journal.load(RETURN)!.keep).toBeUndefined();
    expect((await f.returns.finish(finishArgs('source'))).status).toBe('ok');
    for (const p of [OWN_CLIP, OWN_STILL, RENAMED_ARCHIVE_ITEM, `analytics/cam1/${f.ev}.jpg`]) expect(has(f, p), p).toBe(true);
    for (const p of [IMPORTED_CLIP, IMPORTED_B_CLIP, LANDED_STILL]) expect(has(f, p), p).toBe(false);
    expect(f.journal.active()).toEqual([]);
  });

  it('an imported event with an analysis made here stays with its analyses (exists nowhere else)', async () => {
    const f = fixture();
    // An event the move imported (its analysis too), and an analysis asked for here after the switch-over.
    const E = Date.UTC(2026, 9, 20, 13, 0);
    const iev = Number(f.db.prepare("INSERT INTO events (cam, source, kind, start_ts) VALUES ('cam1', 'onvif', 'person', ?)").run(E).lastInsertRowid);
    const ia = Number(f.db.prepare("INSERT INTO analyses (event_id, provider, status, requested_at, image) VALUES (?, 'vision', 'done', ?, ?)").run(iev, E, f.abs(`analytics/cam1/${iev}.jpg`)).lastInsertRowid);
    f.put(`analytics/cam1/${iev}.jpg`, 'imported-analysis');
    writeChunkPart(f.dataDir, CANCELLED, 'events:2026-10-20', { imported: { events: [[601, iev, `${E}|onvif|person`]], analyses: [[602, ia, `${iev}|vision`]] } });
    const own = Number(f.db.prepare("INSERT INTO analyses (event_id, provider, status, requested_at) VALUES (?, 'gemini', 'done', ?)").run(iev, B9).lastInsertRowid);
    await copiedBack(f);
    const d = await f.returns.finish(finishArgs('source'));
    expect(d.status).toBe('ok');
    expect(count(f.db, 'SELECT COUNT(*) AS n FROM events WHERE id = ?', iev)).toBe(1);
    expect(count(f.db, 'SELECT COUNT(*) AS n FROM analyses WHERE id IN (?, ?)', ia, own)).toBe(2);
    expect(has(f, `analytics/cam1/${iev}.jpg`)).toBe(true);
    expect(f.journal.ended(RETURN, 'source')!.kept!.events.files).toBe(1);
    // Other imported content still goes.
    expect(has(f, IMPORTED_CLIP)).toBe(false);
    // Without an analysis of its own, an imported event goes with its analyses.
    const g = fixture();
    const gev = Number(g.db.prepare("INSERT INTO events (cam, source, kind, start_ts) VALUES ('cam1', 'onvif', 'person', ?)").run(E).lastInsertRowid);
    const ga = Number(g.db.prepare("INSERT INTO analyses (event_id, provider, status, requested_at, image) VALUES (?, 'vision', 'done', ?, ?)").run(gev, E, g.abs(`analytics/cam1/${gev}.jpg`)).lastInsertRowid);
    g.put(`analytics/cam1/${gev}.jpg`, 'imported-analysis');
    writeChunkPart(g.dataDir, CANCELLED, 'events:2026-10-20', { imported: { events: [[601, gev, `${E}|onvif|person`]], analyses: [[602, ga, `${gev}|vision`]] } });
    await copiedBack(g);
    expect((await g.returns.finish(finishArgs('source'))).status).toBe('ok');
    expect(count(g.db, 'SELECT COUNT(*) AS n FROM events WHERE id = ?', gev)).toBe(0);
    expect(has(g, `analytics/cam1/${gev}.jpg`)).toBe(false);
  });

  it('a return.start more than 7 days after the cancel still finds the camera (the tombstone waits for the return)', async () => {
    const f = fixture();
    f.returns.open(open());
    const calls: string[] = [];
    const o = original(f, { stoneAt: CANCEL_AT - 9 * DAY, runner: { start: (id: string) => void calls.push(id), stop: async () => undefined } as never });
    o.journal.sweep();
    expect(o.journal.ended(CANCELLED, 'source')).toMatchObject({ camera: 'cam1' });
    expect(await o.returns.start(start())).toEqual({ status: 'ok', result: {} });
    expect(calls).toEqual([RETURN]);
  });

  it('a finish on a proxy that knows nothing of the return answers ok with nothing deleted', async () => {
    const f = fixture();
    expect(await f.returns.finish(finishArgs('source', true))).toMatchObject({ status: 'ok' });
    expect(await f.returns.finish(finishArgs('source'))).toEqual({ status: 'failed', code: 'unknown_move' });
    // The cancelled move still waits for its copy back.
    expect(f.journal.load(CANCELLED)).toMatchObject({ returnPending: true });
    const o = original(f);
    expect(await o.returns.finish(finishArgs('target', true))).toMatchObject({ status: 'ok' });
    // The roles crossed (the return's source record named as target): refused.
    f.returns.open(open());
    expect(await f.returns.finish(finishArgs('target'))).toEqual({ status: 'failed', code: 'wrong_phase' });
    expect(f.journal.load(RETURN)).not.toBeNull();
  });
});
