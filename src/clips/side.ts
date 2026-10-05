import { readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { generate } from 'selfsigned';
import { bareHost, splitHost } from '../camera/http';
import { cameraConfig, cameraIds } from '../config/cameras';
import type { Config } from '../config/defaults';
import { logger } from '../log';
import { FtpServer, type Upload } from './ftp-server';
import type { ClipIndexer } from './indexer';

// The clips side: one FTP server every camera uploads to (spec
// 2026-10-05-multi-camera-host-design §7), feeding each camera's indexer.
export interface ClipsSide {
  server: FtpServer;
  listening: () => boolean;
  // The camera's figures, or every camera's without one.
  lastUpload: (cam?: string) => number | null;
  uploadFailures: (cam?: string) => number;
}

export type FtpUsers = Map<string, { cam: string; ip?: string }>;

// The FTP users (spec §7): every camera with FTP on, by its user; the source
// address when the camera's host is an IPv4 address (Ruling P2-4).
export function ftpUsers(c: Config): FtpUsers {
  const m: FtpUsers = new Map();
  for (const id of cameraIds(c)) {
    const cam = cameraConfig(c, id)!;
    if (!cam.ftp.enabled) continue;
    const host = bareHost(splitHost(cam.host).hostname);
    m.set(cam.ftp.user, { cam: id, ...(/^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? { ip: host } : {}) });
  }
  return m;
}

let generated: Promise<{ cert: string; key: string }> | undefined;

// The FTPS certificate: ftp.certFile/keyFile, or one made for this process
// (the camera doesn't verify it).
async function ftpTls(cfg: Config['ftp']): Promise<{ cert: string; key: string } | undefined> {
  if (!cfg.tls) return undefined;
  if (cfg.certFile && cfg.keyFile) return { cert: readFileSync(cfg.certFile, 'utf8'), key: readFileSync(cfg.keyFile, 'utf8') };
  generated ??= generate([{ name: 'commonName', value: 'cam-proxy' }], { keyType: 'ec' }).then((p) => ({ cert: p.cert, key: p.private }));
  return generated;
}

function parsePassive(range: string): [number, number] {
  const m = /^(\d+)-(\d+)$/.exec(range.trim());
  const lo = Number(m?.[1]);
  const hi = Number(m?.[2]);
  if (!m || lo < 1 || hi > 65535 || lo > hi) throw new Error(`ftp.passive: invalid range "${range}"`);
  return [lo, hi];
}

export function createClipsSide(d: {
  config: Config;
  password: string;
  users: () => FtpUsers;
  indexer: (cam: string) => ClipIndexer | undefined;
  accept: () => boolean;
  onRefused?: (r: { user: string; ip: string; expected: string }) => void;
}): { side: ClipsSide; start: () => Promise<void>; stop: () => Promise<void> } {
  const last = new Map<string, number>();
  const failures = new Map<string, number>();
  const fail = (cam: string | undefined) => failures.set(cam ?? '', (failures.get(cam ?? '') ?? 0) + 1);
  let server: FtpServer | undefined;
  const side: ClipsSide = {
    get server() {
      if (!server) throw new Error('FTP server not started');
      return server;
    },
    listening: () => server?.listening() ?? false,
    lastUpload: (cam) => (cam !== undefined ? (last.get(cam) ?? null) : last.size ? Math.max(...last.values()) : null),
    uploadFailures: (cam) => (cam !== undefined ? (failures.get(cam) ?? 0) : [...failures.values()].reduce((a, b) => a + b, 0)),
  };
  const start = async () => {
    const f = d.config.ftp;
    server = new FtpServer({
      port: f.port,
      passive: parsePassive(f.passive),
      publicHost: f.publicHost,
      users: d.users,
      password: d.password,
      tls: await ftpTls(f),
      root: join(d.config.server.dataDir, 'ftp'),
      log: (line) => logger.debug({ ftp: line }, 'ftp_command'),
      // Refuse at STOR while storage is paused (spec §8a); a file that got
      // in before the pause is still dropped below.
      accept: d.accept,
    });
    server.on('upload', (u: Upload) => {
      last.set(u.cam, Date.now());
      const ix = d.indexer(u.cam);
      if (!ix || !d.accept()) {
        fail(u.cam);
        logger.warn({ cameraId: u.cam, name: u.name }, ix ? 'clip_dropped_storage_paused' : 'clip_dropped_no_camera');
        if (ix) return void ix.discard(u);
        return void rmSync(u.tmpFile, { force: true });
      }
      void ix.add(u);
    });
    server.on('failed', (x: { name: string; reason: string; cam?: string }) => {
      fail(x.cam);
      logger.warn({ ...(x.cam ? { cameraId: x.cam } : {}), name: x.name, reason: x.reason }, 'ftp_upload_failed');
    });
    server.on('refused', (r: { user: string; ip: string; expected: string }) => {
      logger.warn(r, 'ftp_login_refused');
      d.onRefused?.(r);
    });
    await server.start();
    logger.info({ port: f.port, tls: f.tls }, 'ftp_listening');
  };
  return { side, start, stop: async () => server?.stop() };
}
