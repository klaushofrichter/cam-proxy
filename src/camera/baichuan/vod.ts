// src/camera/baichuan/vod.ts
// The VOD download, ported from reolink_aio PR #186 9a1bb52 (xmls.py
// L281-L352, baichuan.py L4399-L4417; MIT, see THIRD_PARTY_NOTICES). As
// measured on the RLC-1224A: cmd 8 with <Id> only; the first reply carries a
// 32-byte info record (not file data); then chunks whose first encryptLen
// bytes are AES; no terminator: the end is the size; then cmd 9 (handle 0).
// Every frame of the download carries cmd 8's message id, so chunks still in
// flight after cmd 9 (about 13 of them) are dropped by the session.
import type { Writable } from 'stream';
import { BaichuanError } from './errors';
import { OK_STATUS, type BaichuanSession, type Subscription } from './session';

export const SAFE_PATH = /^[A-Za-z0-9_./-]+\.mp4$/;

export const downloadXml = (path: string): string =>
  `\n<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<FileInfoList version="1.1">\n<FileInfo>\n<Id>${path}</Id>\n<channelId>0</channelId>\n</FileInfo>\n</FileInfoList>\n</body>`;

export const stopXml = (): string =>
  `\n<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<FileInfoList version="1.1">\n<FileInfo>\n<channelId>0</channelId>\n<handle>0</handle>\n</FileInfo>\n</FileInfoList>\n</body>`;

export interface DownloadOptions {
  firstChunkMs?: number; // after cmd 8, 15 s
  stallMs?: number; // between chunks, or a writer that doesn't drain, 20 s
  stopMs?: number; // cmd 9's reply, 5 s
}

const INFO_RECORD_BYTES = 32; // measured on the RLC-1224A

const abortError = (why: string) => Object.assign(new Error(why), { name: 'AbortError' });

// Writes the file at `path` (size from its name) to `out`. Resolves with the
// bytes written, once `out` has taken the last of them; never ends `out`. A
// broken download can't resume (cmd 8 has no offset).
export async function download(session: BaichuanSession, path: string, size: number, out: Writable, o: DownloadOptions = {}): Promise<number> {
  if (!SAFE_PATH.test(path)) throw new BaichuanError('protocol', 'unexpected recording path');
  if (!Number.isSafeInteger(size) || size < 0) throw new BaichuanError('protocol', 'unexpected recording size');
  await session.ensure();
  // The output went away while the session connected: no cmd 8 for nobody.
  if (out.destroyed || out.writableEnded) throw abortError('the output closed');
  return new Promise<number>((resolve, reject) => {
    let received = 0;
    let first = true;
    let stopped = false; // the transfer is over (cmd 9 sent)
    let settled = false; // the promise is settled
    let paused = false;
    let lastWrite = false; // the last bytes are with the writer
    let timer: NodeJS.Timeout | undefined;
    let sub: Subscription | undefined;

    // While the socket is paused for the writer, or the writer holds the last
    // bytes, a stall is the writer's (a slow or paused client), not the camera's.
    const arm = (ms: number, why: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const writer = paused || lastWrite;
        fail(new BaichuanError('timeout', writer ? 'the writer stalled' : why, undefined, writer ? 'writer' : undefined));
      }, ms);
    };
    const stall = () => arm(o.stallMs ?? 20_000, 'the download stalled');
    const onDrain = () => {
      if (!paused || stopped) return;
      paused = false;
      session.resume();
      stall();
    };
    // Both stay attached after the download settles: an error on `out` must
    // never become an uncaught exception because we took our listener away.
    const onOutError = () => fail(abortError('the output failed'));
    const onOutClose = () => {
      fail(abortError('the output closed'));
      out.off('close', onOutClose);
      out.off('error', onOutError);
    };
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(received);
    };
    // Ends the transfer once: always releases the camera's side with cmd 9.
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      out.off('drain', onDrain);
      sub?.close();
      if (paused) {
        paused = false;
        session.resume();
      }
      if (session.connected()) void session.call(9, stopXml(), o.stopMs ?? 5_000).catch(() => undefined);
    };
    // After a camera-side timeout or a protocol error the connection may be
    // dead or out of step: closed, so the next download reconnects.
    const fail = (err: Error) => {
      stop();
      const reconnect = !settled && err instanceof BaichuanError && (err.code === 'protocol' || err.code === 'timeout') && err.phase !== 'writer';
      settle(err);
      if (reconnect) session.close();
    };

    out.on('error', onOutError);
    out.on('close', onOutClose);
    out.on('drain', onDrain);
    try {
      sub = session.open(8, downloadXml(path), {
        onError: (e) => fail(e),
        onMessage: (m) => {
          if (stopped) return;
          if (!OK_STATUS.has(m.status)) return fail(new BaichuanError(m.status === 400 ? 'refused' : 'protocol', `the download answered ${m.status}`, m.status));
          if (first) {
            first = false; // the 32-byte info record, not file data
            if (m.payload.length !== INFO_RECORD_BYTES) return fail(new BaichuanError('protocol', `the download's first reply is not the info record (${m.payload.length} bytes)`));
            if (size === 0) {
              stop();
              settle();
            }
            return;
          }
          let data: Buffer;
          try {
            const len = /<encryptLen>(\d+)<\/encryptLen>/.exec(m.ext)?.[1];
            data = session.chunk(m, len ? Number(len) : undefined); // a copy, never the parser's buffer
          } catch (e) {
            return fail(e instanceof BaichuanError ? e : new BaichuanError('protocol', 'unreadable chunk'));
          }
          if (received + data.length > size) return fail(new BaichuanError('protocol', `more bytes than the size (${received + data.length} > ${size})`));
          if (out.destroyed || out.writableEnded) return fail(abortError('the output closed'));
          received += data.length;
          if (received === size) {
            lastWrite = true;
            stop();
            stall(); // until the writer takes the last bytes
            try {
              out.write(data, (err) => settle(err ? abortError('the output failed') : undefined));
            } catch {
              settle(abortError('the output failed'));
            }
            return;
          }
          let ok: boolean;
          try {
            ok = out.write(data);
          } catch {
            return fail(abortError('the output failed'));
          }
          // A writer that doesn't drain within stallMs is a stall too.
          stall();
          if (!ok && !paused) {
            paused = true;
            session.pause();
          }
        },
      });
    } catch (e) {
      return fail(e instanceof Error ? e : new BaichuanError('protocol', 'the download failed to start'));
    }
    arm(o.firstChunkMs ?? 15_000, 'no data after the download request');
  });
}
