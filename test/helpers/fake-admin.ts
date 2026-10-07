import http from 'http';
import type { AddressInfo, Socket } from 'net';
import { WebSocketServer, type WebSocket } from 'ws';
import { generateKeyPair, normaliseCode, sign, signedText, signEnvelope, ulid, verify, verifyEnvelope, type Envelope } from '../../src/fleet/protocol';
import type { AdminKeyFile } from '../../src/fleet/keyfile';
import { vectors } from './contract';

// A fake cams-admin (spec 2026-10-06-cams-admin-phase1-design §8): the
// enrollment route and the channel, scriptable. Its server key is the
// contract vectors' server key. Behaviours for the isolation tests:
// - normal: challenge, hello check, welcome, an ack per heartbeat;
// - silent: accepts the upgrade and never sends or reads anything;
// - garbage: answers everything with junk;
// - flap: closes every connection after 1 s;
// - reject: closes after the hello with 4401;
// - bad-sig: signs the challenge with another key;
// - no-ack: never acknowledges a heartbeat.
// P2 command modes (after the welcome):
// - command-flood: 500 validly signed commands a second for a command not allowed (config.get);
// - forged: tokens.apply commands signed with another key;
// - replay: a command, re-sent 1 s later on the same connection and again on the next one;
// - oversize: tokens.apply with 200 KiB of args;
// - junk-commands: commands whose bodies miss every field.
export type Mode = 'normal' | 'silent' | 'garbage' | 'flap' | 'reject' | 'bad-sig' | 'no-ack' | 'command-flood' | 'forged' | 'replay' | 'oversize' | 'junk-commands';

export interface Received { conn: number; msg: Envelope }

export class FakeAdmin {
  mode: Mode = 'normal';
  welcomeHeartbeatS = 30;
  nextInS = 30;
  // Enrollment: valid codes (canonical) and a fixed answer for every request when set.
  codes = new Set<string>();
  enrollReply: { status: number; body: unknown } | null = null;
  enrollRequests: Record<string, unknown>[] = [];
  // Upgrades refused with 426 (an incompatible server); GET then answers `supported`.
  refuseUpgrade = false;
  // Upgrades left unanswered (a server that hangs before the handshake); counted.
  muteUpgrade = false;
  // A body that never ends (1 KiB every 10 ms) for the 426 probe or the enrollment answer.
  endlessProbe = false;
  endlessEnroll = false;
  enrollDelayMs = 0;
  upgrades = 0;
  supported = ['cams-admin.v1'];
  received: Received[] = [];
  connections = 0;
  // P2: close a connection right after a `received` result arrives on it.
  closeAfterReceived = false;
  // A MITM replay (security review): everything a past connection sent, as
  // sent, on the next connection: its challenge first, the rest after the hello.
  replayConn: number | null = null;
  readonly outbound = new Map<number, string[]>();
  // P2: the channel of each socket (after its hello).
  private chan = new Map<WebSocket, { conn: number; connId: string; proxyId: string | null }>();
  readonly sockets = new Set<WebSocket>();
  readonly server = { privateKey: vectors.keys.server.privateKey, publicKey: vectors.keys.server.publicKey };
  private keys = new Map<string, { keyId: string; publicKey: string }>();
  private http = http.createServer((req, res) => this.onRequest(req, res));
  private wss = new WebSocketServer({ noServer: true, handleProtocols: (p) => (p.has('cams-admin.v1') ? 'cams-admin.v1' : false) });
  private raw = new Set<Socket>();
  port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  get connectUrl(): string {
    return `ws://127.0.0.1:${this.port}/proxy/v1/connect`;
  }
  open(): number {
    return [...this.sockets].filter((s) => s.readyState === s.OPEN).length;
  }
  heartbeats(): Received[] {
    return this.received.filter((r) => r.msg.type === 'heartbeat');
  }
  results(cmdId?: string): Received[] {
    return this.received.filter((r) => r.msg.type === 'result' && (cmdId === undefined || (r.msg.body as { cmdId?: string }).cmdId === cmdId));
  }
  events(): Received[] {
    return this.received.filter((r) => r.msg.type === 'event');
  }
  // The connIds the proxy was given, oldest first.
  readonly allConnIds: string[] = [];
  connIds(): string[] {
    return [...this.allConnIds];
  }
  // A signed command (contract P2) to every open, welcomed socket; the last one's ids.
  // exp 'past': older than the 120 s slack; key: another signer; unsigned: no sig.
  sendCommand(command: string, args: Record<string, unknown>, o: { connId?: string; proxyId?: string; exp?: number | 'past' | 'far'; key?: string; actor?: string; cmdId?: string; unsigned?: boolean } = {}): { id: string; cmdId: string } {
    const cmdId = o.cmdId ?? `cmd_${ulid(Date.now()).slice(6)}`;
    let id = '';
    for (const [ws, c] of this.chan) {
      if (ws.readyState !== ws.OPEN || !c.proxyId) continue;
      const seq = (this.seqOut.get(ws) ?? 0) + 1;
      this.seqOut.set(ws, seq);
      const ts = o.exp === 'past' ? Date.now() - 200_000 : Date.now();
      const exp = typeof o.exp === 'number' ? o.exp : o.exp === 'far' ? ts + 60_001 : ts + 30_000;
      id = ulid(Date.now());
      const m: Record<string, unknown> = { v: 1, type: 'command', id, seq, ts, body: { proxyId: o.proxyId ?? c.proxyId, connId: o.connId ?? c.connId, cmdId, exp, actor: o.actor ?? 'ops@example.org', command, args } };
      if (!o.unsigned) m.sig = signEnvelope(o.key ?? this.server.privateKey, m as never);
      ws.send(JSON.stringify(m));
    }
    return { id, cmdId };
  }
  // A result or event signed by the proxy key registered for its proxyId.
  verifyFromProxy(m: Envelope): boolean {
    const k = this.keys.get(String((m.body as { proxyId?: string }).proxyId));
    return !!k && verifyEnvelope([k.publicKey], m);
  }

  async start(port = 0): Promise<this> {
    this.http.on('connection', (s) => {
      this.raw.add(s);
      s.on('close', () => this.raw.delete(s));
    });
    this.http.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/proxy/v1/connect')) return void socket.destroy();
      this.upgrades++;
      if (this.muteUpgrade) return;
      if (this.refuseUpgrade || !String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).some((p) => this.supported.includes(p))) {
        socket.end(`HTTP/1.1 426 Upgrade Required\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify({ error: 'unsupported_protocol', supported: this.supported })}`);
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
    });
    await new Promise<void>((r) => this.http.listen(port, '127.0.0.1', () => r()));
    this.port = (this.http.address() as AddressInfo).port;
    return this;
  }

  // A key file as enrollment would write it, with a fresh proxy key registered here.
  keyFile(over: Partial<AdminKeyFile> = {}): AdminKeyFile {
    const k = generateKeyPair();
    const proxyId = `prx_${ulid(Date.now()).slice(6)}`;
    const keyId = `key_${ulid(Date.now()).slice(6)}`;
    this.keys.set(proxyId, { keyId, publicKey: k.publicKey });
    return { v: 1, url: this.url, connectUrl: this.connectUrl, proxyId, keyId, privateKey: k.privateKey, publicKey: k.publicKey, serverKeys: [this.server.publicKey], account: 'home', enrolledAt: Date.now(), ...over };
  }
  revoke(proxyId: string): void {
    this.keys.delete(proxyId);
  }

  closeAll(code: number, reason = ''): void {
    for (const s of this.sockets) s.close(code, reason);
  }
  // Drops every connection without a close frame (a pulled cable).
  destroyAll(): void {
    for (const s of this.sockets) s.terminate();
  }
  send(type: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
    for (const s of this.sockets) this.sendTo(s, type, body, extra);
  }
  sendRaw(text: string): void {
    for (const s of this.sockets) s.send(text);
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    for (const s of this.raw) s.destroy();
    this.wss.close();
    await new Promise<void>((r) => this.http.close(() => r()));
  }

  private seqOut = new WeakMap<WebSocket, number>();
  private sendTo(ws: WebSocket, type: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
    const seq = (this.seqOut.get(ws) ?? 0) + 1;
    this.seqOut.set(ws, seq);
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ v: 1, type, id: ulid(Date.now()), seq, ts: Date.now(), ...extra, body }));
  }

  private onSocket(ws: WebSocket): void {
    const conn = ++this.connections;
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    ws.on('error', () => undefined);
    const mode = this.mode;
    if (mode === 'silent') {
      // Accepts and never reads: the socket's data is left in the buffers.
      (ws as unknown as { _socket: Socket })._socket.pause();
      return;
    }
    const rec: string[] = [];
    this.outbound.set(conn, rec);
    const send = ws.send.bind(ws);
    ws.send = ((d: unknown, ...r: unknown[]) => {
      if (typeof d === 'string') rec.push(d);
      return (send as (...a: unknown[]) => void)(d, ...r);
    }) as typeof ws.send;
    if (this.replayConn !== null) {
      const texts = [...(this.outbound.get(this.replayConn) ?? [])];
      this.replayConn = null;
      ws.send(texts[0]);
      ws.once('message', (data) => {
        this.received.push({ conn, msg: JSON.parse(String(data)) as Envelope });
        for (const t of texts.slice(1)) ws.send(t);
        ws.on('message', (d) => this.received.push({ conn, msg: JSON.parse(String(d)) as Envelope }));
      });
      return;
    }
    if (mode === 'flap') setTimeout(() => ws.close(1011), 1000);
    if (mode === 'garbage') {
      ws.send('}{ not json');
      ws.send(Buffer.from([0, 1, 2, 3]));
      ws.on('message', () => ws.send(JSON.stringify({ v: 7, junk: true })));
      return;
    }
    const connId = `con_${ulid(Date.now()).slice(6)}`;
    this.chan.set(ws, { conn, connId, proxyId: null });
    this.allConnIds.push(connId);
    ws.on('close', () => this.chan.delete(ws));
    const nonce = Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString('base64url');
    const serverTime = Date.now();
    const signer = mode === 'bad-sig' ? vectors.keys.other.privateKey : this.server.privateKey;
    this.sendTo(ws, 'challenge', { connId, nonce, serverTime, serverKeyId: 'SHA256:FAKE' }, { sig: sign(signer, signedText.challenge(connId, nonce, serverTime)) });
    ws.on('message', (data) => {
      let msg: Envelope;
      try {
        msg = JSON.parse(String(data)) as Envelope;
      } catch {
        return void ws.close(4400);
      }
      this.received.push({ conn, msg });
      if (msg.type === 'hello') {
        const b = msg.body as { proxyId: string; keyId: string; connId: string; nonce: string; ts: number };
        const k = this.keys.get(b.proxyId);
        const ok = !!k && k.keyId === b.keyId && b.connId === connId && b.nonce === nonce && verify(k.publicKey, signedText.hello(connId, nonce, b.proxyId, b.keyId, b.ts), msg.sig);
        if (!ok || mode === 'reject') return void ws.close(4401);
        this.chan.get(ws)!.proxyId = b.proxyId;
        this.sendTo(ws, 'welcome', { heartbeatS: this.welcomeHeartbeatS, offlineAfterS: 90, maxMessageBytes: 262144, serverTime: Date.now() });
        this.hostile(ws, mode, connId, b.proxyId);
      } else if (msg.type === 'heartbeat') {
        if (mode !== 'no-ack') this.sendTo(ws, 'ack', { nextInS: this.nextInS }, { re: msg.id });
      } else if (msg.type === 'result' && this.closeAfterReceived && (msg.body as { phase?: string }).phase === 'received') {
        ws.terminate();
      }
    });
  }

  // The last command of replay mode, re-sent on the next connection too.
  private captured: string | null = null;
  private hostile(ws: WebSocket, mode: Mode, connId: string, proxyId: string): void {
    const raw = (body: Record<string, unknown>, o: { key?: string; ts?: number } = {}): string => {
      const seq = (this.seqOut.get(ws) ?? 0) + 1;
      this.seqOut.set(ws, seq);
      const ts = o.ts ?? Date.now();
      const m: Record<string, unknown> = { v: 1, type: 'command', id: ulid(Date.now()), seq, ts, body };
      m.sig = signEnvelope(o.key ?? this.server.privateKey, m as never);
      return JSON.stringify(m);
    };
    const cmd = (command: string, args: Record<string, unknown>) => ({ proxyId, connId, cmdId: `cmd_${ulid(Date.now()).slice(6)}`, exp: Date.now() + 30_000, actor: 'mallory@example.org', command, args });
    const tokens = { v: 1, revision: 99, tokens: [{ id: 'tok_00000000000000000099', kind: 'admin', hash: `sha256:${'9'.repeat(64)}`, label: 'evil', retireAt: null }] };
    const every = (ms: number, n: number, fn: () => void) => {
      const t = setInterval(() => {
        if (ws.readyState !== ws.OPEN) return clearInterval(t);
        for (let i = 0; i < n; i++) fn();
      }, ms);
      ws.on('close', () => clearInterval(t));
    };
    if (mode === 'command-flood') every(10, 5, () => ws.send(raw(cmd('config.get', { v: 1 }))));
    else if (mode === 'forged') every(20, 1, () => ws.send(raw(cmd('tokens.apply', tokens), { key: vectors.keys.other.privateKey })));
    else if (mode === 'oversize') every(100, 1, () => ws.send(raw(cmd('tokens.apply', { ...tokens, pad: 'x'.repeat(200 * 1024) }))));
    else if (mode === 'junk-commands') every(20, 1, () => ws.send(raw({})));
    else if (mode === 'replay') {
      // A captured command is sent again as it was (its seq is then out of order: the proxy closes).
      // On the next connection: the captured envelope as it was (its seq happens to fit).
      if (this.captured) {
        ws.send(this.captured);
        this.seqOut.set(ws, (JSON.parse(this.captured) as { seq: number }).seq);
        return;
      }
      const text = raw(cmd('config.get', { v: 1 }));
      ws.send(text);
      this.captured = text;
      const t = setTimeout(() => ws.readyState === ws.OPEN && ws.send(text), 1000);
      ws.on('close', () => clearTimeout(t));
    }
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const answer = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const endless = (status: number) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.write('{"error":"unsupported_protocol","supported":["cams-admin.v2"],"pad":"');
      const t = setInterval(() => (res.destroyed ? clearInterval(t) : res.write('x'.repeat(1024))), 10);
      setTimeout(() => (clearInterval(t), res.end('"}')), 20_000).unref();
    };
    if (req.method === 'GET' && req.url?.startsWith('/proxy/v1/connect')) return this.endlessProbe ? endless(426) : answer(426, { error: 'unsupported_protocol', supported: this.supported });
    if (req.method !== 'POST' || req.url !== '/proxy/v1/enroll') return answer(404, { error: 'not_found' });
    let text = '';
    req.on('data', (c: Buffer) => (text += c.toString()));
    req.on('end', () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return answer(400, { error: 'bad_request' });
      }
      this.enrollRequests.push(body);
      if (this.endlessEnroll) return endless(201);
      if (this.enrollReply) return answer(this.enrollReply.status, this.enrollReply.body);
      const code = normaliseCode(body.code);
      if (!code || !this.codes.has(code)) return answer(401, { error: 'invalid_code' });
      if (!verify(String(body.publicKey), signedText.enroll(code, String(body.publicKey)), body.proof)) return answer(400, { error: 'bad_proof' });
      this.codes.delete(code);
      const proxyId = `prx_${ulid(Date.now()).slice(6)}`;
      const keyId = `key_${ulid(Date.now()).slice(6)}`;
      this.keys.set(proxyId, { keyId, publicKey: String(body.publicKey) });
      setTimeout(() => answer(201, { v: 1, proxyId, keyId, account: 'home', connectUrl: this.connectUrl, serverKeys: [this.server.publicKey], heartbeatS: 30 }), this.enrollDelayMs);
    });
  }
}

export const startFakeAdmin = (port = 0): Promise<FakeAdmin> => new FakeAdmin().start(port);
