import { afterEach, describe, expect, it } from 'vitest';
import http, { type IncomingMessage } from 'http';
import { PassThrough } from 'stream';
import { CameraError, ReolinkClient } from '../src/camera/client';
import { ExtFeed, EXT_FEED_MAX_PER_CAMERA } from '../src/stream/ext-feed';
import { EXT_FEED_URL } from '../src/stills/go2rtc';
import { logBuffer } from '../src/log';
import { startSim } from './helpers/sim';

// The ext stream (the app's Balanced): the camera has it on FLV only (CX820,
// measured 2026-11-03), with a login token; go2rtc reads it from the proxy's
// loopback feed, which never gives go2rtc the token.
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

// GET on the feed: status, content type and up to `bytes` of the body.
function get(url: string, bytes = 4096): Promise<{ status: number; type: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      const done = () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) });
      res.on('data', (c: Buffer) => {
        chunks.push(c);
        n += c.length;
        if (n >= bytes) (res.destroy(), done());
      });
      res.on('end', done);
      res.on('error', () => undefined);
    }).on('error', reject);
  });
}

// A fake camera FLV: endless until destroyed.
function fakeFlv(): IncomingMessage & { destroyedSeen: () => boolean } {
  const p = new PassThrough();
  const t = setInterval(() => p.write(Buffer.from('FLV\x01\x05\x00\x00\x00\x09')), 20);
  let gone = false;
  p.on('close', () => (clearInterval(t), (gone = true)));
  return Object.assign(p as unknown as IncomingMessage, { destroyedSeen: () => gone });
}

describe('ExtFeed', () => {
  async function feed(open: (cam: string) => Promise<IncomingMessage> | null) {
    const f = new ExtFeed({ open });
    await f.listen();
    cleanup.push(() => f.close());
    return f;
  }

  it('a loopback URL with the camera id and a 48-hex key, no camera secret; undefined before listening', async () => {
    const f0 = new ExtFeed({ open: () => null });
    expect(f0.url('cam1')).toBeUndefined();
    const f = await feed(() => null);
    expect(f.url('cam1')).toMatch(EXT_FEED_URL);
    expect(f.url('cam1')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ext\/cam1\/[a-f0-9]{48}$/);
  });

  it('passes the camera FLV on as video/x-flv and ends it when the reader leaves', async () => {
    const up = fakeFlv();
    const f = await feed(async () => up);
    const r = await get(f.url('cam1')!, 64);
    expect([r.status, r.type]).toEqual([200, 'video/x-flv']);
    expect(r.body.subarray(0, 3).toString()).toBe('FLV');
    await expect.poll(() => up.destroyedSeen()).toBe(true);
    await expect.poll(() => f.count('cam1')).toBe(0);
  });

  it('a wrong key, another path or method is 404; a camera without ext is 404; nothing is opened', async () => {
    let opened = 0;
    const f = await feed((cam) => (opened++, cam === 'noext' ? null : Promise.resolve(fakeFlv())));
    const url = f.url('cam1')!;
    expect((await get(url.replace(/[a-f0-9]{48}$/, 'f'.repeat(48)))).status).toBe(404);
    expect((await get(url.replace('/ext/', '/other/'))).status).toBe(404);
    expect(opened).toBe(0);
    expect((await get(f.url('noext')!)).status).toBe(404);
    const post = await new Promise<number>((r) => http.request(url, { method: 'POST' }, (res) => (res.resume(), r(res.statusCode ?? 0))).end());
    expect(post).toBe(404);
  });

  it('a camera that refuses: 502 with no body, the reason only at debug, never a URL', async () => {
    const f = await feed(async () => {
      throw new CameraError('camera_error', 'FLV: the camera closed the connection (after a new login too)');
    });
    const r = await get(f.url('cam1')!);
    expect([r.status, r.body.length]).toEqual([502, 0]);
    expect(JSON.stringify(logBuffer.recent(200))).not.toMatch(/token=|\/flv\?/);
  });

  it(`at most ${EXT_FEED_MAX_PER_CAMERA} feeds per camera`, async () => {
    const f = await feed(async () => fakeFlv());
    const held = Array.from({ length: EXT_FEED_MAX_PER_CAMERA }, () => new Promise<http.IncomingMessage>((r) => http.get(f.url('cam1')!, r)));
    const open = await Promise.all(held);
    cleanup.push(() => open.forEach((x) => x.destroy()));
    expect(f.count('cam1')).toBe(EXT_FEED_MAX_PER_CAMERA);
    expect((await get(f.url('cam1')!)).status).toBe(503);
    f.closeCamera('cam1');
    await expect.poll(() => f.count()).toBe(0);
  });
});

describe('ReolinkClient.openLiveFlv against cam-sim', () => {
  async function client(model?: 'CX820') {
    const s = await startSim(model ? { model } : {});
    cleanup.push(() => s.close());
    const c = new ReolinkClient({ id: 'cam1', host: s.camera.host, protocol: 'http', user: 'proxy', password: s.password });
    return { s, c, hasExt: !!(s.sim.engine.profile.media as { ext?: unknown }).ext };
  }

  it('the CX820: the ext FLV with the client\'s token (H.264); a revoked token logs in again', async (ctx) => {
    const { s, c, hasExt } = await client('CX820');
    if (!hasExt) return ctx.skip(); // this cam-sim has no ext stream yet
    const res = await c.openLiveFlv();
    expect([res.statusCode, res.headers['content-type']]).toEqual([200, 'video/x-flv']);
    res.destroy();
    const logins = s.sim.engine.counters.logins;
    s.sim.engine.sessions.revokeAll();
    const again = await c.openLiveFlv();
    expect(again.statusCode).toBe(200);
    again.destroy();
    expect(s.sim.engine.counters.logins).toBe(logins + 1);
  });

  it('the RLC-1224A (no ext): refused after one new login, with no URL or token in the error', async (ctx) => {
    const { s, c, hasExt } = await client();
    if (!hasExt && !(await startSimHasExt())) return ctx.skip();
    const err = await c.openLiveFlv().catch((e: Error) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect((err as Error).message).not.toMatch(/token|flv\?|channel0/);
    expect(s.sim.engine.counters.logins).toBe(2);
  });
});

// Whether the installed cam-sim knows the ext stream at all (the RLC-1224A
// profile has none, so ask a CX820 profile).
async function startSimHasExt(): Promise<boolean> {
  const { profileFor } = (await import('cam-sim/dist/src/profile/profile.js').catch(() => ({ profileFor: undefined }))) as { profileFor?: (m: string) => { media: { ext?: unknown } } };
  return !!profileFor?.('CX820').media.ext;
}
