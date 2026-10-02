import pino from 'pino';
import { Writable } from 'stream';

// Secrets never reach the logs: passwords and tokens anywhere a caller might
// put them, and authorization headers. URLs are logged without their query
// (camera URLs carry the session token).
const REDACT = [
  'password', 'token', 'authorization',
  '*.password', '*.token', '*.authorization',
  'req.headers.authorization', 'headers.authorization',
];

export function createLogger(level: string, dest?: pino.DestinationStream): pino.Logger {
  return pino({ level, redact: { paths: REDACT, censor: '[redacted]' } }, dest);
}

export function withoutQuery(url: string): string {
  const i = url.indexOf('?');
  return i < 0 ? url : url.slice(0, i);
}

// A URL path with token-like segments masked: any segment of 32 or more
// characters (by length, not charset: dots, +, =, %, ~ and an extension do not
// hide a token) is written as `:token`, in case a token was put in the URL.
// Ids and file names are shorter (Rec20261001_120000_000_M.mp4 is 29).
export function maskPath(path: string): string {
  return path.replace(/\/[^/]{32,}(?=\/|$)/g, '/:token');
}

// Recent log lines (info and above) for the control API, whatever the
// console level. Lines are already redacted by pino when they get here.
export class LogBuffer {
  private readonly lines: Record<string, unknown>[] = [];
  constructor(private readonly max = 500) {}
  push(line: Record<string, unknown>): void {
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.shift();
  }
  recent(limit = 100): Record<string, unknown>[] {
    return this.lines.slice(-Math.max(1, Math.min(limit, this.max)));
  }
}

export const logBuffer = new LogBuffer();
const INFO = pino.levels.values.info;
let consoleLevel = INFO;
const levelOf = (chunk: Buffer | string) => Number(/"level":(\d+)/.exec(String(chunk))?.[1] ?? 0);

const toConsole = new Writable({
  write(chunk, _enc, cb) {
    if (levelOf(chunk) >= consoleLevel) process.stdout.write(chunk);
    cb();
  },
});
const toBuffer = new Writable({
  write(chunk, _enc, cb) {
    if (levelOf(chunk) >= INFO) {
      try {
        logBuffer.push(JSON.parse(String(chunk)));
      } catch {
        // not a JSON line: skip
      }
    }
    cb();
  },
});

// The process-wide logger: console at the configured level, the buffer at info.
export const logger = pino(
  { level: 'info', redact: { paths: REDACT, censor: '[redacted]' } },
  pino.multistream([{ level: 'trace', stream: toConsole }, { level: 'trace', stream: toBuffer }]),
);

export function setLogLevel(level: string): void {
  consoleLevel = level === 'silent' ? Infinity : (pino.levels.values[level] ?? INFO);
  logger.level = consoleLevel < INFO ? level : 'info';
}
setLogLevel(process.env.CAMPROXY_LOG_LEVEL ?? 'info');
