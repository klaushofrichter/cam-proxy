// The Archive API, reading and changing (docs/archive.md §3–8; spec
// 2026-10-05-archive-design §3–6): list, item, PATCH, DELETE, video with
// Range, thumbnail, metadata, ZIP (read back by unzip), status, health,
// Clear the Archive, expiry. Fixtures come through the service (the create
// limiter is tested in archive-api.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { execFile, execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { fileSource } from '../src/archive/sources';
import type { ArchiveRequest } from '../src/archive/jobs';

const run = promisify(execFile);
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let clipFile = '';
const T = Date.UTC(2026, 9, 5, 19, 0, 0);
const ids: number[] = [];
const get = (path: string) => request(p.base).get(path).set(auth());
const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
const records = (action: string) => p.proxy.audit.list({ actions: [action], limit: 500 }).records as unknown as { event: { outcome: string }; user?: { name: string }; message: string; cam_proxy: Record<string, unknown> }[];
const lastMsg = () => p.proxy.log.since(0, { types: ['archive'] }, 1000).at(-1)!;

async function add(o: Partial<ArchiveRequest> & { name: string }): Promise<number> {
  const size = statSync(clipFile).size;
  const job = p.proxy.archive.create({
    cam: 'cam1', source: { type: 'clip', clipId: 1, stream: 'sub' }, kind: 'clip', window: { from: T, to: T + 4000 }, quality: 'sd', original: true, size, durationS: 4,
    obtain: fileSource(clipFile), labels: [], retentionDays: 365, createdBy: 'client', ...o,
  }, { user: 'client' });
  if (job === 'busy') throw new Error('busy');
  const v = await p.proxy.archive.jobs.wait(job.id, 20_000);
  if (v?.state !== 'done') throw new Error(`job ${v?.state} ${v?.error}`);
  return v.archiveId!;
}

beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
  clipFile = join(p.dir, 'clip.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipFile]);
  ids.push(await add({ name: 'Fox at night', labels: ['Pet', 'SD'], window: { from: T, to: T + 4000 } }));
  ids.push(await add({ name: 'Delivery van', labels: ['Vehicle', '4K'], quality: '4k', window: { from: T + 60_000, to: T + 64_000 }, retentionDays: null }));
  ids.push(await add({ name: 'fox again', labels: ['pet'], window: { from: T + 120_000, to: T + 124_000 }, retentionDays: 1 }));
}, 60_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('GET /api/archive', () => {
  const list = async (q: string) => (await get(`/api/archive${q}`)).body as { total: number; items: { id: number }[]; offset: number; limit: number };
  it('lists newest first with the total; filters, sorts and pages', async () => {
    const all = await list('');
    expect(all).toMatchObject({ total: 3, offset: 0, limit: 100 });
    expect(all.items.map((x) => x.id)).toEqual([...ids].reverse());
    expect((await list('?labels=PET')).items.map((x) => x.id).sort()).toEqual([ids[0], ids[2]]);
    expect((await list('?labels=pet,sd')).items.map((x) => x.id)).toEqual([ids[0]]);
    expect((await list('?q=FOX&sort=name&order=asc')).items.map((x) => x.id)).toEqual([ids[2], ids[0]]);
    expect((await list('?quality=4k')).items.map((x) => x.id)).toEqual([ids[1]]);
    expect((await list(`?from=${T + 30_000}&to=${T + 90_000}`)).items.map((x) => x.id)).toEqual([ids[1]]);
    expect((await list('?sort=recorded&order=asc')).items.map((x) => x.id)).toEqual(ids);
    expect((await list('?sort=expires&order=asc')).items.map((x) => x.id)).toEqual([ids[2], ids[0], ids[1]]);
    for (const sort of ['created', 'recorded', 'name', 'size', 'expires', 'cam', 'quality', 'duration', 'labels']) expect((await get(`/api/archive?sort=${sort}`)).status).toBe(200);
    expect((await list('?sort=quality&order=asc')).items.map((x) => x.id)).toEqual([ids[2], ids[0], ids[1]]); // sd, sd (recorded desc), 4k
    expect((await list('?sort=labels&order=asc')).items.map((x) => x.id)).toEqual([ids[1], ids[2], ids[0]]); // 4k, pet, pet
    const page = await list('?limit=1&offset=1');
    expect(page).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(page.items.map((x) => x.id)).toEqual([ids[1]]);
  });
  it.each([['?sort=bytes'], ['?order=up'], ['?limit=0'], ['?limit=501'], ['?labels=a-b'], ['?quality=8k'], ['?from=x'], ['?cam=../x']])('400 for %s', async (q) => {
    expect((await get(`/api/archive${q}`)).status).toBe(400);
  });
});

describe('one item', () => {
  it('GET, 404 for an unknown id, 400 for a non-number', async () => {
    expect((await get(`/api/archive/${ids[0]}`)).body).toMatchObject({ id: ids[0], name: 'Fox at night', labels: ['Pet', 'SD'], urls: { video: `/api/archive/${ids[0]}/video` } });
    expect((await get('/api/archive/9999')).status).toBe(404);
    expect((await get('/api/archive/abc')).status).toBe(400);
  });

  it('PATCH: changes, audits (with the person) and announces; an unchanged value writes nothing', async () => {
    const before = records('archive-update').length;
    const r = await request(p.base).patch(`/api/archive/${ids[0]}`).set(auth()).set('X-On-Behalf-Of', 'klaus@example.com').send({ name: '  Fox at dawn ', labels: ['pet', 'Dawn'], retentionDays: 10 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'Fox at dawn', labels: ['Pet', 'Dawn'], retentionDays: 10 });
    expect(r.body.expiresAt - r.body.createdAt).toBe(10 * 86_400_000);
    expect(records('archive-update')[0]).toMatchObject({ user: { name: 'client' }, cam_proxy: { id: ids[0], onBehalfOf: 'klaus@example.com', changes: [{ field: 'name', from: 'Fox at night', to: 'Fox at dawn' }, { field: 'labels', from: ['Pet', 'SD'], to: ['Pet', 'Dawn'] }, { field: 'retentionDays', from: 365, to: 10 }] } });
    expect(lastMsg()).toMatchObject({ data: { action: 'update', ids: [ids[0]], items: [{ name: 'Fox at dawn' }] } });
    const meta = JSON.parse(readFileSync(join(p.dir, 'data', 'archive', 'cam1', String(ids[0]), 'meta.json'), 'utf8'));
    expect(meta.item).toMatchObject({ name: 'Fox at dawn' }); // the folder explains itself
    expect((await request(p.base).patch(`/api/archive/${ids[0]}`).set(auth()).send({ name: 'Fox at dawn' })).status).toBe(200);
    expect(records('archive-update').length).toBe(before + 1);
    expect((await request(p.base).patch(`/api/archive/${ids[0]}`).set(auth()).send({ retentionDays: null })).body).toMatchObject({ retentionDays: null, expiresAt: null });
    expect((await request(p.base).patch(`/api/archive/${ids[0]}`).set(auth()).send({})).status).toBe(400);
    expect((await request(p.base).patch(`/api/archive/${ids[0]}`).set(auth()).send({ name: '' })).status).toBe(400);
    expect((await request(p.base).patch('/api/archive/9999').set(auth()).send({ name: 'x' })).status).toBe(404);
  });

  it('video: the whole file, a Range (206), 416 past the end, a download name, HEAD', async () => {
    const file = readFileSync(clipFile);
    const whole = await binary(get(`/api/archive/${ids[1]}/video`));
    expect(whole.status).toBe(200);
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['cache-control']).toBe('private, max-age=604800, immutable');
    expect(whole.headers.etag).toBeTruthy();
    expect((whole.body as Buffer).equals(file)).toBe(true);
    const part = await binary(get(`/api/archive/${ids[1]}/video`).set('Range', 'bytes=10-109'));
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-109/${file.length}`);
    expect((part.body as Buffer).equals(file.subarray(10, 110))).toBe(true);
    const tail = await binary(get(`/api/archive/${ids[1]}/video`).set('Range', 'bytes=-50'));
    expect((tail.body as Buffer).equals(file.subarray(file.length - 50))).toBe(true);
    const past = await get(`/api/archive/${ids[1]}/video`).set('Range', `bytes=${file.length + 10}-`);
    expect(past.status).toBe(416);
    expect(past.headers['content-range']).toBe(`bytes */${file.length}`);
    const dl = await binary(get(`/api/archive/${ids[1]}/video?download=1`));
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="Delivery van.mp4"; filename*=UTF-8''Delivery%20van.mp4`);
    const head = await request(p.base).head(`/api/archive/${ids[1]}/video`).set(auth());
    expect(head.status).toBe(200);
    expect(Number(head.headers['content-length'])).toBe(file.length);
    expect((await get('/api/archive/9999/video')).status).toBe(404);
  });

  it('thumbnail (the first frame here) and metadata', async () => {
    const t = await binary(get(`/api/archive/${ids[1]}/thumbnail`));
    expect(t.status).toBe(200);
    expect(t.headers['content-type']).toBe('image/jpeg');
    expect((t.body as Buffer).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const m = await get(`/api/archive/${ids[1]}/metadata`);
    expect(m.body).toMatchObject({ schema: 1, item: { id: ids[1], name: 'Delivery van' }, camera: { id: 'cam1' }, window: { from: T + 60_000, to: T + 64_000 }, events: [], stillChecks: [], proxy: { version: 'dev' } });
    expect(m.body.item.urls).toBeUndefined();
  });
});

describe('GET /api/archive/zip', () => {
  it('streams a ZIP that unzip reads: the clips, their metadata and thumbnails', async () => {
    const r = await binary(get(`/api/archive/zip?ids=${ids[1]},${ids[2]}`));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="archive-cam1-\d{8}-\d{6}\.zip"/);
    expect(Number(r.headers['content-length'])).toBe((r.body as Buffer).length);
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-zipapi-'));
    const zip = join(dir, 'a.zip');
    writeFileSync(zip, r.body as Buffer);
    expect(execFileSync('unzip', ['-t', zip]).toString()).toMatch(/No errors detected/);
    const names = execFileSync('unzip', ['-Z1', zip]).toString().trim().split('\n').sort();
    expect(names).toEqual([`Delivery van (${ids[1]}).jpg`, `Delivery van (${ids[1]}).json`, `Delivery van (${ids[1]}).mp4`, `fox again (${ids[2]}).jpg`, `fox again (${ids[2]}).json`, `fox again (${ids[2]}).mp4`]);
    execFileSync('unzip', ['-q', zip, '-d', dir]);
    expect(readFileSync(join(dir, `Delivery van (${ids[1]}).mp4`)).equals(readFileSync(clipFile))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, `fox again (${ids[2]}).json`), 'utf8'))).toMatchObject({ schema: 1, item: { id: ids[2], name: 'fox again' } });
  });
  it('404 with the missing ids; 400 for bad ids', async () => {
    expect((await get(`/api/archive/zip?ids=${ids[1]},9999`)).body).toEqual({ error: 'not_found', missing: [9999] });
    expect((await get('/api/archive/zip')).status).toBe(400);
    expect((await get('/api/archive/zip?ids=a,b')).status).toBe(400);
    expect((await get(`/api/archive/zip?ids=${Array.from({ length: 201 }, (_, i) => i + 1).join(',')}`)).status).toBe(400);
  });
});

describe('status, health and the Status page', () => {
  it('GET /api/archive/status and /control/status.archive', async () => {
    const s = (await get('/api/archive/status')).body;
    expect(s).toMatchObject({ enabled: true, count: 3, forever: 2, warnPercent: 50, warning: false, minFreeBytes: expect.any(Number), lastCleanup: null });
    expect(s.bytes).toBe(3 * statSync(clipFile).size);
    expect(s.disk.size).toBeGreaterThan(0);
    expect(s.nextCleanupAt).toBeGreaterThan(Date.now() - 120_000);
    expect(s.labels.slice(0, 5)).toEqual([{ label: 'Pet', count: 2 }, { label: 'Person', count: 0 }, { label: 'Vehicle', count: 1 }, { label: 'SD', count: 0 }, { label: '4K', count: 1 }]);
    expect(s.labels.slice(5)).toEqual([{ label: 'Dawn', count: 1 }]);
    const c = (await request(p.base).get('/control/status').set(auth(ADMIN_TOKEN))).body;
    expect(c.archive).toMatchObject({ count: 3 });
  });

  it('the health item, a problem over archive.warnPercent (also for the display)', async () => {
    const h = (await request(p.base).get('/api/local/health')).body;
    expect(h.items.map((i: { id: string }) => i.id)).toContain('archive');
    expect(h.items.find((i: { id: string }) => i.id === 'archive')).toMatchObject({ label: 'Archive', problem: false });
    expect(h.thresholds.archiveWarnPercent).toBe(50);
    // A tiny disk: the archive is over 50 % of it.
    const real = p.proxy.storage.diskSpace.bind(p.proxy.storage);
    p.proxy.storage.diskSpace = () => ({ free: 10 ** 12, size: Math.ceil((3 * statSync(clipFile).size) / 0.6) });
    try {
      const over = (await request(p.base).get('/api/local/health')).body;
      expect(over.items.find((i: { id: string }) => i.id === 'archive')).toMatchObject({ problem: true, value: 60 });
      expect((await get('/api/archive/status')).body).toMatchObject({ warning: true, percentOfDisk: 60 });
    } finally {
      p.proxy.storage.diskSpace = real;
    }
    await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ archive: { enabled: false } });
    expect((await request(p.base).get('/api/local/health')).body.items.map((i: { id: string }) => i.id)).not.toContain('archive');
    await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ archive: { enabled: true } });
  });
});

describe('removing', () => {
  it('the daily cleanup expires clips past their retention, one record each', async () => {
    const r = p.proxy.archive.expire(Date.now() + 2 * 86_400_000); // fox again: 1 day
    expect(r.removed).toBe(1);
    expect((await get(`/api/archive/${ids[2]}`)).status).toBe(404);
    expect(existsSync(join(p.dir, 'data', 'archive', 'cam1', String(ids[2])))).toBe(false);
    expect(records('archive-expire')[0]).toMatchObject({ user: { name: 'system' }, cam_proxy: { id: ids[2], name: 'fox again', retentionDays: 1 } });
    expect(lastMsg()).toMatchObject({ data: { action: 'expire', ids: [ids[2]] } });
  });

  it('DELETE one, then bulk delete with an unknown id', async () => {
    const extra = await add({ name: 'Extra' });
    const extra2 = await add({ name: 'Extra 2' });
    expect((await request(p.base).delete(`/api/archive/${extra}`).set(auth())).status).toBe(204);
    expect((await request(p.base).delete(`/api/archive/${extra}`).set(auth())).status).toBe(404);
    expect(records('archive-delete')[0]).toMatchObject({ cam_proxy: { id: extra, name: 'Extra' } });
    const bulk = await request(p.base).post('/api/archive/delete').set(auth()).send({ ids: [extra2, 9999] });
    expect(bulk.body).toEqual({ deleted: [extra2], notFound: [9999] });
    expect(lastMsg()).toMatchObject({ data: { action: 'delete', ids: [extra2] } });
    expect((await request(p.base).post('/api/archive/delete').set(auth()).send({ ids: [] })).status).toBe(400);
    expect((await request(p.base).post('/api/archive/delete').set(auth()).send({ ids: ['1'] })).status).toBe(400);
  });

  it('Clear the Archive: admin only, by the exact count', async () => {
    const clear = (body: object, token = ADMIN_TOKEN) => request(p.base).post('/control/actions/archive-clear').set(auth(token)).send(body);
    expect((await request(p.base).post('/control/actions/archive-clear').send({ count: 2 })).status).toBe(401);
    expect((await request(p.base).post('/control/actions/archive-clear').set(auth()).send({ count: 2 })).status).toBe(403);
    expect((await clear({})).status).toBe(400);
    const wrong = await clear({ count: 5 });
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ error: 'count_mismatch', count: 2 });
    const ok = await clear({ count: 2 });
    expect(ok.body).toEqual({ cleared: 2, bytes: 2 * statSync(clipFile).size });
    expect(records('archive-clear')[0]).toMatchObject({ user: { name: 'admin' }, cam_proxy: { count: 2, ids: [ids[0], ids[1]] } });
    expect(p.proxy.audit.list({ actions: ['control-action'], limit: 5 }).records.some((x) => (x as { cam_proxy?: { action?: string } }).cam_proxy?.action === 'archive-clear')).toBe(false);
    expect(lastMsg()).toMatchObject({ data: { action: 'clear', ids: [ids[0], ids[1]] } });
    expect((await get('/api/archive')).body.total).toBe(0);
    await until(async () => (await get('/api/archive/status')).body.count === 0);
  });
});
