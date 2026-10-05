import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { sleep } from '../async';
import { logger } from '../log';
import { stopProcess } from './grabber';
import { trackChild } from '../children';

interface Go2rtcOptions {
  binary?: string;
  rtspPort: number;
  apiPort: number;
  cam: string;
  readyMs?: number; // how long a start waits for its go2rtc's API (10 s)
  source: { host: string; port: number; user: string; password: string };
}

interface StreamInfo { producers: unknown[]; consumers: unknown[] }

const PASS_ENV = 'CAMPROXY_GO2RTC_PASS';

// go2rtc holds the one RTSP connection per camera stream and restreams it on
// 127.0.0.1. Its config is a 0600 file in a private temp folder (go2rtc
// expands ${VAR} only in config files, not in a -c string). The file holds no
// secret: the camera password reaches go2rtc only through its environment.
// WebRTC is off (by default it listens on every interface).
export class Go2rtc extends EventEmitter {
  private proc: ChildProcess | undefined;
  private running = false;
  private ready = false;
  private cwd: string | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private backoff = 1000;

  constructor(private readonly o: Go2rtcOptions) {
    super();
  }

  streamUrl(stream: 'sub' | 'main'): string {
    return `rtsp://127.0.0.1:${this.o.rtspPort}/${this.o.cam}_${stream}`;
  }

  up(): boolean {
    return this.ready;
  }

  pid(): number | undefined {
    return this.proc?.pid;
  }

  private config(): string {
    const s = this.o.source;
    const src = (path: string) => `rtsp://${encodeURIComponent(s.user)}:\${${PASS_ENV}}@${s.host}:${s.port}/${path}`;
    return JSON.stringify({
      api: { listen: `127.0.0.1:${this.o.apiPort}` },
      rtsp: { listen: `127.0.0.1:${this.o.rtspPort}` },
      webrtc: { listen: '' },
      srtp: { listen: '' },
      log: { level: 'warn' },
      streams: { [`${this.o.cam}_sub`]: src('h264Preview_01_sub'), [`${this.o.cam}_main`]: src('h264Preview_01_main') },
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cwd = mkdtempSync(join(tmpdir(), 'camproxy-go2rtc-'));
    await this.spawn();
  }

  private async spawn(): Promise<void> {
    const binary = this.o.binary ?? 'go2rtc';
    const pass = encodeURIComponent(this.o.source.password);
    const file = join(this.cwd!, 'go2rtc.json');
    writeFileSync(file, this.config(), { mode: 0o600 });
    const p = spawn(binary, ['-c', file], {
      cwd: this.cwd,
      env: { PATH: process.env.PATH ?? '', [PASS_ENV]: pass },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = p;
    trackChild(p);
    const clean = (d: Buffer) => String(d).trim().replaceAll(pass, '***').replaceAll(this.o.source.password, '***');
    p.stdout?.on('data', (d: Buffer) => logger.debug({ go2rtc: clean(d) }, 'go2rtc'));
    p.stderr?.on('data', (d: Buffer) => logger.debug({ go2rtc: clean(d) }, 'go2rtc'));
    p.on('error', (err) => logger.error({ err: err.message }, 'go2rtc_spawn_failed'));
    p.on('exit', (code, signal) => {
      if (this.proc === p) this.proc = undefined;
      this.setReady(false);
      if (!this.running) return;
      logger.warn({ code, signal }, 'go2rtc_exited');
      this.restartTimer = setTimeout(() => void this.spawn().catch(() => undefined), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
    // Ready once its API answers, and it is this start's go2rtc: an old one
    // that still holds the port (a quick restart) answers too, with another
    // config file. Not ready in time: a start failure (the worker retries
    // with its backoff); a respawn after an exit just stays down.
    const t0 = Date.now();
    while (this.running && this.proc === p && Date.now() - t0 < (this.o.readyMs ?? 10_000)) {
      if (await this.ping(file)) {
        this.backoff = 1000;
        this.setReady(true);
        return;
      }
      await sleep(100);
    }
    if (!this.running) return;
    logger.warn({ cam: this.o.cam, apiPort: this.o.apiPort }, 'go2rtc_not_ready');
    throw new Error(`go2rtc_not_ready: no go2rtc of this proxy on 127.0.0.1:${this.o.apiPort} (port in use?)`);
  }

  private setReady(v: boolean): void {
    if (v === this.ready) return;
    this.ready = v;
    this.emit('state', { up: v });
  }

  // Answers, and runs our config file (go2rtc reports the -c path).
  private ping(file: string): Promise<boolean> {
    return this.get('/api').then((body) => {
      try {
        return (JSON.parse(body) as { config_path?: unknown }).config_path === file;
      } catch {
        return false;
      }
    }, () => false);
  }

  private get(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: this.o.apiPort, path, timeout: 2000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }

  // go2rtc's view of its streams (producers = camera connections).
  async streams(): Promise<Record<string, StreamInfo>> {
    const raw = JSON.parse(await this.get('/api/streams')) as Record<string, Partial<StreamInfo> | null>;
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { producers: v?.producers ?? [], consumers: v?.consumers ?? [] }]));
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.restartTimer);
    const p = this.proc;
    if (p) await stopProcess(p);
    this.proc = undefined;
    this.setReady(false);
    if (this.cwd) rmSync(this.cwd, { recursive: true, force: true });
    this.cwd = undefined;
  }
}
