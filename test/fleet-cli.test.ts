import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAdminCli } from '../src/fleet/cli';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { ADMIN_TOKEN, CLIENT_TOKEN, freePort, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// admin-enroll / admin-unenroll (spec 2026-10-06-cams-admin-phase1-design §9.2):
// the code from stdin only; through the running proxy's control API when it
// runs (the same code path as the Status card), else straight to the files.
const CODE = 'CAE1-7Q2M-K9XD-4HPA-W3ZT-RN6B';
const ENV = { CAMPROXY_TOKENS: CLIENT_TOKEN, CAMPROXY_ADMIN_TOKEN: ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD: 'x' };
let fake: FakeAdmin;
let closedPort = 0; // nothing listens there: the proxy is not running
beforeAll(async () => {
  fake = await startFakeAdmin();
  closedPort = await freePort();
});
afterAll(() => fake.close());

const stdin = (text: string) => Object.assign(Readable.from([text]), { isTTY: false });
const run = async (argv: string[], o: { cwd: string; input?: string; proxyUrl?: string }) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAdminCli(argv, { env: ENV, cwd: o.cwd, stdin: stdin(o.input ?? ''), out: (s) => out.push(s), err: (s) => err.push(s), proxyUrl: o.proxyUrl ?? `http://127.0.0.1:${closedPort}` });
  return { code, out: out.join(''), err: err.join('') };
};
const workDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-cli-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ camera: { host: '127.0.0.1' }, server: { logLevel: 'silent' } }));
  return dir;
};

describe('admin-enroll', () => {
  it('refuses a code given as an argument', async () => {
    const dir = workDir();
    for (const argv of [['admin-enroll', '--url', fake.url, CODE], ['admin-enroll', '--url', fake.url, `--code=${CODE}`], ['admin-enroll', '--code', CODE, '--url', fake.url]]) {
      const r = await run(argv, { cwd: dir, input: CODE });
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.err).toMatch(/stdin/);
      expect(r.err).not.toContain(CODE);
    }
    expect(fake.enrollRequests).toHaveLength(0);
  });

  it('needs --url', async () => {
    const r = await run(['admin-enroll'], { cwd: workDir(), input: CODE });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--url/);
  });

  it('proxy not running: reads the code from a pipe, writes the key file and the override, prints id, account, fingerprint', async () => {
    const dir = workDir();
    fake.codes.add(CODE);
    const r = await run(['admin-enroll', '--url', fake.url], { cwd: dir, input: `${CODE}\n` });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/prx_[0-9A-Z]{20}/);
    expect(r.out).toMatch(/account: home/);
    expect(r.out).toMatch(/SHA256:[0-9A-F]{64}/);
    expect(r.out + r.err).not.toContain('7Q2M');
    expect(existsSync(join(dir, 'data', 'admin', 'key.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'data', 'overrides.json'), 'utf8'))).toEqual({ camsAdmin: { url: fake.url } });
    // Audited in the proxy's audit log, without the code.
    const audit = readdirSync(join(dir, 'data', 'audit')).map((f) => readFileSync(join(dir, 'data', 'audit', f), 'utf8')).join('');
    expect(audit).toMatch(/"action":"admin-enroll"/);
    expect(audit).not.toContain('7Q2M');

    const u = await run(['admin-unenroll'], { cwd: dir });
    expect(u.code, u.err).toBe(0);
    expect(existsSync(join(dir, 'data', 'admin', 'key.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'data', 'overrides.json'), 'utf8'))).toEqual({});
  });

  it('a refused code: exit 1 with the reason, no key file', async () => {
    const dir = workDir();
    const r = await run(['admin-enroll', '--url', fake.url], { cwd: dir, input: CODE });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/refused the code/);
    expect(existsSync(join(dir, 'data', 'admin'))).toBe(false);
  });

  it('an empty pipe: exit 2', async () => {
    const r = await run(['admin-enroll', '--url', fake.url], { cwd: workDir(), input: '' });
    expect(r.code).toBe(2);
  });
});

describe('admin-enroll: something else on the proxy port', () => {
  const serve = (handler: (res: import('http').ServerResponse) => void) =>
    new Promise<{ url: string; hits: string[]; close: () => void }>((resolve) => {
      const hits: string[] = [];
      const s = http.createServer((req, res) => {
        hits.push(`${req.method} ${req.url} ${req.headers.authorization ? 'auth' : ''}`);
        handler(res);
      });
      s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, hits, close: () => { s.closeAllConnections(); s.close(); } }));
    });

  it('not a cam-proxy answering /health: refused, the token and the code never sent, nothing written', async () => {
    const other = await serve((res) => res.end('{"status":"ok"}'));
    try {
      const dir = workDir();
      const r = await run(['admin-enroll', '--url', fake.url], { cwd: dir, input: CODE, proxyUrl: other.url });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/not a cam-proxy/);
      expect(other.hits.filter((h) => h.includes('auth') || !h.startsWith('GET /health'))).toEqual([]);
      expect(existsSync(join(dir, 'data', 'admin'))).toBe(false);
    } finally {
      other.close();
    }
  });

  it('a proxy port that does not answer: refused, overrides.json never written behind it', async () => {
    const hung = await serve(() => undefined);
    try {
      const dir = workDir();
      fake.codes.add(CODE);
      const r = await run(['admin-enroll', '--url', fake.url], { cwd: dir, input: CODE, proxyUrl: hung.url });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/did not answer/);
      expect(existsSync(join(dir, 'data', 'overrides.json'))).toBe(false);
      expect(existsSync(join(dir, 'data', 'admin'))).toBe(false);
    } finally {
      fake.codes.delete(CODE);
      hung.close();
    }
  }, 15_000);
});

describe('admin-enroll with the proxy running', () => {
  it('goes through the control API: the running proxy enrolls and connects at once', async () => {
    const sim = await startSim();
    const p = await startProxy(sim, { proxy: { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0 } } } });
    try {
      fake.codes.add(CODE);
      fake.welcomeHeartbeatS = 1;
      mkdirSync(join(p.dir, 'data'), { recursive: true });
      const r = await run(['admin-enroll', '--url', fake.url], { cwd: p.dir, input: CODE, proxyUrl: p.base });
      expect(r.code, r.err).toBe(0);
      expect(r.out).toMatch(/connected|connecting/);
      await until(() => p.proxy.camsAdmin.view().state === 'connected');
      const u = await run(['admin-unenroll'], { cwd: p.dir, proxyUrl: p.base });
      expect(u.code, u.err).toBe(0);
      await until(() => fake.received.some((x) => x.msg.type === 'bye' && (x.msg.body as { reason: string }).reason === 'unenrolled'));
      expect(p.proxy.camsAdmin.view().state).toBe('off');
    } finally {
      await p.proxy.stop();
      await sim.close();
    }
  });
});
