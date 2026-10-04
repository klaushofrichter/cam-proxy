import { closeSync, constants, copyFileSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, chmodSync, unlinkSync, writeSync } from 'fs';
import { basename, dirname, isAbsolute, join, normalize } from 'path';

// The Pi's one .env file (spec 2026-10-04-pi-config-design): cam-proxy reads
// CAMERA_HOST and PI_ADDRESS from it at start, and "Use this address" writes
// CAMERA_HOST into it. Only that one line ever changes; every other byte of
// the file (secrets included) stays as it was. Values never reach a log or an
// error message here.

export type EnvFileErrorCode = 'not_set' | 'bad_path' | 'missing' | 'not_a_file' | 'too_large' | 'bad_value' | 'not_writable' | 'is_a_mount' | 'write_failed';
export class EnvFileError extends Error {
  constructor(readonly code: EnvFileErrorCode, message: string) {
    super(message);
  }
}

const MAX_BYTES = 64 * 1024;

interface Assignment { start: number; end: number; eol: string; prefix: string; value: string; rest: string }

// One line's assignment of `key`: `[spaces][export ]KEY[spaces]=[spaces]value[ # comment]`.
// `prefix`: everything before the value, as written; `rest`: what follows
// it (a closing quote's comment, an inline comment).
function parseLine(line: string, key: string): { prefix: string; value: string; rest: string } | undefined {
  let i = 0;
  const spaces = () => {
    while (line[i] === ' ' || line[i] === '\t') i++;
  };
  spaces();
  if (line.startsWith('export ', i)) {
    i += 7;
    spaces();
  }
  if (!line.startsWith(key, i)) return undefined;
  i += key.length;
  spaces();
  if (line[i] !== '=') return undefined;
  i++;
  spaces();
  const prefix = line.slice(0, i);
  const q = line[i];
  if (q === '"' || q === "'") {
    const close = line.indexOf(q, i + 1);
    if (close >= 0) return { prefix, value: line.slice(i + 1, close), rest: line.slice(close + 1) };
  }
  // Unquoted: an inline comment starts at whitespace + '#'.
  const m = /[ \t]+#/.exec(line.slice(i));
  const valueEnd = m ? i + m.index : line.length;
  return { prefix, value: line.slice(i, valueEnd).trimEnd(), rest: line.slice(valueEnd) };
}

// Every assignment of `key` in the text, in order.
function assignments(text: string, key: string): Assignment[] {
  const out: Assignment[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    const lineEnd = nl < 0 ? text.length : nl;
    const cr = lineEnd > start && text[lineEnd - 1] === '\r';
    const end = cr ? lineEnd - 1 : lineEnd;
    const a = parseLine(text.slice(start, end), key);
    if (a) out.push({ start, end, eol: nl < 0 ? '' : cr ? '\r\n' : '\n', ...a });
    start = nl < 0 ? text.length : nl + 1;
  }
  return out;
}

// The value of `key` (the last assignment, as a shell or compose would take
// it), quotes and an inline comment removed; undefined when not set.
export function readEnvValue(text: string, key: string): string | undefined {
  return assignments(text, key).at(-1)?.value;
}

// The text with `key` set to `value`: the last assignment's value replaced,
// or a new line appended. Values that would need quoting are refused.
export function setEnvLine(text: string, key: string, value: string): string {
  if (!/^[A-Za-z0-9._:-]*$/.test(value)) throw new EnvFileError('bad_value', `${key}: the value has characters a .env line can't hold unquoted`);
  const last = assignments(text, key).at(-1);
  if (last) {
    return text.slice(0, last.start) + last.prefix + value + last.rest + text.slice(last.end);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const sep = text.length && !text.endsWith('\n') ? eol : '';
  return `${text}${sep}${key}=${value}${eol}`;
}

// The configured env file, checked: an absolute path without '..', named
// .env or .env.<word>, an existing regular file (no symlink), under 64 KB.
export function checkEnvPath(path: string | undefined): string {
  if (!path) throw new EnvFileError('not_set', 'CAMPROXY_ENV_FILE is not set');
  if (!isAbsolute(path) || path.split(/[\\/]/).includes('..') || normalize(path) !== path) throw new EnvFileError('bad_path', 'CAMPROXY_ENV_FILE must be an absolute path without ..');
  if (!/^\.env(\.[A-Za-z0-9_-]{1,32})?$/.test(basename(path))) throw new EnvFileError('bad_path', 'CAMPROXY_ENV_FILE must name a .env file');
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new EnvFileError('missing', 'CAMPROXY_ENV_FILE: the file does not exist');
  }
  if (!st.isFile()) throw new EnvFileError('not_a_file', 'CAMPROXY_ENV_FILE: not a regular file (a symlink or a directory)');
  if (st.size > MAX_BYTES) throw new EnvFileError('too_large', 'CAMPROXY_ENV_FILE: larger than 64 KB');
  return path;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// Sets one key in the env file: a backup first (.env.bak-YYYYMMDD-HHMMSS,
// UTC, the file's mode), then the new text to a temp file in the same
// directory (the file's mode) and a rename over the file. `keys`: the names
// that set this value, strongest first; the first one the file sets is
// replaced, else the last name is appended. Answers the previous value (null:
// not set) and the backup's file name.
export function writeEnvKey(path: string, keys: string | string[], value: string, now = new Date()): { previous: string | null; backup: string } {
  const names = Array.isArray(keys) ? keys : [keys];
  checkEnvPath(path);
  const dir = dirname(path);
  const text = readFileSync(path, 'utf8');
  const key = names.find((k) => readEnvValue(text, k) !== undefined) ?? names[names.length - 1];
  const previous = readEnvValue(text, key) ?? null;
  const next = setEnvLine(text, key, value);
  const mode = lstatSync(path).mode & 0o777;
  // The backup: never over an older one.
  const base = `${basename(path)}.bak-${stamp(now)}`;
  let backup = base;
  for (let n = 2; ; n++) {
    try {
      copyFileSync(path, join(dir, backup), constants.COPYFILE_EXCL);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' && n < 100) {
        backup = `${base}-${n}`;
        continue;
      }
      throw new EnvFileError(code === 'EACCES' || code === 'EROFS' || code === 'EPERM' ? 'not_writable' : 'write_failed', `the env file's directory is not writable (${code}); mount the directory, not the file`);
    }
  }
  chmodSync(join(dir, backup), mode);
  const tmp = join(dir, `${basename(path)}.tmp-${process.pid}`);
  try {
    const fd = openSync(tmp, 'wx', mode);
    try {
      writeSync(fd, next);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // not created
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EBUSY' || code === 'EXDEV') throw new EnvFileError('is_a_mount', 'the env file is mounted on its own; mount its directory instead');
    throw new EnvFileError('write_failed', `the env file could not be written (${code ?? 'error'})`);
  }
  return { previous, backup };
}
