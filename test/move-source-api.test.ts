// The source's move endpoints and the move-token guard (camera-move plan Task 5,
// S §8.1, §8.3, §9.3; rulings B3/B31, B16, P5 cache). Mounted ahead of the
// client auth: the move token is their only guard.
import { generateKeyPairSync } from 'crypto';
import express from 'express';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import type { Server } from 'http';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { movesSourceApi, type MovesSourceDeps } from '../src/api/moves-api';
import { AuditLog } from '../src/audit/audit-log';
import { openCatalog } from '../src/catalog/db';
import { MoveJournal, type MoveRecord } from '../src/moves/journal';
import { listChunks } from '../src/moves/inventory';
import { unseal } from '../src/moves/seal';
import { hashMoveToken } from '../src/moves/token';
import { setLogLevel } from '../src/log';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, CLIENT_TOKEN, startProxy } from './helpers/proxy';

const MOVE = 'mv_0123456789ABCDEFGHJK';
const TOKEN = 'move-token-'.padEnd(43, 'q');
const TARGET_IP = '192.0.2.10';
const OTHER_IP = '192.0.2.99';
const PASSWORD = 'proxy-user-pw-'.padEnd(20, 'p');
const D1 = Date.UTC(2026, 9, 1, 12, 0);
const D2 = Date.UTC(2026, 9, 2, 0, 5);

beforeAll(() => setLogLevel('silent'));
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function fixture(o: { phase?: MoveRecord['phase']; busy?: boolean; journal?: MovesSourceDeps['journal'] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-movesrc-'));
  const catalog = openCatalog(join(dataDir, 'catalog.db'));
  const put = (rel: string, content: string) => {
    mkdirSync(dirname(join(dataDir, rel)), { recursive: true });
    writeFileSync(join(dataDir, rel), content);
  };
  put('stills/cam3/2026/10/01/1200.pack', 'aaaa');
  put('previews/cam3/2026/10/01/1200.jpg', 'bb');
  put('stills/cam3/2026/10/02/0005.pack', 'cccccc');
  put('stills/cam4/2026/10/01/1200.pack', 'other camera');
  put('secret/x.bin', 'outside');
  catalog.db.prepare('INSERT INTO clips (cam, start_ts, path, stream, size, received_at, snapshot) VALUES (?, ?, ?, ?, 8, 1, NULL)').run('cam3', D1, join(dataDir, 'clips/cam3/2026/10/01/1200-1.mp4'), 'sub');
  put('clips/cam3/2026/10/01/1200-1.mp4', '0123456789abcdef');
  const journal = new MoveJournal(join(dataDir, 'admin', 'moves'));
  const inventory = { catalog, dataDir };
  const record: MoveRecord = {
    v: 1, id: MOVE, role: 'source', camera: 'cam3', phase: o.phase ?? 'opened', plan: null,
    peer: { proxyId: 'proxy-target', name: 'target', ip: TARGET_IP },
    tokenHash: hashMoveToken(TOKEN), chunks: {}, bytesDone: 0, startedAt: 1,
  };
  journal.save(record);
  const audit = new AuditLog({ dir: join(dataDir, 'audit'), version: 'test' });
  let now = 1_000_000;
  let busy = o.busy ?? false;
  const deps: MovesSourceDeps = { journal: o.journal ?? journal, audit, inventory, busy: () => busy, password: (cam) => (cam === 'cam3' ? PASSWORD : 'wrong-camera'), now: () => now };
  const app = express();
  app.set('trust proxy', true);
  app.use('/api', movesSourceApi(deps));
  // Stands in for the client APIs behind requireAccess: a request reaching it fell through.
  app.use((_req, res) => void res.status(299).json({ fellThrough: true }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  const base = () => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const records = () => {
    const dir = join(dataDir, 'audit');
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>));
  };
  const update = (f: (r: MoveRecord) => void) => {
    const r = journal.load(MOVE)!;
    f(r);
    journal.save(r);
  };
  const freeze = () => update((r) => {
    r.plan = { transfer: true, kinds: ['clips', 'stills'], space: 'all', targetSettings: null, budgetS: 3600, estimateS: 60 };
    r.manifest = listChunks(inventory, 'cam3', ['clips', 'stills']);
    r.approvedAt = D2;
  });
  return {
    dataDir, journal, put, base, records, update, freeze, audit,
    setNow: (t: number) => void (now = t),
    setBusy: (b: boolean) => void (busy = b),
    get: (path: string, o2: { ip?: string; token?: string | null } = {}) => {
      const r = request(base()).get(path).set('X-Forwarded-For', o2.ip ?? TARGET_IP);
      return o2.token === null ? r : r.set('Authorization', `Bearer ${o2.token ?? TOKEN}`);
    },
  };
}

const ROUTES = [`/api/moves/${MOVE}/probe?bytes=10`, `/api/moves/${MOVE}/manifest`, `/api/moves/${MOVE}/chunks/clips:2026-10-01`, `/api/moves/${MOVE}/chunks/clips:2026-10-01/rows`, `/api/moves/${MOVE}/file?path=clips/cam3/2026/10/01/1200-1.mp4`, `/api/moves/${MOVE}/secrets`];

describe('the move-token guard', () => {
  it('no route answers without the token (also not to the local admin token)', async () => {
    const f = await fixture();
    f.freeze();
    for (const path of [...ROUTES, `/api/moves/${MOVE}/nope`, `/api/moves/${MOVE}`, '/api/moves', `/api/moves/mv_ZZZZZZZZZZZZZZZZZZZZ/manifest`]) {
      for (const token of [null, ADMIN_TOKEN, CLIENT_TOKEN, 'x', `${TOKEN}x`]) {
        const res = await f.get(path, { token });
        expect([403, 404], `${path} ${token}`).toContain(res.status);
        expect(res.body.fellThrough, path).toBeUndefined();
        if (res.status === 403) expect(res.body).toEqual({ error: 'move_token' });
      }
    }
    // A token in the URL is not a token.
    expect((await f.get(`/api/moves/${MOVE}/manifest?token=${TOKEN}`, { token: null })).status).toBe(403);
  });

  it('token from another address → 403 and one audit record per move per 10 minutes', async () => {
    const f = await fixture();
    const r1 = await f.get(`/api/moves/${MOVE}/probe?bytes=10`, { ip: OTHER_IP });
    expect(r1.status).toBe(403);
    expect(r1.body).toEqual({ error: 'move_token' });
    await f.get(`/api/moves/${MOVE}/manifest`, { ip: OTHER_IP });
    await f.get(`/api/moves/${MOVE}/manifest`, { token: 'wrong' });
    let recs = f.records().filter((r) => r.event.action === 'move-token-refused');
    expect(recs).toHaveLength(1);
    expect(recs[0].event.outcome).toBe('failure');
    expect(recs[0].source.ip).toBe(OTHER_IP);
    expect(recs[0].cam_proxy.moveId).toBe(MOVE);
    expect(recs[0].cam_proxy.reason).toBe('wrong-address');
    expect(JSON.stringify(recs[0])).not.toContain(TOKEN);
    f.setNow(1_000_000 + 10 * 60_000 + 1);
    await f.get(`/api/moves/${MOVE}/manifest`, { ip: OTHER_IP });
    recs = f.records().filter((r) => r.event.action === 'move-token-refused');
    expect(recs).toHaveLength(2);
    expect(recs[1].cam_proxy.suppressed).toBe(2);
  });

  it('refusals for unknown moves share one throttle, so made-up ids cannot flood the log', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) expect((await f.get(`/api/moves/mv_${String(i).padStart(20, '0')}/manifest`)).status).toBe(403);
    // and none of them uses up the real move's record
    await f.get(`/api/moves/${MOVE}/manifest`, { ip: OTHER_IP });
    const recs = f.records().filter((r) => r.event.action === 'move-token-refused');
    expect(recs.map((r) => r.cam_proxy.reason)).toEqual(['unknown-move', 'wrong-address']);
  });

  it('accepts the IPv4-mapped form of the target address', async () => {
    const f = await fixture();
    expect((await f.get(`/api/moves/${MOVE}/probe?bytes=3`, { ip: `::ffff:${TARGET_IP}` })).status).toBe(200);
  });

  it('token after done is refused', async () => {
    for (const phase of ['finished', 'cancelled', 'failed'] as const) {
      const f = await fixture({ phase });
      const res = await f.get(`/api/moves/${MOVE}/probe?bytes=3`);
      expect(res.status, phase).toBe(403);
      expect(f.records().filter((r) => r.event.action === 'move-token-refused')[0].cam_proxy.reason).toBe('ended');
    }
  });

  it("a target's record is not a source's", async () => {
    const f = await fixture();
    f.update((r) => {
      r.role = 'target';
    });
    expect((await f.get(`/api/moves/${MOVE}/probe?bytes=3`)).status).toBe(403);
  });

  it('a record without a peer address refuses every address', async () => {
    const f = await fixture();
    f.update((r) => {
      delete r.peer.ip;
    });
    expect((await f.get(`/api/moves/${MOVE}/probe?bytes=3`)).status).toBe(403);
  });

  it('an unreadable journal refuses (503), never falls through', async () => {
    const f = await fixture({ journal: { load: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }, save: () => undefined } });
    const res = await f.get(`/api/moves/${MOVE}/probe?bytes=3`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'busy' });
  });
});

describe('the source endpoints', () => {
  it('probe streams N bytes', async () => {
    const f = await fixture();
    const res = await f.get(`/api/moves/${MOVE}/probe?bytes=100000`).buffer(true).parse((r, cb) => {
      const parts: Buffer[] = [];
      r.on('data', (c: Buffer) => parts.push(c));
      r.on('end', () => cb(null, Buffer.concat(parts)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-length']).toBe('100000');
    expect((res.body as Buffer).length).toBe(100000);
    expect(new Set(res.body as Buffer).size).toBeGreaterThan(200); // random, not zeros
    expect((await f.get(`/api/moves/${MOVE}/probe?bytes=67108865`)).status).toBe(400);
    expect((await f.get(`/api/moves/${MOVE}/probe`)).status).toBe(400);
    expect((await f.get(`/api/moves/${MOVE}/probe?bytes=-1`)).status).toBe(400);
  });

  it('manifest is 409 not_ready until frozen, then the frozen chunk list', async () => {
    const f = await fixture();
    const before = await f.get(`/api/moves/${MOVE}/manifest`);
    expect(before.status).toBe(409);
    expect(before.body).toEqual({ error: 'not_ready' });
    f.freeze();
    const res = await f.get(`/api/moves/${MOVE}/manifest`);
    expect(res.status).toBe(200);
    expect(res.body.chunks.map((c: { id: string }) => c.id)).toEqual(['stills:2026-10-02', 'clips:2026-10-01', 'stills:2026-10-01']);
  });

  it('at released the chunks of the switch-over day are listed again, and their cached manifests dropped', async () => {
    const f = await fixture({ phase: 'switching' });
    f.freeze();
    expect((await f.get(`/api/moves/${MOVE}/chunks/stills:2026-10-02`)).body.files).toHaveLength(1);
    f.put('stills/cam3/2026/10/02/0010.pack', 'overlap');
    // switching: still the frozen list
    expect((await f.get(`/api/moves/${MOVE}/manifest`)).body.chunks.find((c: { id: string }) => c.id === 'stills:2026-10-02').files).toBe(1);
    f.update((r) => {
      r.phase = 'released';
    });
    const res = await f.get(`/api/moves/${MOVE}/manifest`);
    const day = res.body.chunks.find((c: { id: string }) => c.id === 'stills:2026-10-02');
    expect(day).toMatchObject({ files: 2, bytes: 6 + 7 });
    // older days stay as frozen
    expect(res.body.chunks.find((c: { id: string }) => c.id === 'clips:2026-10-01')).toMatchObject({ files: 1, bytes: 16 });
    expect(f.journal.load(MOVE)!.chunks['stills:2026-10-02']).toBeUndefined();
    expect((await f.get(`/api/moves/${MOVE}/chunks/stills:2026-10-02`)).body.files).toHaveLength(2);
    // once only
    f.put('stills/cam3/2026/10/02/0020.pack', 'later');
    expect((await f.get(`/api/moves/${MOVE}/manifest`)).body.chunks.find((c: { id: string }) => c.id === 'stills:2026-10-02').files).toBe(2);
  });

  it('a chunk manifest is computed once and cached in the journal', async () => {
    const f = await fixture();
    f.freeze();
    const res = await f.get(`/api/moves/${MOVE}/chunks/clips:2026-10-01`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ files: [{ path: 'clips/cam3/2026/10/01/1200-1.mp4', size: 16, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }], rows: 1, expired: 0 });
    const cached = f.journal.load(MOVE)!.chunks['clips:2026-10-01'];
    expect(cached.files!['clips/cam3/2026/10/01/1200-1.mp4']).toMatchObject({ size: 16 });
    // a change on disk after the first computation does not change the answer
    writeFileSync(join(f.dataDir, 'clips/cam3/2026/10/01/1200-1.mp4'), 'changed');
    expect((await f.get(`/api/moves/${MOVE}/chunks/clips:2026-10-01`)).body).toEqual(res.body);
  });

  it('a chunk not in the manifest is 404, a chunk id that is not one is 400', async () => {
    const f = await fixture();
    expect((await f.get(`/api/moves/${MOVE}/chunks/clips:2026-10-01`)).status).toBe(409);
    f.freeze();
    expect((await f.get(`/api/moves/${MOVE}/chunks/events:2026-10-01`)).body).toEqual({ error: 'unknown_chunk' });
    expect((await f.get(`/api/moves/${MOVE}/chunks/clips:2026-13-01`)).status).toBe(400);
    expect((await f.get(`/api/moves/${MOVE}/chunks/events:2026-10-01/rows`)).status).toBe(404);
  });

  it("a chunk's rows", async () => {
    const f = await fixture();
    f.freeze();
    const res = await f.get(`/api/moves/${MOVE}/chunks/clips:2026-10-01/rows`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ table: 'clips', rows: [expect.objectContaining({ path: 'clips/cam3/2026/10/01/1200-1.mp4', cam: 'cam3' })] }]);
  });

  it('file serves a listed file, with ranges', async () => {
    const f = await fixture();
    f.freeze();
    const path = 'clips/cam3/2026/10/01/1200-1.mp4';
    // not listed until its chunk's manifest was asked for
    expect((await f.get(`/api/moves/${MOVE}/file?path=${path}`)).status).toBe(404);
    await f.get(`/api/moves/${MOVE}/chunks/clips:2026-10-01`);
    const res = await f.get(`/api/moves/${MOVE}/file?path=${path}`).buffer(true);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer).toString()).toBe('0123456789abcdef');
    const part = await f.get(`/api/moves/${MOVE}/file?path=${path}`).set('Range', 'bytes=4-7').buffer(true);
    expect(part.status).toBe(206);
    expect(Buffer.from(part.body as Buffer).toString()).toBe('4567');
  });

  it('file path outside the camera folder is 400', async () => {
    const f = await fixture();
    f.freeze();
    await f.get(`/api/moves/${MOVE}/chunks/stills:2026-10-01`);
    for (const p of ['secret/x.bin', 'stills/cam4/2026/10/01/1200.pack', 'stills/cam3/../cam4/2026/10/01/1200.pack', '/etc/hosts', `${f.dataDir}/stills/cam3/2026/10/01/1200.pack`, 'stills/cam3', 'stills\\cam3\\x', '', 'admin/moves/x.json', 'stills/cam3/2026/10/01/1200.pack\u0000', 'stills/cam3/./2026/10/01/1200.pack', 'stills//cam3/2026/10/01/1200.pack']) {
      const res = await f.get(`/api/moves/${MOVE}/file?path=${encodeURIComponent(p)}`);
      expect(res.status, p).toBe(400);
    }
    expect((await f.get(`/api/moves/${MOVE}/file`)).status).toBe(400);
  });

  it('deleted file answers 404 expired', async () => {
    const f = await fixture();
    f.freeze();
    await f.get(`/api/moves/${MOVE}/chunks/stills:2026-10-01`);
    rmSync(join(f.dataDir, 'stills/cam3/2026/10/01/1200.pack'));
    const res = await f.get(`/api/moves/${MOVE}/file?path=stills/cam3/2026/10/01/1200.pack`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'expired' });
  });

  it('a file removed before hashing is counted expired in the chunk manifest', async () => {
    const f = await fixture();
    f.freeze();
    // listed at freeze, deleted by retention before the manifest was asked for
    rmSync(join(f.dataDir, 'previews/cam3/2026/10/01/1200.jpg'));
    const res = await f.get(`/api/moves/${MOVE}/chunks/stills:2026-10-01`);
    expect(res.body.files.map((x: { path: string }) => x.path)).toEqual(['stills/cam3/2026/10/01/1200.pack']);
  });

  it('file and chunk endpoints answer 503 busy under pressure; probe and manifest do not', async () => {
    const f = await fixture();
    f.freeze();
    await f.get(`/api/moves/${MOVE}/chunks/clips:2026-10-01`);
    f.setBusy(true);
    for (const p of [`/api/moves/${MOVE}/chunks/clips:2026-10-01`, `/api/moves/${MOVE}/chunks/clips:2026-10-01/rows`, `/api/moves/${MOVE}/file?path=clips/cam3/2026/10/01/1200-1.mp4`]) {
      const res = await f.get(p);
      expect(res.status, p).toBe(503);
      expect(res.body).toEqual({ error: 'busy' });
    }
    expect((await f.get(`/api/moves/${MOVE}/manifest`)).status).toBe(200);
    expect((await f.get(`/api/moves/${MOVE}/probe?bytes=1`)).status).toBe(200);
    // pressure never lets a wrong token in
    expect((await f.get(`/api/moves/${MOVE}/file?path=clips/cam3/2026/10/01/1200-1.mp4`, { ip: OTHER_IP })).status).toBe(403);
  });

  it('secrets before move.go is 409 not_ready; after, the password sealed to the target key', async () => {
    const f = await fixture();
    const before = await f.get(`/api/moves/${MOVE}/secrets`);
    expect(before.status).toBe(409);
    expect(before.body).toEqual({ error: 'not_ready' });
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    f.update((r) => {
      r.targetPublicSpki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    });
    const res = await f.get(`/api/moves/${MOVE}/secrets`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['sealed']);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).not.toContain(PASSWORD);
    const plain = unseal(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), res.body.sealed);
    expect(plain.toString('utf8')).toBe(PASSWORD);
    // nothing about it in the audit log
    for (const r of f.records()) expect(JSON.stringify(r)).not.toContain(PASSWORD);
  });
});

describe('in the proxy', () => {
  let cleanup: () => Promise<void> = async () => undefined;
  afterAll(() => cleanup());

  it('the move routes sit ahead of the client auth and refuse the admin and client tokens', async () => {
    const sim = await startSim();
    const p = await startProxy(sim);
    cleanup = async () => (await p.proxy.stop(), await sim.close());
    const journal = new MoveJournal(join(p.proxy.running.server.dataDir, 'admin', 'moves'));
    journal.save({ v: 1, id: MOVE, role: 'source', camera: 'cam1', phase: 'opened', plan: null, peer: { proxyId: 't', name: 't', ip: '127.0.0.1' }, tokenHash: hashMoveToken(TOKEN), chunks: {}, bytesDone: 0, startedAt: 1 });
    for (const t of [ADMIN_TOKEN, CLIENT_TOKEN]) {
      const res = await request(p.base).get(`/api/moves/${MOVE}/manifest`).set('Authorization', `Bearer ${t}`);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'move_token' });
    }
    const ok = await request(p.base).get(`/api/moves/${MOVE}/manifest`).set('Authorization', `Bearer ${TOKEN}`);
    expect(ok.status).toBe(409);
    const probe = await request(p.base).get(`/api/moves/${MOVE}/probe?bytes=5`).set('Authorization', `Bearer ${TOKEN}`).buffer(true);
    expect(probe.status).toBe(200);
    expect(probe.headers['content-length']).toBe('5');
  }, 30_000);
});
