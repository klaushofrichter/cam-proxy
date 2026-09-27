import { readFileSync } from 'fs';
import { join } from 'path';
import { generate } from 'selfsigned';
import type { Config } from '../config/defaults';
import { logger } from '../log';
import { FtpServer, type Upload } from './ftp-server';
import type { ClipIndexer } from './indexer';

// The clips side: the FTP server the camera uploads to, feeding the indexer.
export interface ClipsSide {
  server: FtpServer;
  indexer: ClipIndexer;
  listening: () => boolean;
  lastUpload: () => number | null;
  uploadFailures: () => number;
}

let generated: Promise<{ cert: string; key: string }> | undefined;

// The FTPS certificate: ftp.certFile/keyFile, or one made for this process
// (the camera doesn't verify it).
export async function ftpTls(cfg: Config['ftp']): Promise<{ cert: string; key: string } | undefined> {
  if (!cfg.tls) return undefined;
  if (cfg.certFile && cfg.keyFile) return { cert: readFileSync(cfg.certFile, 'utf8'), key: readFileSync(cfg.keyFile, 'utf8') };
  generated ??= generate([{ name: 'commonName', value: 'cam-proxy' }], { keyType: 'ec' }).then((p) => ({ cert: p.cert, key: p.private }));
  return generated;
}

export function parsePassive(range: string): [number, number] {
  const m = /^(\d+)-(\d+)$/.exec(range.trim());
  const lo = Number(m?.[1]);
  const hi = Number(m?.[2]);
  if (!m || lo < 1 || hi > 65535 || lo > hi) throw new Error(`ftp.passive: invalid range "${range}"`);
  return [lo, hi];
}

export function createClipsSide(d: { config: Config; password: string; indexer: ClipIndexer; accept: () => boolean }): { side: ClipsSide; start: () => Promise<void>; stop: () => Promise<void> } {
  let last: number | null = null;
  let failures = 0;
  let server: FtpServer | undefined;
  const side: ClipsSide = {
    get server() {
      if (!server) throw new Error('FTP server not started');
      return server;
    },
    indexer: d.indexer,
    listening: () => server?.listening() ?? false,
    lastUpload: () => last,
    uploadFailures: () => failures,
  };
  const start = async () => {
    const f = d.config.ftp;
    server = new FtpServer({
      port: f.port,
      passive: parsePassive(f.passive),
      publicHost: f.publicHost,
      user: f.user,
      password: d.password,
      tls: await ftpTls(f),
      root: join(d.config.server.dataDir, 'ftp'),
      log: (line) => logger.debug({ ftp: line }, 'ftp_command'),
      // Refuse at STOR while storage is paused (spec §8a); a file that got
      // in before the pause is still dropped below.
      accept: d.accept,
    });
    server.on('upload', (u: Upload) => {
      last = Date.now();
      if (!d.accept()) {
        failures++;
        logger.warn({ name: u.name }, 'clip_dropped_storage_paused');
        return void d.indexer.discard(u);
      }
      void d.indexer.add(u);
    });
    server.on('failed', (x: { name: string; reason: string }) => {
      failures++;
      logger.warn(x, 'ftp_upload_failed');
    });
    await server.start();
    logger.info({ port: f.port, tls: f.tls }, 'ftp_listening');
  };
  return { side, start, stop: async () => server?.stop() };
}
