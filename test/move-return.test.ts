// The copy back after a cancel after the switch-over (step 4 Task 9): the new
// proxy is the return's source and serves only what it captured itself
// (spec §1, rulings 1, 2, 7, 20; Review Focus 1 and 3).
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { openCatalog } from '../src/catalog/db';
import type { MoveReturnOpenArgs } from '../src/fleet/command-args';
import { movesSourceApi } from '../src/api/moves-api';
import { capturedMark } from '../src/moves/captured';
import { writeChunkPart } from '../src/moves/chunk-parts';
import { moveHandlers } from '../src/moves/commands';
import { MoveJournal, type MoveRecord } from '../src/moves/journal';
import { noteLanded } from '../src/moves/purge';
import { MoveReturns } from '../src/moves/returns';
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
  const deps = { journal, audit: { write: (r: unknown) => (audits.push(r as Audit), null) }, emit: (e: MoveEvent) => void events.push(e), inventory, proxyId: () => SELF, now: () => CANCEL_AT + 30 * MIN };
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
  return { dataDir, catalog, db, journal, events, audits, returns, deps, late, own, ev, ar, abs, put, clip, app, manifestPaths, captured };
}
const DAY = 86_400_000;
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
