// test/recording-download-path.test.ts
// The per-camera choice between the Baichuan download and HTTP Download
// (src/recordings/download-path.ts): Baichuan first; a camera that refuses it
// (400, the file still listed) gets HTTP, which is then remembered, with
// Baichuan tried again after a while.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough, type Writable } from 'stream';
import { BaichuanError } from '../src/camera/baichuan/errors';
import { DownloadRouter, BAICHUAN_RETRY_MS, type PathDownload } from '../src/recordings/download-path';
import { logger } from '../src/log';

afterEach(() => vi.restoreAllMocks());

const REFUSED = () => new BaichuanError('refused', 'the download answered 400, no body', 400);

// A download that answers from a script: a number (bytes written), or an error.
function path(script: (number | Error)[]) {
  const calls: string[] = [];
  const fn: PathDownload = async (p, _size, out) => {
    calls.push(p);
    const next = script.length > 1 ? script.shift()! : script[0];
    if (next instanceof Error) throw next;
    out.write(Buffer.alloc(next));
    return next;
  };
  return { fn, calls };
}

function setup(o: { baichuan: (number | Error)[]; http?: (number | Error)[]; retryMs?: number }) {
  const clock = { t: 1_000_000 };
  const bc = path(o.baichuan);
  const http = o.http ? path(o.http) : undefined;
  const router = new DownloadRouter({ cam: () => 'cam1', baichuan: bc.fn, http: http?.fn, now: () => clock.t, retryMs: o.retryMs });
  const out = (): Writable => new PassThrough().resume();
  const get = (ctx: { gone?: () => Promise<boolean> } = {}) => router.download('/mnt/sda/Mp4Record/2026-11-02/a.mp4', 100, out(), ctx);
  return { clock, bc, http, router, get };
}

describe('DownloadRouter: which path', () => {
  it('Baichuan works: Baichuan only, HTTP never asked', async () => {
    const s = setup({ baichuan: [100], http: [100] });
    expect(await s.get()).toBe(100);
    expect(await s.get()).toBe(100);
    expect(s.bc.calls).toHaveLength(2);
    expect(s.http!.calls).toHaveLength(0);
    expect(s.router.status()).toMatchObject({ path: 'baichuan', baichuanRefusal: null, retryBaichuanAt: null });
  });

  it('Baichuan refused (400, still listed): HTTP fetches it, and later downloads go straight to HTTP', async () => {
    const s = setup({ baichuan: [REFUSED()], http: [120] });
    const gone = vi.fn(async () => false);
    expect(await s.get({ gone })).toBe(120);
    expect(gone).toHaveBeenCalledTimes(1);
    expect(s.bc.calls).toHaveLength(1);
    expect(s.http!.calls).toHaveLength(1);
    expect(s.router.status()).toEqual({
      path: 'http',
      since: s.clock.t,
      baichuanRefusal: { at: s.clock.t, status: 400, detail: 'the download answered 400, no body' },
      retryBaichuanAt: s.clock.t + BAICHUAN_RETRY_MS,
    });
    s.clock.t += 60_000;
    expect(await s.get({ gone })).toBe(120);
    expect(s.bc.calls).toHaveLength(1); // not asked again
    expect(s.http!.calls).toHaveLength(2);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('a 400 for a file the camera no longer lists is not_found: no HTTP try, the path stays', async () => {
    const s = setup({ baichuan: [REFUSED()], http: [120] });
    await expect(s.get({ gone: async () => true })).rejects.toMatchObject({ code: 'not_found', status: 400 });
    expect(s.http!.calls).toHaveLength(0);
    expect(s.router.status().path).toBe('baichuan');
  });

  it('offline, timeout, auth, protocol and a refusal that is not a 400: no HTTP try', async () => {
    for (const err of [
      new BaichuanError('offline', 'camera unreachable', undefined, 'connect'),
      new BaichuanError('timeout', 'the download stalled'),
      new BaichuanError('auth', 'login rejected'),
      new BaichuanError('protocol', 'the download answered 500', 500),
      new BaichuanError('timeout', 'the writer stalled', undefined, 'writer'),
    ]) {
      const s = setup({ baichuan: [err], http: [120] });
      await expect(s.get({ gone: async () => false })).rejects.toBe(err);
      expect(s.http!.calls, err.message).toHaveLength(0);
      expect(s.router.status().path).toBe('baichuan');
    }
  });

  it('both refuse: refused, with a detail naming both; no status (the list was asked already)', async () => {
    const s = setup({ baichuan: [REFUSED()], http: [new BaichuanError('refused', 'HTTP Download: the camera closed the connection')] });
    const err = await s.get({ gone: async () => false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaichuanError);
    expect(err).toMatchObject({ code: 'refused', status: undefined });
    expect((err as Error).message).toBe('Baichuan: the download answered 400, no body; HTTP: HTTP Download: the camera closed the connection');
    expect(s.router.status()).toMatchObject({ path: 'baichuan', baichuanRefusal: { status: 400 } });
  });

  it('HTTP failing in another way (offline, mid-transfer) is that error, not a refusal', async () => {
    const off = new BaichuanError('offline', 'camera unreachable (ECONNREFUSED)', undefined, 'connect');
    const s = setup({ baichuan: [REFUSED()], http: [off] });
    await expect(s.get({ gone: async () => false })).rejects.toBe(off);
    expect(s.router.status().path).toBe('baichuan');
  });

  it('no HTTP path (not wired): a Baichuan refusal stays as it was', async () => {
    const s = setup({ baichuan: [REFUSED()] });
    await expect(s.get({ gone: async () => false })).rejects.toMatchObject({ code: 'refused', status: 400, message: 'the download answered 400, no body' });
  });

  it('after the retry time, Baichuan first again: still refused → HTTP, retry pushed out; working → back to Baichuan', async () => {
    const s = setup({ baichuan: [REFUSED(), REFUSED(), 100], http: [120], retryMs: 1000 });
    await s.get({ gone: async () => false });
    s.clock.t += 999;
    await s.get({ gone: async () => false });
    expect(s.bc.calls).toHaveLength(1);
    s.clock.t += 1;
    expect(await s.get({ gone: async () => false })).toBe(120);
    expect(s.bc.calls).toHaveLength(2);
    expect(s.router.status()).toMatchObject({ path: 'http', retryBaichuanAt: s.clock.t + 1000 });
    s.clock.t += 1000;
    expect(await s.get({ gone: async () => false })).toBe(100);
    expect(s.router.status()).toMatchObject({ path: 'baichuan', since: s.clock.t, retryBaichuanAt: null });
    expect(s.http!.calls).toHaveLength(3);
  });

  it('on HTTP, an HTTP refusal tries Baichuan; when that works, Baichuan again', async () => {
    const s = setup({ baichuan: [REFUSED(), 100], http: [120, new BaichuanError('refused', 'HTTP Download: HTTP 404', 404)] });
    await s.get({ gone: async () => false });
    expect(await s.get({ gone: async () => false })).toBe(100);
    expect(s.router.status().path).toBe('baichuan');
  });

  it('reset (the camera side restarted) forgets the path', async () => {
    const s = setup({ baichuan: [REFUSED(), 100], http: [120] });
    await s.get({ gone: async () => false });
    expect(s.router.status().path).toBe('http');
    s.router.reset();
    expect(s.router.status()).toEqual({ path: 'baichuan', since: null, baichuanRefusal: null, retryBaichuanAt: null });
    expect(await s.get()).toBe(100);
  });
});

describe('DownloadRouter: the log', () => {
  it('one info line when a path is first used and at each change, with the camera\'s Baichuan refusal', async () => {
    const info = vi.spyOn(logger, 'info');
    const s = setup({ baichuan: [100, 100, REFUSED(), 100], http: [120], retryMs: 1000 });
    const lines = () => info.mock.calls.filter((c) => c[1] === 'recording_download_path').map((c) => c[0]);
    await s.get({ gone: async () => false });
    await s.get({ gone: async () => false });
    expect(lines()).toEqual([{ camera: 'cam1', path: 'baichuan' }]);
    await s.get({ gone: async () => false }); // refused → http
    await s.get({ gone: async () => false });
    expect(lines()).toEqual([
      { camera: 'cam1', path: 'baichuan' },
      { camera: 'cam1', path: 'http', baichuanRefusal: { status: 400, detail: 'the download answered 400, no body' }, retryBaichuanInMin: 0 },
    ]);
    s.clock.t += 1000;
    await s.get({ gone: async () => false }); // Baichuan works again
    expect(lines()).toHaveLength(3);
    expect(lines()[2]).toEqual({ camera: 'cam1', path: 'baichuan' });
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/token|password/i);
  });
});
