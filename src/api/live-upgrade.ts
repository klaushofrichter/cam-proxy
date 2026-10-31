// GET /api/cameras/:cam/live as a WebSocket upgrade on the proxy's own HTTP
// and HTTPS servers (spec 2026-10-30-camera-onboarding-design §4.8, §10.3): no
// new port, bearer token only. Refusals before the upgrade are plain HTTP
// answers with a JSON body; the camera's state after it is told over the
// socket (a client such as cams's WebSocket can't read a refused upgrade's
// status), as {"type":"error","value":<code>} and close 1013.
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { STATUS_CODES } from 'http';
import { WebSocketServer } from 'ws';
import type { CameraRegistry } from '../cameras/registry';
import { LIVE, refuseLive, validCodecs, type LiveRelay } from '../stream/live';
import { upgradeAccess, type AccessDeps } from './auth';

const PATH = /^\/api\/cameras\/([^/?]+)\/live$/;
// Upgrades per client address and minute.
export const LIVE_UPGRADES_PER_MINUTE = 60;

// A plain HTTP answer on the socket, then its end.
function answer(socket: Duplex, status: number, body: object): void {
  const json = JSON.stringify(body);
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${json}`);
  }
  socket.destroy();
}

// At most `limit` per key and fixed minute.
function perMinuteCounter(limit: number, now: () => number) {
  const seen = new Map<string, { start: number; n: number }>();
  return (key: string): boolean => {
    const t = now();
    if (seen.size > 10_000) for (const [k, v] of seen) if (t - v.start >= 60_000) seen.delete(k);
    const e = seen.get(key);
    if (!e || t - e.start >= 60_000) {
      seen.set(key, { start: t, n: 1 });
      return true;
    }
    e.n++;
    return e.n <= limit;
  };
}

export function liveUpgrade(d: { access: AccessDeps; cameras: CameraRegistry; relay: LiveRelay; now?: () => number }): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 });
  const allow = perMinuteCounter(LIVE_UPGRADES_PER_MINUTE, d.now ?? Date.now);
  return (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://proxy.invalid');
    } catch {
      return answer(socket, 400, { error: 'invalid' });
    }
    const m = PATH.exec(url.pathname);
    if (!m || req.method !== 'GET') return answer(socket, 404, { error: 'not_found' });
    // Tokens never travel in URLs.
    if (url.searchParams.has('token') || url.searchParams.has('access_token')) return answer(socket, 400, { error: 'token_in_url' });
    if (!allow((req.socket.remoteAddress ?? '').replace(/^::ffff:/, ''))) return answer(socket, 429, { error: 'rate_limited' });
    const a = upgradeAccess(req, d.access);
    if (a.access !== 'client' && a.access !== 'admin') return answer(socket, 401, { error: 'unauthorized' });
    let cam: string;
    try {
      cam = decodeURIComponent(m[1]);
    } catch {
      return answer(socket, 404, { error: 'not_found' });
    }
    const w = d.cameras.get(cam);
    if (!w) return answer(socket, 404, { error: 'not_found' });
    const stream = url.searchParams.get('stream') ?? 'sub';
    const codecs = validCodecs(url.searchParams.get('codecs') ?? undefined);
    if ((stream !== 'sub' && stream !== 'main') || url.searchParams.getAll('stream').length > 1 || codecs === null) return answer(socket, 400, { error: 'invalid' });
    wss.handleUpgrade(req, socket, head, (client) => {
      const go2rtc = w.stills?.go2rtc;
      if (w.phase() === 'restarting') return refuseLive(client, 'camera_restarting', 1013);
      if (!go2rtc || !go2rtc.up()) return refuseLive(client, 'stream_unavailable', 1013);
      if (!w.status.state().online) return refuseLive(client, 'camera_offline', 1013);
      if (d.relay.count(w.id) >= LIVE.maxPerCamera || d.relay.count() >= LIVE.maxTotal) return refuseLive(client, 'too_many_streams', 1013);
      d.relay.relay(client, go2rtc.wsUrl(w.id, stream), codecs, { cam: w.id, stream });
    });
  };
}
