// Live video for clients (spec 2026-10-30-camera-onboarding-design §4.8,
// §10.3): the host go2rtc's MSE WebSocket (/api/ws on 127.0.0.1), relayed to
// the client's WebSocket on the proxy's own address. The client gets one text
// message {"type":"mse","value":"video/mp4; codecs=\"…\""} (go2rtc's own,
// forwarded only when the MIME type is valid), then binary fMP4 as go2rtc
// sends it. Nothing else go2rtc says reaches the client: its errors can carry
// the RTSP URL with the camera password. A failure is
// {"type":"error","value":"stream_unavailable"} and close 1011.
import WebSocket from 'ws';
import { logger } from '../log';

export const LIVE = { maxPerCamera: 8, maxTotal: 32, maxBufferedBytes: 8 * 1024 * 1024, startMs: 10_000 } as const;
export const DEFAULT_CODECS = 'avc1.640029,avc1.64002A,avc1.640033,hvc1.1.6.L153.B0,mp4a.40.2,mp4a.40.5';
export const MSE_MIME = /^video\/mp4; codecs="[A-Za-z0-9.,]{1,512}"$/;
// How long a closed upstream may take to finish its close handshake before it is dropped.
const UPSTREAM_CLOSE_MS = 2_000;

// The codecs a client offers: undefined → DEFAULT_CODECS; a plain list → it; else null.
export function validCodecs(v: unknown): string | null {
  if (v === undefined) return DEFAULT_CODECS;
  return typeof v === 'string' && /^[A-Za-z0-9.,]{1,512}$/.test(v) ? v : null;
}

export type LiveStream = 'sub' | 'main';
export type LiveError = 'stream_unavailable' | 'camera_restarting' | 'camera_offline' | 'too_many_streams';

// Tells the client why and closes (1011 for a failure of the stream, 1013 "try again later" for a state).
export function refuseLive(client: WebSocket, code: LiveError, closeCode: 1011 | 1013): void {
  if (client.readyState !== WebSocket.OPEN) return void client.terminate();
  client.send(JSON.stringify({ type: 'error', value: code }));
  client.close(closeCode, code);
}

type EndWhy = 'error' | 'slow' | 'shutdown' | 'client';
interface Relayed { client: WebSocket; end: (why: EndWhy) => void }

export class LiveRelay {
  private readonly active = new Map<string, Set<Relayed>>();
  private readonly now: () => number;

  constructor(o: { now?: () => number } = {}) {
    this.now = o.now ?? Date.now;
  }

  // The streams relayed now: of one camera, or all.
  count(cam?: string): number {
    if (cam !== undefined) return this.active.get(cam)?.size ?? 0;
    let n = 0;
    for (const s of this.active.values()) n += s.size;
    return n;
  }

  // Relays go2rtc's MSE stream at `upstreamUrl` (127.0.0.1) to `client`.
  relay(client: WebSocket, upstreamUrl: string, codecs: string, info: { cam: string; stream: LiveStream }): void {
    const t0 = this.now();
    let bytes = 0;
    let started = false;
    let ended = false;
    const up = new WebSocket(upstreamUrl, { perMessageDeflate: false, handshakeTimeout: LIVE.startMs });
    up.binaryType = 'nodebuffer';
    const set = this.active.get(info.cam) ?? new Set<Relayed>();
    this.active.set(info.cam, set);

    const closeUpstream = () => {
      up.removeAllListeners();
      up.on('error', () => undefined);
      if (up.readyState === WebSocket.CONNECTING) return void up.terminate();
      if (up.readyState === WebSocket.OPEN) up.close();
      // A close go2rtc never answers: dropped.
      setTimeout(() => up.terminate(), UPSTREAM_CLOSE_MS).unref();
    };
    // Ends both sides once: why it ended goes to the debug log, never go2rtc's text.
    const end = (why: EndWhy) => {
      if (ended) return;
      ended = true;
      clearTimeout(startTimer);
      set.delete(entry);
      if (set.size === 0 && this.active.get(info.cam) === set) this.active.delete(info.cam);
      closeUpstream();
      if (why === 'error') refuseLive(client, 'stream_unavailable', 1011);
      else if (why === 'slow') client.close(4008, 'slow_consumer');
      else if (why === 'shutdown') {
        client.close(1001, 'shutdown');
        setTimeout(() => client.terminate(), 1_000).unref();
      }
      logger.debug({ cameraId: info.cam, stream: info.stream, ms: this.now() - t0, bytes, why }, 'live_close');
    };
    const entry: Relayed = { client, end };
    set.add(entry);
    logger.debug({ cameraId: info.cam, stream: info.stream }, 'live_open');

    const startTimer = setTimeout(() => end('error'), LIVE.startMs);
    startTimer.unref();

    up.on('open', () => up.send(JSON.stringify({ type: 'mse', value: codecs })));
    up.on('message', (data: Buffer, isBinary: boolean) => {
      if (ended) return;
      if (!isBinary) {
        let m: { type?: unknown; value?: unknown } | null = null;
        try {
          m = JSON.parse(data.toString('utf8')) as { type?: unknown; value?: unknown };
        } catch {
          m = null;
        }
        // The first message: the MIME type, valid, once. Anything else: the stream failed.
        if (!started && m?.type === 'mse' && typeof m.value === 'string' && MSE_MIME.test(m.value)) {
          started = true;
          clearTimeout(startTimer);
          return void client.send(JSON.stringify({ type: 'mse', value: m.value }));
        }
        return end('error');
      }
      if (!started) return; // media before the MIME type: never sent on
      if (client.bufferedAmount + data.length > LIVE.maxBufferedBytes) return end('slow');
      bytes += data.length;
      client.send(data, { binary: true });
    });
    up.on('close', () => end('error'));
    up.on('error', () => end('error'));
    client.on('close', () => end('client'));
    client.on('error', () => end('client'));
    // A client sends nothing; whatever it sends is dropped.
    client.on('message', () => undefined);
  }

  // Shutdown: every relayed socket is closed (an upgraded socket is no longer the HTTP server's).
  closeAll(): void {
    for (const s of [...this.active.values()]) for (const r of [...s]) r.end('shutdown');
  }
}
