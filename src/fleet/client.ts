import type { HealthSummary } from '../health/summary';
import { buildHeartbeat, type HeartbeatProxyInfo } from './heartbeat';
import type { AdminKeyFile } from './keyfile';
import { buildEnvelope, fingerprint, parseEnvelope, sign, signedText, verify, type Envelope } from './protocol';

// The outbound client to cams-admin (spec 2026-10-06-cams-admin-phase1-design
// §8.3-§8.8, §9.1): one WebSocket (Node's global), one timer for the next
// heartbeat or retry, one heartbeat in flight, nothing queued. Every handler
// is wrapped: a failure is logged (admin_client_error) and becomes a
// reconnect with backoff, never an unhandled rejection. It never calls a camera.

export type ClientState = 'connecting' | 'connected' | 'backoff' | 'rejected' | 'incompatible' | 'stopped';

export interface Timing {
  connectTimeoutMs: number; // until the socket is open (10 s)
  helloTimeoutMs: number; // open → welcome (10 s)
  closeGraceMs: number; // a close() unanswered counts as closed after this (2 s)
  backoffCapMs: number; // 5 min
  resetAfterMs: number; // connected this long: the attempt count starts again (60 s)
  replacedWaitMs: number; // after 4409 (30 s)
  rejectedRetryMs: number; // after 4401/4403/untrusted (15 min)
  incompatibleRetryMs: number; // after 426 (6 h)
  rateLimitedDefaultS: number; // after 4429 without retryAfterS (60 s)
  minIntervalS: number; // the floor under ack.nextInS and early heartbeats (10 s)
  jitterS: number; // ±2 s on the heartbeat interval
  byeWaitMs: number; // stop(): how long the close may take (1 s)
  changeCheckMs: number; // how often changeKey is read (5 s)
  healthTimeoutMs: number; // a summary that takes longer is a failure (10 s)
  maxBufferedBytes: number; // unsent data above this: the heartbeat is skipped (512 KiB)
  maxInboundBytes: number; // a larger message is refused (256 KiB, the server's own frame cap)
}

export const DEFAULT_TIMING: Timing = {
  connectTimeoutMs: 10_000, helloTimeoutMs: 10_000, closeGraceMs: 2000, backoffCapMs: 300_000, resetAfterMs: 60_000,
  replacedWaitMs: 30_000, rejectedRetryMs: 15 * 60_000, incompatibleRetryMs: 6 * 3600_000, rateLimitedDefaultS: 60,
  minIntervalS: 10, jitterS: 2, byeWaitMs: 1000, changeCheckMs: 5000, healthTimeoutMs: 10_000, maxBufferedBytes: 512 * 1024, maxInboundBytes: 256 * 1024,
};

export interface ClientLog {
  info(o: object, msg: string): void;
  warn(o: object, msg: string): void;
  debug(o: object, msg: string): void;
}

export interface ClientView {
  state: ClientState;
  url: string;
  account: string;
  proxyId: string;
  fingerprint: string;
  connectedSince: number | null;
  lastHeartbeatAt: number | null;
  lastAckAt: number | null;
  lastError: string | null; // kept after a reconnect, with its time
  lastErrorAt: number | null;
  retryInMs: number | null;
  attempt: number;
  truncated: boolean;
}

export interface ClientDeps {
  keyFile: AdminKeyFile;
  health: () => Promise<HealthSummary>;
  proxyInfo: () => HeartbeatProxyInfo;
  version: string;
  log: ClientLog;
  // Cheap, read every changeCheckMs: a change sends an early heartbeat (§8.5).
  changeKey?: () => string;
  timing?: Partial<Timing>;
  random?: () => number;
  now?: () => number; // the proxy's clock for envelope ts (tests: a clock that is off)
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
}

const PROTOCOL = 'cams-admin.v1';

// Full jitter: random(0, min(cap, 1 s · 2^attempt)).
export function backoffDelay(attempt: number, capMs: number, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(capMs, 1000 * 2 ** Math.min(attempt, 30)));
}

export class AdminClient {
  private readonly t: Timing;
  private readonly key: AdminKeyFile;
  private state: ClientState = 'stopped';
  private ws: WebSocket | null = null;
  private stopping = true;
  private timer: NodeJS.Timeout | null = null; // the next heartbeat or the next connect
  private timerDue = 0;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private changeTimer: NodeJS.Timeout | null = null;
  private seqOut = 0;
  private seqIn = 0;
  private opened = false;
  private helloSent = false;
  private closeHandled = false;
  private attempt = 0;
  private connectedAt = 0;
  private unacked = new Set<string>();
  private nextInS = 30;
  private retryAfterS: number | null = null;
  private untrusted = false;
  private immediate = false;
  private sending = false;
  private lastHeartbeatAt: number | null = null;
  private lastAckAt: number | null = null;
  private lastError: string | null = null;
  private lastErrorAt: number | null = null;
  private reason: string | null = null; // why this connection ends, if known
  private lastOutcome: ClientState | null = null;
  private lastChangeKey: string | null = null;
  private truncated = false;
  private readonly fp: string;

  constructor(private readonly d: ClientDeps) {
    this.t = { ...DEFAULT_TIMING, ...d.timing };
    this.key = d.keyFile;
    this.fp = fingerprint(d.keyFile.publicKey);
  }

  view(): ClientView {
    return {
      state: this.state,
      url: this.key.url,
      account: this.key.account,
      proxyId: this.key.proxyId,
      fingerprint: this.fp,
      connectedSince: this.state === 'connected' ? this.connectedAt : null,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastAckAt: this.lastAckAt,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      retryInMs: this.timer && this.state !== 'connected' ? Math.max(0, this.timerDue - Date.now()) : null,
      attempt: this.attempt,
      truncated: this.truncated,
    };
  }

  start(): void {
    if (!this.stopping) return;
    this.stopping = false;
    if (this.d.changeKey) {
      this.changeTimer = setInterval(() => this.guard('change', () => this.checkChange()), this.t.changeCheckMs);
      this.changeTimer.unref();
    }
    this.connect();
  }

  // Now, whatever the state: a socket open is closed first.
  reconnect(): void {
    if (this.stopping) return;
    this.attempt = 0;
    if (this.ws) {
      this.immediate = true;
      this.closeSocket();
    } else {
      this.clearTimer();
      this.connect();
    }
  }

  // bye (if connected), then close; done within byeWaitMs whatever the server does.
  async stop(reason: 'shutdown' | 'restart' | 'unenrolled' = 'shutdown'): Promise<void> {
    if (this.stopping && !this.ws) {
      this.state = 'stopped';
      return;
    }
    this.stopping = true;
    this.clearTimer();
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    if (this.changeTimer) clearInterval(this.changeTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      const wasConnected = this.state === 'connected';
      if (wasConnected) this.trySend(ws, 'bye', { reason });
      await new Promise<void>((resolve) => {
        const done = setTimeout(resolve, this.t.byeWaitMs);
        done.unref();
        ws.addEventListener('close', () => {
          clearTimeout(done);
          resolve();
        });
        try {
          ws.close(1000);
        } catch {
          resolve();
        }
      });
      if (wasConnected) this.d.log.info({ reason }, 'admin_disconnected');
    }
    this.state = 'stopped';
  }

  // ---- connection ----

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  private guard(where: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.clientError(where, err);
    }
  }

  private clientError(where: string, err: unknown): void {
    const e = err as Error;
    this.reason = `${where}: ${String(e?.message ?? e).slice(0, 180)}`;
    this.fail(this.reason);
    this.d.log.warn({ where, err: String(e?.message ?? e).slice(0, 200) }, 'admin_client_error');
    this.d.log.debug({ where, stack: e?.stack }, 'admin_client_error_stack');
  }

  private fail(text: string): void {
    this.lastError = text.slice(0, 200);
    this.lastErrorAt = Date.now();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private setTimer(ms: number, fn: () => void): void {
    this.clearTimer();
    this.timerDue = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.guard('timer', fn);
    }, ms);
    this.timer.unref();
  }

  private connect(): void {
    if (this.stopping) return;
    this.state = 'connecting';
    this.seqOut = 0;
    this.seqIn = 0;
    this.opened = false;
    this.helloSent = false;
    this.closeHandled = false;
    this.unacked.clear();
    this.retryAfterS = null;
    this.untrusted = false;
    this.immediate = false;
    this.reason = null;
    this.d.log.debug({ url: this.key.connectUrl, attempt: this.attempt }, 'admin_connecting');
    let ws: WebSocket;
    try {
      ws = new (this.d.WebSocketImpl ?? WebSocket)(this.key.connectUrl, [PROTOCOL]);
    } catch (err) {
      this.clientError('connect', err);
      void this.afterClose(1006);
      return;
    }
    this.ws = ws;
    this.handshakeTimer = setTimeout(() => {
      if (this.ws === ws && this.state === 'connecting') {
        this.reason = this.opened ? 'no welcome from cams-admin in time' : 'cams-admin did not answer in time';
        this.closeSocket();
      }
    }, this.t.connectTimeoutMs);
    this.handshakeTimer.unref();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.opened = true;
      // From open: the challenge, hello and welcome within helloTimeoutMs.
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = setTimeout(() => {
        if (this.ws === ws && this.state === 'connecting') {
          this.reason = 'no welcome from cams-admin in time';
          this.closeSocket();
        }
      }, this.t.helloTimeoutMs);
      this.handshakeTimer.unref();
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return;
      try {
        if (typeof ev.data !== 'string') throw new Error('a binary message');
        if (ev.data.length > this.t.maxInboundBytes) throw new Error('a message over the size limit');
        this.onMessage(ws, parseEnvelope(ev.data));
      } catch (err) {
        this.clientError('message', err);
        this.closeSocket(4400);
      }
    };
    ws.onerror = () => undefined; // the close follows
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws === ws) void this.afterClose(ev.code).catch((err: unknown) => this.clientError('close', err));
    };
  }

  // Closes, and treats the socket as closed after closeGraceMs when the peer
  // never answers (a dead or blackholed link, or a server that never reads).
  private closeSocket(code = 1000): void {
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.close(code);
    } catch {
      /* closing already */
    }
    const t = setTimeout(() => {
      if (this.ws === ws) void this.afterClose(1006).catch((err: unknown) => this.clientError('close', err));
    }, this.t.closeGraceMs);
    t.unref();
  }

  private trySend(ws: WebSocket, type: string, body: Record<string, unknown>, extra: { re?: string; sig?: string } = {}): string | null {
    if (ws.readyState !== WebSocket.OPEN) return null;
    const m = buildEnvelope(type, ++this.seqOut, body, { now: this.now(), ...extra });
    ws.send(JSON.stringify(m));
    return m.id;
  }

  private onMessage(ws: WebSocket, m: Envelope): void {
    if (m.seq !== this.seqIn + 1) throw new Error(`seq ${m.seq} after ${this.seqIn}`);
    this.seqIn = m.seq;
    const b = m.body;
    switch (m.type) {
      case 'challenge': {
        if (this.helloSent || this.state !== 'connecting') throw new Error('an unexpected challenge');
        const { connId, nonce, serverTime } = b as { connId: string; nonce: string; serverTime: number };
        if (typeof connId !== 'string' || typeof nonce !== 'string' || typeof serverTime !== 'number') throw new Error('a malformed challenge');
        const text = signedText.challenge(connId, nonce, serverTime);
        if (!this.key.serverKeys.some((k) => verify(k, text, m.sig))) {
          this.untrusted = true;
          this.reason = 'cams-admin is not trusted: its challenge signature does not match the pinned key';
          this.d.log.warn({ url: this.key.connectUrl }, 'admin_server_untrusted');
          this.closeSocket();
          return;
        }
        const ts = Math.max(0, Math.floor(this.now()));
        const k = this.key;
        this.helloSent = true;
        this.trySend(ws, 'hello', { proxyId: k.proxyId, keyId: k.keyId, connId, nonce, ts, version: this.d.version.slice(0, 64), capabilities: ['status'] }, { sig: sign(k.privateKey, signedText.hello(connId, nonce, k.proxyId, k.keyId, ts)) });
        return;
      }
      case 'welcome': {
        if (!this.helloSent || this.state !== 'connecting') throw new Error('an unexpected welcome');
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
        this.state = 'connected';
        this.connectedAt = Date.now();
        this.lastOutcome = 'connected';
        this.nextInS = typeof b.heartbeatS === 'number' ? b.heartbeatS : 30;
        this.d.log.info({ url: this.key.url, proxyId: this.key.proxyId }, 'admin_connected');
        this.heartbeat();
        return;
      }
      case 'ack':
        if (m.re && this.unacked.has(m.re)) {
          this.unacked.clear();
          this.lastAckAt = Date.now();
        }
        if (typeof b.nextInS === 'number' && Number.isFinite(b.nextInS)) this.nextInS = b.nextInS;
        return;
      case 'error':
        if (typeof b.retryAfterS === 'number' && Number.isFinite(b.retryAfterS)) this.retryAfterS = Math.min(Math.max(0, b.retryAfterS), 3600);
        this.d.log.debug({ code: String(b.code).slice(0, 64) }, 'admin_server_error');
        return;
      case 'bye':
        this.d.log.debug({ reason: String(b.reason).slice(0, 64) }, 'admin_server_bye');
        return;
      default:
        // P2/P3 types (command, result, event, key.rotate) and anything unknown.
        this.trySend(ws, 'error', { code: 'unsupported_type', message: `type ${m.type.slice(0, 100)} is not supported` }, { re: m.id });
    }
  }

  private async afterClose(code: number): Promise<void> {
    if (this.closeHandled) return;
    this.closeHandled = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.clearTimer();
    const wasConnected = this.state === 'connected';
    const opened = this.opened;
    this.ws = null;
    if (this.stopping) {
      this.state = 'stopped';
      return;
    }
    if (wasConnected) this.d.log.info({ code }, 'admin_disconnected');
    if (wasConnected && Date.now() - this.connectedAt >= this.t.resetAfterMs) this.attempt = 0;
    const random = this.d.random ?? Math.random;
    const normal = () => backoffDelay(this.attempt++, this.t.backoffCapMs, random);
    if (this.immediate) return this.retry('backoff', 0);
    if (this.untrusted || code === 4401 || code === 4403) {
      this.fail(this.untrusted ? this.reason! : `rejected by cams-admin (${code}): re-enroll`);
      if (this.lastOutcome !== 'rejected') this.d.log.info({ code }, 'admin_rejected');
      this.lastOutcome = 'rejected';
      return this.retry('rejected', this.t.rejectedRetryMs);
    }
    if (code === 4409) {
      this.fail('replaced by another connection with the same key (4409)');
      this.d.log.info({}, 'admin_replaced');
      return this.retry('backoff', this.t.replacedWaitMs + normal());
    }
    if (code === 4429) {
      this.fail('rate limited by cams-admin (4429)');
      return this.retry('backoff', (this.retryAfterS ?? this.t.rateLimitedDefaultS) * 1000 + normal());
    }
    if (!opened && (await this.incompatible())) {
      if (this.stopping) return;
      this.fail('cams-admin does not speak cams-admin.v1: update the proxy or cams-admin');
      if (this.lastOutcome !== 'incompatible') this.d.log.info({}, 'admin_incompatible');
      this.lastOutcome = 'incompatible';
      return this.retry('incompatible', this.t.incompatibleRetryMs);
    }
    if (this.stopping) return;
    this.fail(this.reason ?? (!opened ? 'cams-admin could not be reached' : !wasConnected ? `closed during the handshake (${code})` : `connection closed (${code})`));
    this.lastOutcome = 'backoff';
    this.retry('backoff', normal());
  }

  private retry(state: ClientState, ms: number): void {
    if (this.stopping) return;
    this.state = state;
    this.d.log.debug({ state, inMs: ms }, 'admin_retry');
    this.setTimer(ms, () => this.connect());
  }

  // Node's WebSocket can't show the upgrade's HTTP status: a plain GET on the
  // channel answers 426 with the supported subprotocols (spec §8.1).
  private async incompatible(): Promise<boolean> {
    try {
      const u = new URL(this.key.connectUrl);
      u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
      const r = await (this.d.fetchImpl ?? fetch)(u, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (r.status !== 426) return false;
      const b = (await r.json()) as { supported?: unknown };
      return Array.isArray(b.supported) && !b.supported.includes(PROTOCOL);
    } catch {
      return false;
    }
  }

  // ---- heartbeats ----

  private heartbeat(): void {
    void this.sendHeartbeat().catch((err: unknown) => {
      this.clientError('heartbeat', err);
      this.closeSocket();
    });
  }

  private async sendHeartbeat(): Promise<void> {
    const ws = this.ws;
    if (this.state !== 'connected' || !ws || this.sending) return;
    if (this.unacked.size >= 3) {
      this.reason = 'no ack for 3 heartbeats';
      this.d.log.debug({}, 'admin_ack_missing');
      this.closeSocket();
      return;
    }
    this.sending = true;
    try {
      let timeout: NodeJS.Timeout | undefined;
      const summary = await Promise.race([
        this.d.health(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('the health summary took too long')), this.t.healthTimeoutMs);
          timeout.unref();
        }),
      ]).finally(() => clearTimeout(timeout));
      if (this.ws !== ws || this.state !== 'connected') return;
      this.lastChangeKey = this.d.changeKey ? this.d.changeKey() : null;
      if (ws.bufferedAmount > this.t.maxBufferedBytes) {
        // cams-admin isn't reading: skipped (it counts as unacknowledged).
        this.unacked.add(`skipped-${Date.now()}`);
        this.d.log.debug({ buffered: ws.bufferedAmount }, 'admin_heartbeat_skipped');
      } else {
        const hb = buildHeartbeat(summary, this.d.proxyInfo());
        this.truncated = hb.truncated;
        const id = this.trySend(ws, 'heartbeat', hb.body);
        if (id) {
          this.unacked.add(id);
          this.lastHeartbeatAt = Date.now();
          this.d.log.debug({ bytes: hb.bytes, truncated: hb.truncated }, 'admin_heartbeat');
        }
      }
    } finally {
      this.sending = false;
    }
    this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(): void {
    if (this.state !== 'connected' || this.stopping) return;
    const base = Math.max(this.nextInS, this.t.minIntervalS);
    const jitter = this.t.jitterS * ((this.d.random ?? Math.random)() * 2 - 1);
    this.setTimer(Math.max(this.t.minIntervalS, base + jitter) * 1000, () => this.heartbeat());
  }

  // An early heartbeat on a change, at least minIntervalS after the last one.
  private checkChange(): void {
    if (this.state !== 'connected' || !this.d.changeKey) return;
    const key = this.d.changeKey();
    if (this.lastChangeKey === null || key === this.lastChangeKey) return;
    this.lastChangeKey = key;
    const wait = Math.max(0, (this.lastHeartbeatAt ?? 0) + this.t.minIntervalS * 1000 - Date.now());
    if (!this.timer || this.timerDue - Date.now() > wait) this.setTimer(wait, () => this.heartbeat());
  }
}
