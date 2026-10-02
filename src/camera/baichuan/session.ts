// src/camera/baichuan/session.ts
// One Baichuan session per camera, ported from reolink_aio 5d37cb3
// (baichuan.py L665-L692 nonce, L1707-L1757 login; base_protocol.py
// L119-L147, L250-L264, L381-L412) and its PR #186 9a1bb52 (MIT; see
// THIRD_PARTY_NOTICES). The session lasts as long as the TCP connection: no
// token; nonce and key are per connection. Always a plain close, never cmd 2
// (it would send the password). Never logs the password, the nonce, the key
// or a login body.
import net from 'node:net';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../../log';
import { aesEncrypt, aesKey, bcXor, decodeText, decryptChunk, md5_31 } from './cipher';
import { BaichuanError } from './errors';
import { encodeFrame, FrameParser, HOST, msgIdOf, type FrameClass } from './frame';

export interface BaichuanTarget { host: string; port: number; user: string; password: string }
export interface SessionOptions {
  idleMs?: number; // close after this long without a request (20 s; the camera drops at about 32 s)
  connectMs?: number; // 5 s
  loginMs?: number; // nonce and login, 10 s
  loginGuardMs?: number; // after a rejected login, no new attempt for this long (15 s)
  now?: () => number;
  log?: Logger;
}
export interface Message { cmd: number; msgId: number; status: number; ext: string; payload: Buffer }
export interface Subscription { msgId: number; close(): void }
interface Handlers { onMessage: (m: Message) => void; onError: (e: BaichuanError) => void }

export const OK_STATUS = new Set([200, 201, 300]);

// aio's LOGIN_XML (xmls.py L3-L15); both values are md5_31 hashes.
export const loginXml = (userHash: string, passwordHash: string): string =>
  `<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<LoginUser version="1.1">\n<userName>${userHash}</userName>\n<password>${passwordHash}</password>\n<userVer>1</userVer>\n</LoginUser>\n<LoginNet version="1.1">\n<type>LAN</type>\n<udpPort>0</udpPort>\n</LoginNet>\n</body>\n`;

export class BaichuanSession {
  private socket: net.Socket | null = null;
  private parser = new FrameParser();
  private key: Buffer | null = null;
  private counter = 0;
  private readonly subs = new Map<number, Handlers & { cmd: number }>();
  private connecting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | undefined;
  private idleDue = false; // idleMs passed since the last request while a call or stream was open
  private generation = 0; // close() bumps it: a connect or login in flight gives up
  private abortConnect: (() => void) | null = null;
  private lastRejected = Number.NEGATIVE_INFINITY;
  private readonly log: Logger;

  constructor(
    private readonly target: () => BaichuanTarget,
    private readonly opts: SessionOptions = {},
  ) {
    this.log = opts.log ?? rootLogger;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  connected(): boolean {
    return this.socket !== null && this.key !== null;
  }

  // Connects and logs in unless a session is open; callers share one attempt.
  ensure(): Promise<void> {
    if (this.connected()) return Promise.resolve();
    this.connecting ??= this.start().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async start(): Promise<void> {
    // aio's guard: a bug must not lock the account.
    if (this.now() - this.lastRejected < (this.opts.loginGuardMs ?? 15_000)) throw new BaichuanError('auth', 'login recently rejected; waiting before the next attempt');
    const t = this.target();
    const gen = this.generation;
    const socket = await this.connect(t);
    if (gen !== this.generation) {
      socket.destroy();
      throw new BaichuanError('offline', 'session closed');
    }
    this.socket = socket;
    this.parser = new FrameParser();
    this.key = null;
    this.counter = 0;
    let answered = false;
    socket.on('data', (d: Buffer) => {
      answered = true;
      this.onData(socket, d);
    });
    socket.on('error', () => undefined); // 'close' follows
    // A reset before any answer is the camera's session limit (12 connections).
    socket.on('close', () =>
      this.lost(socket, answered ? new BaichuanError('offline', 'connection to the camera lost') : new BaichuanError('refused', 'the camera closed the connection before answering (session limit?)')),
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.login(t),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new BaichuanError('timeout', 'login timed out')), this.opts.loginMs ?? 10_000);
        }),
      ]);
    } catch (e) {
      this.close();
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (gen !== this.generation || this.socket !== socket) throw new BaichuanError('offline', 'session closed');
    this.armIdle(); // the login was the last request
  }

  private connect(t: BaichuanTarget): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: t.host, port: t.port });
      const fail = (err: BaichuanError) => {
        clearTimeout(timer);
        this.abortConnect = null;
        s.destroy();
        reject(err);
      };
      const timer = setTimeout(() => fail(new BaichuanError('offline', 'connect timed out')), this.opts.connectMs ?? 5_000);
      const onError = (e: NodeJS.ErrnoException) => fail(new BaichuanError('offline', `connect failed (${e.code ?? 'error'})`));
      this.abortConnect = () => fail(new BaichuanError('offline', 'session closed'));
      s.once('error', onError);
      s.once('connect', () => {
        clearTimeout(timer);
        this.abortConnect = null;
        s.off('error', onError);
        s.setNoDelay(true);
        resolve(s);
      });
    });
  }

  private async login(t: BaichuanTarget): Promise<void> {
    const nonceReply = await this.exchange(1, '1465', 0xdc12, Buffer.alloc(0));
    const nonce = /<nonce>([^<]+)<\/nonce>/.exec(bcXor(nonceReply.payload, HOST).toString('utf8'))?.[1];
    if (!nonce) throw new BaichuanError('protocol', 'no nonce in the reply');
    const body = bcXor(Buffer.from(loginXml(md5_31(t.user + nonce), md5_31(t.password + nonce)), 'utf8'), HOST);
    const reply = await this.exchange(1, '1464', 0, body);
    if (reply.status === 401) {
      this.lastRejected = this.now();
      throw new BaichuanError('auth', 'the camera rejected the login', 401);
    }
    if (!OK_STATUS.has(reply.status)) throw new BaichuanError('protocol', `login answered ${reply.status}`, reply.status);
    this.key = aesKey(nonce, t.password);
  }

  // A handshake message and its reply (before the AES key exists).
  private exchange(cmd: number, cls: FrameClass, code: number, body: Buffer): Promise<Message> {
    return new Promise((resolve, reject) => {
      const msgId = this.nextId();
      this.subs.set(msgId, {
        cmd,
        onMessage: (m) => {
          this.subs.delete(msgId);
          resolve(m);
        },
        onError: reject,
      });
      this.socket?.write(encodeFrame({ cmd, msgId, code, cls }, Buffer.alloc(0), body));
    });
  }

  private nextId(): number {
    this.counter = this.counter >= 0xffffff ? 1 : this.counter + 1;
    return msgIdOf(HOST, this.counter);
  }

  // Every message with this cmd and message id goes to onMessage until close().
  open(cmd: number, xml: string, h: Handlers): Subscription {
    if (!this.socket || !this.key) throw new BaichuanError('offline', 'no session');
    const msgId = this.nextId();
    this.subs.set(msgId, { cmd, ...h });
    this.armIdle(); // idle counts from the last request sent
    this.socket.write(encodeFrame({ cmd, msgId, code: 0, cls: '1464' }, Buffer.alloc(0), aesEncrypt(this.key, Buffer.from(xml, 'utf8'))));
    return {
      msgId,
      close: () => {
        if (this.subs.delete(msgId)) this.released();
      },
    };
  }

  // One request and its first reply. Never retried (a 400 is an answer).
  call(cmd: number, xml: string, timeoutMs = 10_000): Promise<Message> {
    return new Promise((resolve, reject) => {
      let sub: Subscription | undefined;
      const timer = setTimeout(() => {
        sub?.close();
        reject(new BaichuanError('timeout', `cmd ${cmd} timed out`));
      }, timeoutMs);
      try {
        sub = this.open(cmd, xml, {
          onMessage: (m) => {
            clearTimeout(timer);
            sub?.close();
            if (OK_STATUS.has(m.status)) resolve(m);
            else reject(new BaichuanError(m.status === 400 ? 'refused' : 'protocol', `cmd ${cmd} answered ${m.status}`, m.status));
          },
          onError: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  pause(): void {
    this.socket?.pause();
  }

  resume(): void {
    this.socket?.resume();
  }

  text(m: Message): string {
    return decodeText(this.key, m.payload, m.msgId & 0xff);
  }

  chunk(m: Message, encryptLen?: number): Buffer {
    if (!this.key) throw new BaichuanError('offline', 'no session');
    return decryptChunk(this.key, m.payload, encryptLen);
  }

  // A plain close: the camera frees the session at once (measured).
  close(): void {
    this.generation++;
    this.abortConnect?.();
    const s = this.socket;
    if (!s) return;
    this.lost(s, new BaichuanError('offline', 'session closed'));
    s.destroy();
  }

  // Armed at every request sent, so the close always comes before the
  // camera's own drop (about 32 s after the client's last message). Never
  // closes while a call or stream is open: then the close waits for the last
  // one to end, plus a fresh idleMs (the caller may still send cmd 9).
  private armIdle(): void {
    this.idleDue = false;
    this.startIdleTimer();
  }

  private startIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.subs.size === 0) this.close();
      else this.idleDue = true;
    }, this.opts.idleMs ?? 20_000);
    this.idleTimer.unref?.();
  }

  // A call or stream ended.
  private released(): void {
    if (this.subs.size > 0 || !this.socket || !this.idleDue) return;
    this.idleDue = false;
    this.startIdleTimer();
  }

  private lost(socket: net.Socket, err: BaichuanError): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.key = null;
    clearTimeout(this.idleTimer);
    this.idleDue = false;
    const subs = [...this.subs.values()];
    this.subs.clear();
    for (const s of subs) s.onError(err);
  }

  private onData(socket: net.Socket, d: Buffer): void {
    if (this.socket !== socket) return;
    let frames;
    try {
      frames = this.parser.push(d);
    } catch (e) {
      const err = e instanceof BaichuanError ? e : new BaichuanError('protocol', 'unreadable message');
      this.log.warn({ err: err.message }, 'baichuan_protocol_error');
      this.lost(socket, err);
      socket.destroy();
      return;
    }
    for (const f of frames) {
      if (this.socket !== socket) return; // a handler closed the session
      const { cmd, msgId, code, length, payloadOffset } = f.header;
      this.log.debug({ cmd, msgId, status: code, length }, 'baichuan_message'); // never a body
      const sub = this.subs.get(msgId);
      if (!sub || sub.cmd !== cmd) continue; // a push (message id 0), or a stale chunk of a stopped download
      const ext = payloadOffset ? decodeText(this.key, f.body.subarray(0, payloadOffset), msgId & 0xff) : '';
      try {
        sub.onMessage({ cmd, msgId, status: code, ext, payload: f.body.subarray(payloadOffset) });
      } catch {
        // A handler bug must not escape the socket's data event; the other
        // frames in this read still go out.
        this.log.warn({ cmd, msgId }, 'baichuan_handler_error');
        if (this.subs.get(msgId) !== sub) continue; // it already ended (closed or failed)
        this.subs.delete(msgId);
        this.released();
        try {
          sub.onError(new BaichuanError('protocol', `the handler for cmd ${cmd} failed`));
        } catch {
          // nothing more to tell
        }
      }
    }
  }
}
