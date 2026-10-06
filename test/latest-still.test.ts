import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { latestApi } from '../src/api/latest-api';
import { CameraRegistry } from '../src/cameras/registry';
import type { CameraWorker } from '../src/cameras/worker';

function app(state: { up: boolean; frame?: { ts: number; still: Buffer; tile: Buffer } }) {
  const w = { id: 'cam3', phase: () => 'ready', latestFrame: () => state.frame, stills: { grabber: { up: () => state.up } } } as unknown as CameraWorker;
  const cams = new CameraRegistry(() => ['cam3']);
  cams.add(w);
  const a = express();
  a.use(latestApi({ cameras: cams }));
  return a;
}

describe('latest still (spec 2026-10-05-multi-camera-host-design §6.4)', () => {
  const frame = { ts: 1_791_000_000_000, still: Buffer.from('still'), tile: Buffer.from('tile') };
  it('serves the last frame with ETag, X-Still-Ts and no-cache; a matching ETag gets 304', async () => {
    const a = app({ up: true, frame });
    const r = await request(a).get('/cameras/cam3/stills/latest.jpg');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/jpeg');
    expect(r.headers.etag).toBe(`"cam3-${frame.ts}"`);
    expect(r.headers['x-still-ts']).toBe(String(frame.ts));
    expect(r.headers['cache-control']).toBe('no-cache');
    expect(r.body.toString()).toBe('still');
    const again = await request(a).get('/cameras/cam3/stills/latest.jpg').set('If-None-Match', `"cam3-${frame.ts}"`);
    expect(again.status).toBe(304);
    expect(again.text).toBe('');
    expect((await request(a).get('/cameras/cam3/previews/latest.jpg')).body.toString()).toBe('tile');
  });
  it('down: 404 even with a matching ETag, with the last ts', async () => {
    const a = app({ up: false, frame });
    const r = await request(a).get('/cameras/cam3/stills/latest.jpg').set('If-None-Match', `"cam3-${frame.ts}"`);
    expect([r.status, r.body]).toEqual([404, { error: 'no_still', ts: frame.ts }]);
    expect((await request(app({ up: true })).get('/cameras/cam3/stills/latest.jpg')).body).toEqual({ error: 'no_still', ts: null });
  });
  it('GET /stills/latest: every camera in one answer', async () => {
    const r = await request(app({ up: true, frame })).get('/stills/latest');
    expect(r.body).toEqual([{ cam: 'cam3', ts: frame.ts, url: '/api/cameras/cam3/stills/latest.jpg', tileUrl: '/api/cameras/cam3/previews/latest.jpg', up: true }]);
  });
  it('an unknown camera: 404 not_found', async () => {
    expect((await request(app({ up: true, frame })).get('/cameras/cam9/stills/latest.jpg')).status).toBe(404);
  });
});
