import pino from 'pino';

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
