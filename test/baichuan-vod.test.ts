// test/baichuan-vod.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { PassThrough, Writable } from 'stream';
import { createLogger } from '../src/log';
import { aesKey, md5_31 } from '../src/camera/baichuan/cipher';
import { BaichuanError } from '../src/camera/baichuan/errors';
import { BaichuanSession, type SessionOptions } from '../src/camera/baichuan/session';
import { download, downloadXml, stopXml, type DownloadOptions } from '../src/camera/baichuan/vod';
import { CAM_PASSWORD, CAM_USER, fakeCamera, NONCE, type FakeCamera, type FakeOptions } from './helpers/bc-camera';

const PATH = '/mnt/sda/Mp4Record/2026-10-02/RecS0A_DST20261002_040758_040819_0_55148080000000_7224E.mp4';
const FILE = randomBytes(467_534); // the traced sub file's size
const open: { cam: FakeCamera; s: BaichuanSession }[] = [];
afterEach(async () => {
  for (const x of open.splice(0)) {
    x.s.close();
    await x.cam.close();
  }
});

async function setup(o: FakeOptions = {}, so: SessionOptions = {}) {
  const cam = await fakeCamera({ files: { [PATH]: FILE }, ...o });
  const s = new BaichuanSession(() => ({ host: '127.0.0.1', port: cam.port, user: CAM_USER, password: CAM_PASSWORD }), so);
  open.push({ cam, s });
  return { cam, s };
}
function sink(delayMs = 0) {
  const parts: Buffer[] = [];
  const w = new Writable({
    highWaterMark: 64 * 1024,
    write(chunk: Buffer, _e, cb) {
      parts.push(chunk);
      if (delayMs) setTimeout(cb, delayMs);
      else cb();
    },
  });
  return { w, bytes: () => Buffer.concat(parts) };
}
const run = (s: BaichuanSession, out: Writable, o?: DownloadOptions, size = FILE.length) => download(s, PATH, size, out, o);

describe('VOD message builders (as traced)', () => {
  it('cmd 8: Id and channelId, no name (247 bytes for the traced path)', () => {
    const x = downloadXml(PATH);
    expect(Buffer.byteLength(x)).toBe(247);
    expect(x).toContain(`<Id>${PATH}</Id>\n<channelId>0</channelId>\n</FileInfo>`);
    expect(x).not.toContain('<name>');
  });
  it('cmd 9: channelId and handle 0 (167 bytes)', () => {
    expect(Buffer.byteLength(stopXml())).toBe(167);
    expect(stopXml()).toContain('<channelId>0</channelId>\n<handle>0</handle>');
  });
});

describe('download', () => {
  it('skips the 32-byte info record, writes the file, ends at the size, then sends cmd 9', async () => {
    const { cam, s } = await setup();
    const out = sink();
    expect(await run(s, out.w)).toBe(FILE.length);
    expect(out.bytes()).toEqual(FILE);
    await vi.waitFor(() => expect(cam.requests.map((r) => r.cmd)).toEqual([8, 9]));
    expect(cam.requests[0].xml).toBe(downloadXml(PATH));
    expect(cam.requests[1].xml).toBe(stopXml());
  });

  it('ignores pushes between the request, the info record and the chunks', async () => {
    const { s } = await setup({ pushBetween: true });
    const out = sink();
    await run(s, out.w);
    expect(out.bytes()).toEqual(FILE);
  });

  it('a 400 on cmd 8 is refused, with the status; nothing is written', async () => {
    const { s } = await setup({ files: {} });
    const out = sink();
    const e = (await run(s, out.w).catch((x) => x)) as BaichuanError;
    expect([e.code, e.status]).toEqual(['refused', 400]);
    expect(out.bytes().length).toBe(0);
  });

  it('honours backpressure: a slow writer pauses the socket, and the file still comes out whole', async () => {
    const { s } = await setup({ chunkSize: 16_384 });
    await s.ensure();
    const pause = vi.spyOn(s, 'pause');
    const out = sink(2);
    await run(s, out.w);
    expect(pause).toHaveBeenCalled();
    expect(out.bytes()).toEqual(FILE);
  });

  it('no data within firstChunkMs after cmd 8 is a timeout, and cmd 9 is still sent', async () => {
    const { cam, s } = await setup({ firstChunkDelayMs: 300 });
    expect(((await run(s, sink().w, { firstChunkMs: 100 }).catch((x) => x)) as BaichuanError).code).toBe('timeout');
    await vi.waitFor(() => expect(cam.requests.map((r) => r.cmd)).toContain(9));
  });

  it('a stall between chunks is a timeout', async () => {
    const { s } = await setup({ stallAfterChunks: 2 });
    expect(((await run(s, sink().w, { stallMs: 100 }).catch((x) => x)) as BaichuanError).code).toBe('timeout');
  });

  it('a writer that stops taking bytes mid-file is a timeout, and cmd 9 is sent', async () => {
    const { cam, s } = await setup({ chunkSize: 16_384 });
    const stuck = new Writable({ highWaterMark: 16 * 1024, write: () => undefined }); // never calls back
    expect(((await run(s, stuck, { stallMs: 100 }).catch((x) => x)) as BaichuanError).code).toBe('timeout');
    await vi.waitFor(() => expect(cam.requests.map((r) => r.cmd)).toContain(9));
  });

  it('a writer that never takes the last bytes is a timeout', async () => {
    const { s } = await setup();
    let n = 0;
    const stuck = new Writable({
      write(c: Buffer, _e, cb) {
        if ((n += c.length) < FILE.length) cb();
      },
    });
    expect(((await run(s, stuck, { stallMs: 100 }).catch((x) => x)) as BaichuanError).code).toBe('timeout');
  });

  it('a slow writer destroyed mid-transfer fails at once with AbortError, and cmd 9 is sent once', async () => {
    const { cam, s } = await setup({ chunkSize: 16_384 });
    const out = sink(5);
    let n = 0;
    const orig = out.w.write.bind(out.w);
    out.w.write = ((c: Buffer, ...rest: never[]) => {
      if (++n === 4) setTimeout(() => out.w.destroy(), 10);
      return orig(c, ...rest);
    }) as typeof out.w.write;
    const t0 = Date.now();
    const e = (await run(s, out.w, { stallMs: 2000 }).catch((x: Error) => x)) as Error;
    expect(e.name).toBe('AbortError');
    expect(Date.now() - t0).toBeLessThan(1000);
    await vi.waitFor(() => expect(cam.requests.filter((r) => r.cmd === 9)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(cam.requests.filter((r) => r.cmd === 9)).toHaveLength(1);
  });

  it('a failed last write rejects with AbortError and no uncaught error, with no error listener on the writer', async () => {
    const { s } = await setup();
    const uncaught: unknown[] = [];
    const h = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', h);
    try {
      let n = 0;
      const failing = new Writable({
        write(c: Buffer, _e, cb) {
          n += c.length;
          cb(n >= FILE.length ? new Error('disk full') : null);
        },
      });
      const e = (await run(s, failing).catch((x: Error) => x)) as Error;
      expect(e.name).toBe('AbortError');
      await new Promise((r) => setTimeout(r, 20));
      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', h);
    }
  });

  it('a first reply that is not the 32-byte info record is a protocol error', async () => {
    const { s } = await setup({ infoRecord: Buffer.alloc(40) });
    const out = sink();
    expect(((await run(s, out.w).catch((x) => x)) as BaichuanError).code).toBe('protocol');
    expect(out.bytes().length).toBe(0);
  });

  it('more bytes than the size is a protocol error', async () => {
    const { s } = await setup();
    expect(((await run(s, sink().w, {}, 1000).catch((x) => x)) as BaichuanError).code).toBe('protocol');
  });

  it('a dropped connection mid-transfer fails the download', async () => {
    const { cam, s } = await setup({ delayMs: 20 });
    const p = run(s, sink().w);
    await vi.waitFor(() => expect(cam.downloads).toBe(1));
    cam.dropAll();
    expect(((await p.catch((x) => x)) as BaichuanError).code).toBe('offline');
  });

  it('after an abort, stale chunks with the old message id are dropped and the next download on the same connection is whole', async () => {
    const { cam, s } = await setup({ delayMs: 5, staleAfterStop: 13 });
    let n = 0;
    const failing = new Writable({
      write(_c, _e, cb) {
        cb(++n === 2 ? new Error('reader gone') : null);
      },
    });
    const e = (await run(s, failing).catch((x: Error) => x)) as Error;
    expect(e.name).toBe('AbortError');
    const out = sink();
    await run(s, out.w);
    expect(out.bytes()).toEqual(FILE);
    expect(cam.logins).toBe(1); // the same session
  });

  it('an output destroyed while the session connects sends no cmd 8', async () => {
    const { cam, s } = await setup();
    const out = sink();
    const p = run(s, out.w);
    out.w.destroy();
    expect(((await p.catch((x: Error) => x)) as Error).name).toBe('AbortError');
    expect(cam.requests.filter((r) => r.cmd === 8)).toHaveLength(0);
  });

  it('refuses a path that is not a plain recording path', async () => {
    const { s } = await setup();
    expect(((await download(s, '/mnt/sda/x;rm.mp4', 10, sink().w).catch((x) => x)) as BaichuanError).code).toBe('protocol');
  });
});

describe('no secrets in the logs', () => {
  it('a full session at trace level never logs the password, the nonce, the hashes or the key', async () => {
    const lines: string[] = [];
    const log = createLogger('trace', new PassThrough().on('data', (c: Buffer) => lines.push(String(c))));
    const { s } = await setup({ pushBetween: true }, { log });
    await run(s, sink().w);
    const bad = new BaichuanSession(() => ({ host: '127.0.0.1', port: open[0].cam.port, user: CAM_USER, password: 'wrong-password' }), { log });
    await bad.ensure().catch(() => undefined);
    const text = lines.join('');
    expect(text).toContain('baichuan_message'); // it did log at trace/debug
    for (const secret of [CAM_PASSWORD, 'wrong-password', NONCE, md5_31(CAM_USER + NONCE), md5_31(CAM_PASSWORD + NONCE), aesKey(NONCE, CAM_PASSWORD).toString('ascii')]) {
      expect(text).not.toContain(secret);
    }
  });
});
