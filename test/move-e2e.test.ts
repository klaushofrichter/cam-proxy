// A whole camera move end to end (camera-move plan Task 12, S §4–§12): two
// real proxies, both with a site CA covering one cam-sim, and a scripted
// cams-admin (one FakeAdmin per proxy, relayed by this test in the order of
// the cams-admin plan, Tasks 4–6): request → move.open / move.offer →
// move.answer → approve → move.start / move.go → switched → move.release →
// copy → copied → move.finish (source, then target) → done.
// Documentation addresses (RFC 5737) and made-up tokens only; never a real camera.
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cameraPasswordStore } from '../src/config/camera-passwords';
import { writeKeyFile } from '../src/fleet/keyfile';
import { writePrivateJson } from '../src/fleet/private-file';
import { newId, type Envelope } from '../src/fleet/protocol';
import { setLogLevel } from '../src/log';
import { MoveJournal } from '../src/moves/journal';
import { hashMoveToken } from '../src/moves/token';
import type { MovePlan, MoveSummary, Space } from '../src/moves/types';
import { minutePath } from '../src/stills/store';
import { fingerprintOf } from '../src/tls/ca';
import { servedFingerprint } from '../src/tls/served';
import { utcDayParts, utcHhmm } from '../src/time-units';
import { strict, why } from './helpers/contract';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { ADMIN_TOKEN, auth, freePort, until } from './helpers/proxy';

const DAY = 86_400_000;
const TLS = (site: string) => ({ site, cameraSubnet: '127.0.0.0/16', proxyAddresses: '127.0.0.1' });
const bodyOf = (r: { msg: Envelope }) => r.msg.body as Record<string, any>;
const TOKEN = randomBytes(32).toString('base64url');
const SOURCE_FTP_PASSWORD = 'src-ftp-'.padEnd(24, 's');
const TARGET_FTP_PASSWORD = 'tgt-ftp-'.padEnd(24, 't');
const go2rtc = !!process.env.CAMPROXY_TEST_GO2RTC;

beforeAll(() => setLogLevel('silent'));

type P = Awaited<ReturnType<typeof startMultiProxy>>;
const dataOf = (p: P) => p.proxy.loaded.config.server.dataDir;
const put = (path: string, bytes: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, randomBytes(bytes));
};
// The seeded days: yesterday and the day before (UTC noon), far from the switch-over day.
const SEED_DAYS = [1, 2].map((n) => Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - n * DAY + 12 * 3600_000);
// One day's content of cam3 on the source: two still minutes, a clip with its snapshot and row, an event row.
function seed(p: P, ts: number): void {
  const dataDir = dataOf(p);
  put(`${minutePath(dataDir, 'stills', 'cam3', ts)}.pack`, 2000);
  put(`${minutePath(dataDir, 'stills', 'cam3', ts + 60_000)}.pack`, 2000);
  const clip = join(dataDir, 'clips', 'cam3', ...utcDayParts(ts), `${utcHhmm(ts)}-1.mp4`);
  const snap = clip.replace(/\.mp4$/, '.jpg');
  put(clip, 5000);
  put(snap, 500);
  p.proxy.catalog.db.prepare("INSERT INTO clips (cam, start_ts, path, snapshot, stream, size, received_at) VALUES ('cam3', ?, ?, ?, 'sub', 5000, ?)").run(ts, clip, snap, ts);
  p.proxy.catalog.db.prepare("INSERT INTO events (cam, source, kind, start_ts) VALUES ('cam3', 'onvif', 'person', ?)").run(ts);
}
// What one proxy has of cam3 on the seeded days: rows per table, still files.
function seeded(p: P): { clips: number; events: number; stills: number } {
  const dataDir = dataOf(p);
  const lo = Math.min(...SEED_DAYS) - 12 * 3600_000;
  const hi = Math.max(...SEED_DAYS) + 12 * 3600_000;
  const n = (sql: string) => (p.proxy.catalog.db.prepare(sql).get('cam3', lo, hi) as { n: number }).n;
  let stills = 0;
  for (const ts of SEED_DAYS) {
    const dir = dirname(minutePath(dataDir, 'stills', 'cam3', ts));
    if (existsSync(dir)) stills += readdirSync(dir).length;
  }
  return {
    clips: n('SELECT COUNT(*) AS n FROM clips WHERE cam = ? AND start_ts >= ? AND start_ts < ?'),
    events: n('SELECT COUNT(*) AS n FROM events WHERE cam = ? AND start_ts >= ? AND start_ts < ?'),
    stills,
  };
}
const auditText = (p: P) => {
  const dir = join(p.dir, 'data', 'audit');
  return readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
};
const actionsOf = (p: P) => new Set(auditText(p).split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { event?: { action?: string } }).event?.action).filter((a): a is string => !!a?.startsWith('move-')));

let sims: Sim[];
let fakeS: FakeAdmin;
let fakeT: FakeAdmin;
let S: P;
let T: P;
let sourceId = '';
let targetId = '';
let sourceFtp = 0;
let targetFtp = 0;

// cams-admin's side: a command to one proxy, its final answer (must be ok and match its result schema).
const run = async (fake: FakeAdmin, command: string, args: Record<string, unknown>) => {
  const sent = fake.sendCommand(command, args, { actor: 'admin@example.org' });
  await until(() => fake.results(sent.cmdId).some((r) => ['done', 'refused'].includes(bodyOf(r).phase)), 60_000);
  const b = bodyOf(fake.results(sent.cmdId).at(-1)!);
  expect(b, `${command}: ${JSON.stringify(b)}`).toMatchObject({ phase: 'done', status: 'ok' });
  const v = strict(`commands/${command}.result`);
  expect(v(b.result ?? {}), `${command}: ${why(v)}`).toBe(true);
  return b.result as Record<string, any>;
};
const events = (fake: FakeAdmin, kind: string) => fake.events().map(bodyOf).filter((b) => b.kind === kind);
const phases = (fake: FakeAdmin, moveId: string) => events(fake, 'move.phase').filter((e) => e.moveId === moveId).map((e) => e.phase as string);

// One world per describe: two proxies, a scripted cams-admin each, one cam-sim. The state lives
// at module level (describes run one after the other), the tests are defined inside.
function world(title: string, tests: () => void): void {
  describe(title, () => {
    beforeAll(async () => {
      sims = await startSims(1);
      [fakeS, fakeT] = await Promise.all([startFakeAdmin(), startFakeAdmin()]);
      fakeS.welcomeHeartbeatS = 1;
      fakeT.welcomeHeartbeatS = 1;
      const timing = { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200 } }, tlsPush: { clearWaitMs: 50, verifyMs: 5000, pollMs: 100 } };
      const ftp = async (port: number) => {
        const passive = await freePort();
        return { enabled: true, port, passive: `${passive}-${passive + 19}`, publicHost: '127.0.0.1', tls: true, stream: 'sub' };
      };
      sourceFtp = await freePort();
      targetFtp = await freePort();
      const sdir = mkdtempSync(join(tmpdir(), 'camproxy-e2e-src-'));
      const sk = fakeS.keyFile();
      sourceId = sk.proxyId;
      writeKeyFile(join(sdir, 'data', 'admin', 'key.json'), sk);
      writePrivateJson(join(sdir, 'data', 'admin', 'policy.json'), { v: 1, allow: ['move.send'], consent: 3, changedAt: 1, changedBy: 'local' });
      S = await startMultiProxy(sims, { dir: sdir, https: true, env: { CAMPROXY_FTP_PASSWORD: SOURCE_FTP_PASSWORD }, proxy: timing, settings: { tls: TLS('s'), camsAdmin: { url: fakeS.url }, ftp: await ftp(sourceFtp) } });
      // The target has a camera of its own and a default camera password that is not the sim's.
      const tdir = mkdtempSync(join(tmpdir(), 'camproxy-e2e-tgt-'));
      const tk = fakeT.keyFile();
      targetId = tk.proxyId;
      writeKeyFile(join(tdir, 'data', 'admin', 'key.json'), tk);
      writePrivateJson(join(tdir, 'data', 'admin', 'policy.json'), { v: 1, allow: ['move.receive'], consent: 3, changedAt: 1, changedBy: 'local' });
      T = await startMultiProxy([], {
        dir: tdir, extra: [{ id: 'cam1', host: '' }], env: { CAMPROXY_CAMERA_PASSWORD: 'not-the-camera-pw', CAMPROXY_FTP_PASSWORD: TARGET_FTP_PASSWORD },
        proxy: { ...timing, moves: { retryMs: 200, retryCapMs: 1000 } },
        settings: { tls: TLS('u'), camsAdmin: { url: fakeT.url }, ftp: await ftp(targetFtp) },
      });
      await until(() => fakeS.open() === 1 && fakeT.open() === 1 && S.proxy.cameras.get('cam3')!.status.state().online, 30_000);
      await S.proxy.certs!.tick();
      expect(S.proxy.certs!.state('cam3').mode).toBe('site-ca');
      for (const ts of SEED_DAYS) seed(S, ts);
    }, 180_000);
    afterAll(async () => {
      await Promise.all([S?.proxy.stop(), T?.proxy.stop()]);
      await Promise.all([fakeS?.close(), fakeT?.close()]);
      await Promise.all((sims ?? []).map((s) => s.close()));
    });

    tests();
  });
}

world('a camera move end to end (two proxies, one cam-sim)', () => {
  it('moves cam3 with its content from the source to the target', async () => {
    const before = seeded(S);
    expect(before).toEqual({ clips: 2, events: 2, stills: 4 });
    const ownLeaf = S.proxy.certs!.state('cam3').fingerprint!;
    const admin = auth(ADMIN_TOKEN);

    // 1. The source's page: the target list, then the request.
    const tr = await request(S.base).post('/control/moves/targets').set(admin).send({ camera: 'cam3' }).expect(202);
    await until(() => events(fakeS, 'move.targets').some((e) => e.requestId === tr.body.requestId), 10_000);
    await run(fakeS, 'move.targets', { v: 1, requestId: tr.body.requestId, targets: [{ proxyId: targetId, name: 'Mini PC', site: 'u' }] });
    const rq = await request(S.base).post('/control/moves').set(admin).send({ camera: 'cam3', target: targetId }).expect(202);
    const requestId = rq.body.requestId as string;
    await until(() => events(fakeS, 'move.request').some((e) => e.requestId === requestId), 10_000);
    const req = events(fakeS, 'move.request').find((e) => e.requestId === requestId)!;
    expect(req.summary.clips).toMatchObject({ files: 4, rows: 2 });

    // 2. cams-admin: the token, move.open to the source, move.offer to the target (R4: bound to the target's address).
    const moveId = newId('mv_');
    await run(fakeS, 'move.open', { v: 1, moveId, requestId, camera: 'cam3', tokenHash: hashMoveToken(TOKEN), targetIp: '127.0.0.1' });
    const caPem = (await request(S.base).get('/tls/ca.pem').expect(200)).text;
    const offer = await run(fakeT, 'move.offer', {
      v: 1, moveId, token: TOKEN,
      source: { proxyId: sourceId, name: 'Garage Pi', url: S.base, caFingerprints: [fingerprintOf(caPem)], tlsServername: 'proxy.s.internal' },
      camera: { camsId: 'garden-cam', ...req.camera }, summary: req.summary, settings: req.settings,
    });
    expect(offer).toMatchObject({ accept: true, space: { fits: true } });
    expect(offer.probeBps).toBeGreaterThan(0);

    // 3. move.answer to the source with cams-admin's estimate.
    const summary = req.summary as MoveSummary;
    const kinds = (['stills', 'clips', 'events'] as const).filter((k) => summary[k].files + summary[k].rows > 0);
    expect(kinds).toEqual(['stills', 'clips', 'events']);
    const bytes = kinds.reduce((n, k) => n + summary[k].bytes, 0);
    const estimateS = Math.max(1, Math.ceil(bytes / offer.probeBps));
    await run(fakeS, 'move.answer', { v: 1, moveId, requestId, target: { proxyId: targetId, name: 'Mini PC' }, accept: true, space: offer.space as Space, estimateS });

    // 4. The admin approves on the source's page: the move.approve event carries the plan. The copy
    // fills its budget (S §8.3): 20 s for these few kB.
    const plan: MovePlan = { transfer: true, kinds: [...kinds], space: 'all', targetSettings: null, budgetS: Math.max(estimateS, 20), estimateS };
    await request(S.base).post(`/control/moves/${moveId}/approve`).set(admin).send({ plan }).expect(202);
    await until(() => events(fakeS, 'move.approve').some((e) => e.moveId === moveId), 10_000);
    const approved = events(fakeS, 'move.approve').find((e) => e.moveId === moveId)!.plan as MovePlan;

    // 5. move.start to the target; its key and leaf go to the source in move.go (the plan as approved).
    const started = await run(fakeT, 'move.start', { v: 1, moveId, plan: approved, settings: req.settings, done: [] });
    // While the camera switches over, at every moment one of the two proxies has it online.
    const samples: { s: boolean; t: boolean }[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        samples.push({ s: S.proxy.cameras.get('cam3')?.status.state().online === true, t: T.proxy.cameras.get('cam3')?.status.state().online === true });
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    let goAt = Date.now();
    if (go2rtc) {
      // The source grabs until the release, but a grabber that just came up has no still yet: go
      // only once it has one of the current minute, or that minute has a still nowhere.
      const grabber = S.proxy.cameras.get('cam3')!.stills!.grabber;
      await until(() => {
        goAt = Date.now();
        const ts = grabber.lastFrameTs();
        return ts !== null && Math.floor(ts / 60_000) === Math.floor(goAt / 60_000);
      }, 60_000);
    }
    await run(fakeS, 'move.go', { v: 1, moveId, plan: approved, targetPublicKey: started.publicKey, expectedLeaf: started.leafFingerprint });

    // 6. switched on the target → move.release to the source (the target already copies, P12).
    await until(() => phases(fakeT, moveId).includes('switched'), 120_000);
    await until(() => T.proxy.cameras.get('cam3')?.status.state().online === true, 30_000);
    await run(fakeS, 'move.release', { v: 1, moveId });
    await until(() => phases(fakeS, moveId).includes('released'), 10_000);
    const releasedAt = Date.now();
    sampling = false;
    await sampler;
    expect(S.proxy.cameras.get('cam3')).toBeUndefined();
    expect(samples.length).toBeGreaterThan(5);
    expect(samples.filter((x) => !x.s && !x.t), 'a moment with the camera online on neither proxy').toEqual([]);
    if (go2rtc) {
      // Every minute of the switch-over has a still on the source or on the target.
      await until(() => T.proxy.cameras.get('cam3')!.stills?.grabber.up() === true, 30_000);
      await until(() => existsSync(`${minutePath(dataOf(T), 'stills', 'cam3', Math.floor(releasedAt / 60_000) * 60_000 + 60_000)}.pack`), 150_000);
      for (let m = Math.floor(goAt / 60_000) * 60_000; m <= releasedAt; m += 60_000) {
        const there = [S, T].some((p) => existsSync(`${minutePath(dataOf(p), 'stills', 'cam3', m)}.pack`));
        expect(there, `a still of ${new Date(m).toISOString()}`).toBe(true);
      }
    }

    // 7. The copy ends (copied) → move.finish to the source, then to the target (cams-admin: done).
    await until(() => phases(fakeT, moveId).includes('copied'), 180_000);
    const progress = events(fakeT, 'move.progress').filter((e) => e.moveId === moveId);
    expect(progress.length).toBeGreaterThan(0);
    for (const e of fakeT.events().filter((x) => String(bodyOf(x).kind).startsWith('move.'))) expect(strict('event')(e.msg), why(strict('event'))).toBe(true);
    for (const e of fakeS.events().filter((x) => String(bodyOf(x).kind).startsWith('move.'))) expect(strict('event')(e.msg), why(strict('event'))).toBe(true);
    const fs = await run(fakeS, 'move.finish', { v: 1, moveId, role: 'source', abandoned: false });
    expect(fs.deleted.clips.files).toBe(4);
    await run(fakeT, 'move.finish', { v: 1, moveId, role: 'target', abandoned: false });

    // The target has what the source had, runs the camera with the source's password, its leaf and its FTP.
    expect(seeded(T)).toEqual(before);
    expect(cameraPasswordStore(join(T.dir, 'data')).get('cam3')).toBe(sims[0].password);
    expect(await servedFingerprint('127.0.0.1', sims[0].ports.https)).toBe(started.leafFingerprint);
    expect(sims[0].sim.engine.settings.running.Ftp).toMatchObject({ enable: 1, server: '127.0.0.1', port: targetFtp, userName: 'cam3' });
    expect(T.proxy.cameras.get('cam3')?.status.state().online).toBe(true);
    // The source: purged, the config.json entry hidden, its password, leaf and expected leaf gone.
    expect(seeded(S)).toEqual({ clips: 0, events: 0, stills: 0 });
    for (const folder of ['stills', 'previews', 'clips', 'analytics', 'still-checks', 'archive']) {
      const dir = join(dataOf(S), folder, 'cam3');
      expect(existsSync(dir) ? readdirSync(dir) : [], folder).toEqual([]);
    }
    expect(S.proxy.loaded.config.cameras.cam3.moved).toBe(moveId);
    expect(S.proxy.cameras.get('cam3')).toBeUndefined();
    expect(S.proxy.certs!.expected('cam3')).toBeNull();
    expect(S.proxy.certs!.state('cam3').fingerprint).not.toBe(ownLeaf);
    // Both journals closed, both sides reported finished.
    expect(new MoveJournal(join(S.dir, 'data', 'admin', 'moves')).load(moveId)).toBeNull();
    expect(new MoveJournal(join(T.dir, 'data', 'admin', 'moves')).load(moveId)).toBeNull();
    expect(phases(fakeS, moveId)).toEqual(['opened', 'switching', 'released', 'finished']);
    expect(phases(fakeT, moveId).slice(0, 3)).toEqual(['switching', 'switched', 'copying']);
    expect(phases(fakeT, moveId).slice(-2)).toEqual(['copied', 'finished']);

    // Every audit action on the side that writes it, nothing of a failure; never a secret.
    const sa = actionsOf(S);
    const ta = actionsOf(T);
    for (const a of ['move-request', 'move-approve', 'move-switch', 'move-phase', 'move-cleanup', 'move-done']) expect(sa.has(a), `source ${a}`).toBe(true);
    for (const a of ['move-offer', 'move-switch', 'move-phase', 'move-progress', 'move-done']) expect(ta.has(a), `target ${a}`).toBe(true);
    for (const a of ['move-token-refused', 'move-budget-exceeded', 'move-file-failed', 'move-source-unreachable', 'move-cancel']) {
      expect(sa.has(a), `source ${a}`).toBe(false);
      expect(ta.has(a), `target ${a}`).toBe(false);
    }
    expect(ta.has('move-offer') && !sa.has('move-offer')).toBe(true);
    expect(sa.has('move-cleanup') && !ta.has('move-cleanup')).toBe(true);
    for (const p of [S, T]) {
      const text = auditText(p);
      for (const secret of [TOKEN, sims[0].password, 'PRIVATE KEY', SOURCE_FTP_PASSWORD, TARGET_FTP_PASSWORD]) expect(text.includes(secret), `${p === S ? 'source' : 'target'} audit has a secret`).toBe(false);
    }
    // The token is refused after the end.
    expect((await request(S.base).get(`/api/moves/${moveId}/manifest`).set('Authorization', `Bearer ${TOKEN}`)).status).toBe(403);
  }, 420_000);
});

// The same move, started by cams-admin with bounds (move.begin): nobody clicks Approve move.
world('a camera move started by cams-admin is approved by the source within its bounds', () => {
  it('an auto-approved move started by move.begin ends done', async () => {
    const before = seeded(S);
    expect(before).toEqual({ clips: 2, events: 2, stills: 4 });

    // 1. cams-admin starts the move on the source, with its bounds; the request event carries them.
    const bounds = { transfer: true, kinds: ['stills', 'clips', 'events', 'checks', 'archive'], space: 'fit', maxBudgetS: 3600 };
    const begun = await run(fakeS, 'move.begin', { v: 1, camera: 'cam3', target: targetId, bounds });
    const requestId = begun.requestId as string;
    expect(strict('commands/move.begin.result')(begun), why(strict('commands/move.begin.result'))).toBe(true);
    await until(() => events(fakeS, 'move.request').some((e) => e.requestId === requestId), 10_000);
    const req = events(fakeS, 'move.request').find((e) => e.requestId === requestId)!;
    expect(req.bounds).toEqual(bounds);
    expect(req.summary.clips).toMatchObject({ files: 4, rows: 2 });

    // 2. move.open to the source, move.offer to the target, move.answer to the source (the CA order).
    const moveId = newId('mv_');
    await run(fakeS, 'move.open', { v: 1, moveId, requestId, camera: 'cam3', tokenHash: hashMoveToken(TOKEN), targetIp: '127.0.0.1' });
    const caPem = (await request(S.base).get('/tls/ca.pem').expect(200)).text;
    const offer = await run(fakeT, 'move.offer', {
      v: 1, moveId, token: TOKEN,
      source: { proxyId: sourceId, name: 'Garage Pi', url: S.base, caFingerprints: [fingerprintOf(caPem)], tlsServername: 'proxy.s.internal' },
      camera: { camsId: 'garden-cam', ...req.camera }, summary: req.summary, settings: req.settings,
    });
    expect(offer).toMatchObject({ accept: true, space: { fits: true } });
    const summary = req.summary as MoveSummary;
    const kinds = (['stills', 'clips', 'events'] as const).filter((k) => summary[k].files + summary[k].rows > 0);
    const bytes = kinds.reduce((n, k) => n + summary[k].bytes, 0);
    const estimateS = Math.max(1, Math.ceil(bytes / offer.probeBps));
    await run(fakeS, 'move.answer', { v: 1, moveId, requestId, target: { proxyId: targetId, name: 'Mini PC' }, accept: true, space: offer.space as Space, estimateS });

    // 3. Nobody approves: the source does it, within the bounds. cams-admin relays move.start / move.go.
    await until(() => events(fakeS, 'move.approve').some((e) => e.moveId === moveId), 10_000);
    const approved = events(fakeS, 'move.approve').find((e) => e.moveId === moveId)!.plan as MovePlan;
    expect(approved).toMatchObject({ transfer: true, space: 'all', estimateS });
    expect(approved.budgetS).toBeLessThanOrEqual(bounds.maxBudgetS);
    expect(approved.budgetS).toBeGreaterThanOrEqual(estimateS);
    const started = await run(fakeT, 'move.start', { v: 1, moveId, plan: approved, settings: req.settings, done: [] });
    await run(fakeS, 'move.go', { v: 1, moveId, plan: approved, targetPublicKey: started.publicKey, expectedLeaf: started.leafFingerprint });

    // 4. The rest as in the page-started move.
    await until(() => phases(fakeT, moveId).includes('switched'), 120_000);
    await until(() => T.proxy.cameras.get('cam3')?.status.state().online === true, 30_000);
    await run(fakeS, 'move.release', { v: 1, moveId });
    await until(() => phases(fakeS, moveId).includes('released'), 10_000);
    await until(() => phases(fakeT, moveId).includes('copied'), 180_000);
    for (const fake of [fakeS, fakeT]) for (const e of fake.events().filter((x) => String(bodyOf(x).kind).startsWith('move.'))) expect(strict('event')(e.msg), why(strict('event'))).toBe(true);
    await run(fakeS, 'move.finish', { v: 1, moveId, role: 'source', abandoned: false });
    await run(fakeT, 'move.finish', { v: 1, moveId, role: 'target', abandoned: false });

    // The target serves cam3 with its copied days; the source has none left; both journals are closed.
    expect(seeded(T)).toEqual(before);
    expect(T.proxy.cameras.get('cam3')?.status.state().online).toBe(true);
    expect(seeded(S)).toEqual({ clips: 0, events: 0, stills: 0 });
    expect(S.proxy.cameras.get('cam3')).toBeUndefined();
    expect(new MoveJournal(join(S.dir, 'data', 'admin', 'moves')).load(moveId)).toBeNull();
    expect(new MoveJournal(join(T.dir, 'data', 'admin', 'moves')).load(moveId)).toBeNull();
    expect(phases(fakeS, moveId)).toEqual(['opened', 'switching', 'released', 'finished']);

    // The approval is the auto-approval's, and nothing was left waiting.
    const approveLines = auditText(S).split('\n').filter((l) => l.includes('"move-approve"'));
    expect(approveLines.length).toBe(1);
    expect(approveLines[0]).toContain('cams-admin auto-approval');
    const sa = actionsOf(S);
    for (const a of ['move-request', 'move-approve', 'move-switch', 'move-done']) expect(sa.has(a), `source ${a}`).toBe(true);
    expect(sa.has('move-auto-approve')).toBe(false);
    for (const p of [S, T]) {
      const text = auditText(p);
      for (const secret of [TOKEN, sims[0].password, 'PRIVATE KEY', SOURCE_FTP_PASSWORD, TARGET_FTP_PASSWORD]) expect(text.includes(secret), 'an audit has a secret').toBe(false);
    }
  }, 420_000);
});

// A cancel after the switch-over (step 4 Task 11, spec §1): the camera goes back,
// then the return (copy back) brings what the target captured itself to the
// original; the target then deletes what the original verified and what the
// move had imported. cams-admin's relay is this test (return.open, return.start, finish).
world('a cancel after the switch-over copies the target\'s capture back', () => {
  it('cancel after the switch-over copies the target\'s capture back', async () => {
    const before = seeded(S);
    expect(before).toEqual({ clips: 2, events: 2, stills: 4 });
    const admin = auth(ADMIN_TOKEN);

    // 1. The move, as above, up to copied (its imports are on the target).
    const tr = await request(S.base).post('/control/moves/targets').set(admin).send({ camera: 'cam3' }).expect(202);
    await until(() => events(fakeS, 'move.targets').some((e) => e.requestId === tr.body.requestId), 10_000);
    await run(fakeS, 'move.targets', { v: 1, requestId: tr.body.requestId, targets: [{ proxyId: targetId, name: 'Mini PC', site: 'u' }] });
    const rq = await request(S.base).post('/control/moves').set(admin).send({ camera: 'cam3', target: targetId }).expect(202);
    const requestId = rq.body.requestId as string;
    await until(() => events(fakeS, 'move.request').some((e) => e.requestId === requestId), 10_000);
    const req = events(fakeS, 'move.request').find((e) => e.requestId === requestId)!;
    const moveId = newId('mv_');
    await run(fakeS, 'move.open', { v: 1, moveId, requestId, camera: 'cam3', tokenHash: hashMoveToken(TOKEN), targetIp: '127.0.0.1' });
    const sourceCa = (await request(S.base).get('/tls/ca.pem').expect(200)).text;
    const offer = await run(fakeT, 'move.offer', {
      v: 1, moveId, token: TOKEN,
      source: { proxyId: sourceId, name: 'Garage Pi', url: S.base, caFingerprints: [fingerprintOf(sourceCa)], tlsServername: 'proxy.s.internal' },
      camera: { camsId: 'garden-cam', ...req.camera }, summary: req.summary, settings: req.settings,
    });
    const summary = req.summary as MoveSummary;
    const kinds = (['stills', 'clips', 'events'] as const).filter((k) => summary[k].files + summary[k].rows > 0);
    const estimateS = Math.max(1, Math.ceil(kinds.reduce((n, k) => n + summary[k].bytes, 0) / offer.probeBps));
    await run(fakeS, 'move.answer', { v: 1, moveId, requestId, target: { proxyId: targetId, name: 'Mini PC' }, accept: true, space: offer.space as Space, estimateS });
    const plan: MovePlan = { transfer: true, kinds: [...kinds], space: 'all', targetSettings: null, budgetS: Math.max(estimateS, 20), estimateS };
    await request(S.base).post(`/control/moves/${moveId}/approve`).set(admin).send({ plan }).expect(202);
    await until(() => events(fakeS, 'move.approve').some((e) => e.moveId === moveId), 10_000);
    const approved = events(fakeS, 'move.approve').find((e) => e.moveId === moveId)!.plan as MovePlan;
    const started = await run(fakeT, 'move.start', { v: 1, moveId, plan: approved, settings: req.settings, done: [] });
    await run(fakeS, 'move.go', { v: 1, moveId, plan: approved, targetPublicKey: started.publicKey, expectedLeaf: started.leafFingerprint });
    await until(() => phases(fakeT, moveId).includes('switched'), 120_000);
    await until(() => T.proxy.cameras.get('cam3')?.status.state().online === true, 30_000);
    await run(fakeS, 'move.release', { v: 1, moveId });
    await until(() => phases(fakeT, moveId).includes('copied'), 180_000);
    expect(seeded(T)).toEqual(before);

    // 2. The target's own capture while it had the camera: two still minutes and an Archive item.
    // Today (UTC): never one of the seeded days, whatever the time of day.
    const minute = Math.floor(Date.now() / DAY) * DAY;
    const ownStills = [minute, minute + 60_000].map((m) => `${minutePath(dataOf(T), 'stills', 'cam3', m)}.pack`);
    for (const p of ownStills) put(p, 1500);
    // A finished minute of live capture is its pack plus the preview sprite and its sidecar (src/stills/store.ts).
    const ownPreviews = [minute, minute + 60_000].flatMap((m) => {
      const base = minutePath(dataOf(T), 'previews', 'cam3', m);
      put(`${base}.jpg`, 800);
      writeFileSync(`${base}.json`, JSON.stringify({ v: 1, minute: m, cols: 10, rows: 6, tileW: 160, tileH: 90, intervalS: 1, present: [] }));
      return [`${base}.jpg`, `${base}.json`];
    });
    const created = Date.now() - 1000;
    const arcId = Number(T.proxy.catalog.db.prepare("INSERT INTO archive (cam, name, labels, created_at, recorded_from, recorded_to, quality, original, duration_s, bytes, files, source, thumb_from, created_by, metadata) VALUES ('cam3', 'Fox at the gate', '[]', ?, ?, ?, 'sub', 1, 10, 3000, '[\"clip.mp4\"]', 'clips', 'first', 'admin', '{}')").run(created, created - 20_000, created - 10_000).lastInsertRowid);
    put(join(dataOf(T), 'archive', 'cam3', String(arcId), 'clip.mp4'), 3000);
    await new Promise((r) => setTimeout(r, 20));

    // 3. Cancel after the switch-over: the target lets go first, then the source runs the camera again.
    await run(fakeT, 'move.cancel', { v: 1, moveId, role: 'target', copied: 'delete' });
    expect(events(fakeT, 'move.phase').filter((e) => e.moveId === moveId).at(-1)).toMatchObject({ phase: 'cancelled', returnPending: true });
    await run(fakeS, 'move.cancel', { v: 1, moveId, role: 'source', expectedLeaf: started.leafFingerprint });
    await until(() => new MoveJournal(join(S.dir, 'data', 'admin', 'moves')).ended(moveId, 'source')?.camera === 'cam3', 60_000);
    await until(() => S.proxy.cameras.get('cam3')?.status.state().online === true, 30_000);
    // Nothing deleted on the target by the cancel (the copy back decides).
    expect(seeded(T)).toEqual(before);

    // 4. The return: open on the target (the return's source), start on the original (its target).
    const returnId = newId('mv_');
    const RETURN_TOKEN = randomBytes(32).toString('base64url');
    const opened = await run(fakeT, 'move.return.open', { v: 1, moveId: returnId, returnOf: moveId, tokenHash: hashMoveToken(RETURN_TOKEN), targetIp: '127.0.0.1' });
    expect(opened.chunks).toBeGreaterThanOrEqual(2);
    const targetCa = (await request(T.base).get('/tls/ca.pem').expect(200)).text;
    const returnSource = { proxyId: targetId, name: 'Mini PC', url: T.base, caFingerprints: [fingerprintOf(targetCa)], tlsServername: 'proxy.u.internal' };
    await run(fakeS, 'move.return.start', { v: 1, moveId: returnId, returnOf: moveId, token: RETURN_TOKEN, done: [], source: returnSource });
    // cams-admin "restarts" (ruling 20): a new token at the new proxy (return.open again) and at
    // the original (return.start again), whose copier starts over from the record. A return is
    // not paced, so it copies at once.
    const RETURN_TOKEN_2 = randomBytes(32).toString('base64url');
    await run(fakeT, 'move.return.open', { v: 1, moveId: returnId, returnOf: moveId, tokenHash: hashMoveToken(RETURN_TOKEN_2), targetIp: '127.0.0.1' });
    await run(fakeS, 'move.return.start', { v: 1, moveId: returnId, returnOf: moveId, token: RETURN_TOKEN_2, done: [], source: returnSource });
    await until(() => phases(fakeS, returnId).includes('copied'), 180_000);
    expect(events(fakeS, 'move.phase').find((e) => e.moveId === returnId && e.phase === 'copied')).toMatchObject({ role: 'target', check: { complete: true } });

    // 5. The finish: the original (target role) first, then the new proxy (source role).
    // cam-sim keeps the target recording stills while it has the camera; on a slow run the switch-over and the
    // cancel fall in different minutes, and those finished minutes go back too. So: count what the target deletes.
    // The move's kind `stills` is the stills and the previews folders (src/moves/purge.ts): a finished
    // minute is a pack, a sprite and its sidecar (#252: CI counted 2 preview files the snapshot left out).
    const tFolders = ['stills', 'previews'].map((k) => join(dataOf(T), k, 'cam3'));
    const stillFiles = () => tFolders.flatMap((d) => (existsSync(d) ? (readdirSync(d, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)) : []));
    const tBefore = stillFiles();
    await run(fakeS, 'move.finish', { v: 1, moveId: returnId, role: 'target', abandoned: false, return: true });
    const fin = await run(fakeT, 'move.finish', { v: 1, moveId: returnId, role: 'source', abandoned: false, return: true });
    const tLeft = new Set(stillFiles());
    const tDeleted = tBefore.filter((f) => !tLeft.has(f));
    expect(fin.deleted.stills.files).toBe(tDeleted.length);
    expect(tDeleted.length).toBeGreaterThanOrEqual(4 + 2 + 4); // the move's 4 imported stills, the 2 captured minutes (pack, sprite, sidecar each; and any live capture)
    for (const p of [...ownStills, ...ownPreviews]) expect(tDeleted, p).toContain(p);
    // Only what the original holds (verified) was deleted.
    for (const f of tDeleted) expect(existsSync(f.replace(dataOf(T), dataOf(S))), f).toBe(true);
    expect(fin.deleted.archive.files).toBe(1);
    for (const fake of [fakeS, fakeT]) for (const e of fake.events().filter((x) => String(bodyOf(x).kind).startsWith('move.'))) expect(strict('event')(e.msg), why(strict('event'))).toBe(true);

    // The original has its own content, the target's captured stills and the Archive item with move.from.
    expect(seeded(S)).toEqual(before);
    for (const p of [...ownStills, ...ownPreviews]) expect(existsSync(p.replace(dataOf(T), dataOf(S))), p).toBe(true);
    const arc = S.proxy.catalog.db.prepare("SELECT id, name, metadata FROM archive WHERE cam = 'cam3'").all() as { id: number; name: string; metadata: string }[];
    expect(arc.map((a) => a.name)).toEqual(['Fox at the gate']);
    expect(JSON.parse(arc[0].metadata).move).toMatchObject({ moveId: returnId, from: { proxyId: targetId, name: 'Mini PC' } });
    expect(existsSync(join(dataOf(S), 'archive', 'cam3', String(arc[0].id), 'clip.mp4'))).toBe(true);
    // The new proxy has none of it: neither the imports nor its own capture; no move open any more.
    expect(seeded(T)).toEqual({ clips: 0, events: 0, stills: 0 });
    for (const p of [...ownStills, ...ownPreviews]) expect(existsSync(p), p).toBe(false);
    expect(T.proxy.catalog.db.prepare("SELECT COUNT(*) AS n FROM archive WHERE cam = 'cam3'").get()).toEqual({ n: 0 });
    const tj = new MoveJournal(join(T.dir, 'data', 'admin', 'moves'));
    const sj = new MoveJournal(join(S.dir, 'data', 'admin', 'moves'));
    expect(tj.active()).toEqual([]);
    expect(sj.active()).toEqual([]);
    expect(phases(fakeT, returnId)).toEqual(['released', 'released', 'finished']); // opened, re-keyed, finished
    expect(phases(fakeS, returnId).slice(-2)).toEqual(['copied', 'finished']);
    expect(sj.ended(moveId, 'source')).toMatchObject({ returned: true });
    expect(actionsOf(T).has('move-return') && actionsOf(S).has('move-return')).toBe(true);
    // The return's token is refused after the end; never a secret in an audit.
    expect((await request(T.base).get(`/api/moves/${returnId}/manifest`).set('Authorization', `Bearer ${RETURN_TOKEN_2}`)).status).toBe(403);
    for (const p of [S, T]) {
      const text = auditText(p);
      for (const secret of [TOKEN, RETURN_TOKEN, RETURN_TOKEN_2, sims[0].password, 'PRIVATE KEY']) expect(text.includes(secret), 'an audit has a secret').toBe(false);
    }
  }, 420_000);
});
