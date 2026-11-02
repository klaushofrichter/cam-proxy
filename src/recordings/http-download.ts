// src/recordings/http-download.ts
// An SD recording over HTTP Download (cmd=Download) through the camera
// client: its login, token and trust, and its gate for the request itself.
// The other path to Baichuan's (src/camera/baichuan/vod.ts), for a camera
// that refuses that (the E1 Outdoor Pro, measured 2026-11-02; see
// download-path.ts). It behaves like vod.ts for the fetcher: errors are
// BaichuanErrors with the same codes, it never ends `out`, a stall while
// `out` doesn't drain is the writer's (phase 'writer'), and it resolves once
// `out` has taken the last bytes.
//
// The body is the camera's own remux of the file (on the RLC-1224A, when it
// still served Download, a fragmented MP4 whose length differed from the
// size in the name): its Content-Length is the length, announced through
// hooks.length before the first byte. Never logs the URL (it has the token).
import type { IncomingMessage } from 'http';
import type { Writable } from 'stream';
import { abortError } from '../async';
import { BaichuanError } from '../camera/baichuan/errors';
import { SAFE_PATH } from '../camera/baichuan/vod';
import { CameraError, DownloadRefused, DownloadTimeout, type ReolinkClient } from '../camera/client';
import type { DownloadHooks } from './download-path';

export interface HttpDownloadOptions {
  firstByteMs?: number; // until the camera's answer, 15 s (vod.ts's first chunk)
  stallMs?: number; // between chunks, or a writer that doesn't drain, 20 s
}

// The most a body may be against the size in the name (a remux differs a
// little; this only stops a runaway answer).
export const maxHttpBytes = (size: number): number => 2 * size + 16 * 2 ** 20;

const noop = () => undefined;
const guarded = new WeakSet<Writable>(); // one lasting error listener per writable (vod.ts #99)

const PREFIX = 'HTTP Download: ';

// The client's errors as the fetcher knows them (vod.ts's codes).
function asBaichuanError(err: unknown): Error {
  if (err instanceof DownloadRefused) return new BaichuanError('refused', PREFIX + err.message, err.httpStatus);
  if (err instanceof DownloadTimeout) return new BaichuanError('timeout', PREFIX + err.message);
  if (err instanceof CameraError) {
    if (err.code === 'camera_auth_failed') return new BaichuanError('auth', PREFIX + err.message);
    if (err.code === 'camera_offline') return new BaichuanError('offline', PREFIX + err.message, undefined, err.requestSent ? undefined : 'connect');
    if (err.message === 'unexpected recording path') return new BaichuanError('protocol', err.message);
    return new BaichuanError('protocol', PREFIX + err.message);
  }
  return new BaichuanError('protocol', `${PREFIX}failed`);
}

export async function httpDownload(client: () => ReolinkClient, path: string, size: number, out: Writable, hooks: DownloadHooks = {}, o: HttpDownloadOptions = {}): Promise<number> {
  if (!SAFE_PATH.test(path) || path.includes('..')) throw new BaichuanError('protocol', 'unexpected recording path');
  if (out.destroyed || out.writableEnded) throw abortError('the output closed');
  let res: IncomingMessage;
  try {
    res = await client().openDownload(path, { timeoutMs: o.firstByteMs ?? 15_000 });
  } catch (err) {
    throw asBaichuanError(err);
  }
  res.on('error', noop); // reported through 'close' below
  if (out.destroyed || out.writableEnded) {
    res.destroy();
    throw abortError('the output closed');
  }
  res.setTimeout(0); // this function's own stall timer from here on
  const header = res.headers['content-length'];
  const announced = header !== undefined && /^\d+$/.test(header) ? Number(header) : null;
  const limit = maxHttpBytes(size);
  if (announced !== null && announced > limit) {
    res.destroy();
    throw new BaichuanError('protocol', `${PREFIX}larger than expected (${announced} > ${limit})`);
  }
  hooks.length?.(announced);
  const stallMs = o.stallMs ?? 20_000;

  return new Promise<number>((resolve, reject) => {
    let received = 0;
    let paused = false; // waiting for `out` to drain
    let ended = false; // the body is complete
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        settle(paused ? new BaichuanError('timeout', 'the writer stalled', undefined, 'writer') : new BaichuanError('timeout', `${PREFIX}stalled`));
      }, stallMs);
    };
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res.off('data', onData);
      res.off('end', onEnd);
      res.off('close', onClose);
      out.off('drain', onDrain);
      out.off('error', onOutError);
      out.off('close', onOutClose);
      if (!guarded.has(out)) {
        guarded.add(out);
        out.on('error', noop);
      }
      if (err) {
        res.destroy(); // the camera's side ends with the connection
        reject(err);
      } else resolve(received);
    };
    const finish = () => {
      if (!out.writableNeedDrain) return settle();
      paused = true; // the writer holds the last bytes
      arm();
    };
    const onDrain = () => {
      if (!paused) return;
      paused = false;
      if (ended) return settle();
      res.resume();
      arm();
    };
    const onData = (chunk: Buffer) => {
      if (received + chunk.length > (announced ?? limit)) return settle(new BaichuanError('protocol', `${PREFIX}more bytes than announced`));
      if (out.destroyed || out.writableEnded) return settle(abortError('the output closed'));
      received += chunk.length;
      let ok: boolean;
      try {
        ok = out.write(chunk);
      } catch {
        return settle(abortError('the output failed'));
      }
      arm();
      if (!ok && !paused) {
        paused = true;
        res.pause();
      }
    };
    const onEnd = () => {
      ended = true;
      if (announced !== null && received !== announced) return settle(new BaichuanError('protocol', `${PREFIX}ended early (${received} of ${announced} bytes)`));
      finish();
    };
    // Closed before its end: the camera broke off.
    const onClose = () => {
      if (!ended) settle(new BaichuanError('protocol', `${PREFIX}broke off after ${received} bytes`));
    };
    const onOutError = () => settle(abortError('the output failed'));
    const onOutClose = () => settle(abortError('the output closed'));

    out.on('error', onOutError);
    out.on('close', onOutClose);
    out.on('drain', onDrain);
    res.on('data', onData);
    res.on('end', onEnd);
    res.on('close', onClose);
    arm();
  });
}
