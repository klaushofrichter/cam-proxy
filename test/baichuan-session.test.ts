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
