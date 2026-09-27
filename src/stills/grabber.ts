import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { Transform, type Readable } from 'stream';
import { logger } from '../log';

export interface Frame {
  ts: number; // proxy clock, rounded down to the interval (ms)
  still: Buffer; // JPEG at stills.size
  tile: Buffer; // JPEG at previews.tileSize
}

const MAX_JPEG = 4 * 1024 * 1024;

// Splits a stream of concatenated JPEGs (ffmpeg image2pipe) into one JPEG per
// chunk, from SOI (FF D8) to EOI (FF D9). Inside JPEG data FF is always
// followed by 00 or a marker, so FF D9 only ends an image.
export function splitJpegs(): Transform {
  let buf: Buffer = Buffer.alloc(0);
  return new Transform({
    readableObjectMode: true,
    transform(chunk: Buffer, _enc, cb) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
        if (start < 0) {
          buf = buf.subarray(buf.length - 1); // keep a possible FF
          break;
        }
        const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
        if (end < 0) {
          buf = buf.subarray(start);
          if (buf.length > MAX_JPEG) buf = Buffer.alloc(0); // not a JPEG stream: drop
          break;
        }
        this.push(Buffer.from(buf.subarray(start, end + 2)));
        buf = buf.subarray(end + 2);
      }
      cb();
    },
  });
}

// A frame's slot: the next slot after `last` while frames keep coming at the
// expected pace (arrival jitter doesn't cost a slot), but never more than a
// quarter interval ahead of the clock; after a stall or at start, the clock's
// slot. null: the frame falls in a slot already taken (a burst).
export function nextStamp(last: number, now: number, step: number): number | null {
  const clock = Math.floor(now / step) * step;
  const next = last + step;
  const ts = last >= 0 && next <= now + step / 4 && now - next < 1.5 * step ? next : clock;
  return ts > last ? ts : null;
}

export interface GrabberOptions {
  input: string; // go2rtc's local restream
  intervalS: number;
  size: string; // WxH
  tileSize: string;
  quality: number; // ffmpeg q:v
  tileQuality: number;
  staleMs?: number; // no frame this long → down (default 10 s)
  ffmpeg?: string;
  now?: () => number;
}

// One ffmpeg decodes the sub stream and writes stills (stdout) and tiles
// (fd 3) from the same frames. Restarted with backoff when it exits.
export class FrameGrabber extends EventEmitter {
  private proc: ChildProcess | undefined;
  private running = false;
  private isUp = false;
  private last: number | null = null;
  private lastStamp = -1;
  private backoff = 1000;
  private startedAt = 0;
  private spawnedAt = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private staleTimer: NodeJS.Timeout | undefined;

  constructor(private readonly o: GrabberOptions) {
    super();
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  up(): boolean {
    return this.isUp;
  }

  lastFrameTs(): number | null {
    return this.last;
  }

  pid(): number | undefined {
    return this.proc?.pid;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.spawn();
    // No frame for staleMs: down, and ffmpeg is restarted (it can block for
    // good on a stream that stalls without closing; the exit path restarts it).
    this.startedAt = this.now();
    this.staleTimer = setInterval(() => {
      const since = this.last ?? this.startedAt;
      if (this.now() - since <= (this.o.staleMs ?? 10_000)) return;
      this.setUp(false);
      const p = this.proc;
      // A fresh ffmpeg gets time to connect and reach a keyframe first.
      if (p && p.exitCode === null && this.now() - this.spawnedAt > 2 * (this.o.staleMs ?? 10_000) + 5000) {
        logger.warn('frame_grabber_stalled_restarting');
        p.kill('SIGKILL');
      }
    }, 500);
  }

  private setUp(v: boolean): void {
    if (v === this.isUp) return;
    this.isUp = v;
    this.emit('state', { up: v, lastFrameTs: this.last });
  }

  private spawn(): void {
    const [w, h] = this.o.size.split('x');
    const [tw, th] = this.o.tileSize.split('x');
    const filter = `[0:v]fps=1/${this.o.intervalS},split=2[a][b];[a]scale=${w}:${h}[s];[b]scale=${tw}:${th}[t]`;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      // A read that hangs for 10 s fails (ffmpeg then exits and is restarted).
      '-rtsp_transport', 'tcp', '-timeout', '10000000', '-i', this.o.input,
      '-filter_complex', filter,
      // flush_packets: each frame leaves at once (buffered pipes deliver pairs).
      '-map', '[s]', '-f', 'image2pipe', '-flush_packets', '1', '-c:v', 'mjpeg', '-q:v', String(this.o.quality), 'pipe:1',
      '-map', '[t]', '-f', 'image2pipe', '-flush_packets', '1', '-c:v', 'mjpeg', '-q:v', String(this.o.tileQuality), 'pipe:3',
    ];
    const p = spawn(this.o.ffmpeg ?? 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    this.proc = p;
    this.spawnedAt = this.now();
    const stills: Buffer[] = [];
    const tiles: Buffer[] = [];
    const pair = () => {
      while (stills.length && tiles.length) {
        const still = stills.shift()!;
        const tile = tiles.shift()!;
        const ts = nextStamp(this.lastStamp, this.now(), this.o.intervalS * 1000);
        if (ts === null) continue; // a burst frame in a slot already taken
        this.lastStamp = ts;
        this.last = ts;
        this.backoff = 1000;
        this.setUp(true);
        this.emit('frame', { ts, still, tile } satisfies Frame);
      }
    };
    p.stdout!.pipe(splitJpegs()).on('data', (j: Buffer) => (stills.push(j), pair()));
    (p.stdio[3] as Readable).pipe(splitJpegs()).on('data', (j: Buffer) => (tiles.push(j), pair()));
    p.stderr!.on('data', (d: Buffer) => logger.debug({ ffmpeg: String(d).trim() }, 'frame_grabber'));
    p.on('error', (err) => logger.error({ err: err.message }, 'frame_grabber_spawn_failed'));
    p.on('exit', (code) => {
      if (this.proc === p) this.proc = undefined;
      if (!this.running) return;
      this.setUp(false);
      logger.warn({ code }, 'frame_grabber_exited');
      this.restartTimer = setTimeout(() => this.running && this.spawn(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.restartTimer);
    clearInterval(this.staleTimer);
    const p = this.proc;
    if (p && p.exitCode === null && p.signalCode === null) await stopProcess(p);
    this.proc = undefined;
    this.setUp(false);
  }
}

// SIGTERM, then SIGKILL after 3 s; resolves only once the process is gone
// (ffmpeg can ignore SIGTERM while it waits on the network).
export function stopProcess(p: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (p.exitCode !== null || p.signalCode !== null) return resolve();
    p.once('exit', () => resolve());
    p.kill('SIGTERM');
    setTimeout(() => p.kill('SIGKILL'), 3000).unref();
  });
}
