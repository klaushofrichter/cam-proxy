import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// GET /api/cameras/:cam/snapshot.jpg (spec 2026-10-30-camera-onboarding-design §4.8).
const go2rtc = process.env.CAMPROXY_TEST_GO2RTC;
// cam-sim's RLC-1224A sub stream (its GetEnc).
const SUB = { width: 896, height: 512 };

// A JPEG's size from its first SOF marker.
function jpegSize(b: Buffer): { width: number; height: number } {
  expect([b[0], b[1]]).toEqual([0xff, 0xd8]);
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error('not a marker');
    const m = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  throw new Error('no SOF');
}

const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

let s: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  s = await startSim();
  p = await startProxy(s);
  await until(() => p.proxy.cameras.get('cam1')!.status.state().online, 10_000);
}, 30_000);
afterAll(async () => {
  await p?.proxy.stop();
  await s?.close();
});

const snap = (base: string, q = '') => request(base).get(`/api/cameras/cam1/snapshot.jpg${q}`).set(auth()).buffer(true).parse(binary);

describe('on-demand snapshot', () => {
  it('main (the default): the camera\'s full-size picture', async () => {
    const r = await snap(p.base);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers['cache-control']).toBe('no-store');
    // The camera's own Snap, unchanged. cam-sim's Snap serves its fixture
    // picture at the sub size (a real RLC-1224A answers MAIN): the size check
    // waits for a cam-sim that serves the main size.
    expect((r.body as Buffer).equals(await s.sim.engine.snapshot())).toBe(true);
    expect(jpegSize(r.body as Buffer)).toEqual(expect.objectContaining({ width: expect.any(Number) }));
    expect((await snap(p.base, '?stream=main')).status).toBe(200);
  });

  it.skipIf(!go2rtc)('sub: a frame of the sub stream from go2rtc', async () => {
    let r!: request.Response;
    await until(async () => (r = await snap(p.base, '?stream=sub')).status === 200, 20_000);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(jpegSize(r.body as Buffer)).toEqual(SUB);
  }, 30_000);

  it('another stream is 400', async () => {
    const r = await request(p.base).get('/api/cameras/cam1/snapshot.jpg?stream=foo').set(auth());
    expect([r.status, r.body.error]).toEqual([400, 'invalid']);
    expect((await request(p.base).get('/api/cameras/cam1/snapshot.jpg?stream=sub&stream=main').set(auth())).status).toBe(400);
  });

  it('sub for a camera without stills (no go2rtc stream) is 404 stream_unavailable', async () => {
    const m = await startSim();
    const q = await startProxy(m, { settings: { stills: { enabled: false } } });
    try {
      const r = await request(q.base).get('/api/cameras/cam1/snapshot.jpg?stream=sub').set(auth());
      expect([r.status, r.body.error]).toEqual([404, 'stream_unavailable']);
      expect(JSON.stringify(r.body)).not.toContain('rtsp://');
    } finally {
      await q.proxy.stop();
      await m.close();
    }
  }, 30_000);

  it('an offline camera is 503 camera_offline; no refusal names an rtsp URL', async () => {
    const m = await startSim();
    const q = await startProxy(m);
    try {
      await until(() => q.proxy.cameras.get('cam1')!.status.state().online, 10_000);
      await m.close();
      const w = q.proxy.cameras.get('cam1')!;
      await w.status.checkNow();
      await w.status.checkNow();
      for (const stream of ['main', 'sub']) {
        const r = await request(q.base).get(`/api/cameras/cam1/snapshot.jpg?stream=${stream}`).set(auth());
        expect([r.status, r.body.error]).toEqual([503, 'camera_offline']);
        expect(r.text).not.toContain('rtsp://');
      }
    } finally {
      await q.proxy.stop();
    }
  }, 30_000);
});
