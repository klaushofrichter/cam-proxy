// test/recording-http-download.test.ts
// HTTP Download (cmd=Download) of an SD recording through the camera client
// (src/recordings/http-download.ts), against cam-sim's E1 Outdoor Pro, which
// serves it (and refuses Baichuan, like the real E1, measured 2026-11-02).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { createServer, type Server } from 'net';
import { PassThrough, Writable } from 'stream';
import { createCamSim, type CamSim } from 'cam-sim';
import { BaichuanError } from '../src/camera/baichuan/errors';
import { ReolinkClient } from '../src/camera/client';
import { httpDownload } from '../src/recordings/http-download';
import { logger } from '../src/log';
import { freePort } from './helpers/proxy';

let sim: CamSim;
let port: number;
const client = () => new ReolinkClient({ id: 'cam1', host: `127.0.0.1:${port}`, protocol: 'http', user: 'proxy', password: 'proxy-pw' });

beforeAll(async () => {
  sim = await createCamSim({ users: [{ name: 'proxy', level: 'admin', password: 'proxy-pw' }], seedClips: 'demo', model: 'E1-Outdoor-Pro' });
  ({ http: port } = await sim.listen({ http: 0 }, '127.0.0.1'));
}, 30_000);
afterAll(async () => {
  await sim.close();
});
afterEach(() => {
  vi.restoreAllMocks();
  sim.engine.faults.clear('downloads.refuse');
  sim.engine.faults.clear('downloads.delayMs');
});

const rec = () => sim.engine.sd.all()[0];
const fileOf = (s: 'sub' | 'main') => readFileSync(sim.engine.mediaFor(rec()).clipPath(s));
function sink() {
  const parts: Buffer[] = [];
  const w = new PassThrough();
  w.on('data', (c: Buffer) => parts.push(c));
  return { w, bytes: () => Buffer.concat(parts) };
}

describe('httpDownload', () => {
  it('writes the whole file, announces its length before the first byte, and never ends the output', async () => {
    const c = client();
    for (const s of ['sub', 'main'] as const) {
      const { name, size } = rec().files[s];
      const out = sink();
      const events: string[] = [];
      out.w.once('data', () => events.push('data'));
      const n = await httpDownload(() => c, name, size, out.w, { length: (b) => events.push(`length ${b}`) });
      const want = fileOf(s);
      expect(n).toBe(want.length);
      expect(out.bytes().equals(want)).toBe(true);
      expect(events).toEqual([`length ${want.length}`, 'data']);
      expect(out.w.writableEnded).toBe(false);
    }
    expect(sim.engine.counters.baichuanDownloads).toBe(0);
  });

  it('a refused Download (the connection closed, no answer) is refused; nothing written', async () => {
    sim.engine.faults.set({ name: 'downloads.refuse' });
    const { name, size } = rec().files.sub;
    const out = sink();
    const e = (await httpDownload(client, name, size, out.w).catch((x) => x)) as BaichuanError;
    expect(e).toBeInstanceOf(BaichuanError);
    expect([e.code, e.message]).toEqual(['refused', 'HTTP Download: the camera closed the connection']);
    expect(out.bytes().length).toBe(0);
  });

  it('a file the camera doesn\'t have is refused too (cam-sim resets, as the camera does)', async () => {
    const e = (await httpDownload(client, '/mnt/sda/Mp4Record/2026-01-01/RecS03_20260101_000000_000010_2B14808_100.mp4', 256, sink().w).catch((x) => x)) as BaichuanError;
    expect(e.code).toBe('refused');
  });

  it('an expired token: logs in again and downloads', async () => {
    const c = client();
    const { name, size } = rec().files.sub;
    await httpDownload(() => c, name, size, sink().w);
    sim.engine.sessions.revokeAll();
    expect(await httpDownload(() => c, name, size, sink().w)).toBe(fileOf('sub').length);
  });

  it('a path that is not a recording: protocol, nothing sent', async () => {
    const before = sim.engine.counters.downloads;
    for (const p of ['/mnt/sda/x.mp4?cmd=Reboot', '../etc/passwd', '/mnt/sda/a b.mp4']) {
      const e = (await httpDownload(client, p, 1, sink().w).catch((x) => x)) as BaichuanError;
      expect([e.code, e.message], p).toEqual(['protocol', 'unexpected recording path']);
    }
    expect(sim.engine.counters.downloads).toBe(before);
  });

  it('a camera that is not there: offline (connect)', async () => {
    const dead = await freePort();
    const c = new ReolinkClient({ id: 'cam1', host: `127.0.0.1:${dead}`, protocol: 'http', user: 'proxy', password: 'proxy-pw' });
    const e = (await httpDownload(() => c, rec().files.sub.name, 1, sink().w).catch((x) => x)) as BaichuanError;
    expect([e.code, e.phase]).toEqual(['offline', 'connect']);
  });

  it('no answer within firstByteMs: timeout', async () => {
    sim.engine.faults.set({ name: 'downloads.delayMs', ms: 2000 });
    const { name, size } = rec().files.sub;
    const e = (await httpDownload(client, name, size, sink().w, {}, { firstByteMs: 300 }).catch((x) => x)) as BaichuanError;
    expect(e.code).toBe('timeout');
  });

  it('a writer that stops taking bytes is a writer stall (not the camera\'s), and the camera connection is closed', async () => {
    const { name, size } = rec().files.main;
    const stuck = new Writable({ highWaterMark: 1024, write: () => undefined }); // never calls back
    const e = (await httpDownload(client, name, size, stuck, {}, { stallMs: 300 }).catch((x) => x)) as BaichuanError;
    expect([e.code, e.phase]).toEqual(['timeout', 'writer']);
    await vi.waitFor(() => expect(sim.engine.counters.activeDownloads).toBe(0));
  });

  it('an output that closes mid-download aborts it', async () => {
    const { name, size } = rec().files.main;
    const out = new PassThrough({ highWaterMark: 1024 });
    let n = 0;
    out.on('data', (c: Buffer) => {
      n += c.length;
      if (n > 10_000) out.destroy();
    });
    const e = (await httpDownload(client, name, size, out).catch((x) => x)) as Error;
    expect(e.name).toBe('AbortError');
    await vi.waitFor(() => expect(sim.engine.counters.activeDownloads).toBe(0));
  });

  // A camera that logs in and answers Download with `answer` (raw HTTP).
  async function fakeCamera(answer: string, run: (c: ReolinkClient) => Promise<void>) {
    const srv: Server = createServer((sock) => {
      sock.once('data', (d) => {
        if (d.toString().includes('cmd=Login')) {
          const body = JSON.stringify([{ cmd: 'Login', code: 0, value: { Token: { name: 'abc', leaseTime: 3600 } } }]);
          sock.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
        } else sock.end(answer);
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const p = (srv.address() as { port: number }).port;
    try {
      await run(new ReolinkClient({ id: 'cam1', host: `127.0.0.1:${p}`, protocol: 'http', user: 'u', password: 'p' }));
    } finally {
      srv.close();
    }
  }
  const PATH = '/mnt/sda/Mp4Record/2026-11-02/a.mp4';
  const json = (b: unknown, status = '200 OK') => { const t = JSON.stringify(b); return `HTTP/1.1 ${status}\r\nContent-Type: text/html\r\nContent-Length: ${t.length}\r\n\r\n${t}`; };

  it('a body shorter than its Content-Length is a protocol error', async () => {
    await fakeCamera('HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 1000\r\n\r\n' + 'x'.repeat(10), async (c) => {
      const e = (await httpDownload(() => c, PATH, 1000, sink().w).catch((x) => x)) as BaichuanError;
      expect([e.code, e.message]).toEqual(['protocol', 'HTTP Download: broke off after 10 bytes']);
    });
  });

  it('an announced length far over the name\'s size is a protocol error, before any byte', async () => {
    await fakeCamera('HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: 999999999\r\n\r\nxx', async (c) => {
      const out = sink();
      const e = (await httpDownload(() => c, PATH, 1000, out.w).catch((x) => x)) as BaichuanError;
      expect(e.code).toBe('protocol');
      expect(out.bytes().length).toBe(0);
    });
  });

  it('the camera\'s JSON error instead of the file: refused, with its rspCode and detail', async () => {
    await fakeCamera(json([{ cmd: 'Download', code: 1, error: { rspCode: -17, detail: 'rcv failed' } }]), async (c) => {
      const e = (await httpDownload(() => c, PATH, 1000, sink().w).catch((x) => x)) as BaichuanError;
      expect([e.code, e.message, e.status]).toEqual(['refused', 'HTTP Download: rspCode -17 "rcv failed"', 200]);
    });
  });

  it('another HTTP status: refused, with it', async () => {
    await fakeCamera('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n', async (c) => {
      const e = (await httpDownload(() => c, PATH, 1000, sink().w).catch((x) => x)) as BaichuanError;
      expect([e.code, e.message, e.status]).toEqual(['refused', 'HTTP Download: HTTP 404', 404]);
    });
  });

  it('a 401 every time: auth, after one more login', async () => {
    await fakeCamera('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n', async (c) => {
      const e = (await httpDownload(() => c, PATH, 1000, sink().w).catch((x) => x)) as BaichuanError;
      expect(e.code).toBe('auth');
    });
  });

  it('logs no URL, token or password', async () => {
    const spies = (['trace', 'debug', 'info', 'warn', 'error'] as const).map((l) => vi.spyOn(logger, l));
    sim.engine.faults.set({ name: 'downloads.refuse' });
    await httpDownload(client, rec().files.sub.name, 1, sink().w).catch(() => undefined);
    const text = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(text).not.toMatch(/token=|proxy-pw|cmd=Download|source=/);
  });
});
