// The ext stream's feed for go2rtc (the third stream, the Reolink app's
// Balanced). The camera has it on FLV only (CX820, measured 2026-11-03: every
// RTSP ext path answers 404), and its FLV URL needs a login token. So the
// token never reaches go2rtc: go2rtc's <cam>_ext reads this loopback HTTP
// feed, and the feed opens the camera's FLV with the camera client's own
// token (src/camera/client.ts openLiveFlv) and passes the bytes on. go2rtc
// connects only while a client watches, and closes when the last one leaves.
//
// The URL has the camera id and a random key of this process (48 hex): no
// camera secret, and nothing but go2rtc on this host knows it. Listens on
// 127.0.0.1 only. Answers carry no detail (a refusal is a bare status code).
import http, { type IncomingMessage, type ServerResponse } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import type { AddressInfo } from 'net';
import { logger } from '../log';

// Feeds open at once per camera (go2rtc opens one per stream; a second one
// can overlap while it reconnects).
export const EXT_FEED_MAX_PER_CAMERA = 2;

export interface ExtFeedDeps {
  // The camera's ext FLV (the response, endless), or null when the camera is
  // unknown or offers no ext. Throws when the camera refuses it.
  open: (cam: string) => Promise<IncomingMessage> | null;
}

const PATH = /^\/ext\/([a-z0-9][a-z0-9-]{0,31})\/([a-f0-9]{48})$/;

export class ExtFeed {
  private server: http.Server | undefined;
  private port = 0;
  private readonly key = randomBytes(24).toString('hex');
  private readonly feeds = new Map<string, Set<ServerResponse>>();

  constructor(private readonly d: ExtFeedDeps) {}

  // Starts listening (once); the URLs exist from then on.
  async listen(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => void this.serve(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        this.port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  // go2rtc's source for the camera's ext stream; undefined until listening.
  url(cam: string): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}/ext/${cam}/${this.key}` : undefined;
  }

  // Feeds open now: of one camera, or all.
  count(cam?: string): number {
    if (cam !== undefined) return this.feeds.get(cam)?.size ?? 0;
    let n = 0;
    for (const s of this.feeds.values()) n += s.size;
    return n;
  }

  // Ends a camera's feeds (its live clients are being closed, e.g. a restart).
  closeCamera(cam: string): void {
    for (const res of this.feeds.get(cam) ?? []) res.destroy();
  }

  async close(): Promise<void> {
    for (const s of this.feeds.values()) for (const res of s) res.destroy();
    const server = this.server;
    this.server = undefined;
    this.port = 0;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  private keyOk(k: string): boolean {
    const a = Buffer.from(k);
    const b = Buffer.from(this.key);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bare = (status: number) => {
      if (!res.headersSent) res.writeHead(status, { 'Content-Length': '0', Connection: 'close' });
      res.end();
    };
    const m = PATH.exec((req.url ?? '').split('?')[0]);
    if (req.method !== 'GET' || !m || !this.keyOk(m[2])) return bare(404);
    const cam = m[1];
    const set = this.feeds.get(cam) ?? new Set<ServerResponse>();
    if (set.size >= EXT_FEED_MAX_PER_CAMERA) return bare(503);
    let upstream: IncomingMessage | null;
    try {
      upstream = await this.d.open(cam);
    } catch (err) {
      // The client's errors name the reason, never the URL or the token.
      logger.debug({ cameraId: cam, err: (err as Error).message }, 'ext_feed_failed');
      return bare(502);
    }
    if (!upstream) return bare(404);
    if (res.destroyed || req.destroyed) return void upstream.destroy();
    set.add(res);
    this.feeds.set(cam, set);
    logger.debug({ cameraId: cam }, 'ext_feed_open');
    const done = () => {
      upstream.destroy();
      set.delete(res);
      if (set.size === 0 && this.feeds.get(cam) === set) this.feeds.delete(cam);
    };
    res.on('close', done);
    upstream.on('error', () => res.destroy());
    upstream.on('end', () => res.end());
    res.writeHead(200, { 'Content-Type': 'video/x-flv', 'Cache-Control': 'no-store' });
    upstream.pipe(res);
  }
}
