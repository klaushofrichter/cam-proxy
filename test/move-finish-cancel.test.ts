// The end of a camera move (camera-move plan Task 10, S §5, §10.3, §11, §12):
// move.finish and move.cancel on both sides. Part 1 drives MoveTarget and
// MoveSource with a real journal, configuration, catalog and purge and
// injected camera steps; part 2 runs two proxies over one cam-sim and gives
// the camera back after the switch-over. Documentation addresses (RFC 5737)
// and made-up tokens only; never a real camera.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArchiveStore } from '../src/archive/store';
import { AuditLog } from '../src/audit/audit-log';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { cameraPasswordStore } from '../src/config/camera-passwords';
import { deleteCameraPositions, insertPosition, listPositions } from '../src/catalog/ptz-positions';
import { chmodSync } from 'fs';
import { applyOverrides, loadConfig, planUnset, type Loaded } from '../src/config/load';
import type { MoveCancelArgs, MoveFinishArgs, MoveStartArgs } from '../src/fleet/command-args';
import { writeKeyFile } from '../src/fleet/keyfile';
import { writePrivateJson } from '../src/fleet/private-file';
import type { Envelope } from '../src/fleet/protocol';
import { setLogLevel } from '../src/log';
import { capturedMark } from '../src/moves/captured';
import { moveHandlers } from '../src/moves/commands';
import { chunkPartsDir, writeChunkPart } from '../src/moves/chunk-parts';
import { MoveJournal, type MoveRecord } from '../src/moves/journal';
import { ManifestCache, manifestCacheDir } from '../src/moves/manifest-cache';
import { landedLog, noteLanded, purgeExcept, removeImported } from '../src/moves/purge';
import type { MoveOutcome } from '../src/moves/check';
import { seal } from '../src/moves/seal';
import { keepDaysOf } from '../src/moves/retention';
import { MoveSource, type SourceDeps } from '../src/moves/source';
import { MoveLeftovers, removePasswordLine } from '../src/moves/leftovers';
import { MoveTarget, type TargetDeps } from '../src/moves/target';
import { moveTokenGuard } from '../src/moves/token-guard';
import { hashMoveToken } from '../src/moves/token';
import type { MoveEvent, MovePlan, MoveSummary } from '../src/moves/types';
import { FILE_KINDS } from '../src/moves/types';
import { minutePath } from '../src/stills/store';
import { utcDayParts, utcHhmm } from '../src/time-units';
import { Storage } from '../src/storage';
import { StreamLog } from '../src/stream/log';
import { fingerprintOf, siteCa, type SiteCa } from '../src/tls/ca';
import type { Leaf } from '../src/tls/leaf';
import type { PushResult } from '../src/tls/push';
import { servedFingerprint } from '../src/tls/served';
import { fixtures, strict, why } from './helpers/contract';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { freePort, until } from './helpers/proxy';

const MOVE = 'mv_0123456789ABCDEFGHJK';
const TOKEN = 'finish-token-'.padEnd(43, 'q');
const PASSWORD = 'moved-camera-pw';
const SOURCE_ID = 'prx_1123456789ABCDEFGHJK';
const TARGET_ID = 'prx_2123456789ABCDEFGHJK';
const TARGET_LEAF = `SHA256:${'B'.repeat(64)}`;
const OWN_LEAF = `SHA256:${'C'.repeat(64)}`;
const SECRETS = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'x' };
const kind = () => ({ files: 0, bytes: 0, rows: 0, oldest: null, newest: null });
const SUMMARY: MoveSummary = { stills: kind(), clips: kind(), events: kind(), checks: kind(), archive: kind() };
const PLAN: MovePlan = { transfer: true, kinds: [], space: 'all', targetSettings: null, budgetS: 3600, estimateS: 60 };
const ZEROS = Object.fromEntries(FILE_KINDS.map((k) => [k, { files: 0, bytes: 0 }]));
const startArgs = (): MoveStartArgs => ({ v: 1, moveId: MOVE, plan: PLAN, settings: { name: 'Garden', statusPollS: 30 }, done: [] });
const finishArgs = (role: 'source' | 'target', abandoned = false): MoveFinishArgs => ({ v: 1, moveId: MOVE, role, abandoned });
const DAY = 86_400_000;

type Audit = { action: string; outcome: string; message: string; details?: Record<string, any> };

beforeAll(() => setLogLevel('silent'));

// A file of `bytes` at `path` (folders made).
const put = (path: string, bytes = 10) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
};
// One camera's content: a still, a clip with its row, an event with its row.
function content(dataDir: string, catalog: Catalog, cam: string, ts = Date.UTC(2026, 9, 20, 12, 0)): void {
  put(`${minutePath(dataDir, 'stills', cam, ts)}.pack`, 100);
  const clip = join(dataDir, 'clips', cam, ...utcDayParts(ts), `${utcHhmm(ts)}-1.mp4`);
  put(clip, 300);
  catalog.db.prepare("INSERT INTO clips (cam, start_ts, path, stream, size, received_at) VALUES (?, ?, ?, 'sub', 300, 1)").run(cam, ts, clip);
  catalog.db.prepare("INSERT INTO events (cam, source, kind, start_ts) VALUES (?, 'onvif', 'person', ?)").run(cam, ts);
}
const rows = (catalog: Catalog, cam: string) => (catalog.db.prepare('SELECT (SELECT COUNT(*) FROM clips WHERE cam = ?) + (SELECT COUNT(*) FROM events WHERE cam = ?) AS n').get(cam, cam) as { n: number }).n;
const phasesOf = (events: MoveEvent[]) => events.filter((e) => e.kind === 'move.phase').map((e) => (e as { phase: string }).phase);

// ---- Part 1a: the target (MoveTarget) ----

let unitCa: SiteCa;
beforeAll(async () => {
  unitCa = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-end-ca-')), { site: 'u', cameraSubnet: '192.0.2.0/24', proxyAddresses: ['198.51.100.1'] });
}, 60_000);

const offered = (over: Partial<MoveRecord> = {}): MoveRecord => ({
  v: 1, id: MOVE, role: 'target', camera: 'cam9', phase: 'opened', plan: null,
  peer: { proxyId: SOURCE_ID, name: 'een', url: 'http://198.51.100.7:8480', caFingerprints: [`SHA256:${'A'.repeat(64)}`], tlsServername: 'proxy.s.internal', ip: '198.51.100.7' },
  token: TOKEN,
  cameraConnection: { proxyCameraId: 'cam9', name: 'Garden', host: '192.0.2.9', protocol: 'https', user: 'proxy', onvifPort: 8000, rtspPort: 554, baichuanPort: 9000 },
  summary: SUMMARY, settings: { name: 'Garden', statusPollS: 30 },
  chunks: {}, bytesDone: 0, startedAt: Date.now() - 60_000, ...over,
});

function targetUnit() {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-end-tgt-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ cameras: [{ id: 'cam1', host: '' }], tls: { site: 'u', cameraSubnet: '192.0.2.0/24', proxyAddresses: '198.51.100.1' } }));
  let loaded = loadConfig(SECRETS, { cwd: dir });
  const dataDir = loaded.config.server.dataDir;
  const catalog = openCatalog(join(dataDir, 'catalog.db'));
  const journal = new MoveJournal(join(dataDir, 'admin', 'moves'));
  const events: MoveEvent[] = [];
  const audits: Audit[] = [];
  const passwords = new Map<string, string>();
  const staged: (Leaf | null)[] = [];
  const forgot: string[] = [];
  const stopped: string[] = [];
  const setLoadedCalls: Loaded[] = [];
  // The outcome reports to the source (PUT /api/moves/:id/outcome), with the move.phase events seen before each.
  const outcomes: { body: MoveOutcome; phasesBefore: string[] }[] = [];
  let outcomeStatus = 204;
  const deps: TargetDeps = {
    journal,
    audit: { write: (r) => (audits.push(r as Audit), null) },
    emit: (e) => events.push(e),
    ca: () => unitCa,
    site: () => 'u',
    loaded: () => loaded,
    setLoaded: async (l) => {
      setLoadedCalls.push(l);
      loaded = l;
    },
    passwords: { set: (id, pw) => void passwords.set(id, pw) },
    stageLeaf: (_cam, l) => void staged.push(l),
    pushLeaf: async (_cam, l): Promise<PushResult> => ({ outcome: 'pushed', served: l.fingerprint, leaf: l, tookMs: 1 }),
    ftp: async () => ({ verified: true, mismatch: [] }),
    startCopy: () => undefined,
    stopCopy: async (id) => void stopped.push(id),
    proxyId: () => TARGET_ID,
    fetchSecrets: async () => ({ status: 200, sealed: seal(journal.load(MOVE)!.x25519!.publicSpki, Buffer.from(PASSWORD)) }),
    timing: { attempts: 2, retryMs: 5, retryCapMs: 20, notReadyMs: 5000, outcomeRetryMs: 5 },
    reportOutcome: async (_r, body) => {
      outcomes.push({ body, phasesBefore: phasesOf(events) });
      return outcomeStatus;
    },
    end: {
      dataDir,
      removeImported: (r) => removeImported({ catalog, dataDir, storage: { recount: () => undefined } }, r),
      captured: (cam, now) => capturedMark(catalog, cam, now),
      deletePassword: (cam) => void passwords.delete(cam),
      forgetLeaf: (cam) => void forgot.push(cam),
      deletePositions: (cam) => deleteCameraPositions(catalog, cam),
    },
  };
  const target = new MoveTarget(deps);
  return { dir, dataDir, catalog, journal, events, audits, passwords, staged, forgot, stopped, setLoadedCalls, deps, target, outcomes, setOutcomeStatus: (n: number) => void (outcomeStatus = n), get loaded() { return loaded; } };
}
type TargetUnit = ReturnType<typeof targetUnit>;

// A target move switched over and copied (the copier's end simulated).
async function copied(u: TargetUnit): Promise<void> {
  u.journal.save(offered());
  expect((await u.target.start(startArgs())).status).toBe('ok');
  await u.target.idle(MOVE);
  expect(u.journal.load(MOVE)!.phase).toBe('copying');
  const r = u.journal.load(MOVE)!;
  r.chunks = { 'clips:2026-10-20': { state: 'verified', v: 2, s: 1, f: 0, vb: 300, b: 300 }, 'stills:2026-10-20': { state: 'failed', v: 3, s: 0, f: 1, vb: 100, b: 120 } };
  r.manifest = [
    { id: 'clips:2026-10-20', kind: 'clips', day: '2026-10-20', files: 3, bytes: 300, rows: 1 },
    { id: 'stills:2026-10-20', kind: 'stills', day: '2026-10-20', files: 4, bytes: 120, rows: 0 },
    { id: 'stills:2026-10-19', kind: 'stills', day: '2026-10-19', files: 4, bytes: 120, rows: 0 },
  ];
  u.target.setPhase(r, 'copied', {});
}

const cancelT = (copiedChoice: 'delete' | 'age-out'): MoveCancelArgs => ({ v: 1, moveId: MOVE, role: 'target', copied: copiedChoice });

describe('move.finish on the target (A5/B45)', () => {
  it('stops the copier, removes its temporary files, drops the keys and closes the move; move-done audited', async () => {
    const u = targetUnit();
    await copied(u);
    const part = join(u.dataDir, 'stills', 'cam9', '2026', '10', '19', `1200.pack.move-${MOVE}.part`);
    const staged = join(u.dataDir, 'move-staging', MOVE, 'clips', 'x.mp4');
    put(part);
    put(staged);
    const n = u.events.length;
    const d = await u.target.finish(finishArgs('target'));
    expect(d.status).toBe('ok');
    const v = strict('commands/move.finish.result');
    expect(v(d.result), why(v)).toBe(true);
    expect(d.result).toEqual({ deleted: ZEROS });
    expect(u.stopped).toContain(MOVE);
    expect(existsSync(part)).toBe(false);
    expect(existsSync(join(u.dataDir, 'move-staging', MOVE))).toBe(false);
    // The record goes (with the X25519 and the leaf's private keys): no move file left.
    expect(u.journal.load(MOVE)).toBeNull();
    // ...only its tombstone (final review 4): no key, no token in it.
    expect(readdirSync(join(u.dataDir, 'admin', 'moves')).filter((f) => f.startsWith(MOVE))).toEqual([`${MOVE}.target.ended.json`]);
    const stone = readFileSync(join(u.dataDir, 'admin', 'moves', `${MOVE}.target.ended.json`), 'utf8');
    for (const secret of [TOKEN, 'PRIVATE', 'privatePkcs8', 'keyPem']) expect(stone).not.toContain(secret);
    expect(phasesOf(u.events.slice(n))).toEqual(['finished']);
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'target', phase: 'finished', ok: true });
    // The camera stays here: it is this proxy's now.
    expect(u.loaded.config.cameras.cam9).toBeDefined();
    expect(u.staged.at(-1)).toBeNull();
    const done = u.audits.find((a) => a.action === 'move-done')!;
    expect(done).toMatchObject({ outcome: 'success', details: { moveId: MOVE, camera: 'cam9', source: SOURCE_ID, target: TARGET_ID, role: 'target', abandoned: false } });
    expect(done.details!.chunks).toEqual({ total: 3, verified: 1, skipped: 0, failed: 1, abandoned: 1 });
    expect(done.details!.files).toEqual({ verified: 5, skipped: 1, failed: 1 });
    expect(done.details!.bytes).toBe(400);
    expect(typeof done.details!.durationS).toBe('number');
    for (const k of Object.keys(done.details!)) expect(k).not.toMatch(/key$|token|password|secret/i);
    // The journal's end is recorded before the removal: no event re-emitted after (B2).
    expect(u.journal.currentPhase()).toBeNull();
  }, 60_000);

  it('finish twice is a no-op with the same answer', async () => {
    const u = targetUnit();
    await copied(u);
    const a = await u.target.finish(finishArgs('target'));
    const n = [u.events.length, u.audits.length];
    const b = await u.target.finish(finishArgs('target'));
    expect(b).toEqual(a);
    // Only the terminal phase again (final review 4: cams-admin may have missed it); no audit.
    expect([u.events.length, u.audits.length]).toEqual([n[0] + 1, n[1]]);
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'target', phase: 'finished', ok: true });
  }, 60_000);

  it('after a restart: a repeated cancel re-emits cancelled, a finish answers wrong_phase with it (final review 4)', async () => {
    const u = targetUnit();
    await copied(u);
    expect((await u.target.cancel(cancelT('age-out'))).status).toBe('ok');
    // After the switch-over the record stays for the copy back (step 4 Task 8), without its keys.
    expect(u.journal.load(MOVE)).toMatchObject({ phase: 'cancelled', returnPending: true });
    expect(u.journal.load(MOVE)!.x25519).toBeUndefined();
    // The tombstone: 600, no secret.
    const stone = join(u.dataDir, 'admin', 'moves', `${MOVE}.target.ended.json`);
    expect(statSync(stone).mode & 0o777).toBe(0o600);
    expect(readFileSync(stone, 'utf8')).not.toContain(TOKEN);
    // A new process: the memory of the end is gone, the tombstone and the record are not.
    const again = new MoveTarget(u.deps);
    const n = u.audits.length;
    const want = { kind: 'move.phase', moveId: MOVE, role: 'target', phase: 'cancelled', ok: true, returnPending: true };
    expect(await again.cancel(cancelT('age-out'))).toEqual({ status: 'ok', result: {} });
    expect(u.events.at(-1)).toEqual(want);
    expect(u.journal.load(MOVE)).toMatchObject({ phase: 'cancelled', returnPending: true });
    expect(await again.finish(finishArgs('target'))).toMatchObject({ status: 'failed', code: 'wrong_phase' });
    expect(u.events.at(-1)).toEqual(want);
    expect(u.audits.length).toBe(n);
  }, 60_000);

  it('an offer never approved closes on its own after 35 minutes, audited and reported (final review 5)', async () => {
    const u = targetUnit();
    let now = Date.now();
    const t = new MoveTarget({ ...u.deps, now: () => now });
    u.journal.save(offered({ startedAt: now }));
    now += 34 * 60_000;
    t.expireOffers();
    expect(u.journal.load(MOVE)!.phase).toBe('opened');
    now += 2 * 60_000;
    t.expireOffers();
    expect(u.journal.load(MOVE)).toBeNull();
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'target', phase: 'cancelled', ok: true });
    expect(u.audits.find((a) => a.action === 'move-cancel')).toMatchObject({ outcome: 'success', details: { moveId: MOVE, role: 'target', phase: 'opened', reason: 'offer_expired', cameraEntry: 'untouched' } });
    // An approved move (a plan) never expires this way.
    const v = targetUnit();
    let later = Date.now();
    const tv = new MoveTarget({ ...v.deps, now: () => later });
    v.journal.save(offered({ startedAt: later, plan: PLAN, phase: 'switching' }));
    later += 3600_000;
    tv.expireOffers();
    expect(v.journal.load(MOVE)!.phase).toBe('switching');
    // A repeated cancel re-emits it.
    expect((await t.cancel(cancelT('delete'))).status).toBe('ok');
    expect(u.events.at(-1)).toMatchObject({ phase: 'cancelled' });
  }, 60_000);

  it('before the switch-over it is refused (the camera is not here yet); ending the transfer early is abandoned', async () => {
    const u = targetUnit();
    u.journal.save(offered());
    expect(await u.target.finish(finishArgs('target'))).toMatchObject({ status: 'failed', code: 'wrong_phase' });
    expect(u.journal.load(MOVE)!.phase).toBe('opened');
    // copying: only with abandoned (cams-admin ends the transfer early, S §10.4).
    const c = targetUnit();
    c.journal.save(offered());
    await c.target.start(startArgs());
    await c.target.idle(MOVE);
    expect(await c.target.finish(finishArgs('target'))).toMatchObject({ status: 'failed', code: 'wrong_phase' });
    expect((await c.target.finish(finishArgs('target', true))).status).toBe('ok');
    expect(c.audits.find((a) => a.action === 'move-done')!.details).toMatchObject({ abandoned: true });
  }, 60_000);

  it('an abandoned target finish reports its outcome to the source before it answers', async () => {
    const u = targetUnit();
    u.journal.save(offered());
    await u.target.start(startArgs());
    await u.target.idle(MOVE);
    const r = u.journal.load(MOVE)!;
    r.manifest = [
      { id: 'archive:2026-10-20', kind: 'archive', day: '2026-10-20', files: 2, bytes: 20, rows: 1 },
      { id: 'archive:2026-10-19', kind: 'archive', day: '2026-10-19', files: 2, bytes: 20, rows: 1 },
      { id: 'archive:2026-10-18', kind: 'archive', day: '2026-10-18', files: 2, bytes: 20, rows: 1 },
      { id: 'clips:2026-10-20', kind: 'clips', day: '2026-10-20', files: 2, bytes: 20, rows: 2 },
      { id: 'stills:2026-10-20', kind: 'stills', day: '2026-10-20', files: 2, bytes: 20, rows: 0 },
    ];
    // Archive of the 20th verified, the 19th failed (its rows imported), the 18th not reached; a clip failed its checks.
    r.chunks = {
      'archive:2026-10-20': { state: 'verified', v: 2, meta: { files: 2, bytes: 20, rows: 1 } },
      'archive:2026-10-19': { state: 'failed', v: 1, f: 1, rowsInserted: 1, meta: { files: 2, bytes: 20, rows: 1 } },
      'clips:2026-10-20': { state: 'failed', v: 1, f: 1, rowsInserted: 1, meta: { files: 2, bytes: 20, rows: 2 } },
    };
    // A report the copier left (persisted before its PUT) is part of it.
    r.keep = { 'stills:2026-10-20': ['stills/cam9/2026/10/20/1200.pack'] };
    u.journal.save(r);
    writeChunkPart(u.dataDir, MOVE, 'clips:2026-10-20', { ff: ['clips/cam9/2026/10/20/1210-1.mp4'] });
    const d = await u.target.finish(finishArgs('target', true));
    expect(d.status).toBe('ok');
    expect(u.outcomes).toHaveLength(1);
    // Before the move ended here.
    expect(u.outcomes[0].phasesBefore).not.toContain('finished');
    expect(u.outcomes[0].body.keep).toEqual({
      'archive:2026-10-19': 'all',
      'archive:2026-10-18': 'all',
      'clips:2026-10-20': ['clips/cam9/2026/10/20/1210-1.mp4'],
      'stills:2026-10-20': ['stills/cam9/2026/10/20/1200.pack'],
    });
    expect(u.outcomes[0].body.copied).toEqual({ 'archive:2026-10-20': { files: 2, bytes: 20, rows: 1 }, 'archive:2026-10-19': { files: 2, bytes: 20, rows: 1 } });
    // A source that never takes it: at most 3 tries, then the finish answers anyway.
    const v = targetUnit();
    v.setOutcomeStatus(503);
    v.journal.save(offered());
    await v.target.start(startArgs());
    await v.target.idle(MOVE);
    const w = v.journal.load(MOVE)!;
    w.manifest = [{ id: 'archive:2026-10-20', kind: 'archive', day: '2026-10-20', files: 2, bytes: 20, rows: 1 }];
    v.journal.save(w);
    expect((await v.target.finish(finishArgs('target', true))).status).toBe('ok');
    expect(v.outcomes).toHaveLength(3);
    // Refused (or never taken): audited with ids only, the source keeps every Archive item (ruling 5).
    const refused = v.audits.filter((x) => x.action === 'move-outcome-refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ outcome: 'failure', details: { moveId: MOVE, camera: 'cam9', role: 'target', status: 503 } });
    // A finish after copied (the copier reported already) sends nothing more.
    const c = targetUnit();
    await copied(c);
    expect((await c.target.finish(finishArgs('target'))).status).toBe('ok');
    expect(c.outcomes).toHaveLength(0);
  }, 60_000);

  it('cancel after finish is refused, finish after cancel too', async () => {
    const u = targetUnit();
    await copied(u);
    await u.target.finish(finishArgs('target'));
    expect(await u.target.cancel(cancelT('delete'))).toMatchObject({ status: 'failed', code: 'wrong_phase' });
    const c = targetUnit();
    c.journal.save(offered());
    expect((await c.target.cancel(cancelT('delete'))).status).toBe('ok');
    expect(await c.target.finish(finishArgs('target'))).toMatchObject({ status: 'failed', code: 'wrong_phase' });
  }, 60_000);
});

describe('move.cancel on the target', () => {
  it('a cancel after the switch-over keeps the record, import log and landed log for the copy back (returnPending); nothing deleted, even with copied delete', async () => {
    const u = targetUnit();
    await copied(u);
    const IMPORTED = Date.UTC(2026, 9, 18, 12, 0); // a day of the source's
    const OWN = Date.UTC(2026, 9, 21, 12, 0); // captured here after the switch-over
    content(u.dataDir, u.catalog, 'cam9', IMPORTED);
    content(u.dataDir, u.catalog, 'cam9', OWN);
    content(u.dataDir, u.catalog, 'cam1');
    // What the copier recorded: the files it landed at their own paths, the rows it imported.
    noteLanded(u.dataDir, MOVE, 'stills/cam9/2026/10/18/1200.pack');
    noteLanded(u.dataDir, MOVE, 'clips/cam9/2026/10/18/1200-1.mp4');
    const id = (t: string) => (u.catalog.db.prepare(`SELECT id FROM ${t} WHERE cam = 'cam9' AND start_ts = ?`).get(IMPORTED) as { id: number }).id;
    const r = u.journal.load(MOVE)!;
    r.chunks['clips:2026-10-18'] = { state: 'verified' };
    r.chunks['events:2026-10-18'] = { state: 'verified' };
    u.journal.save(r);
    // The import maps live beside the record (final review 6), with each row's natural key (final review 3).
    writeChunkPart(u.dataDir, MOVE, 'clips:2026-10-18', { imported: { clips: [[501, id('clips'), String(IMPORTED)]] } });
    writeChunkPart(u.dataDir, MOVE, 'events:2026-10-18', { imported: { events: [[502, id('events'), `${IMPORTED}|onvif|person`]] } });
    // cam1's rows came last: the high water is cam9's own, not the table's.
    const maxOf = (t: string) => (u.catalog.db.prepare(`SELECT MAX(id) AS n FROM ${t} WHERE cam = 'cam9'`).get() as { n: number }).n;
    const clipsMax = maxOf('clips');
    const eventsMax = maxOf('events');
    expect(clipsMax).toBeLessThan((u.catalog.db.prepare('SELECT MAX(id) AS n FROM clips').get() as { n: number }).n);
    expect(u.passwords.get('cam9')).toBe(PASSWORD);
    const part = join(u.dataDir, 'clips', 'cam9', '2026', '10', '19', `x.mp4.move-${MOVE}.part`);
    put(part);
    const before = Date.now();
    const d = await u.target.cancel(cancelT('delete'));
    expect(d).toEqual({ status: 'ok', result: {} });
    const v = strict('commands/move.cancel.result');
    expect(v(d.result), why(v)).toBe(true);
    expect(u.stopped).toContain(MOVE);
    // The camera removed here (live stop), its password and its leaf gone; the copier's temporary files too.
    expect(u.loaded.config.cameras.cam9).toBeUndefined();
    expect(JSON.stringify(JSON.parse(readFileSync(u.loaded.files.overrides, 'utf8')))).not.toContain('cam9');
    expect(u.passwords.has('cam9')).toBe(false);
    expect(u.forgot).toEqual(['cam9']);
    expect(existsSync(part)).toBe(false);
    // Nothing deleted (ruling 18: the copied choice is ignored after the switch-over): imported and own capture, cam1 too.
    expect(existsSync(`${minutePath(u.dataDir, 'stills', 'cam9', IMPORTED)}.pack`)).toBe(true);
    expect(existsSync(join(u.dataDir, 'clips/cam9/2026/10/18/1200-1.mp4'))).toBe(true);
    expect(existsSync(`${minutePath(u.dataDir, 'stills', 'cam9', OWN)}.pack`)).toBe(true);
    expect(rows(u.catalog, 'cam9')).toBe(4);
    expect(rows(u.catalog, 'cam1')).toBe(2);
    // The import log and the landed log stay with the record for the return's manifest.
    expect(existsSync(landedLog(u.dataDir, MOVE))).toBe(true);
    expect(existsSync(chunkPartsDir(u.dataDir, MOVE))).toBe(true);
    u.journal.sweep();
    expect(existsSync(chunkPartsDir(u.dataDir, MOVE))).toBe(true);
    const kept = u.journal.load(MOVE)!;
    expect(kept).toMatchObject({ phase: 'cancelled', returnPending: true, switchedOver: true, cancelledFrom: 'copied' });
    expect(kept.x25519).toBeUndefined();
    expect(kept.leaf).toBeUndefined();
    // The high water at the cancel (ruling 7): row ids of this camera per table, and this proxy's clock.
    expect(kept.captured!.maxIds).toEqual({ clips: clipsMax, events: eventsMax, analyses: 0, still_checks: 0, archive: 0 });
    expect(kept.captured!.at).toBeGreaterThanOrEqual(before);
    expect(kept.captured!.at).toBeLessThanOrEqual(Date.now());
    // Busy until the return is checked (ruling 10).
    expect(u.journal.active().map((x) => x.id)).toEqual([MOVE]);
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'target', phase: 'cancelled', ok: true, returnPending: true });
    const a = u.audits.find((x) => x.action === 'move-cancel')!;
    expect(a).toMatchObject({ outcome: 'success', details: { moveId: MOVE, camera: 'cam9', source: SOURCE_ID, target: TARGET_ID, role: 'target', phase: 'copied', cameraEntry: 'removed', returnPending: true, deleted: null } });
    expect(a.details!.copied).toBeUndefined();
    expect(a.message).toContain('copied back to een next');
    // Again: nothing more happens but the terminal phase again; the record stays.
    const n = [u.events.length, u.audits.length];
    expect(await u.target.cancel(cancelT('delete'))).toEqual(d);
    expect([u.events.length, u.audits.length]).toEqual([n[0] + 1, n[1]]);
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'target', phase: 'cancelled', ok: true, returnPending: true });
    expect(u.journal.load(MOVE)).toMatchObject({ phase: 'cancelled', returnPending: true, captured: kept.captured });
    expect(existsSync(landedLog(u.dataDir, MOVE))).toBe(true);
    // Its tombstone gone after 7 days, the record still answers (it never expires by itself, ruling 10).
    const later = new MoveJournal(join(u.dataDir, 'admin', 'moves'), undefined, { now: () => Date.now() + 8 * DAY });
    const t8 = new MoveTarget({ ...u.deps, journal: later });
    expect(await t8.cancel(cancelT('delete'))).toEqual(d);
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'target', phase: 'cancelled', ok: true, returnPending: true });
    expect(u.audits.length).toBe(n[1]);
    expect(await t8.finish(finishArgs('target'))).toMatchObject({ status: 'failed', code: 'wrong_phase' });
    expect(later.load(MOVE)).toMatchObject({ returnPending: true });
    // A restart does not run it again.
    const m = u.events.length;
    t8.resume();
    await t8.idle(MOVE);
    expect(u.events.length).toBe(m);
    expect(later.load(MOVE)).toMatchObject({ phase: 'cancelled', returnPending: true });
  }, 60_000);

  it('a cancel after the switch-over is busy from its first save; a crash before its steps ran runs them on the repeat', async () => {
    const u = targetUnit();
    await copied(u);
    const seen: { active: string[]; returnPending: unknown }[] = [];
    const setLoaded = u.deps.setLoaded;
    let crash = true;
    const t = new MoveTarget({ ...u.deps, setLoaded: async (l) => {
      seen.push({ active: u.journal.active().map((x) => x.id), returnPending: u.journal.load(MOVE)?.returnPending });
      if (crash) throw new Error('crash while the camera stops');
      await setLoaded(l);
    } });
    await expect(t.cancel(cancelT('age-out'))).rejects.toThrow(/crash/);
    // While the camera stopped here the move was already busy (no offer slips in).
    expect(seen).toEqual([{ active: [MOVE], returnPending: true }]);
    expect(u.audits.some((x) => x.action === 'move-cancel')).toBe(false);
    // The repeat (cams-admin sends it again) runs the steps the crash left, not only the terminal phase.
    crash = false;
    const t2 = new MoveTarget({ ...u.deps, setLoaded: async (l) => {
      seen.push({ active: u.journal.active().map((x) => x.id), returnPending: u.journal.load(MOVE)?.returnPending });
      await setLoaded(l);
    } });
    expect((await t2.cancel(cancelT('age-out'))).status).toBe('ok');
    expect(u.loaded.config.cameras.cam9).toBeUndefined();
    expect(u.audits.filter((x) => x.action === 'move-cancel')).toHaveLength(1);
    expect(u.journal.load(MOVE)).toMatchObject({ phase: 'cancelled', returnPending: true });
    expect(u.journal.active().map((x) => x.id)).toEqual([MOVE]);
  }, 60_000);

  it('cancel with age-out keeps the target\'s copy and its retention removes it later', async () => {
    const u = targetUnit();
    await copied(u);
    const NOW = Date.UTC(2026, 9, 21, 12, 0);
    const old = NOW - 10 * DAY;
    content(u.dataDir, u.catalog, 'cam9', old);
    expect((await u.target.cancel(cancelT('age-out'))).status).toBe('ok');
    expect(u.loaded.config.cameras.cam9).toBeUndefined();
    expect(existsSync(`${minutePath(u.dataDir, 'stills', 'cam9', old)}.pack`)).toBe(true);
    expect(rows(u.catalog, 'cam9')).toBe(2);
    expect(u.audits.find((x) => x.action === 'move-cancel')!.details).toMatchObject({ returnPending: true, deleted: null });
    // The retention's dry run lists the removed camera's old content (its folders are swept like any camera's).
    const config = structuredClone(u.loaded.config);
    config.retention.stillsDays = 7;
    config.retention.clipsDays = 7;
    const storage = new Storage({ catalog: u.catalog, log: new StreamLog(u.catalog, () => NOW), config: () => config, now: () => NOW, statfs: () => ({ free: 100 * 2 ** 30, size: 200 * 2 ** 30 }) });
    const run = storage.run({ dryRun: true });
    expect(run.deleted.stills).toBe(1);
    expect(run.deleted.clips).toBe(1);
    expect(existsSync(`${minutePath(u.dataDir, 'stills', 'cam9', old)}.pack`)).toBe(true);
  }, 60_000);

  it('cancel of an opened record (offer expired, or cancelled before move.start) only closes it', async () => {
    const u = targetUnit();
    u.journal.save(offered());
    expect((await u.target.cancel(cancelT('delete'))).status).toBe('ok');
    expect(u.journal.load(MOVE)).toBeNull();
    expect(u.setLoadedCalls).toEqual([]);
    expect(u.forgot).toEqual([]);
    expect(phasesOf(u.events)).toEqual(['cancelled']);
    expect(u.audits.find((x) => x.action === 'move-cancel')!.details).toMatchObject({ phase: 'opened', cameraEntry: 'untouched', deleted: null });
  });

  it("a cancel after the camera step deletes the camera's positions on the target", async () => {
    const u = targetUnit();
    await copied(u);
    const p = (id: string, cam: string) => insertPosition(u.catalog, { id, cam, name: 'Gate', sort_order: 0, home: 1, slot: 1, preset_name: 'gate', created_at: 1, updated_at: 1 });
    p('pos_0000000000000009', 'cam9');
    p('pos_0000000000000001', 'cam1');
    expect((await u.target.cancel(cancelT('age-out'))).status).toBe('ok');
    expect(listPositions(u.catalog, 'cam9')).toEqual([]);
    expect(listPositions(u.catalog, 'cam1')).toHaveLength(1);
  });

  it('a cancel before the switch-over closes the record as before: no returnPending, no high water, its logs gone', async () => {
    const u = targetUnit();
    u.journal.save(offered({ phase: 'switching', plan: PLAN, step: 'camera' }));
    noteLanded(u.dataDir, MOVE, 'stills/cam9/2026/10/18/1200.pack');
    writeChunkPart(u.dataDir, MOVE, 'clips:2026-10-18', { imported: { clips: [] } });
    expect((await u.target.cancel(cancelT('age-out'))).status).toBe('ok');
    expect(u.journal.load(MOVE)).toBeNull();
    expect(u.journal.active()).toEqual([]);
    expect(existsSync(landedLog(u.dataDir, MOVE))).toBe(false);
    expect(existsSync(chunkPartsDir(u.dataDir, MOVE))).toBe(false);
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'target', phase: 'cancelled', ok: true });
    const a = u.audits.find((x) => x.action === 'move-cancel')!;
    expect(a.details).toMatchObject({ phase: 'switching', copied: 'age-out' });
    expect(a.details!.returnPending).toBeUndefined();
  });

  it('a cancel while move.start makes the leaf: the start is discarded (no key, no leaf staged)', async () => {
    const u = targetUnit();
    u.journal.save(offered());
    const start = u.target.start(startArgs());
    const c = await u.target.cancel(cancelT('delete'));
    expect(c.status).toBe('ok');
    expect(await start).toMatchObject({ status: 'failed', code: 'wrong_phase' });
    await u.target.idle(MOVE);
    expect(u.journal.load(MOVE)).toBeNull();
    expect(u.staged).toEqual([]);
    expect(phasesOf(u.events)).toEqual(['cancelled']);
  }, 60_000);

  it('a camera of that id the target had itself is never removed or purged (the camera step refused it)', async () => {
    const u = targetUnit();
    content(u.dataDir, u.catalog, 'cam1');
    // A move of "cam1" whose camera step was refused (id_taken): the record failed at that step.
    u.journal.save(offered({ camera: 'cam1', phase: 'failed', failure: 'camera_failed', step: 'camera', plan: PLAN }));
    expect((await u.target.cancel(cancelT('delete'))).status).toBe('ok');
    expect(u.loaded.config.cameras.cam1).toBeDefined();
    expect(rows(u.catalog, 'cam1')).toBe(2);
    expect(u.forgot).toEqual([]);
    expect(u.audits.find((x) => x.action === 'move-cancel')!.details).toMatchObject({ phase: 'failed', cameraEntry: 'untouched', deleted: null });
  });
});

// ---- Part 1b: the source (MoveSource) ----

const sourceRecord = (over: Partial<MoveRecord> = {}): MoveRecord => ({
  v: 1, id: MOVE, role: 'source', camera: 'cam3', phase: 'released', plan: PLAN, approvedAt: 1, budgetS: 3600,
  peer: { proxyId: TARGET_ID, name: 'Mini PC', ip: '127.0.0.1' }, tokenHash: hashMoveToken(TOKEN), requestId: 'rq_0123456789ABCDEFGHJK',
  answer: { accept: true }, summary: SUMMARY, settings: { name: 'cam3' }, expectedLeaf: TARGET_LEAF, manifest: [],
  chunks: {}, bytesDone: 0, startedAt: Date.now() - 120_000, ...over,
});

// noSite: the Pi (no tls.site, no camera certificates at all); tlsName: a
// camera whose certificate is managed elsewhere (cam1's Let's Encrypt name);
// http, cameraCerts false: certificates this proxy never pushes either.
function sourceUnit(o: { added?: boolean; released?: boolean; noSite?: boolean; tlsName?: string; http?: boolean; cameraCerts?: false; env?: Record<string, string> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-end-src-'));
  const cam3 = { id: 'cam3', host: '192.0.2.3', protocol: o.http ? 'http' : 'https', user: 'proxy', ...(o.tlsName ? { tlsName: o.tlsName } : {}) };
  const tls = o.noSite ? {} : { site: 's', cameraSubnet: '192.0.2.0/24', proxyAddresses: '198.51.100.1', ...(o.cameraCerts === false ? { cameraCerts: false } : {}) };
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ cameras: [{ id: 'cam1', host: '' }, ...(o.added ? [] : [cam3])], tls }));
  let loaded = loadConfig({ ...SECRETS, ...(o.env ?? {}) }, { cwd: dir });
  if (o.added) loaded = applyOverrides(loaded, { cameras: { cam3: { host: '192.0.2.3', protocol: 'https', user: 'proxy' } } });
  if (o.released !== false) loaded = applyOverrides(loaded, { cameras: { cam3: { moved: MOVE } } });
  const dataDir = loaded.config.server.dataDir;
  const catalog = openCatalog(join(dataDir, 'catalog.db'));
  const journal = new MoveJournal(join(dataDir, 'admin', 'moves'));
  const audit = new AuditLog({ dir: join(dataDir, 'audit'), version: 'test' });
  const events: MoveEvent[] = [];
  const calls: string[] = [];
  const expected = new Map<string, string | null>([['cam3', TARGET_LEAF]]);
  let push: PushResult = { outcome: 'pushed', served: OWN_LEAF, tookMs: 1 };
  const cache = new ManifestCache(dataDir);
  const leftovers = new MoveLeftovers(dataDir);
  const deps: SourceDeps = {
    journal, audit, emit: (e) => events.push(e),
    running: () => loaded.config,
    loaded: () => loaded,
    setLoaded: (l) => {
      calls.push(`setLoaded moved=${l.config.cameras.cam3?.moved ?? '-'}`);
      loaded = l;
    },
    sendAllowed: () => true,
    siteReady: () => !o.noSite,
    inventory: { catalog, dataDir },
    certs: () => (o.noSite ? undefined : { setExpected: (id, fp) => (calls.push(`expected ${id} ${fp}`), void expected.set(id, fp)) }),
    refreshManifest: () => undefined,
    proxyId: () => SOURCE_ID,
    timing: { cancelRetryMs: 5, cancelRetryCapMs: 20 },
    end: {
      dropManifests: (id) => cache.forget(id),
      purge: (cam, o) => purgeExcept({ catalog, dataDir, storage: { recount: () => undefined }, archive: { store: new ArchiveStore({ dataDir, catalog }) } }, cam, o),
      deletePassword: (cam) => void calls.push(`password ${cam}`),
      forgetLeaf: (cam) => void calls.push(`forget ${cam}`),
      pushOwnLeaf: async (cam) => (calls.push(`push ${cam}`), push),
      ftp: async (cam) => (calls.push(`ftp ${cam}`), { verified: true, mismatch: [] }),
      settled: async () => void calls.push('settled'),
      deletePositions: (cam) => deleteCameraPositions(catalog, cam),
      envCleanup: (cam) => (calls.push(`env ${cam}`), removePasswordLine(loaded, cam, new Date(Date.UTC(2026, 9, 30, 9, 0, 0)))),
      leftovers,
    },
  };
  const source = new MoveSource(deps);
  const audits = (action: string) => audit.list({ actions: [action as never], limit: 50 }).records as Record<string, any>[];
  return { dir, dataDir, catalog, journal, audit, audits, events, calls, expected, deps, source, cache, leftovers, setPush: (p: PushResult) => (push = p), get loaded() { return loaded; } };
}

describe('move.finish on the source (S §11)', () => {
  it('finish purges content and hides or removes the camera', async () => {
    // A config.json camera: purged, its entry stays hidden (P2).
    const u = sourceUnit();
    u.journal.save(sourceRecord());
    content(u.dataDir, u.catalog, 'cam3');
    content(u.dataDir, u.catalog, 'cam1');
    const manifests = manifestCacheDir(u.dataDir, MOVE);
    put(join(manifests, 'clips-2026-10-20.json'));
    const d = await u.source.finish(finishArgs('source'));
    expect(d.status).toBe('ok');
    const v = strict('commands/move.finish.result');
    expect(v(d.result), why(v)).toBe(true);
    // Exactly the five kinds (B49/X13).
    expect(Object.keys((d.result as { deleted: object }).deleted).sort()).toEqual([...FILE_KINDS].sort());
    expect(d.result).toMatchObject({ deleted: { stills: { files: 1, bytes: 100 }, clips: { files: 1, bytes: 300 } } });
    expect(rows(u.catalog, 'cam3')).toBe(0);
    expect(rows(u.catalog, 'cam1')).toBe(2);
    expect(existsSync(join(u.dataDir, 'stills', 'cam3'))).toBe(false);
    expect(existsSync(join(u.dataDir, 'stills', 'cam1'))).toBe(true);
    expect(u.loaded.config.cameras.cam3.moved).toBe(MOVE);
    expect(u.calls).toEqual(expect.arrayContaining(['password cam3', 'forget cam3', 'expected cam3 null']));
    expect(u.expected.get('cam3')).toBeNull();
    expect(existsSync(manifests)).toBe(false);
    expect(u.journal.load(MOVE)).toBeNull();
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'source', phase: 'finished', ok: true });
    expect(u.audits('move-cleanup')[0]).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { moveId: MOVE, camera: 'cam3', source: SOURCE_ID, target: TARGET_ID, role: 'source', cameraEntry: 'hidden' } });
    expect(u.audits('move-cleanup')[0].cam_proxy.deleted.clips).toEqual({ files: 1, bytes: 300 });
    expect(u.audits('move-done')[0]).toMatchObject({ cam_proxy: { moveId: MOVE, role: 'source', abandoned: false } });
    // An overrides-added camera: removed with its override.
    const a = sourceUnit({ added: true });
    a.journal.save(sourceRecord());
    content(a.dataDir, a.catalog, 'cam3');
    expect((await a.source.finish(finishArgs('source', true))).status).toBe('ok');
    expect(a.loaded.config.cameras.cam3).toBeUndefined();
    expect(JSON.parse(readFileSync(a.loaded.files.overrides, 'utf8')).cameras?.cam3).toBeUndefined();
    expect(rows(a.catalog, 'cam3')).toBe(0);
    expect(a.audits('move-cleanup')[0].cam_proxy.cameraEntry).toBe('removed');
    expect(a.audits('move-done')[0].cam_proxy.abandoned).toBe(true);
  }, 60_000);

  it('finish deletes only what arrived: the keep list stays, the cleanup names it', async () => {
    const u = sourceUnit();
    const t = Date.UTC(2026, 9, 20, 12, 0);
    content(u.dataDir, u.catalog, 'cam3', t);
    const kept = `clips/cam3/${utcDayParts(t).join('/')}/${utcHhmm(t)}-1.mp4`;
    u.journal.save(sourceRecord({ manifest: [{ id: 'clips:2026-10-20', kind: 'clips', day: '2026-10-20', files: 1, bytes: 300, rows: 1 }], keep: { 'clips:2026-10-20': [kept] } }));
    const d = await u.source.finish(finishArgs('source'));
    expect(d.status).toBe('ok');
    expect(existsSync(join(u.dataDir, kept))).toBe(true);
    expect(existsSync(join(u.dataDir, 'stills', 'cam3'))).toBe(false);
    // The answer counts what was deleted (the contract's shape); the cleanup record also what stayed.
    expect(d.result).toMatchObject({ deleted: { clips: { files: 0, bytes: 0 }, stills: { files: 1, bytes: 100 } } });
    const cleanup = u.audits('move-cleanup')[0];
    expect(cleanup.cam_proxy.kept.clips).toEqual({ files: 1, bytes: 300 });
    expect(cleanup.message).toContain('stay on this proxy (they age out with retention; Archive items keep their own expiry)');
  }, 60_000);

  it('finish keeps the audit files', async () => {
    const u = sourceUnit();
    u.audit.write({ action: 'move-request', category: ['configuration'], type: ['creation'], outcome: 'success', user: 'admin', camera: 'cam3', message: 'Camera move requested: cam3', details: { camera: 'cam3' } });
    u.journal.save(sourceRecord());
    content(u.dataDir, u.catalog, 'cam3');
    const before = readdirSync(join(u.dataDir, 'audit'));
    expect((await u.source.finish(finishArgs('source'))).status).toBe('ok');
    for (const f of before) expect(existsSync(join(u.dataDir, 'audit', f))).toBe(true);
    // History is not rewritten: the camera's earlier records are all still there, the end added to them.
    expect(u.audits('move-request')).toHaveLength(1);
    expect(u.audits('move-done')).toHaveLength(1);
  }, 60_000);

  it('finish twice is a no-op', async () => {
    const u = sourceUnit();
    u.journal.save(sourceRecord());
    content(u.dataDir, u.catalog, 'cam3');
    const a = await u.source.finish(finishArgs('source'));
    expect(a.result).not.toEqual({ deleted: ZEROS });
    const n = [u.events.length, u.calls.length];
    const b = await u.source.finish(finishArgs('source'));
    // The same answer: the counts of the first finish, from its tombstone (final review 4).
    expect(b).toEqual(a);
    expect([u.events.length, u.calls.length]).toEqual([n[0] + 1, n[1]]);
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'source', phase: 'finished', ok: true });
    expect(u.audits('move-done')).toHaveLength(1);
    // After a restart too.
    const again = new MoveSource(u.deps);
    expect(await again.finish(finishArgs('source'))).toEqual(a);
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'source', phase: 'finished', ok: true });
    expect(await again.cancel({ v: 1, moveId: MOVE, role: 'source' })).toMatchObject({ status: 'failed', code: 'wrong_phase' });
    expect(u.audits('move-done')).toHaveLength(1);
  }, 60_000);

  it('an offer never approved closes on its own after 35 minutes on the source too (final review 5)', () => {
    const u = sourceUnit({ released: false });
    let now = Date.now();
    const s = new MoveSource({ ...u.deps, now: () => now });
    u.journal.save(sourceRecord({ phase: 'opened', plan: null, expectedLeaf: undefined, startedAt: now }));
    now += 34 * 60_000;
    s.expireOffers();
    expect(u.journal.load(MOVE)!.phase).toBe('opened');
    now += 2 * 60_000;
    s.expireOffers();
    expect(u.journal.load(MOVE)).toBeNull();
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'source', phase: 'cancelled', ok: true });
    expect(u.audits('move-cancel')[0]).toMatchObject({ cam_proxy: { moveId: MOVE, role: 'source', phase: 'opened', reason: 'offer_expired', switchedBack: false } });
    expect(u.source.refusal('cam3')).toBeNull();
  });

  it('never purges a camera that is still active', async () => {
    // Not released yet (switching): refused, nothing deleted.
    const u = sourceUnit({ released: false });
    u.journal.save(sourceRecord({ phase: 'switching' }));
    content(u.dataDir, u.catalog, 'cam3');
    expect(await u.source.finish(finishArgs('source'))).toMatchObject({ status: 'failed', code: 'wrong_phase' });
    // Released in the journal, but the camera runs again (its `moved` cleared by hand): refused too.
    u.journal.save(sourceRecord());
    expect(await u.source.finish(finishArgs('source'))).toMatchObject({ status: 'failed', code: 'camera_active' });
    expect(rows(u.catalog, 'cam3')).toBe(2);
    expect(existsSync(join(u.dataDir, 'stills', 'cam3'))).toBe(true);
    expect(u.journal.load(MOVE)!.phase).toBe('released');
    expect(u.calls).toEqual([]);
  }, 60_000);
});

describe('the cleanup of plan D on the source (PTZ positions, the env password, leftovers)', () => {
  const PW = 'CAMPROXY_CAMERA_PASSWORD_CAM3';
  const VALUE = 'test-only-pw-value';
  const envFile = () => {
    const d = mkdtempSync(join(tmpdir(), 'camproxy-end-env-'));
    const f = join(d, '.env');
    writeFileSync(f, `# cams\r\nCOMPOSE_PROJECT_NAME=cams\r\n${PW}=${VALUE} # moved\r\nexport OTHER=1`);
    return { d, f };
  };
  const pos = (u: ReturnType<typeof sourceUnit>, id: string, cam: string, slot: number) => insertPosition(u.catalog, { id, cam, name: id.slice(-4), sort_order: slot, home: slot === 0 ? 1 : 0, slot, preset_name: 'p', created_at: 1, updated_at: 1 });

  it("finish deletes the camera's PTZ positions and audits the count", async () => {
    const u = sourceUnit();
    u.journal.save(sourceRecord());
    pos(u, 'pos_0000000000000001', 'cam3', 0);
    pos(u, 'pos_0000000000000002', 'cam3', 1);
    pos(u, 'pos_0000000000000003', 'cam1', 0);
    expect((await u.source.finish(finishArgs('source'))).status).toBe('ok');
    expect(listPositions(u.catalog, 'cam3')).toEqual([]);
    expect(listPositions(u.catalog, 'cam1')).toHaveLength(1);
    const c = u.audits('move-cleanup')[0];
    expect(c.cam_proxy.ptzPositions).toBe(2);
    expect(c.message).toContain('2 PTZ positions deleted');
    expect(c.event.outcome).toBe('success');
  }, 60_000);

  it('finish removes the password line from a managed env file, other lines byte for byte', async () => {
    const { d, f } = envFile();
    const u = sourceUnit({ env: { CAMPROXY_ENV_FILE: f } });
    u.journal.save(sourceRecord());
    expect((await u.source.finish(finishArgs('source'))).status).toBe('ok');
    expect(readFileSync(f, 'utf8')).toBe('# cams\r\nCOMPOSE_PROJECT_NAME=cams\r\nexport OTHER=1');
    // No backup holds the password (final review 3).
    for (const n of readdirSync(d)) expect(readFileSync(join(d, n), 'utf8'), n).not.toContain(VALUE);
    const c = u.audits('move-cleanup')[0];
    expect(c.cam_proxy.env).toEqual({ outcome: 'removed', key: PW });
    expect(c.message).toContain(`${PW} removed from the env file`);
    expect(c.message).not.toContain('.env.bak');
    // config.json still has the hidden entry: listed, with the move id.
    expect(c.cam_proxy.leftovers).toEqual(['config.json entry']);
    expect(c.message).toContain('still to remove by hand: config.json entry');
    expect(u.leftovers.current(u.loaded)).toEqual([{ camera: 'cam3', moveId: MOVE, items: ['config.json entry'] }]);
  }, 60_000);

  it('an unwritable env file: finish ok, leftover listed, audit says failed', async () => {
    if (process.getuid?.() === 0) return;
    const { d, f } = envFile();
    // As compose's env_file sets it, the process has the value too.
    const u = sourceUnit({ added: true, env: { CAMPROXY_ENV_FILE: f, [PW]: VALUE } });
    u.journal.save(sourceRecord());
    chmodSync(d, 0o500);
    let res;
    try {
      res = await u.source.finish(finishArgs('source'));
    } finally {
      chmodSync(d, 0o700);
    }
    expect(res.status).toBe('ok');
    expect(readFileSync(f, 'utf8')).toContain(`${PW}=${VALUE}`);
    const c = u.audits('move-cleanup')[0];
    expect(c.event.outcome).toBe('success');
    expect(c.cam_proxy.env).toEqual({ outcome: 'failed', key: PW, code: 'not_writable' });
    expect(c.message).toContain(`${PW} could not be removed from the env file (not_writable)`);
    expect(c.cam_proxy.leftovers).toEqual([`env ${PW}`]);
    expect(u.leftovers.current(u.loaded)).toEqual([{ camera: 'cam3', moveId: MOVE, items: [`env ${PW}`] }]);
    // No env value in any audit record.
    expect(JSON.stringify(u.audit.list({ limit: 200 }).records)).not.toContain(VALUE);
  }, 60_000);

  it('a config.json camera without an env file: leftover "config.json entry", env not_managed', async () => {
    const u = sourceUnit();
    u.journal.save(sourceRecord());
    expect((await u.source.finish(finishArgs('source'))).status).toBe('ok');
    const c = u.audits('move-cleanup')[0];
    expect(c.cam_proxy.env).toEqual({ outcome: 'not_managed', key: PW });
    expect(c.cam_proxy.leftovers).toEqual(['config.json entry']);
  }, 60_000);

  it('a repeated finish does not touch the env file again', async () => {
    const { f } = envFile();
    const u = sourceUnit({ env: { CAMPROXY_ENV_FILE: f } });
    u.journal.save(sourceRecord());
    await u.source.finish(finishArgs('source'));
    writeFileSync(f, `${PW}=again\n`);
    await u.source.finish(finishArgs('source'));
    expect(readFileSync(f, 'utf8')).toBe(`${PW}=again\n`);
    expect(u.calls.filter((c) => c === 'env cam3')).toHaveLength(1);
    expect(u.audits('move-cleanup')).toHaveLength(1);
  }, 60_000);

  it('a camera running here again has no leftover', async () => {
    const u = sourceUnit();
    u.journal.save(sourceRecord());
    await u.source.finish(finishArgs('source'));
    expect(u.leftovers.current(u.loaded)).toHaveLength(1);
    // A later move brings it back: moved cleared, the camera runs here.
    const back = planUnset(u.loaded, ['cameras.cam3.moved']).next;
    expect(back.config.cameras.cam3.moved).toBeUndefined();
    expect(u.leftovers.current(back)).toEqual([]);
  }, 60_000);
});

describe('move.cancel on the source', () => {
  it('cancel before switch-over leaves the source untouched (B48): the record closed, the token refused after', async () => {
    const u = sourceUnit({ released: false });
    u.journal.save(sourceRecord({ phase: 'opened', expectedLeaf: undefined, manifest: undefined }));
    content(u.dataDir, u.catalog, 'cam3');
    const app = express();
    app.get('/api/moves/:id/manifest', moveTokenGuard({ journal: u.journal, audit: u.audit }), (_req, res) => void res.json({ ok: true }));
    await request(app).get(`/api/moves/${MOVE}/manifest`).set('Authorization', `Bearer ${TOKEN}`).expect(200);
    const before = JSON.stringify(u.loaded.config.cameras.cam3);
    u.cache.set(MOVE, 'clips:2026-10-20', { files: [{ path: 'clips/cam3/2026/10/20/1200-1.mp4', size: 1, sha256: '0'.repeat(64) }], rows: 0, expired: 0 });
    expect(u.cache.lists(MOVE, 'clips/cam3/2026/10/20/1200-1.mp4')).toBe(true);
    const d = await u.source.cancel({ v: 1, moveId: MOVE, role: 'source' });
    // The move's cached manifests go, on disk and in memory.
    expect(existsSync(manifestCacheDir(u.dataDir, MOVE))).toBe(false);
    expect(u.cache.lists(MOVE, 'clips/cam3/2026/10/20/1200-1.mp4')).toBe(false);
    expect(d).toEqual({ status: 'ok', result: {} });
    await request(app).get(`/api/moves/${MOVE}/manifest`).set('Authorization', `Bearer ${TOKEN}`).expect(403);
    expect(u.journal.load(MOVE)).toBeNull();
    // The camera untouched: no config write, no push, no FTP change; only `expected` cleared (it was set).
    expect(JSON.stringify(u.loaded.config.cameras.cam3)).toBe(before);
    expect(u.calls).toEqual(['expected cam3 null']);
    expect(rows(u.catalog, 'cam3')).toBe(2);
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'source', phase: 'cancelled', ok: true });
    expect(u.audits('move-cancel')[0]).toMatchObject({ cam_proxy: { moveId: MOVE, camera: 'cam3', role: 'source', phase: 'opened', switchedBack: false } });
    expect(u.journal.ended(MOVE, 'source')?.camera).toBeUndefined();
    expect(u.source.list().filter((m) => m.id === MOVE)).toEqual([]);
    // Twice: nothing more but the terminal phase again (final review 4), also after a restart.
    const n = [u.events.length, u.calls.length];
    expect(await u.source.cancel({ v: 1, moveId: MOVE, role: 'source' })).toEqual(d);
    expect([u.events.length, u.calls.length]).toEqual([n[0] + 1, n[1]]);
    expect(await new MoveSource(u.deps).cancel({ v: 1, moveId: MOVE, role: 'source' })).toEqual(d);
    expect([u.events.length, u.calls.length]).toEqual([n[0] + 2, n[1]]);
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'source', phase: 'cancelled', ok: true });
  });

  it('cancel after switch-over: the expected leaf, the camera shown, its own leaf pushed, FTP back, then no expected leaf', async () => {
    const u = sourceUnit();
    u.journal.save(sourceRecord());
    const d = await u.source.cancel({ v: 1, moveId: MOVE, role: 'source', expectedLeaf: TARGET_LEAF });
    expect(d).toEqual({ status: 'ok', result: {} });
    expect(u.calls).toEqual(['setLoaded moved=-', `expected cam3 ${TARGET_LEAF}`, 'settled', 'push cam3', 'ftp cam3', 'expected cam3 null']);
    expect(u.loaded.config.cameras.cam3.moved).toBeUndefined();
    expect(u.journal.load(MOVE)).toBeNull();
    expect(u.audits('move-cancel')[0].cam_proxy).toMatchObject({ phase: 'released', switchedBack: true, push: 'pushed', ftp: 'ok' });
    // The tombstone names the camera back here: the copy back (step 4 Task 10) copies into it.
    expect(u.journal.ended(MOVE, 'source')).toMatchObject({ phase: 'cancelled', camera: 'cam3' });
  });

  it('a failed give-back step: the camera is the source\'s at once; audited, busy, retried by itself until done', async () => {
    const u = sourceUnit();
    u.journal.save(sourceRecord());
    u.setPush({ outcome: 'failed', served: TARGET_LEAF, detail: 'an event is open: try again when it has ended', tookMs: 0 });
    expect(await u.source.cancel({ v: 1, moveId: MOVE, role: 'source', expectedLeaf: TARGET_LEAF })).toEqual({ status: 'ok', result: {} });
    // (a) `moved` cleared first: the camera runs here, the target's leaf still accepted.
    expect(u.calls.slice(0, 2)).toEqual(['setLoaded moved=-', `expected cam3 ${TARGET_LEAF}`]);
    expect(u.loaded.config.cameras.cam3.moved).toBeUndefined();
    expect(u.expected.get('cam3')).toBe(TARGET_LEAF);
    // (c) audited with the step and the code; (d) busy, no cancelled event yet, nothing re-emitted.
    expect(u.audits('move-cancel')).toHaveLength(1);
    expect(u.audits('move-cancel')[0]).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { moveId: MOVE, role: 'source', step: 'cert', code: 'cert_failed' } });
    expect(u.journal.load(MOVE)).toMatchObject({ phase: 'cancelled', cancelPending: true });
    expect(u.source.refusal('cam1')).toBe('busy');
    expect(u.journal.currentPhase()).toBeNull();
    expect(phasesOf(u.events)).toEqual([]);
    // (b) retried in the background; the failures audited at most hourly.
    await until(() => u.calls.filter((c) => c === 'push cam3').length >= 3, 5000);
    expect(u.audits('move-cancel')).toHaveLength(1);
    u.setPush({ outcome: 'pushed', served: OWN_LEAF, tookMs: 1 });
    await until(() => u.journal.load(MOVE) === null, 5000);
    expect(u.expected.get('cam3')).toBeNull();
    expect(phasesOf(u.events)).toEqual(['cancelled']);
    expect(u.audits('move-cancel').map((a) => a.event.outcome).sort()).toEqual(['failure', 'success']);
    expect(u.source.refusal('cam1')).toBeNull();
    // A cancel now: nothing more but the terminal phase again (final review 4).
    expect(await u.source.cancel({ v: 1, moveId: MOVE, role: 'source', expectedLeaf: TARGET_LEAF })).toEqual({ status: 'ok', result: {} });
    expect(phasesOf(u.events)).toEqual(['cancelled', 'cancelled']);
  });

  it('a restart in the middle of the retries resumes the give-back', async () => {
    const u = sourceUnit();
    u.journal.save(sourceRecord());
    u.setPush({ outcome: 'failed', served: TARGET_LEAF, detail: 'push failed', tookMs: 0 });
    await u.source.cancel({ v: 1, moveId: MOVE, role: 'source', expectedLeaf: TARGET_LEAF });
    u.source.stop();
    const n = u.calls.filter((c) => c === 'push cam3').length;
    await new Promise((r) => setTimeout(r, 60));
    expect(u.calls.filter((c) => c === 'push cam3').length).toBe(n);
    expect(u.journal.load(MOVE)).toMatchObject({ cancelPending: true });
    // A new process on the same data.
    u.setPush({ outcome: 'pushed', served: OWN_LEAF, tookMs: 1 });
    const again = new MoveSource(u.deps);
    again.resume();
    await until(() => u.journal.load(MOVE) === null, 5000);
    expect(u.expected.get('cam3')).toBeNull();
    expect(phasesOf(u.events)).toEqual(['cancelled']);
  });

  // 2026-10-26 (Klaus): the Pi (no site CA) and a camera whose certificate is
  // managed elsewhere (tlsName, e.g. cam1's Let's Encrypt certificate) may be a
  // move source. The source never expects, checks or pushes such a camera's
  // leaf: a cancel gives the camera back without the certificate step and says
  // that the camera keeps the target's certificate.
  for (const [what, o] of [
    ['the Pi (no tls.site)', { noSite: true }],
    ['a camera with tlsName', { tlsName: 'cam3.example.org' }],
    ['an http camera', { http: true }],
    ['tls.cameraCerts off', { cameraCerts: false }],
  ] as const) {
    it(`${what}: go expects no leaf; a cancel after it gives the camera back without the certificate step`, async () => {
      const u = sourceUnit({ released: false, ...o });
      u.journal.save(sourceRecord({ phase: 'opened', expectedLeaf: undefined, manifest: undefined }));
      expect(u.source.setExpectedLeaf('cam3', TARGET_LEAF)).toBe(true);
      const go = { v: 1, moveId: MOVE, plan: PLAN, targetPublicKey: 'MCowBQYDK2VuAyEAmP0gq8Yx4JbJ1TfKqSx1n0lW7f9H3cQm6y2xZ0aB1cA=', expectedLeaf: TARGET_LEAF };
      expect(await u.source.handlers()['move.go'](go, undefined as never)).toEqual({ status: 'ok', result: {} });
      expect(u.journal.load(MOVE)).toMatchObject({ phase: 'switching', expectedLeaf: TARGET_LEAF });
      // Again (a new cmdId): the same state, still nothing expected.
      expect(await u.source.handlers()['move.go'](go, undefined as never)).toEqual({ status: 'ok', result: {} });
      expect(u.calls).toEqual([]);
      expect(u.expected.get('cam3')).toBe(TARGET_LEAF); // the fake's initial value, never touched
      // Released, then cancelled: `moved` cleared, the camera settled, its FTP back; no expected leaf, no push.
      expect(await u.source.handlers()['move.release']({ v: 1, moveId: MOVE }, undefined as never)).toEqual({ status: 'ok', result: {} });
      u.calls.length = 0;
      expect(await u.source.cancel({ v: 1, moveId: MOVE, role: 'source', expectedLeaf: TARGET_LEAF })).toEqual({ status: 'ok', result: {} });
      expect(u.calls).toEqual(['setLoaded moved=-', 'settled', 'ftp cam3']);
      expect(u.loaded.config.cameras.cam3.moved).toBeUndefined();
      expect(u.journal.load(MOVE)).toBeNull();
      expect(phasesOf(u.events).at(-1)).toBe('cancelled');
      const rec = u.audits('move-cancel');
      expect(rec).toHaveLength(1);
      expect(rec[0]).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { phase: 'released', switchedBack: true, cert: 'not_managed', ftp: 'ok' } });
      expect(rec[0].cam_proxy.push).toBeUndefined();
      expect(rec[0].message).toContain("the camera keeps the target's certificate");
      expect(rec[0].message).toContain('cam1-cert-push');
      expect(u.journal.ended(MOVE, 'source')).toMatchObject({ phase: 'cancelled', camera: 'cam3' });
    });
  }

  it("a camera with tlsName: while it serves the target's leaf the FTP step fails; the failure says to restore its certificate, and it retries until done", async () => {
    const u = sourceUnit({ tlsName: 'cam3.example.org' });
    u.journal.save(sourceRecord());
    let reachable = false;
    u.deps.end!.ftp = async (cam) => {
      u.calls.push(`ftp ${cam}`);
      if (!reachable) throw new Error('certificate verification failed');
      return { verified: true, mismatch: [] };
    };
    expect(await u.source.cancel({ v: 1, moveId: MOVE, role: 'source', expectedLeaf: TARGET_LEAF })).toEqual({ status: 'ok', result: {} });
    const fail = u.audits('move-cancel');
    expect(fail).toHaveLength(1);
    expect(fail[0]).toMatchObject({ event: { outcome: 'failure' }, cam_proxy: { step: 'ftp', code: 'ftp_failed' } });
    expect(fail[0].message).toContain("restore the camera's own certificate where it is managed");
    expect(u.journal.load(MOVE)).toMatchObject({ cancelPending: true });
    await until(() => u.calls.filter((c) => c === 'ftp cam3').length >= 2, 5000);
    reachable = true;
    await until(() => u.journal.load(MOVE) === null, 5000);
    expect(u.calls.filter((c) => c.startsWith('push') || c.startsWith('expected'))).toEqual([]);
    expect(phasesOf(u.events)).toEqual(['cancelled']);
  });

  it('a camera with tlsName: a cancel before the switch-over expects nothing and closes the move', async () => {
    const u = sourceUnit({ released: false, tlsName: 'cam3.example.org' });
    u.journal.save(sourceRecord({ phase: 'opened', expectedLeaf: undefined, manifest: undefined }));
    expect(await u.source.cancel({ v: 1, moveId: MOVE, role: 'source' })).toEqual({ status: 'ok', result: {} });
    expect(u.calls).toEqual([]);
    expect(u.journal.load(MOVE)).toBeNull();
    expect(u.audits('move-cancel')[0]).toMatchObject({ cam_proxy: { phase: 'opened', switchedBack: false } });
  });

  it('a valid token from another address: the failure is recorded in the journal, the move ends', async () => {
    const u = sourceUnit({ released: false });
    u.journal.save(sourceRecord({ phase: 'switching' }));
    put(join(manifestCacheDir(u.dataDir, MOVE), 'clips-2026-10-20.json'));
    u.source.wrongAddress(u.journal.load(MOVE)!);
    expect(existsSync(manifestCacheDir(u.dataDir, MOVE))).toBe(false);
    expect(u.journal.load(MOVE)).toMatchObject({ phase: 'failed', failure: 'token_address' });
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'source', phase: 'failed', ok: false, code: 'token_address' });
    expect(u.journal.currentPhase()).toBeNull();
    // The failure survives a restart: re-emitted after a welcome, and with a finish (final review 4).
    u.events.length = 0;
    const again = new MoveSource(u.deps);
    again.reemitFailed();
    expect(u.events).toEqual([{ kind: 'move.phase', moveId: MOVE, role: 'source', phase: 'failed', ok: false, code: 'token_address' }]);
    expect(await again.finish(finishArgs('source'))).toMatchObject({ status: 'failed', code: 'wrong_phase' });
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'source', phase: 'failed', ok: false, code: 'token_address' });
  });

  it('the command handlers route by role', async () => {
    const s = sourceUnit({ released: false });
    s.journal.save(sourceRecord({ phase: 'opened', expectedLeaf: undefined }));
    const t = targetUnit();
    t.journal.save(offered());
    const h = moveHandlers({ emit: () => undefined, audit: { write: () => null }, source: s.source, target: t.target });
    expect(await h['move.cancel']({ v: 1, moveId: MOVE, role: 'source' }, {} as never)).toEqual({ status: 'ok', result: {} });
    expect(s.journal.load(MOVE)).toBeNull();
    expect(t.journal.load(MOVE)).not.toBeNull();
    expect(await h['move.cancel']({ v: 1, moveId: MOVE, role: 'target', copied: 'delete' }, {} as never)).toEqual({ status: 'ok', result: {} });
    expect(t.journal.load(MOVE)).toBeNull();
  });
});

// ---- Part 2: two proxies over one cam-sim, the camera given back ----

const bodyOf = (r: { msg: Envelope }) => r.msg.body as Record<string, any>;
const TLS = (site: string) => ({ site, cameraSubnet: '127.0.0.0/16', proxyAddresses: '127.0.0.1' });

describe('cancel after switch-over (integration)', () => {
  let sims: Sim[];
  let fakeS: FakeAdmin;
  let fakeT: FakeAdmin;
  let S: Awaited<ReturnType<typeof startMultiProxy>>;
  let T: Awaited<ReturnType<typeof startMultiProxy>>;
  let sourceFtp = 0;
  let targetFtp = 0;
  let ownLeaf = '';
  const done = async (fake: FakeAdmin, command: string, args: Record<string, unknown>) => {
    const sent = fake.sendCommand(command, args, { actor: 'admin@example.org' });
    await until(() => fake.results(sent.cmdId).some((r) => ['done', 'refused'].includes(bodyOf(r).phase)), 60_000);
    return bodyOf(fake.results(sent.cmdId).at(-1)!) as Record<string, any>;
  };
  const phaseEvents = (fake: FakeAdmin) => fake.events().map(bodyOf).filter((b) => b.kind === 'move.phase');

  beforeAll(async () => {
    sims = await startSims(1);
    [fakeS, fakeT] = await Promise.all([startFakeAdmin(), startFakeAdmin()]);
    fakeS.welcomeHeartbeatS = 1;
    fakeT.welcomeHeartbeatS = 1;
    const timing = { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200 } }, tlsPush: { clearWaitMs: 50, verifyMs: 5000, pollMs: 100 } };
    const ftp = async (port: number) => { const passive = await freePort(); return { enabled: true, port, passive: `${passive}-${passive + 19}`, publicHost: '127.0.0.1', tls: true, stream: 'sub' }; };
    sourceFtp = await freePort();
    targetFtp = await freePort();
    const sdir = mkdtempSync(join(tmpdir(), 'camproxy-end-src-int-'));
    writeKeyFile(join(sdir, 'data', 'admin', 'key.json'), fakeS.keyFile());
    writePrivateJson(join(sdir, 'data', 'admin', 'policy.json'), { v: 1, allow: ['move.send'], consent: 3, changedAt: 1, changedBy: 'local' });
    S = await startMultiProxy(sims, { dir: sdir, https: true, env: { CAMPROXY_FTP_PASSWORD: 'src-ftp-'.padEnd(24, 's') }, proxy: timing, settings: { tls: TLS('s'), camsAdmin: { url: fakeS.url }, ftp: await ftp(sourceFtp) } });
    const tdir = mkdtempSync(join(tmpdir(), 'camproxy-end-tgt-int-'));
    writeKeyFile(join(tdir, 'data', 'admin', 'key.json'), fakeT.keyFile());
    writePrivateJson(join(tdir, 'data', 'admin', 'policy.json'), { v: 1, allow: ['move.receive'], consent: 3, changedAt: 1, changedBy: 'local' });
    T = await startMultiProxy([], {
      dir: tdir, extra: [{ id: 'cam1', host: '' }], env: { CAMPROXY_CAMERA_PASSWORD: 'not-the-camera-pw', CAMPROXY_FTP_PASSWORD: 'tgt-ftp-'.padEnd(24, 't') },
      proxy: { ...timing, moves: { retryMs: 200, retryCapMs: 1000 } },
      settings: { tls: TLS('u'), camsAdmin: { url: fakeT.url }, profile: { cameras: 2 }, ftp: await ftp(targetFtp) },
    });
    await until(() => fakeS.open() === 1 && fakeT.open() === 1 && S.proxy.cameras.get('cam3')!.status.state().online, 30_000);
    await S.proxy.certs!.tick();
    expect(S.proxy.certs!.state('cam3').mode).toBe('site-ca');
    ownLeaf = S.proxy.certs!.state('cam3').fingerprint!;
  }, 180_000);
  afterAll(async () => {
    await Promise.all([S?.proxy.stop(), T?.proxy.stop()]);
    await Promise.all([fakeS?.close(), fakeT?.close()]);
    await Promise.all((sims ?? []).map((s) => s.close()));
  });

  it('cancel after switch-over gives the camera back to the source with its own leaf and FTP', async () => {
    const caPem = (await request(S.base).get('/tls/ca.pem').expect(200)).text;
    const sj = new MoveJournal(join(S.dir, 'data', 'admin', 'moves'));
    const node = S.proxy.running.cameras.cam3;
    const connection = { proxyCameraId: 'cam3', name: node.name, host: node.host, protocol: node.protocol, user: node.user, onvifPort: node.onvifPort, rtspPort: node.rtspPort, baichuanPort: node.baichuanPort };
    sj.save({ v: 1, id: MOVE, role: 'source', camera: 'cam3', phase: 'opened', plan: PLAN, approvedAt: 1, budgetS: PLAN.budgetS, peer: { proxyId: fakeT.keyFile().proxyId, name: 'Mini PC', ip: '127.0.0.1' }, tokenHash: hashMoveToken(TOKEN), requestId: 'rq_0123456789ABCDEFGHJK', answer: { accept: true }, summary: SUMMARY, settings: { name: 'cam3', statusPollS: 5 }, cameraConnection: connection, chunks: {}, bytesDone: 0, startedAt: Date.now() });
    const offer = { v: 1, moveId: MOVE, token: TOKEN, source: { proxyId: fakeS.keyFile().proxyId, name: 'Source', url: S.base, caFingerprints: [fingerprintOf(caPem)], tlsServername: 'proxy.s.internal' }, camera: { camsId: 'garden-cam', ...connection }, summary: SUMMARY, settings: { name: 'cam3', statusPollS: 5 } };
    expect(await done(fakeT, 'move.offer', offer)).toMatchObject({ status: 'ok', result: { accept: true } });
    const started = await done(fakeT, 'move.start', { ...startArgs(), settings: { name: 'cam3', statusPollS: 5 } });
    expect(started.status).toBe('ok');
    const targetLeaf = started.result.leafFingerprint as string;
    expect((await done(fakeS, 'move.go', { v: 1, moveId: MOVE, plan: PLAN, targetPublicKey: started.result.publicKey, expectedLeaf: targetLeaf })).status).toBe('ok');
    await until(() => phaseEvents(fakeT).some((e) => e.phase === 'copied'), 120_000);
    expect(await servedFingerprint('127.0.0.1', sims[0].ports.https)).toBe(targetLeaf);
    expect(sims[0].sim.engine.settings.running.Ftp).toMatchObject({ port: targetFtp });
    expect((await done(fakeS, 'move.release', { v: 1, moveId: MOVE })).status).toBe('ok');
    await until(() => !S.proxy.cameras.get('cam3'), 10_000);

    // cams-admin cancels: the target drops the camera first (B36), then the source takes it back.
    const ct = await done(fakeT, 'move.cancel', { v: 1, moveId: MOVE, role: 'target', copied: 'delete' });
    expect(ct, JSON.stringify(ct)).toMatchObject({ status: 'ok', result: {} });
    expect(T.proxy.loaded.config.cameras.cam3).toBeUndefined();
    expect(T.proxy.cameras.get('cam3')).toBeUndefined();
    expect(cameraPasswordStore(join(T.dir, 'data')).get('cam3')).toBeUndefined();
    expect(T.proxy.certs!.state('cam3').mode).toBe('none');
    expect(existsSync(join(T.dir, 'data', 'tls', 'cameras', 'cam3.crt'))).toBe(false);

    const cs = await done(fakeS, 'move.cancel', { v: 1, moveId: MOVE, role: 'source', expectedLeaf: targetLeaf });
    expect(cs, JSON.stringify(cs)).toMatchObject({ status: 'ok', result: {} });
    // The camera serves the source's own leaf again, uploads to the source, and runs there.
    expect(await servedFingerprint('127.0.0.1', sims[0].ports.https)).toBe(ownLeaf);
    expect(S.proxy.certs!.state('cam3')).toMatchObject({ mode: 'site-ca', fingerprint: ownLeaf });
    expect(S.proxy.certs!.expected('cam3')).toBeNull();
    expect(sims[0].sim.engine.settings.running.Ftp).toMatchObject({ enable: 1, server: '127.0.0.1', port: sourceFtp, userName: 'cam3' });
    expect(S.proxy.loaded.config.cameras.cam3.moved).toBeUndefined();
    await until(() => S.proxy.cameras.get('cam3')?.status.state().online === true, 30_000);
    // Both journals closed; both sides reported cancelled and audited it.
    expect(sj.load(MOVE)).toBeNull();
    // The target keeps its record for the copy back (step 4 Task 8).
    expect(new MoveJournal(join(T.dir, 'data', 'admin', 'moves')).load(MOVE)).toMatchObject({ phase: 'cancelled', returnPending: true });
    for (const fake of [fakeS, fakeT]) {
      const last = phaseEvents(fake).filter((e) => e.moveId === MOVE).at(-1)!;
      expect(last).toMatchObject({ phase: 'cancelled', ok: true });
      const ev = fake.events().filter((e) => bodyOf(e).kind === 'move.phase').at(-1)!;
      expect(strict('event')(ev.msg), why(strict('event'))).toBe(true);
    }
    for (const P of [S, T]) {
      const a = P.proxy.audit.list({ actions: ['move-cancel' as never], limit: 5 }).records as Record<string, any>[];
      expect(a).toHaveLength(1);
      const text = readdirSync(join(P.dir, 'data', 'audit')).map((f) => readFileSync(join(P.dir, 'data', 'audit', f), 'utf8')).join('\n');
      for (const secret of [TOKEN, sims[0].password, 'PRIVATE KEY']) expect(text).not.toContain(secret);
    }
    // Again on both sides: nothing more.
    expect(await done(fakeT, 'move.cancel', { v: 1, moveId: MOVE, role: 'target', copied: 'delete' })).toMatchObject({ status: 'ok' });
    expect(await done(fakeS, 'move.cancel', { v: 1, moveId: MOVE, role: 'source', expectedLeaf: targetLeaf })).toMatchObject({ status: 'ok' });
    expect(S.proxy.audit.list({ actions: ['move-cancel' as never], limit: 5 }).records).toHaveLength(1);
  }, 300_000);
});

describe('keepDays on the terminal phases (move step 4, Task 7)', () => {
  const RET = { stillsDays: 3, previewsDays: 2, clipsDays: 14, eventsDays: 30 };
  // The event as the strict contract sees it: wrapped in the vendored fixture's envelope.
  const valid = (e: MoveEvent): void => {
    const m = fixtures().find((x) => x.name === 'valid-event-move-phase-return-pending')!.f.message as { body: Record<string, unknown> };
    const { kind, ...rest } = e as unknown as Record<string, unknown>;
    const v = strict('event');
    expect(v({ ...m, body: { proxyId: m.body.proxyId, connId: m.body.connId, kind, ...rest } }), why(v)).toBe(true);
  };

  it('keepDaysOf: the largest retention, at least 7, at most 3650', () => {
    expect(keepDaysOf(RET)).toBe(30);
    expect(keepDaysOf({ stillsDays: 1, previewsDays: 1, clipsDays: 1, eventsDays: 1 })).toBe(7);
    expect(keepDaysOf({ stillsDays: 9999, previewsDays: 1, clipsDays: 1, eventsDays: 1 })).toBe(3650);
  });

  it('a target finish and its repeat carry keepDays, and the event is a valid contract event', async () => {
    const u = targetUnit();
    u.deps.retention = () => RET;
    await copied(u);
    await u.target.finish(finishArgs('target'));
    const want = { kind: 'move.phase', moveId: MOVE, role: 'target', phase: 'finished', ok: true, keepDays: 30 };
    expect(u.events.at(-1)).toEqual(want);
    valid(u.events.at(-1)!);
    await u.target.finish(finishArgs('target'));
    expect(u.events.at(-1)).toEqual(want);
    const again = new MoveTarget(u.deps);
    await again.finish(finishArgs('target'));
    expect(u.events.at(-1)).toEqual(want);
  }, 60_000);

  it('a target cancel carries keepDays, also from the tombstone', async () => {
    const u = targetUnit();
    u.deps.retention = () => RET;
    await copied(u);
    await u.target.cancel(cancelT('age-out'));
    const want = { kind: 'move.phase', moveId: MOVE, role: 'target', phase: 'cancelled', ok: true, keepDays: 30, returnPending: true };
    expect(u.events.at(-1)).toEqual(want);
    valid(u.events.at(-1)!);
    await new MoveTarget(u.deps).cancel(cancelT('age-out'));
    expect(u.events.at(-1)).toEqual(want);
  }, 60_000);

  it('a source finish and cancel carry keepDays, also from the tombstone', async () => {
    const u = sourceUnit();
    u.deps.retention = () => RET;
    u.journal.save(sourceRecord());
    await u.source.finish(finishArgs('source'));
    const fin = { kind: 'move.phase', moveId: MOVE, role: 'source', phase: 'finished', ok: true, keepDays: 30 };
    expect(u.events.at(-1)).toEqual(fin);
    valid(u.events.at(-1)!);
    await new MoveSource(u.deps).finish(finishArgs('source'));
    expect(u.events.at(-1)).toEqual(fin);

    const c = sourceUnit({ released: false });
    c.deps.retention = () => RET;
    c.journal.save(sourceRecord({ phase: 'opened', plan: null, expectedLeaf: undefined }));
    await c.source.cancel({ v: 1, moveId: MOVE, role: 'source' });
    const can = { kind: 'move.phase', moveId: MOVE, role: 'source', phase: 'cancelled', ok: true, keepDays: 30 };
    expect(c.events.at(-1)).toEqual(can);
    valid(c.events.at(-1)!);
    await new MoveSource(c.deps).cancel({ v: 1, moveId: MOVE, role: 'source' });
    expect(c.events.at(-1)).toEqual(can);
  }, 60_000);
});

describe("a return's record refuses a plain finish and cancel (step 4, Task 9 review I1)", () => {
  const RETURN_OF = 'mv_9123456789ABCDEFGHJK';

  it('source: a plain move.finish or move.cancel naming a return answers wrong_phase and deletes nothing', async () => {
    const u = sourceUnit({ added: true, released: false });
    content(u.dataDir, u.catalog, 'cam3');
    const before = rows(u.catalog, 'cam3');
    // The new proxy's return source record (the camera's node removed at the cancel).
    u.journal.save(sourceRecord({ returnOf: RETURN_OF, plan: null, expectedLeaf: undefined }));
    expect(await u.source.finish(finishArgs('source'))).toEqual({ status: 'failed', code: 'wrong_phase' });
    expect(await u.source.finish(finishArgs('source', true))).toEqual({ status: 'failed', code: 'wrong_phase' });
    expect(await u.source.cancel({ v: 1, moveId: MOVE, role: 'source' })).toEqual({ status: 'failed', code: 'wrong_phase' });
    expect(rows(u.catalog, 'cam3')).toBe(before);
    expect(u.journal.load(MOVE)).toMatchObject({ role: 'source', phase: 'released', returnOf: RETURN_OF });
    expect(u.calls).toEqual([]);
    expect(u.journal.ended(MOVE, 'source')).toBeNull();
  });

  it('target: a plain move.finish or move.cancel naming a return answers wrong_phase; the record stays', async () => {
    const u = targetUnit();
    u.journal.save({ ...offered({ phase: 'copying', returnOf: RETURN_OF, plan: PLAN }), cameraConnection: undefined });
    expect(await u.target.finish(finishArgs('target'))).toEqual({ status: 'failed', code: 'wrong_phase' });
    expect(await u.target.cancel(cancelT('delete'))).toEqual({ status: 'failed', code: 'wrong_phase' });
    expect(u.journal.load(MOVE)).toMatchObject({ role: 'target', phase: 'copying', returnOf: RETURN_OF });
    expect(u.stopped).toEqual([]);
    expect(u.journal.ended(MOVE, 'target')).toBeNull();
  });
});
