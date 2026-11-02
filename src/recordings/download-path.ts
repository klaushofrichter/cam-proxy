// src/recordings/download-path.ts
// Which way a camera's SD recordings download: Baichuan (port 9000, cmd 8),
// or HTTP Download (cmd=Download) through the camera client. Baichuan first:
// on the RLC-1224A HTTP Download has been refused since 2026-10-01 and
// Baichuan is 20-60 times faster. The E1 Outdoor Pro refuses Baichuan
// instead (400 for a file its Search lists, measured 2026-11-02), and its web
// UI downloads over HTTP. So a Baichuan refusal (400, the file still listed)
// tries HTTP; the path that worked is remembered per camera (in memory: a
// restart, or reset() after a camera-side restart, starts with Baichuan
// again), and while on HTTP Baichuan is tried first again every retryMs.
//
// One download at a time per camera (the fetcher's rule), so no locking here.
// A refusal comes before any byte (cmd 8's first reply; HTTP before its
// body), so the other path writes to the same, still empty, output.
import type { Writable } from 'stream';
import { BaichuanError } from '../camera/baichuan/errors';
import { logger } from '../log';

export type DownloadPath = 'baichuan' | 'http';

// What a download may tell its caller while it runs: the body's real length
// (HTTP's Content-Length; null: not announced), before the first byte.
export interface DownloadHooks { length?: (bytes: number | null) => void }
// Never ends `out`; resolves with the bytes written.
export type PathDownload = (path: string, size: number, out: Writable, hooks?: DownloadHooks) => Promise<number>;

export interface DownloadPathStatus {
  path: DownloadPath; // what the next download tries first
  since: number | null; // when the path last changed (null: never)
  // The camera's last Baichuan refusal: its status and what it sent.
  baichuanRefusal: { at: number; status: number | null; detail: string } | null;
  retryBaichuanAt: number | null; // on HTTP: when Baichuan is tried first again
}

// Ruling (2026-11-02): every 6 hours while on HTTP; a refusal costs about 0.5 s.
export const BAICHUAN_RETRY_MS = 6 * 3600_000;

interface RouterDeps {
  cam: () => string;
  baichuan: PathDownload;
  http?: PathDownload; // absent: Baichuan only
  now?: () => number;
  retryMs?: number;
}

const isRefusal = (e: unknown): e is BaichuanError => e instanceof BaichuanError && e.code === 'refused';
// Only a 400 from Baichuan: what the RLC-1224A answers for a missing file and
// the E1 for every file. Other statuses are protocol errors (vod.ts).
const isBaichuanRefusal = (e: unknown): e is BaichuanError => isRefusal(e) && e.status === 400;
const refusedOn = (p: DownloadPath, e: unknown): e is BaichuanError => (p === 'baichuan' ? isBaichuanRefusal(e) : isRefusal(e));

export class DownloadRouter {
  private path: DownloadPath = 'baichuan';
  private since: number | null = null;
  private refusal: DownloadPathStatus['baichuanRefusal'] = null;
  private retryAt: number | null = null;
  private logged: DownloadPath | null = null; // the path the last info line named

  constructor(private readonly d: RouterDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  status(): DownloadPathStatus {
    return { path: this.path, since: this.since, baichuanRefusal: this.refusal ? { ...this.refusal } : null, retryBaichuanAt: this.retryAt };
  }

  // The camera side restarted (a reboot, a new address): Baichuan first again.
  reset(): void {
    this.path = 'baichuan';
    this.since = null;
    this.refusal = null;
    this.retryAt = null;
    this.logged = null;
  }

  // `gone`: whether the camera no longer lists the file (asked once, after
  // the first refusal): then not_found, and the other path isn't tried.
  async download(path: string, size: number, out: Writable, ctx: DownloadHooks & { gone?: () => Promise<boolean> } = {}): Promise<number> {
    const http = this.d.http;
    const first: DownloadPath = http && this.path === 'http' && (this.retryAt === null || this.now() < this.retryAt) ? 'http' : 'baichuan';
    const run = (p: DownloadPath) => (p === 'http' ? http! : this.d.baichuan)(path, size, out, { length: ctx.length });
    let refused: BaichuanError;
    try {
      const bytes = await run(first);
      this.worked(first);
      return bytes;
    } catch (err) {
      if (!refusedOn(first, err)) throw err;
      refused = err;
    }
    if (first === 'baichuan') this.noteRefusal(refused);
    // Without HTTP the fetcher asks the list itself (its 400 check).
    if (!http) throw refused;
    if (ctx.gone && (await ctx.gone().catch(() => false))) throw new BaichuanError('not_found', 'the camera no longer has the recording', 400);
    if (out.destroyed || out.writableEnded) throw refused;
    const second: DownloadPath = first === 'baichuan' ? 'http' : 'baichuan';
    try {
      const bytes = await run(second);
      this.worked(second);
      return bytes;
    } catch (err) {
      if (!refusedOn(second, err)) throw err;
      if (second === 'baichuan') this.noteRefusal(err);
      const [bc, h] = first === 'baichuan' ? [refused, err] : [err, refused];
      if (this.path === 'http') this.retryAt = this.now() + this.retryMs();
      throw new BaichuanError('refused', `Baichuan: ${bc.message}; HTTP: ${h.message}`);
    }
  }

  private retryMs(): number {
    return this.d.retryMs ?? BAICHUAN_RETRY_MS;
  }

  private noteRefusal(e: BaichuanError): void {
    this.refusal = { at: this.now(), status: e.status ?? null, detail: e.message };
  }

  private worked(p: DownloadPath): void {
    // On HTTP: the retry time is set when HTTP takes over, or when it was due
    // (Baichuan refused again); later HTTP downloads don't push it out.
    if (p === 'baichuan') this.retryAt = null;
    else if (this.path !== 'http' || this.retryAt === null || this.now() >= this.retryAt) this.retryAt = this.now() + this.retryMs();
    if (p !== this.path) {
      this.path = p;
      this.since = this.now();
    }
    if (this.logged === p) return;
    this.logged = p;
    const r = this.refusal;
    logger.info(
      p === 'http' && r
        ? { camera: this.d.cam(), path: p, baichuanRefusal: { status: r.status, detail: r.detail }, retryBaichuanInMin: Math.round(this.retryMs() / 60_000) }
        : { camera: this.d.cam(), path: p },
      'recording_download_path',
    );
  }
}
