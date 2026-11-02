// test/recordings-http-fallback.test.ts
// A viewer's SD recording download end to end, proxy and cam-sim: the E1
// Outdoor Pro refuses the Baichuan download (400, measured 2026-11-02) and
// serves HTTP Download, so the proxy falls back to HTTP and stays there; the
// RLC-1224A keeps Baichuan. The control status shows the path per camera.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { E1_MODEL, startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';

type World = { sim: Awaited<ReturnType<typeof startSim>>; p: Awaited<ReturnType<typeof startProxy>> };

const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

async function world(model?: typeof E1_MODEL): Promise<World> {
  const sim = await startSim(model ? { model } : {});
  const p = await startProxy(sim);
  await until(() => p.proxy.status.state().online, 15_000);
  return { sim, p };
}
const close = async (w?: World) => {
  await w?.p.proxy.stop();
  await w?.sim.close();
};
const recs = (w: World) => w.sim.sim.engine.sd.all().filter((r) => r.end !== null);
const file = (w: World, i: number, s: 'sub' | 'main') => readFileSync(w.sim.sim.engine.mediaFor(recs(w)[i]).clipPath(s));
const get = (w: World, i: number, s: 'sub' | 'main') => binary(request(w.p.base).get(`/api/cameras/cam1/recordings/${basename(recs(w)[i].files[s].name)}`).set(auth()));
const bcRequests = (w: World) => w.sim.sim.engine.requests.recent(500).filter((x) => x.port === 'baichuan' && x.cmd === '8');
const cameraStatus = async (w: World) => (await request(w.p.base).get('/control/cameras/cam1/status').set(auth(ADMIN_TOKEN))).body;

describe('E1 Outdoor Pro: Baichuan refused, HTTP Download', () => {
  let w: World;
  beforeAll(async () => {
    w = await world(E1_MODEL);
  }, 30_000);
  afterAll(() => close(w));

  it('a viewer gets the recording over HTTP after Baichuan refuses; the next goes straight to HTTP', async () => {
    const c = w.sim.sim.engine.counters;
    const r = await get(w, 0, 'sub');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('video/mp4');
    expect((r.body as Buffer).equals(file(w, 0, 'sub'))).toBe(true);
    expect(Number(r.headers['content-length'])).toBe((r.body as Buffer).length);
    expect(bcRequests(w).map((x) => x.status)).toEqual([400]);
    expect([c.baichuanDownloads, c.downloads]).toEqual([0, 1]);

    const r2 = await get(w, 1, 'main');
    expect(r2.status).toBe(200);
    expect((r2.body as Buffer).equals(file(w, 1, 'main'))).toBe(true);
    expect(bcRequests(w)).toHaveLength(1); // Baichuan not asked again
    expect(c.downloads).toBe(2);
    // From the cache now: the camera isn't asked.
    expect(((await get(w, 0, 'sub')).body as Buffer).equals(file(w, 0, 'sub'))).toBe(true);
    expect(c.downloads).toBe(2);
  });

  // A real camera's HTTP Download is its own remux: its length differs from
  // the size in the name (RLC-1224A, when it served it). cam-sim's index can
  // say so: its stored size (the name's) is made 1000 bytes smaller than the
  // file it serves (a test-only poke at its SD index).
  it('a body whose length differs from the name\'s size: the viewer gets the camera\'s length, and the cache keeps it whole', async () => {
    const stored = (w.sim.sim.engine.sd as unknown as { recs: { sizes: { sub: number } }[] }).recs;
    const i = 2;
    const media = file(w, i, 'sub');
    stored[i].sizes = { ...stored[i].sizes, sub: media.length - 1000 };
    expect(recs(w)[i].files.sub.size).toBe(media.length - 1000);
    const r = await get(w, i, 'sub');
    expect(r.status).toBe(200);
    expect(Number(r.headers['content-length'])).toBe(media.length);
    expect((r.body as Buffer).equals(media)).toBe(true);
    const again = await get(w, i, 'sub'); // the cache's copy
    expect((again.body as Buffer).equals(media)).toBe(true);
    expect(again.headers.etag).toBe(r.headers.etag);
  });

  it('the control status shows the path and the camera\'s Baichuan refusal', async () => {
    const s = await cameraStatus(w);
    expect(s.recordings.download).toMatchObject({ path: 'http', baichuanRefusal: { status: 400, detail: 'the download answered 400, no body' } });
    expect(s.recordings.download.retryBaichuanAt).toBeGreaterThan(Date.now() + 5 * 3600_000);
    expect(s.recordings.last).toMatchObject({ result: 'ok' });
  });
});

describe('RLC-1224A: Baichuan', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  }, 30_000);
  afterAll(() => close(w));

  it('downloads over Baichuan; HTTP Download is never asked; the status says baichuan', async () => {
    const c = w.sim.sim.engine.counters;
    const r = await get(w, 0, 'sub');
    expect(r.status).toBe(200);
    expect((r.body as Buffer).length).toBe(recs(w)[0].files.sub.size);
    expect([c.baichuanDownloads, c.downloads]).toEqual([1, 0]);
    expect((await cameraStatus(w)).recordings.download).toEqual({ path: 'baichuan', since: null, baichuanRefusal: null, retryBaichuanAt: null });
  });
});
