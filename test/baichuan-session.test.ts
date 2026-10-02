// test/baichuan-session.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'net';
import { BaichuanSession, loginXml, type SessionOptions } from '../src/camera/baichuan/session';
import { BaichuanError } from '../src/camera/baichuan/errors';
import { CAM_PASSWORD, CAM_USER, fakeCamera, type FakeCamera, type FakeOptions } from './helpers/bc-camera';

const XML = '<?xml version="1.0" encoding="UTF-8" ?>\n<body/>\n';
const open: { cam?: FakeCamera; s?: BaichuanSession }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const x of open.splice(0)) {
    x.s?.close();
    await x.cam?.close();
  }
});

async function setup(o: FakeOptions = {}, so: SessionOptions = {}, password = CAM_PASSWORD) {
  const cam = await fakeCamera(o);
  const s = new BaichuanSession(() => ({ host: '127.0.0.1', port: cam.port, user: CAM_USER, password }), so);
  open.push({ cam, s });
  return { cam, s };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BaichuanError);
    return (e as BaichuanError).code;
  }
  throw new Error('expected a BaichuanError');
};

describe('BaichuanSession: login', () => {
  it('the login body is aio LOGIN_XML (296 bytes with 31-character hashes, as traced)', () => {
    expect(Buffer.byteLength(loginXml('X'.repeat(31), 'Y'.repeat(31)))).toBe(296);
  });

  it('logs in once and answers requests, matched by cmd and message id', async () => {
    const { cam, s } = await setup();
    await Promise.all([s.ensure(), s.ensure()]);
    expect(cam.logins).toBe(1);
    expect(s.connected()).toBe(true);
    const m = await s.call(9, XML);
    expect(m.status).toBe(200);
    expect(cam.requests).toEqual([{ cmd: 9, xml: XML }]);
  });

  it('a wrong password is auth; within 15 s the next attempt fails fast without reaching the camera', async () => {
    let t = 1_000_000;
    const { cam, s } = await setup({}, { now: () => t }, 'wrong');
    expect(await code(s.ensure())).toBe('auth');
    expect(await code(s.ensure())).toBe('auth');
    expect(cam.loginAttempts).toBe(1);
    t += 15_000;
    expect(await code(s.ensure())).toBe('auth');
    expect(cam.loginAttempts).toBe(2);
  });

  it('a closed port is offline', async () => {
    const port = await new Promise<number>((r) => {
      const srv = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => r(p));
      });
    });
    const s = new BaichuanSession(() => ({ host: '127.0.0.1', port, user: CAM_USER, password: CAM_PASSWORD }));
    expect(await code(s.ensure())).toBe('offline');
  });

  it('a reset at the first message (the session limit) is refused', async () => {
    const { s } = await setup({ resetAtFirstMessage: true });
    expect(await code(s.ensure())).toBe('refused');
  });

  it('a login with no answer times out', async () => {
    const { s } = await setup({ noLoginReply: true }, { loginMs: 100 });
    expect(await code(s.ensure())).toBe('timeout');
    expect(s.connected()).toBe(false);
  });
});

describe('BaichuanSession: messages', () => {
  it('skips pushes (message id 0) that arrive between a request and its reply', async () => {
    const { s } = await setup({ pushBetween: true });
    await s.ensure();
    const m = await s.call(9, XML);
    expect([m.cmd, m.status]).toEqual([9, 200]);
  });

  it('an unknown cmd answers 405: the call fails, the session stays usable', async () => {
    const { s } = await setup();
    await s.ensure();
    const e = (await s.call(93, XML).catch((x: unknown) => x)) as BaichuanError;
    expect([e.code, e.status]).toEqual(['protocol', 405]);
    expect((await s.call(9, XML)).status).toBe(200);
  });

  it('a lost connection fails every pending request; the next request logs in again', async () => {
    const { cam, s } = await setup({ silentCmds: [50] });
    await s.ensure();
    const pending = s.call(50, XML);
    await vi.waitFor(() => expect(cam.requests.some((r) => r.cmd === 50)).toBe(true));
    cam.dropAll();
    expect(await code(pending)).toBe('offline');
    expect(s.connected()).toBe(false);
    await s.ensure();
    expect(cam.logins).toBe(2);
  });

  it('a reply with bad magic is a protocol error and closes the session', async () => {
    const { s } = await setup({ badMagicOn: 9 });
    await s.ensure();
    expect(await code(s.call(9, XML))).toBe('protocol');
    expect(s.connected()).toBe(false);
  });

  it('a request without a session is offline (no reconnect inside open)', async () => {
    const { s } = await setup();
    expect(() => s.open(9, XML, { onMessage: () => undefined, onError: () => undefined })).toThrow(/no session/);
  });
});

describe('BaichuanSession: idle', () => {
  it('closes the socket 20 s after the last request, sends no keep-alive, and reconnects on demand', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { cam, s } = await setup();
    await s.ensure();
    await s.call(9, XML);
    vi.advanceTimersByTime(19_999);
    expect(s.connected()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(s.connected()).toBe(false);
    await vi.waitFor(() => expect(cam.open()).toBe(0));
    expect(cam.requests.map((r) => r.cmd)).toEqual([9]); // no cmd 93, no cmd 2
    await s.ensure();
    expect(cam.logins).toBe(2);
  });

  it('never closes while a request is open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { s } = await setup({ silentCmds: [50] });
    await s.ensure();
    const sub = s.open(50, XML, { onMessage: () => undefined, onError: () => undefined });
    vi.advanceTimersByTime(60_000);
    expect(s.connected()).toBe(true);
    sub.close();
    vi.advanceTimersByTime(20_000);
    expect(s.connected()).toBe(false);
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWNLOAD = '<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<FileInfo><Id>a.mp4</Id></FileInfo>\n</body>\n';

describe('BaichuanSession: close and failures (review fixes)', () => {
  it('close() during connect rejects ensure() offline, destroys the socket; a later call reconnects', async () => {
    const { cam, s } = await setup();
    const p = s.ensure();
    s.close();
    expect(await code(p)).toBe('offline');
    expect(s.connected()).toBe(false);
    await sleep(50);
    expect(cam.open()).toBe(0);
    await s.ensure();
    expect(s.connected()).toBe(true);
    expect((await s.call(9, XML)).status).toBe(200);
  });

  it('close() during login rejects ensure() offline', async () => {
    const { cam, s } = await setup({ noLoginReply: true });
    const p = s.ensure();
    await vi.waitFor(() => expect(cam.loginAttempts).toBe(1));
    s.close();
    expect(await code(p)).toBe('offline');
    expect(s.connected()).toBe(false);
    await vi.waitFor(() => expect(cam.open()).toBe(0));
  });

  it('two callers with a failing login both reject auth (one attempt)', async () => {
    const { cam, s } = await setup({}, {}, 'wrong');
    const [a, b] = await Promise.all([code(s.ensure()), code(s.ensure())]);
    expect([a, b]).toEqual(['auth', 'auth']);
    expect(cam.loginAttempts).toBe(1);
  });

  it('a throwing handler gets onError (protocol), other replies still arrive, the session stays usable', async () => {
    const { s } = await setup();
    await s.ensure();
    const failed = new Promise<BaichuanError>((resolve) => {
      s.open(9, XML, {
        onMessage: () => {
          throw new Error('handler bug');
        },
        onError: resolve,
      });
    });
    const other = s.call(9, XML); // its reply may come in the same read
    const err = await failed;
    expect(err).toBeInstanceOf(BaichuanError);
    expect(err.code).toBe('protocol');
    expect((await other).status).toBe(200);
    expect(s.connected()).toBe(true);
    expect((await s.call(9, XML)).status).toBe(200);
  });

  it('a drop mid-stream reaches onError (offline)', async () => {
    const { cam, s } = await setup({ files: { 'a.mp4': Buffer.alloc(20_000, 1) }, chunkSize: 1000, delayMs: 30 });
    await s.ensure();
    let messages = 0;
    const err = await new Promise<BaichuanError>((resolve) => {
      s.open(8, DOWNLOAD, {
        onMessage: () => {
          if (++messages === 2) cam.dropAll();
        },
        onError: resolve,
      });
    });
    expect(err.code).toBe('offline');
    expect(s.connected()).toBe(false);
  });

  it('a late reply after a call timeout is ignored', async () => {
    const { cam, s } = await setup({ replyDelayMs: 200 });
    await s.ensure();
    expect(await code(s.call(9, XML, 50))).toBe('timeout');
    await sleep(300); // the late reply arrives
    expect(s.connected()).toBe(true);
    expect((await s.call(9, XML)).status).toBe(200);
    expect(cam.requests.length).toBe(2);
  });
});

describe('BaichuanSession: idle from the last request (review fix)', () => {
  it('a slow reply does not push the idle close past idleMs after the request', async () => {
    const { s } = await setup({ replyDelayMs: 450 }, { idleMs: 500 });
    await s.ensure();
    const sent = Date.now();
    await s.call(9, XML);
    await vi.waitFor(() => expect(s.connected()).toBe(false), { timeout: 3000, interval: 5 });
    expect(Date.now() - sent).toBeLessThan(800); // from the reply it would be about 950
  });

  it('a stream longer than idleMs keeps the session; it closes within idleMs after the stream ends', async () => {
    const { s } = await setup({ files: { 'a.mp4': Buffer.alloc(10_000, 1) }, chunkSize: 1000, delayMs: 60 }, { idleMs: 200 });
    await s.ensure();
    let ended = 0;
    await new Promise<void>((resolve, reject) => {
      let n = 0;
      const sub = s.open(8, DOWNLOAD, {
        onMessage: () => {
          if (++n < 11) return; // the info record and ten chunks
          sub.close();
          ended = Date.now();
          resolve();
        },
        onError: reject,
      });
    });
    expect(s.connected()).toBe(true); // not closed at once: the caller may still send cmd 9
    await vi.waitFor(() => expect(s.connected()).toBe(false), { timeout: 3000, interval: 5 });
    expect(Date.now() - ended).toBeLessThan(400);
  });
});

describe('BaichuanSession: #99 (Task 4)', () => {
  it('close() then ensure() in the same tick starts a new attempt, not the old rejecting one', async () => {
    const { cam, s } = await setup();
    const old = s.ensure();
    s.close();
    const next = s.ensure();
    expect(next).not.toBe(old);
    expect(await code(old)).toBe('offline');
    await next;
    expect(s.connected()).toBe(true);
    expect((await s.call(9, XML)).status).toBe(200);
    expect(cam.logins).toBe(1);
  });

  it('close() during login then ensure(): the old attempt does not close the new one', async () => {
    // The login reply waits, so the close lands mid-login (not after it, as
    // it can on localhost when the close follows the accept).
    const { cam, s } = await setup({ loginDelayMs: 150 });
    const old = s.ensure();
    await vi.waitFor(() => expect(cam.loginAttempts).toBe(1), { interval: 1 });
    expect(s.connected()).toBe(false);
    s.close();
    const next = s.ensure();
    try {
      expect(await code(old)).toBe('offline');
      await next;
      expect(s.connected()).toBe(true);
    } finally {
      await next.catch(() => undefined);
    }
  });

  it('a rejected login logs and reports the attempts the camera has left (remainTimes)', async () => {
    const warn = vi.fn();
    const log = { warn, debug: () => undefined, info: () => undefined, error: () => undefined } as unknown as SessionOptions['log'];
    const { s } = await setup({}, { log }, 'wrong');
    const err = (await s.ensure().catch((e) => e)) as BaichuanError;
    expect(err.code).toBe('auth');
    expect(err.message).toMatch(/10 attempts left/);
    expect(warn).toHaveBeenCalledWith({ remainTimes: 10 }, 'baichuan_login_rejected');
  });

  it('chunk(m) decrypts with the key of the connection the message came on, also after a close', async () => {
    const file = Buffer.alloc(3000);
    for (let i = 0; i < file.length; i++) file[i] = i & 0xff;
    const { s } = await setup({ files: { 'a.mp4': file }, chunkSize: 3000, nonces: ['NONCEONE0000000000', 'NONCETWO0000000000'] });
    await s.ensure();
    const m = await new Promise<Parameters<Parameters<typeof s.open>[2]['onMessage']>[0]>((resolve, reject) => {
      let n = 0;
      const sub = s.open(8, DOWNLOAD, {
        onMessage: (x) => {
          if (++n < 2) return; // the info record
          sub.close();
          resolve(x);
        },
        onError: reject,
      });
    });
    s.close();
    await s.ensure(); // a new connection (and, on a camera, a new key)
    expect(s.chunk(m, 1024)).toEqual(file);
  });
});
