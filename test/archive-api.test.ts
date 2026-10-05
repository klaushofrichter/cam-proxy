// The Archive API, creating clips (docs/archive.md §2; spec
// 2026-10-05-archive-design §2): against a proxy and cam-sim.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { execFile } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join } from 'path';
import { promisify } from 'util';
import { crc32 } from 'zlib';
import { insertClip } from '../src/catalog/clips';
import { closeEvent, insertEvent } from '../src/catalog/events';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';

const run = promisify(execFile);
let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let clipId = 0;
let clipFile = '';
const T = Date.UTC(2026, 9, 5, 19, 3, 22); // 14:03:22 CDT
const cam = () => p.proxy.running.camera.id;
const post = (body: object, headers: Record<string, string> = {}) => request(p.base).post(`/api/cameras/${cam()}/archive`).set(auth()).set(headers).send(body);
const records = (action: string) => p.proxy.audit.list({ actions: [action], limit: 500 }).records as unknown as { event: { outcome: string }; user?: { name: string }; message: string; cam_proxy: Record<string, unknown>; error?: { message: string } }[];
const stream = () => p.proxy.log.since(0, { types: ['archive'] }, 1000);
const setConfig = (body: object) => request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send(body);

beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
  await until(() => p.proxy.status.state().online, 15_000);
  clipFile = join(p.dir, 'clip.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipFile]);
  clipId = insertClip(p.proxy.catalog, { cam: cam(), start_ts: T, end_ts: T + 6000, path: clipFile, stream: 'main', size: statSync(clipFile).size, received_at: T, snapshot: null }).id;
  const e = insertEvent(p.proxy.catalog, { cam: cam(), source: 'onvif', kind: 'person', start_ts: T + 2000, raw: null });
  closeEvent(p.proxy.catalog, e.id, T + 5000, 'state');
}, 60_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('POST /api/cameras/{cam}/archive: the request', () => {
  it('needs a client token or an admin; a session needs the CSRF header', async () => {
    expect((await request(p.base).post(`/api/cameras/${cam()}/archive`).send({})).status).toBe(401);
    expect((await request(p.base).get('/api/archive')).status).toBe(401);
    const login = await request(p.base).post('/control/login').send({ token: ADMIN_TOKEN });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const no = await request(p.base).post(`/api/cameras/${cam()}/archive`).set('Cookie', cookie).send({ source: { type: 'clip', clipId } });
    expect(no.status).toBe(403);
    expect(no.body).toEqual({ error: 'csrf' });
    expect((await request(p.base).get('/api/archive/status').set('Cookie', cookie)).status).toBe(200);
  });

  it.each([
    [{}, /^source is/],
    [{ source: { type: 'file', path: '/etc/passwd' } }, /^source.type/],
    [{ source: { type: 'composition', id: '../x' } }, /^source.id is a composition/],
    [{ source: { type: 'clip', clipId: '1' } }, /^source.clipId/],
    [{ source: { type: 'recording', id: '../../catalog.sqlite' } }, /^source.id is an SD/],
    [{ source: { type: 'clip', clipId: 1 }, name: '' }, /^name is empty/],
    [{ source: { type: 'clip', clipId: 1 }, name: 'a\nb' }, /control characters/],
    [{ source: { type: 'clip', clipId: 1 }, labels: ['two words'] }, /label/],
    [{ source: { type: 'clip', clipId: 1 }, retentionDays: 0 }, /retentionDays/],
    [{ source: { type: 'clip', clipId: 1 }, thumbnailAt: -5 }, /thumbnailAt/],
  ])('400 invalid for %j', async (body, detail) => {
    const before = records('archive-add').length;
    const r = await post(body);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'invalid', detail: expect.stringMatching(detail) });
    expect(records('archive-add').length).toBe(before); // a bad request writes nothing
  });

  it('404 for another camera, an unknown clip or composition', async () => {
    expect((await request(p.base).post('/api/cameras/nope/archive').set(auth()).send({ source: { type: 'clip', clipId } })).status).toBe(404);
    expect((await post({ source: { type: 'clip', clipId: 999_999 } })).body).toEqual({ error: 'not_found' });
    expect((await post({ source: { type: 'composition', id: 'A'.repeat(22) } })).body).toEqual({ error: 'not_found' });
  });

  it('503 archive_off while archive.enabled is false (a config-change record)', async () => {
    expect((await setConfig({ archive: { enabled: false } })).status).toBe(200);
    expect((await post({ source: { type: 'clip', clipId } })).body).toEqual({ error: 'archive_off' });
    expect(p.proxy.audit.list({ actions: ['config-change'], limit: 5 }).records[0]).toMatchObject({ cam_proxy: { changes: [{ key: 'archive.enabled', from: true, to: false }] } });
    expect((await setConfig({ archive: { enabled: true } })).status).toBe(200);
    expect((await setConfig({ archive: { warnPercent: 0 } })).status).toBe(400);
    expect((await setConfig({ archive: { warnPercent: 100 } })).status).toBe(400);
  });

  it('507 insufficient_space when the clip would not leave storage.minFreeBytes free; audited', async () => {
    const free = p.proxy.storage.diskSpace().free;
    expect((await setConfig({ storage: { minFreeBytes: free + 10 * 2 ** 30 } })).status).toBe(200);
    const r = await post({ source: { type: 'clip', clipId } }, { 'X-On-Behalf-Of': 'klaus@example.com' });
    expect(r.status).toBe(507);
    expect(r.body).toMatchObject({ error: 'insufficient_space', needed: statSync(clipFile).size + 2 ** 20, minFreeBytes: free + 10 * 2 ** 30 });
    expect(r.body.free).toBeGreaterThan(0);
    expect(records('archive-add')[0]).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'insufficient_space' }, cam_proxy: { onBehalfOf: 'klaus@example.com', requestedBy: 'token', source: { type: 'clip', clipId } } });
    expect((await setConfig({ storage: { minFreeBytes: 0 } })).status).toBe(200);
  });
});

describe('POST /api/cameras/{cam}/archive: the sources', () => {
  it("a clip: 201 with the item, the files, the metadata, an audit record and a stream message", async () => {
    const r = await post({ source: { type: 'clip', clipId }, labels: ['person', 'Garden', '4k'], retentionDays: 30 }, { 'X-On-Behalf-Of': 'klaus@example.com' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ state: 'done', progress: 1, archiveId: expect.any(Number) });
    const item = r.body.item;
    expect(item).toMatchObject({
      cam: 'cam1', cameraName: expect.any(String), name: expect.stringMatching(/^2026-10-0[45] \d\d:03:22 \S/),
      labels: ['Person', 'Garden', '4K'], retentionDays: 30, recordedFrom: T, recordedTo: T + 6000, quality: '4k', original: true,
      bytes: statSync(clipFile).size, source: { type: 'clip', clipId, stream: 'main' }, eventKinds: ['person'], createdBy: 'client',
    });
    expect(item.durationS).toBeCloseTo(6, 0);
    expect(item.expiresAt - item.createdAt).toBe(30 * 86_400_000);
    expect(item.thumbnail.from).toBe('frame'); // no stills here: the first frame
    const dir = join(p.dir, 'data', 'archive', 'cam1', String(item.id));
    const archived = readFileSync(join(dir, 'clip.mp4'));
    expect(archived.equals(readFileSync(clipFile))).toBe(true);
    expect(readFileSync(join(dir, 'thumb.jpg')).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))).toMatchObject({ schema: 1, item: { id: item.id }, events: [{ kind: 'person' }] });
    const row = p.proxy.catalog.db.prepare('SELECT files FROM archive WHERE id = ?').get(item.id) as { files: string };
    expect(JSON.parse(row.files).clip).toEqual({ bytes: archived.length, crc32: crc32(archived) });
    expect(records('archive-add')[0]).toMatchObject({ event: { outcome: 'success' }, user: { name: 'client' }, cam_proxy: { id: item.id, onBehalfOf: 'klaus@example.com', labels: ['Person', 'Garden', '4K'], retentionDays: 30 } });
    const msg = stream().at(-1)!;
    expect(msg).toMatchObject({ type: 'archive', cam: 'cam1', data: { action: 'add', ids: [item.id], items: [{ id: item.id, name: item.name }] } });
  });

  it('a composition: 409 not_ready while it encodes, then 201 with what was asked', async () => {
    const c = await request(p.base).post(`/api/cameras/${cam()}/compositions`).set(auth()).send({ clipId, preS: -1, postS: -1, size: '360p', badge: false });
    expect(c.status).toBe(201);
    const early = await post({ source: { type: 'composition', id: c.body.id } });
    if (early.status === 409) expect(early.body).toMatchObject({ error: 'not_ready', state: expect.stringMatching(/queued|running/) });
    await until(async () => (await request(p.base).get(`/api/cameras/${cam()}/compositions/${c.body.id}`).set(auth())).body.state === 'done', 60_000);
    const r = await post({ source: { type: 'composition', id: c.body.id }, name: 'Composed fox' });
    expect(r.status).toBe(201);
    expect(r.body.item).toMatchObject({
      name: 'Composed fox', quality: '360p', original: false, recordedFrom: T + 1000, recordedTo: T + 5000,
      source: { type: 'composition', jobId: c.body.id, anchor: 'clip', clipId, span: null, preS: -1, postS: -1, size: '360p', badge: false },
    });
    expect(r.body.item.durationS).toBeCloseTo(4, 0);
  });

  it('an SD recording: fetched over Baichuan as it is (202 or 201, then done)', async () => {
    const rec = sim.sim.engine.sd.all().find((x) => x.end !== null)!;
    const id = basename(rec.files.sub.name);
    const r = await post({ source: { type: 'recording', id } });
    expect([201, 202]).toContain(r.status);
    let job = r.body;
    await until(async () => (job = (await request(p.base).get(`/api/archive/jobs/${r.body.id}`).set(auth())).body).state === 'done', 30_000);
    expect(job.item).toMatchObject({ quality: 'sd', original: true, bytes: rec.files.sub.size, source: { type: 'recording', recording: id, stream: 'sub' } });
    expect(statSync(join(p.dir, 'data', 'archive', 'cam1', String(job.archiveId), 'clip.mp4')).size).toBe(rec.files.sub.size);
    // A recording the card doesn't have.
    const gone = await post({ source: { type: 'recording', id: id.replace(/_[0-9A-Fa-f]+\.mp4$/, '_1.mp4') } });
    expect(gone.status).toBe(404);
    expect(gone.body).toEqual({ error: 'unknown_recording' });
  });

  it('jobs: unknown ids are 404; a finished job can be read again', async () => {
    expect((await request(p.base).get('/api/archive/jobs/nope').set(auth())).status).toBe(404);
    expect((await request(p.base).delete(`/api/archive/jobs/${'B'.repeat(22)}`).set(auth())).status).toBe(404);
  });

  it('nothing is left in .incoming', () => {
    const inc = join(p.dir, 'data', 'archive', '.incoming');
    expect(existsSync(inc) ? readdirSync(inc) : []).toEqual([]);
  });
});
