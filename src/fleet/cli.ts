import { join } from 'path';
import { createInterface } from 'readline';
import type { Readable } from 'stream';
import { AuditLog } from '../audit/audit-log';
import { cameraIds } from '../config/cameras';
import { applyOverrides, ConfigError, loadConfig, removeOverride } from '../config/load';
import { setLogLevel } from '../log';
import { enrollWithCode, EnrollError } from './enroll';
import { deleteKeyFile } from './keyfile';
import { fingerprint, readCapped } from './protocol';

// `cam-proxy admin-enroll --url U` and `admin-unenroll` (spec
// 2026-10-06-cams-admin-phase1-design §9.2). The code comes from stdin (a
// pipe or a prompt), never an argument (shell history, the process list).
// With the proxy running, both go through its control API (the Status
// card's code path, audited there; it connects at once); otherwise the key
// file and overrides.json are written here and the next start connects.
export interface CliIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin: Readable & { isTTY?: boolean };
  out: (s: string) => void;
  err: (s: string) => void;
  proxyUrl?: string; // default http://127.0.0.1:<server.port>
}

const USAGE = 'usage: cam-proxy admin-enroll --url <cams-admin URL>   (the code is read from stdin)\n       cam-proxy admin-unenroll\n';

async function readCode(io: CliIo): Promise<string> {
  if (io.stdin.isTTY) {
    const rl = createInterface({ input: io.stdin, output: process.stderr, terminal: true });
    try {
      return await new Promise<string>((r) => rl.question('Enrollment code from cams-admin: ', r));
    } finally {
      rl.close();
    }
  }
  let text = '';
  for await (const chunk of io.stdin) {
    text += String(chunk);
    if (text.length > 1024) break;
  }
  return text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
}

// Whether the proxy runs on its port: 'running' (its /health answered as a
// cam-proxy's: {ok, version, startedAt}), 'stopped' (nothing listens), or
// 'unknown' (something else answers, or nothing in time). The admin token and
// the code go only to a running cam-proxy; nothing is written behind an unknown one.
async function probe(base: string): Promise<'running' | 'stopped' | 'unknown'> {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
    const text = await readCapped(r, 4096);
    const b = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    return r.ok && b && b.ok === true && typeof b.version === 'string' && 'startedAt' in b ? 'running' : 'unknown';
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code;
    return code === 'ECONNREFUSED' ? 'stopped' : 'unknown';
  }
}

const printView = (io: CliIo, v: { proxyId?: string | null; account?: string | null; fingerprint?: string | null; url?: string | null; state?: string }) =>
  io.out(`enrolled with ${v.url}\nproxy id: ${v.proxyId}\naccount: ${v.account}\nkey fingerprint: ${v.fingerprint}\n${v.state ? `state: ${v.state}\n` : ''}`);

export async function runAdminCli(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== 'admin-enroll' && cmd !== 'admin-unenroll') {
    io.err(USAGE);
    return 2;
  }
  let url: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--url') url = rest[++i];
    else if (a.startsWith('--url=')) url = a.slice(6);
    else {
      io.err(`cam-proxy ${cmd}: unexpected argument; the enrollment code is read from stdin, never given as an argument\n${USAGE}`);
      return 2;
    }
  }
  if (cmd === 'admin-enroll' && !url) {
    io.err(`cam-proxy admin-enroll: --url is required\n${USAGE}`);
    return 2;
  }
  setLogLevel('warn');
  let loaded;
  try {
    loaded = loadConfig(io.env, { cwd: io.cwd });
  } catch (err) {
    if (err instanceof ConfigError) {
      io.err(`cam-proxy: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  const base = io.proxyUrl ?? `http://127.0.0.1:${loaded.config.server.port}`;
  const state = await probe(base);
  if (state === 'unknown') {
    io.err(`cam-proxy ${cmd}: ${base} did not answer as a cam-proxy (not a cam-proxy, or it did not answer in time); nothing was sent or written. Retry, or stop the proxy first\n`);
    return 1;
  }
  const live = state === 'running';
  const headers = { Authorization: `Bearer ${loaded.secrets.adminToken}`, 'Content-Type': 'application/json', 'User-Agent': 'cam-proxy-cli' };

  if (cmd === 'admin-unenroll') {
    if (live) {
      const r = await fetch(`${base}/control/admin/unenroll`, { method: 'POST', headers, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) {
        io.err(`cam-proxy admin-unenroll: the proxy answered ${r.status}\n`);
        return 1;
      }
      io.out('unenrolled: the key file is deleted and camsAdmin.url cleared\n');
      return 0;
    }
    const keyPath = join(loaded.config.server.dataDir, loaded.config.camsAdmin.keyFile);
    deleteKeyFile(keyPath);
    if (loaded.sources['camsAdmin.url'] === 'override') removeOverride(loaded, 'camsAdmin.url');
    new AuditLog({ dir: join(loaded.config.server.dataDir, 'audit'), version: 'cli' }).write({ action: 'admin-unenroll', category: ['configuration'], type: ['deletion'], outcome: 'success', user: 'admin', userAgent: 'cam-proxy-cli', message: 'Unenrolled from cams-admin (CLI, proxy not running)', details: { url: loaded.config.camsAdmin.url ?? null } });
    io.out(`unenrolled: the key file is deleted${loaded.sources['camsAdmin.url'] === 'file' ? '; camsAdmin.url is set in config.json: remove it there' : ' and camsAdmin.url cleared'}\n`);
    return 0;
  }

  const code = await readCode(io);
  if (!code) {
    io.err('cam-proxy admin-enroll: no code on stdin\n');
    return 2;
  }
  if (live) {
    const r = await fetch(`${base}/control/admin/enroll`, { method: 'POST', headers, body: JSON.stringify({ url, code }), signal: AbortSignal.timeout(30_000) });
    const b = (await r.json().catch(() => ({}))) as { message?: string; error?: string; proxyId?: string; account?: string; fingerprint?: string; url?: string; state?: string };
    if (!r.ok) {
      io.err(`cam-proxy admin-enroll: ${b.message ?? b.error ?? `the proxy answered ${r.status}`}\n`);
      return r.status === 400 && (b.error === 'bad_url' || b.error === 'not_a_code') ? 2 : 1;
    }
    printView(io, b);
    return 0;
  }
  const keyPath = join(loaded.config.server.dataDir, loaded.config.camsAdmin.keyFile);
  const audit = new AuditLog({ dir: join(loaded.config.server.dataDir, 'audit'), version: 'cli' });
  try {
    const key = await enrollWithCode({ url: url!, code, keyPath, version: process.env.CAMPROXY_VERSION ?? 'dev', cameraIds: cameraIds(loaded.config) });
    if (loaded.config.camsAdmin.url !== key.url) applyOverrides(loaded, { camsAdmin: { url: key.url } });
    const fp = fingerprint(key.publicKey);
    audit.write({ action: 'admin-enroll', category: ['configuration'], type: ['creation'], outcome: 'success', user: 'admin', userAgent: 'cam-proxy-cli', message: `Enrolled with cams-admin ${key.url} as ${key.proxyId} (account ${key.account}; CLI, proxy not running)`, details: { url: key.url, proxyId: key.proxyId, account: key.account, fingerprint: fp } });
    printView(io, { url: key.url, proxyId: key.proxyId, account: key.account, fingerprint: fp });
    io.out('the proxy connects when it starts\n');
    return 0;
  } catch (err) {
    const e = err instanceof EnrollError ? err : null;
    audit.write({ action: 'admin-enroll', category: ['configuration'], type: ['creation'], outcome: 'failure', user: 'admin', userAgent: 'cam-proxy-cli', message: `Enrollment with cams-admin ${url} failed: ${e?.code ?? 'error'}`, error: e?.code ?? 'error', details: { url, reason: e?.code ?? 'error' } });
    io.err(`cam-proxy admin-enroll: ${e ? e.message : (err as Error).message}\n`);
    return e && (e.code === 'not_a_code' || e.code === 'bad_url') ? 2 : 1;
  }
}
