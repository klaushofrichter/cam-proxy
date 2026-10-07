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
import { ALLOW_ENTRIES, CommandPolicy } from './policy';
import { TokenStore } from './token-store';
import { createHash } from 'crypto';

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

const USAGE = 'usage: cam-proxy admin-enroll --url <cams-admin URL>   (the code is read from stdin)\n       cam-proxy admin-unenroll\n       cam-proxy admin-commands [status | allow <entry…> | deny <entry…> | pause [reason] | resume | changes | undo <cmdId>]\n       cam-proxy admin-tokens [list | block <id> | unblock <id>]\n';

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
  if (cmd === 'admin-commands' || cmd === 'admin-tokens') return runPolicyCli(cmd, rest, io);
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

// `admin-commands` and `admin-tokens` (migration P2): local admin rights (the
// CAMPROXY_ADMIN_TOKEN from the environment), so they may widen. With the
// proxy running they call its routes (audited there); stopped, they write
// data/admin/policy.json or tokens.json here and audit it.
type Loaded = ReturnType<typeof loadConfig>;
interface PolicyView { enabled: boolean; envName: string | null; paused: boolean; pauseReason: string | null; allow: string[] }
interface TokenItem { id: string; kind: string; label: string; retireAt: number | null; blocked: boolean; live: boolean; hashPrefix: string }

const printPolicy = (io: CliIo, v: PolicyView) =>
  io.out(`commands: ${v.enabled ? 'on' : `off (${v.envName ?? 'CAMPROXY_ADMIN_COMMANDS'} in the environment)`}\npaused: ${v.paused ? (v.pauseReason ?? 'yes') : 'no'}\nallowed: ${v.allow.join(', ') || 'none'}\n`);
const printTokens = (io: CliIo, v: { revision: number; problem: string | null; items: TokenItem[] }) => {
  if (v.problem) io.err(`the token file is unusable: ${v.problem}\n`);
  if (!v.items.length) return io.out(`no managed tokens (revision ${v.revision})\n`);
  io.out(`revision ${v.revision}\n`);
  for (const t of v.items) io.out(`${t.id}  ${t.kind.padEnd(6)}  ${t.blocked ? 'blocked' : !t.live ? 'retired' : t.retireAt ? `retires ${new Date(t.retireAt).toISOString()}` : 'live'}  ${t.hashPrefix}…  ${t.label}\n`);
};

// cams-admin's settings changes (plan P3 R3-5): when, which command, on whose
// behalf, which paths; never a value.
interface ChangeItem { cmdId: string; command: string; actor: string; at: number; paths: { path: string }[]; rolledBack: { at: number; by: string; user?: string; cmdId?: string } | null }
const printChanges = (io: CliIo, v: { items: ChangeItem[] }) => {
  if (!v.items.length) return io.out('no settings changes from cams-admin\n');
  for (const c of v.items) io.out(`${new Date(c.at).toISOString()}  ${c.cmdId}  ${c.command.padEnd(15)}  ${c.actor}  ${c.paths.map((x) => x.path).join(', ')}${c.rolledBack ? `  (undone ${c.rolledBack.by === 'local' ? `here by ${c.rolledBack.user ?? 'admin'}` : `by cams-admin ${c.rolledBack.cmdId ?? ''}`.trim()})` : ''}\n`);
};

async function runPolicyCli(cmd: 'admin-commands' | 'admin-tokens', rest: string[], io: CliIo): Promise<number> {
  const [op = cmd === 'admin-commands' ? 'status' : 'list', ...args] = rest;
  const usage = (why: string) => (io.err(`cam-proxy ${cmd}: ${why}\n${USAGE}`), 2);
  if (cmd === 'admin-commands') {
    if (!['status', 'allow', 'deny', 'pause', 'resume', 'changes', 'undo'].includes(op)) return usage(`unknown command ${op.slice(0, 32)}`);
    if (op === 'undo' && (args.length !== 1 || !/^cmd_[0-9A-HJKMNP-TV-Z]{20}$/.test(args[0]))) return usage('undo needs one command id (cmd_…)');
    if (op === 'changes' && args.length) return usage('unexpected argument');
    if ((op === 'allow' || op === 'deny') && !args.length) return usage(`${op} needs one or more command names`);
    if (op === 'allow' || op === 'deny') {
      const bad = args.find((a) => !ALLOW_ENTRIES.includes(a));
      if (bad) return usage(`${bad.slice(0, 64)} is not a command cams-admin may be allowed (one of: ${ALLOW_ENTRIES.join(', ')})`);
    }
    if ((op === 'status' || op === 'resume') && args.length) return usage('unexpected argument');
  } else {
    if (!['list', 'block', 'unblock'].includes(op)) return usage(`unknown command ${op.slice(0, 32)}`);
    if (op !== 'list' && (args.length !== 1 || !/^tok_[0-9A-HJKMNP-TV-Z]{20}$/.test(args[0]))) return usage(`${op} needs one token id (tok_…)`);
    if (op === 'list' && args.length) return usage('unexpected argument');
  }
  setLogLevel('warn');
  let loaded: Loaded;
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
    io.err(`cam-proxy ${cmd}: ${base} did not answer as a cam-proxy; nothing was sent or written. Retry, or stop the proxy first\n`);
    return 1;
  }
  // cams-admin's changes and their Undo go through the running proxy (it applies the settings live).
  if (state !== 'running' && (op === 'changes' || op === 'undo')) {
    io.err(`cam-proxy ${cmd} ${op}: the proxy is not running; start it, then try again (or reset the setting on the Settings page)\n`);
    return 1;
  }
  return state === 'running' ? policyLive(cmd, op, args, io, base, loaded) : policyFiles(cmd, op, args, io, loaded);
}

async function policyLive(cmd: string, op: string, args: string[], io: CliIo, base: string, loaded: Loaded): Promise<number> {
  const headers = { Authorization: `Bearer ${loaded.secrets.adminToken}`, 'Content-Type': 'application/json', 'User-Agent': 'cam-proxy-cli' };
  const call = async (method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; b: Record<string, unknown> }> => {
    const r = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000), redirect: 'error' });
    const text = await readCapped(r, 1024 * 1024);
    let b: Record<string, unknown> = {};
    try {
      b = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* not JSON */
    }
    return { ok: r.ok, status: r.status, b };
  };
  const fail = (r: { status: number; b: Record<string, unknown> }) => (io.err(`cam-proxy ${cmd}: ${String(r.b.message ?? r.b.detail ?? r.b.error ?? `the proxy answered ${r.status}`)}\n`), r.status === 400 ? 2 : 1);
  if (cmd === 'admin-commands' && op === 'changes') {
    const r = await call('GET', '/control/admin/changes');
    if (!r.ok) return fail(r);
    printChanges(io, r.b as unknown as { items: ChangeItem[] });
    return 0;
  }
  if (cmd === 'admin-commands' && op === 'undo') {
    const r = await call('POST', `/control/admin/changes/${args[0]}/undo`);
    if (r.status === 409 && r.b.error === 'conflict') return (io.err(`cam-proxy ${cmd} undo: changed here since: ${(r.b.paths as string[]).join(', ')}; nothing undone\n`), 1);
    if (!r.ok) return fail(r);
    const changes = (r.b.changes ?? []) as { path: string }[];
    io.out(`undone ${args[0]}: ${changes.map((c) => c.path).join(', ') || 'nothing changed'}\n`);
    return 0;
  }
  if (cmd === 'admin-commands') {
    let r;
    if (op === 'status') r = await call('GET', '/control/admin/commands');
    else if (op === 'allow' || op === 'deny') {
      const cur = await call('GET', '/control/admin/commands');
      if (!cur.ok) return fail(cur);
      const now = cur.b.allow as string[];
      r = await call('PUT', '/control/admin/commands', { allow: op === 'allow' ? [...new Set([...now, ...args])] : now.filter((a) => !args.includes(a)) });
    } else if (op === 'pause') r = await call('POST', '/control/admin/commands/pause', { reason: args.join(' ') });
    else r = await call('POST', '/control/admin/commands/resume');
    if (!r.ok) return fail(r);
    printPolicy(io, r.b as unknown as PolicyView);
    return 0;
  }
  const r = op === 'list' ? await call('GET', '/control/admin/tokens') : await call('POST', `/control/admin/tokens/${args[0]}/${op}`);
  if (!r.ok) return fail(r);
  printTokens(io, r.b as unknown as { revision: number; problem: string | null; items: TokenItem[] });
  return 0;
}

function policyFiles(cmd: string, op: string, args: string[], io: CliIo, loaded: Loaded): number {
  const dataDir = loaded.config.server.dataDir;
  const audit = () => new AuditLog({ dir: join(dataDir, 'audit'), version: 'cli' });
  const record = (action: 'admin-policy' | 'admin-token', message: string, details: Record<string, unknown>) =>
    audit().write({ action, category: ['configuration'], type: ['change'], outcome: 'success', user: 'admin', userAgent: 'cam-proxy-cli', message: `${message} (CLI, proxy not running)`, details });
  if (cmd === 'admin-commands') {
    const policy = new CommandPolicy({ base: () => loaded.commandPolicyBase, file: join(dataDir, 'admin', 'policy.json'), env: () => loaded.envLayer, log: { warn() {} } });
    const view = () => {
      const e = policy.effective();
      return { allow: e.allow, paused: e.paused, pauseReason: e.pauseReason };
    };
    const before = view();
    if (op === 'allow') policy.setAllow([...new Set([...before.allow, ...args])], 'local');
    else if (op === 'deny') policy.setAllow(before.allow.filter((a) => !args.includes(a)), 'local');
    else if (op === 'pause') policy.pause(args.join(' ') || null, 'local');
    else if (op === 'resume') policy.resume('local');
    if (op !== 'status') record('admin-policy', op === 'pause' ? 'cams-admin commands paused' : op === 'resume' ? 'cams-admin commands resumed' : `Allowed cams-admin commands: ${view().allow.join(', ') || 'none'}`, { from: before, to: view(), requestedBy: 'cli' });
    printPolicy(io, policy.effective());
    return 0;
  }
  const s = loaded.secrets;
  const tokens = new TokenStore({ file: join(dataDir, 'admin', 'tokens.json'), localDigests: () => [s.adminToken, ...s.tokens, ...(s.auditToken ? [s.auditToken] : [])].map((x) => createHash('sha256').update(x).digest()) });
  if (op !== 'list') {
    const t = tokens.list().find((x) => x.id === args[0]);
    try {
      if (op === 'block') tokens.block(args[0]);
      else tokens.unblock(args[0]);
    } catch (err) {
      io.err(`cam-proxy ${cmd}: ${(err as Error).message}; fix or remove the token file first\n`);
      return 1;
    }
    record('admin-token', `Managed token ${args[0]}${t ? ` (${t.label})` : ''} ${op === 'block' ? 'blocked' : 'unblocked'}`, { op, id: args[0], label: t?.label ?? null, kind: t?.kind ?? null });
  }
  printTokens(io, { revision: tokens.revision(), problem: tokens.problem(), items: tokens.list() });
  return 0;
}
