// The post-move sync end to end (issue #311): a real proxy over a cam-sim
// whose SD card holds a recording neither proxy has (recorded while the
// camera switched over). The move's last command comes from a scripted
// cams-admin; its record is written into the journal as the earlier phases
// would have left it (the whole move: test/move-e2e.test.ts). Then the proxy
// runs the clips check with the camera, the repair, the check again, and the
// events check and repair, with the real inventory runner, and records the
// outcome in the move's tombstone. Documentation addresses and made-up
// tokens only; never a real camera.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SeedClip } from 'cam-sim';
import { writeKeyFile } from '../src/fleet/keyfile';
import { writePrivateJson } from '../src/fleet/private-file';
import type { Envelope } from '../src/fleet/protocol';
import { setLogLevel } from '../src/log';
import { MoveJournal, type MoveRecord } from '../src/moves/journal';
import { hashMoveToken } from '../src/moves/token';
import type { MovePlan } from '../src/moves/types';
import { utcDayParts, utcHhmm } from '../src/time-units';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { startMultiProxy } from './helpers/multi';
import { ADMIN_TOKEN, auth, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

const MOVE = 'mv_0S0123456789ABCDEFGH';
const PEER = 'prx_7123456789ABCDEFGHJK';
const TOKEN = 'sync-flow-token-'.padEnd(43, 'z');
const DAY = 86_400_000;
const PLAN: MovePlan = { transfer: true, kinds: ['clips'], space: 'all', targetSettings: null, budgetS: 3600, estimateS: 60 };
// Yesterday (camera time UTC): three recordings; the proxy has the first two, the third is on neither proxy.
const SEED: SeedClip[] = [
  { daysAgo: 1, start: '080000', end: '080030', triggers: ['motion'] },
  { daysAgo: 1, start: '100000', end: '100030', triggers: ['person'] },
  { daysAgo: 1, start: '120000', end: '120030', triggers: ['motion'] },
];
const yesterday = (h: number) => Math.floor(Date.now() / DAY) * DAY - DAY + h * 3600_000;

beforeAll(() => setLogLevel('silent'));

type P = Awaited<ReturnType<typeof startMultiProxy>>;
const bodyOf = (r: { msg: Envelope }) => r.msg.body as Record<string, any>;
const auditRecords = (p: P) => {
  const dir = join(p.dir, 'data', 'audit');
  return readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: { action: string; outcome: string }; message: string; cam_proxy?: Record<string, any> }));
};

// One proxy with cam3 on a seeded cam-sim; `moved`: cam3 starts hidden by this move (the original proxy after the release).
async function world(o: { moved?: boolean }) {
  const sim = await startSim({ seedClips: SEED, tz: 'UTC' });
  const fake = await startFakeAdmin();
  fake.welcomeHeartbeatS = 1;
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-syncflow-'));
  writeKeyFile(join(dir, 'data', 'admin', 'key.json'), fake.keyFile());
  writePrivateJson(join(dir, 'data', 'admin', 'policy.json'), { v: 1, allow: ['move.send', 'move.receive'], consent: 3, changedAt: 1, changedBy: 'local' });
  if (o.moved) writeFileSync(join(dir, 'data', 'overrides.json'), JSON.stringify({ cameras: { cam3: { moved: MOVE } } }));
  const p = await startMultiProxy([sim], {
    dir,
    proxy: {
      camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200 } },
      moveSync: { retryMs: 200, retryCapMs: 1000, busyMs: 200, returnGraceMs: 300, returnPollMs: 200 },
    },
    settings: { camsAdmin: { url: fake.url }, ftp: { enabled: false, stream: 'sub' } },
  });
  await until(() => fake.welcomed() === 1, 30_000);
  // The clips the proxy has: the first two recordings (as FTP brought them).
  for (const h of [8, 10]) {
    const ts = yesterday(h);
    const path = join(dir, 'data', 'clips', 'cam3', ...utcDayParts(ts), `${utcHhmm(ts)}-${ts}.mp4`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.alloc(1000));
    p.proxy.catalog.db.prepare("INSERT INTO clips (cam, start_ts, end_ts, path, stream, size, received_at) VALUES ('cam3', ?, ?, ?, 'sub', 1000, ?)").run(ts, ts + 30_000, path, ts + 60_000);
  }
  const journal = new MoveJournal(join(dir, 'data', 'admin', 'moves'));
  const done = async (command: string, args: Record<string, unknown>) => {
    const sent = fake.sendCommand(command, args, { actor: 'admin@example.org' });
    await until(() => fake.results(sent.cmdId).some((r) => ['done', 'refused'].includes(bodyOf(r).phase)), 60_000);
    return bodyOf(fake.results(sent.cmdId).at(-1)!);
  };
  const close = async () => {
    await p.proxy.stop();
    await fake.close();
    await sim.close();
  };
  return { p, sim, fake, journal, done, close };
}
type World = Awaited<ReturnType<typeof world>>;

const record = (over: Partial<MoveRecord>): MoveRecord => ({
  v: 1, id: MOVE, role: 'target', camera: 'cam3', phase: 'copied', plan: PLAN,
  peer: { proxyId: PEER, name: 'Garage Pi', ip: '127.0.0.1' }, chunks: {}, bytesDone: 0, startedAt: Date.now() - 120_000, approvedAt: Date.now() - 110_000, ...over,
});

// What both sides check once the sync ended: the missing recording fetched, the record and the audit.
async function expectSynced(w: World, role: 'source' | 'target', trigger: 'finished' | 'cancelled') {
  await until(() => ['done', 'failed', 'gave-up'].includes(w.journal.ended(MOVE, role)?.sync?.state ?? ''), 120_000);
  const s = w.journal.ended(MOVE, role)!.sync!;
  expect(s, JSON.stringify(s)).toMatchObject({ state: 'done', trigger, camera: 'cam3', clips: { missingBefore: 1, fetched: 1, missingAfter: 0, stopped: null } });
  // Its events: the check found the recordings' spans without an event and the repair added them.
  expect(s.events!.missing).toBeGreaterThan(0);
  expect(s.events!.added).toBe(s.events!.missing);
  // The recording at 12:00 is a clip here now, from the camera.
  const rows = w.p.proxy.catalog.db.prepare("SELECT start_ts, origin FROM clips WHERE cam = 'cam3' ORDER BY start_ts").all() as { start_ts: number; origin: string | null }[];
  expect(rows).toHaveLength(3);
  expect(Math.abs(rows[2].start_ts - yesterday(12))).toBeLessThanOrEqual(5_000);
  expect(rows[2].origin).toBe('camera');
  // Audited: the sync's start and end, and the inventory runs it started (the system's).
  const recs = auditRecords(w.p);
  const sync = recs.filter((r) => r.event.action === 'move-sync');
  expect(sync.map((r) => [r.cam_proxy!.step, r.event.outcome])).toEqual([['start', 'success'], ['end', 'success']]);
  expect(sync[1].cam_proxy).toMatchObject({ moveId: MOVE, camera: 'cam3', role, trigger, state: 'done', clips: s.clips, events: s.events, stopped: null });
  const runs = recs.filter((r) => r.event.action === 'inventory' || r.event.action === 'inventory-repair');
  expect(runs.map((r) => `${r.event.action} ${r.cam_proxy!.kind}`)).toEqual(['inventory clips', 'inventory-repair clips', 'inventory clips', 'inventory events', 'inventory-repair events']);
  expect(runs.every((r) => r.cam_proxy!.requestedBy === 'system')).toBe(true);
  // The control API lists it.
  const list = (await request(w.p.base).get('/control/moves/syncs').set(auth(ADMIN_TOKEN)).expect(200)).body;
  expect(list.items).toEqual([{ moveId: MOVE, role, camera: 'cam3', sync: s }]);
}

describe('the receiving proxy after move.finish', () => {
  let w: World;
  beforeAll(async () => {
    w = await world({});
  }, 120_000);
  afterAll(async () => w?.close());

  it('fetches the recording neither proxy has and records it on the move', async () => {
    await until(() => w.p.proxy.cameras.get('cam3')?.status.state().online === true, 30_000);
    // The move as the switch-over and the copy left it: the camera here, copied.
    w.journal.save(record({ role: 'target', phase: 'copied', cameraWritten: true, token: TOKEN }));
    const fin = await w.done('move.finish', { v: 1, moveId: MOVE, role: 'target', abandoned: false });
    expect(fin, JSON.stringify(fin)).toMatchObject({ phase: 'done', status: 'ok' });
    expect(w.journal.ended(MOVE, 'target')).toMatchObject({ phase: 'finished' });
    await expectSynced(w, 'target', 'finished');
  }, 180_000);
});

describe('the original proxy after a cancel past the switch-over', () => {
  let w: World;
  beforeAll(async () => {
    w = await world({ moved: true });
  }, 120_000);
  afterAll(async () => w?.close());

  it('fetches the recording neither proxy has once the camera runs here again', async () => {
    expect(w.p.proxy.cameras.get('cam3')).toBeUndefined();
    // The move as the release left it: the camera hidden here (moved), running on the other proxy.
    w.journal.save(record({ role: 'source', phase: 'released', tokenHash: hashMoveToken(TOKEN), requestId: 'rq_0123456789ABCDEFGHJK', answer: { accept: true }, manifest: [] }));
    const c = await w.done('move.cancel', { v: 1, moveId: MOVE, role: 'source' });
    expect(c, JSON.stringify(c)).toMatchObject({ phase: 'done', status: 'ok' });
    await until(() => w.journal.ended(MOVE, 'source')?.camera === 'cam3', 60_000);
    expect(w.journal.ended(MOVE, 'source')!.sync).toMatchObject({ trigger: 'cancelled' });
    await expectSynced(w, 'source', 'cancelled');
  }, 180_000);
});
