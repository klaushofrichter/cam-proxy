import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { sleep, within } from '../async';
import { logger } from '../log';
import { stopProcess } from './grabber';
import { trackChild } from '../children';
import { Backoff } from '../cameras/backoff';

export interface StreamSource { cam: string; host: string; port: number; user: string; password: string }

interface Go2rtcOptions {
  binary?: string;
  rtspPort: number;
  apiPort: number;
  readyMs?: number; // how long a start waits for its go2rtc's API (10 s)
  sources: () => StreamSource[]; // every camera with stills, read at each (re)spawn
  backoff?: Backoff; // test seam: the restart delays (5 s doubling to 5 min)
}

interface StreamInfo { producers: unknown[]; consumers: unknown[] }

// Each camera's password reaches go2rtc only through its own environment
// variable (spec 2026-10-05-multi-camera-host-design §8.5).
export const passwordEnv = (cam: string): string => `CAM_${cam.toUpperCase().replace(/-/g, '_')}_PASSWORD`;
// go2rtc expands ${VAR} anywhere in its config, and it holds every camera's
// password variable: a source field that could carry one is refused (review
// of #173). The user is percent-encoded; the password is an env reference or
// percent-encoded; the paths are fixed.
const SAFE_HOST = /^[A-Za-z0-9.-]{1,253}$/;
const SAFE_CAM = /^[a-z0-9][a-z0-9-]{0,31}$/;
function checkSource(s: StreamSource): void {
  if (!SAFE_CAM.test(s.cam)) throw new Error(`${s.cam}: unsafe stream source camera id`);
  if (!SAFE_HOST.test(s.host)) throw new Error(`${s.cam}: unsafe stream source host`);
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) throw new Error(`${s.cam}: unsafe stream source port`);
}
const rtsp = (s: StreamSource, pass: string, path: string) => {
  checkSource(s);
  return `rtsp://${encodeURIComponent(s.user)}:${pass}@${s.host}:${s.port}/${path}`;
};
const PATHS = { sub: 'h264Preview_01_sub', main: 'h264Preview_01_main' } as const;

// The config file: two streams per camera, no password in it.
export function go2rtcConfig(o: { rtspPort: number; apiPort: number }, sources: StreamSource[]): string {
  const streams: Record<string, string> = {};
  for (const s of sources) {
    streams[`${s.cam}_sub`] = rtsp(s, `\${${passwordEnv(s.cam)}}`, PATHS.sub);
    streams[`${s.cam}_main`] = rtsp(s, `\${${passwordEnv(s.cam)}}`, PATHS.main);
  }
  return JSON.stringify({
    api: { listen: `127.0.0.1:${o.apiPort}` },
    rtsp: { listen: `127.0.0.1:${o.rtspPort}` },
    webrtc: { listen: '' },
    srtp: { listen: '' },
    log: { level: 'warn' },
    streams,
  });
}

// One go2rtc for the host (spec 2026-10-05-multi-camera-host-design §8.5):
// it holds the one RTSP connection per camera stream and restreams it on
// 127.0.0.1. Its config is a 0600 file in a private temp folder (go2rtc
// expands ${VAR} only in config files, not in a -c string). The file holds no
// secret: each camera's password reaches go2rtc only through its own
// environment variable. Cameras added later go in through the API, without a
// restart (Ruling P2-1). WebRTC is off (by default it listens on every interface).
export class Go2rtc extends EventEmitter {
  private proc: ChildProcess | undefined;
  private running = false;
  private isReady = false;
  private cwd: string | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private readonly backoff: Backoff;
  private readonly sent = new Set<string>(); // passwords sent through the API (masked in its output)
  private readyWait: { promise: Promise<void>; resolve: () => void } = Go2rtc.pending();

  constructor(private readonly o: Go2rtcOptions) {
    super();
    this.backoff = o.backoff ?? new Backoff();
  }

  private static pending(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  }

  streamUrl(cam: string, stream: 'sub' | 'main'): string {
    return `rtsp://127.0.0.1:${this.o.rtspPort}/${cam}_${stream}`;
  }

  up(): boolean {
    return this.isReady;
  }

  pid(): number | undefined {
    return this.proc?.pid;
  }

  // Resolves once this go2rtc's API answers (after start; again after a respawn).
  ready(): Promise<void> {
    return this.readyWait.promise;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.cwd = mkdtempSync(join(tmpdir(), 'camproxy-go2rtc-'));
    await this.spawn();
  }

  private async spawn(): Promise<void> {
    const binary = this.o.binary ?? 'go2rtc';
    // An unsafe source (never past the config checks) leaves only that camera out.
    const sources = this.o.sources().filter((x) => {
      try {
        checkSource(x);
        return true;
      } catch (err) {
        logger.error({ cameraId: x.cam, err: (err as Error).message }, 'go2rtc_source_refused');
        return false;
      }
    });
    const file = join(this.cwd!, 'go2rtc.json');
    writeFileSync(file, go2rtcConfig(this.o, sources), { mode: 0o600 });
    const p = spawn(binary, ['-c', file], {
      cwd: this.cwd,
      env: { PATH: process.env.PATH ?? '', ...Object.fromEntries(sources.map((s) => [passwordEnv(s.cam), encodeURIComponent(s.password)])) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = p;
    trackChild(p);
    // Never a password in a log line: every source's as it is now (a camera
    // added after the spawn too) and every one sent through the API, plain and encoded.
    const clean = (d: Buffer) => {
      const secrets = [...this.o.sources().map((x) => x.password), ...this.sent].flatMap((pw) => [pw, encodeURIComponent(pw)]).filter((x) => x.length >= 3);
      return secrets.reduce((t, x) => t.replaceAll(x, '***'), String(d).trim());
    };
    p.stdout?.on('data', (d: Buffer) => logger.debug({ go2rtc: clean(d) }, 'go2rtc'));
    p.stderr?.on('data', (d: Buffer) => logger.debug({ go2rtc: clean(d) }, 'go2rtc'));
    p.on('error', (err) => logger.error({ err: err.message }, 'go2rtc_spawn_failed'));
    p.on('exit', (code, signal) => {
      if (this.proc === p) this.proc = undefined;
      this.setReady(false);
      if (!this.running) return;
      logger.warn({ code, signal }, 'go2rtc_exited');
      // The host restarts go2rtc with the workers' backoff (spec §3.3).
      this.restartTimer = setTimeout(() => void this.spawn().catch(() => undefined), this.backoff.next());
    });
    // Ready once its API answers, and it is this start's go2rtc: an old one
    // that still holds the port (a quick restart) answers too, with another
    // config file. Not ready in time: a start failure (the worker retries
    // with its backoff); a respawn after an exit just stays down.
    const t0 = Date.now();
    while (this.running && this.proc === p && Date.now() - t0 < (this.o.readyMs ?? 10_000)) {
      if (await this.ping(file)) {
        this.backoff.reset();
        this.setReady(true);
        return;
      }
      await sleep(100);
    }
    if (!this.running) return;
    logger.warn({ apiPort: this.o.apiPort }, 'go2rtc_not_ready');
    // Ended, so the exit handler retries it with the backoff (the host's
    // go2rtc: nobody else would).
    if (this.proc === p && p.pid !== undefined) void stopProcess(p);
    throw new Error(`go2rtc_not_ready: no go2rtc of this proxy on 127.0.0.1:${this.o.apiPort} (port in use?)`);
  }

  private setReady(v: boolean): void {
    if (v === this.isReady) return;
    this.isReady = v;
    if (v) this.readyWait.resolve();
    else this.readyWait = Go2rtc.pending();
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

  private call(method: 'PUT' | 'DELETE', query: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: this.o.apiPort, path: `/api/streams?${query}`, method, timeout: 5000 }, (res) => {
        res.resume();
        res.on('end', () => (res.statusCode && res.statusCode < 300 ? resolve() : reject(new Error(`go2rtc ${method} streams: HTTP ${res.statusCode}`))));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  // Up now, or within the ready wait of a start in progress. Not running, or
  // down: false, and nothing to do (every spawn reads the sources afresh).
  private async reachable(): Promise<boolean> {
    if (!this.running) return false;
    if (!this.isReady) await within(this.ready(), this.o.readyMs ?? 10_000);
    return this.isReady;
  }

  // Adds (or replaces) a camera's two streams through the API: no restart
  // (Ruling P2-1: the password travels in the loopback API call, never
  // logged; at the next spawn it is in the environment instead).
  async setStream(s: StreamSource): Promise<void> {
    checkSource(s);
    this.sent.add(s.password);
    if (!(await this.reachable())) return;
    for (const kind of ['sub', 'main'] as const) {
      const name = `${s.cam}_${kind}`;
      await this.call('DELETE', `src=${encodeURIComponent(name)}`).catch(() => undefined); // absent: fine
      await this.call('PUT', `name=${encodeURIComponent(name)}&src=${encodeURIComponent(rtsp(s, encodeURIComponent(s.password), PATHS[kind]))}`);
    }
  }

  async removeStream(cam: string): Promise<void> {
    if (!(await this.reachable())) return;
    for (const kind of ['sub', 'main'] as const) await this.call('DELETE', `src=${encodeURIComponent(`${cam}_${kind}`)}`).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.restartTimer);
    const p = this.proc;
    if (p && p.pid !== undefined) await stopProcess(p);
    this.proc = undefined;
    this.setReady(false);
    if (this.cwd) rmSync(this.cwd, { recursive: true, force: true });
    this.cwd = undefined;
  }
}
