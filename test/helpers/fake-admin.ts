import http from 'http';
import type { AddressInfo, Socket } from 'net';
import { WebSocketServer, type WebSocket } from 'ws';
import { generateKeyPair, normaliseCode, sign, signedText, ulid, verify, type Envelope } from '../../src/fleet/protocol';
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
export type Mode = 'normal' | 'silent' | 'garbage' | 'flap' | 'reject' | 'bad-sig' | 'no-ack';

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
  supported = ['cams-admin.v1'];
  received: Received[] = [];
  connections = 0;
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

  async start(port = 0): Promise<this> {
    this.http.on('connection', (s) => {
      this.raw.add(s);
      s.on('close', () => this.raw.delete(s));
    });
    this.http.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/proxy/v1/connect')) return void socket.destroy();
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
    if (mode === 'flap') setTimeout(() => ws.close(1011), 1000);
    if (mode === 'garbage') {
      ws.send('}{ not json');
      ws.send(Buffer.from([0, 1, 2, 3]));
      ws.on('message', () => ws.send(JSON.stringify({ v: 7, junk: true })));
      return;
    }
    const connId = `con_${ulid(Date.now()).slice(6)}`;
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
        this.sendTo(ws, 'welcome', { heartbeatS: this.welcomeHeartbeatS, offlineAfterS: 90, maxMessageBytes: 262144, serverTime: Date.now() });
      } else if (msg.type === 'heartbeat') {
        if (mode !== 'no-ack') this.sendTo(ws, 'ack', { nextInS: this.nextInS }, { re: msg.id });
      }
    });
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const answer = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url?.startsWith('/proxy/v1/connect')) return answer(426, { error: 'unsupported_protocol', supported: this.supported });
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
      if (this.enrollReply) return answer(this.enrollReply.status, this.enrollReply.body);
      const code = normaliseCode(body.code);
      if (!code || !this.codes.has(code)) return answer(401, { error: 'invalid_code' });
      if (!verify(String(body.publicKey), signedText.enroll(code, String(body.publicKey)), body.proof)) return answer(400, { error: 'bad_proof' });
      this.codes.delete(code);
      const proxyId = `prx_${ulid(Date.now()).slice(6)}`;
      const keyId = `key_${ulid(Date.now()).slice(6)}`;
      this.keys.set(proxyId, { keyId, publicKey: String(body.publicKey) });
      answer(201, { v: 1, proxyId, keyId, account: 'home', connectUrl: this.connectUrl, serverKeys: [this.server.publicKey], heartbeatS: 30 });
    });
  }
}

export const startFakeAdmin = (port = 0): Promise<FakeAdmin> => new FakeAdmin().start(port);
