import { Client } from 'basic-ftp';
import { execFile } from 'child_process';
import { mkdtempSync, readFileSync, statSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import { Readable } from 'stream';
import { promisify } from 'util';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listClips } from '../src/catalog/clips';
import { listEvents } from '../src/catalog/events';
import { writeKeyFile } from '../src/fleet/keyfile';
import { writePrivateJson } from '../src/fleet/private-file';
import { startFakeAdmin, type FakeAdmin, type Mode } from './helpers/fake-admin';
import { auth, freePort, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// A hostile or wedged cams-admin never gets in the proxy's way (spec
// 2026-10-06-cams-admin-phase1-design §9.1, §15.2; plan Review Focus 1):
// with the client attached to each bad variant, events, FTP clips, stills
// and the client API carry on and the event loop stays responsive.
const run = promisify(execFile);
const FTP_PW = 'ftp-secret-'.padEnd(24, 'z');
const LAG_P99_MS = 100; // the budget: far above a healthy loop, far below a stall

// A TCP relay in front of the fake cams-admin that can blackhole the link (a network drop).
function relay(target: number) {
  let dropped = false;
  const pairs = new Set<net.Socket>();
  const server = net.createServer((a) => {
    const b = net.connect(target, '127.0.0.1');
    pairs.add(a).add(b);
    a.on('data', (d) => dropped || b.write(d));
    b.on('data', (d) => dropped || a.write(d));
    for (const [x, y] of [[a, b], [b, a]]) {
      x.on('error', () => y.destroy());
      x.on('close', () => (y.destroy(), pairs.delete(x)));
    }
  });
  return {
    listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port))),
    blackhole: (on: boolean) => (dropped = on),
    close: () => {
      for (const s of pairs) s.destroy();
      server.close();
    },
  };
}

let sim: Awaited<ReturnType<typeof startSim>>;
let fake: FakeAdmin;
let link: ReturnType<typeof relay>;
let p: Awaited<ReturnType<typeof startProxy>>;
let ftpPort = 0;
let adminDir = '';
let clip: Buffer;
let clipN = 0;
const KINDS = ['person', 'vehicle', 'pet', 'motion'] as const;
const lag = monitorEventLoopDelay({ resolution: 10 });

beforeAll(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'camproxy-iso-'));
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(tmp, 'c.mp4')]);
  clip = readFileSync(join(tmp, 'c.mp4'));
  sim = await startSim();
  fake = await startFakeAdmin();
  fake.welcomeHeartbeatS = 1;
  fake.nextInS = 1;
  link = relay(fake.port);
  const linkPort = await link.listen();
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-iso-p-'));
  writeKeyFile(join(dir, 'data', 'admin', 'key.json'), fake.keyFile({ connectUrl: `ws://127.0.0.1:${linkPort}/proxy/v1/connect` }));
  // P2: tokens.apply (with admin entries) allowed, a token set and a journal in place.
  adminDir = join(dir, 'data', 'admin');
  writePrivateJson(join(adminDir, 'policy.json'), { v: 1, allow: ['tokens.apply', 'tokens.apply.admin'], changedAt: 1, changedBy: 'local' });
  writePrivateJson(join(adminDir, 'tokens.json'), { v: 1, revision: 5, blocked: [], tokens: [{ id: 'tok_00000000000000000001', kind: 'client', hash: `sha256:${'1'.repeat(64)}`, label: 'cams', retireAt: null }] });
  writePrivateJson(join(adminDir, 'commands.json'), { v: 1, entries: [{ cmdId: 'cmd_00000000000000000001', command: 'tokens.apply', actor: 'a', at: 1, status: 'ok' }] });
  ftpPort = await freePort();
  const passive = await freePort();
  p = await startProxy(sim, {
    dir,
    settings: {
      camsAdmin: { url: fake.url },
      ftp: { enabled: true, port: ftpPort, passive: `${passive}-${passive + 9}`, publicHost: '127.0.0.1', tls: true, stream: 'sub' },
    },
    env: { CAMPROXY_FTP_PASSWORD: FTP_PW },
    proxy: { camsAdmin: { timing: { connectTimeoutMs: 1000, helloTimeoutMs: 1000, closeGraceMs: 300, backoffCapMs: 500, minIntervalS: 0.5, jitterS: 0, rejectedRetryMs: 500, replacedWaitMs: 300 } } },
  });
  await until(() => p.proxy.camsAdmin.view().state === 'connected', 10_000);
  await until(() => p.proxy.intake.state().onvif === 'subscribed', 15_000);
  lag.enable();
}, 60_000);
afterAll(async () => {
  lag.disable();
  await p?.proxy.stop();
  link?.close();
  await fake?.close();
  await sim?.close();
});

// The proxy's own work, while cams-admin misbehaves.
async function proxyCarriesOn(): Promise<void> {
  const kind = KINDS[clipN % KINDS.length];
  const t0 = Date.now() - 2000;
  sim.sim.engine.events.trigger(kind, 1);
  const c = new Client(5000);
  const at = new Date(Date.now() - 60_000 * ++clipN);
  const stamp = at.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const clips = listClips(p.proxy.catalog, 'cam1', 0, Date.now() + 86_400_000).length;
  try {
    await c.access({ host: '127.0.0.1', port: ftpPort, user: 'camera', password: FTP_PW, secure: true, secureOptions: { rejectUnauthorized: false } });
    await c.ensureDir('/2026/10/06');
    await c.uploadFrom(Readable.from([clip]), `Den_00_${stamp}.mp4`);
  } finally {
    c.close();
  }
  await until(() => listClips(p.proxy.catalog, 'cam1', 0, Date.now() + 86_400_000).length === clips + 1, 15_000);
  await until(() => listEvents(p.proxy.catalog, { cam: 'cam1', from: t0, kind }).length > 0, 15_000);
  expect((await request(p.base).get('/api/cameras').set(auth())).status).toBe(200);
  expect((await request(p.base).get('/api/local/health')).status).toBe(200);
  if (process.env.CAMPROXY_TEST_GO2RTC) await until(async () => (await request(p.base).get('/api/stills/latest').set(auth())).status === 200, 15_000);
}

describe('a hostile cams-admin', () => {
  it.each<[Mode, string]>([
    ['silent', 'accepts and never says or reads anything'],
    ['garbage', 'answers garbage'],
    ['flap', 'closes every connection after a second'],
    ['reject', 'answers 4401'],
    ['no-ack', 'never acknowledges'],
  ])('%s (%s): events, clips, stills and the API carry on; the loop stays responsive', async (mode) => {
    fake.mode = mode;
    fake.destroyAll(); // the next connection meets the new behaviour
    lag.reset();
    const t0 = Date.now();
    await proxyCarriesOn();
    // At least 3 s with it, so the client went through its reconnects.
    await new Promise((r) => setTimeout(r, Math.max(0, 3000 - (Date.now() - t0))));
    await proxyCarriesOn();
    expect(lag.percentile(99) / 1e6).toBeLessThan(LAG_P99_MS);
    expect(p.proxy.camsAdmin.view().state).not.toBe('stopped');
    // Node's WebSocket can't drop a socket the server never lets go: a few linger, no more.
    expect(p.proxy.camsAdmin.view().lingering).toBeLessThanOrEqual(4);
    expect(fake.open()).toBeLessThanOrEqual(5);
  }, 60_000);

  // P2: hostile commands (plan Review Focus 5) never run, never write the
  // journal or the token store, and leave bounded audit records.
  const snapshot = () => ['tokens.json', 'commands.json'].map((f) => `${f}:${statSync(join(adminDir, f)).mtimeMs}:${readFileSync(join(adminDir, f), 'utf8')}`).join('|');
  it.each<[Mode, string]>([
    ['command-flood', '500 signed commands a second for one not allowed'],
    ['forged', 'tokens.apply signed with another key'],
    ['replay', 'a command re-sent on the same and the next connection'],
    ['oversize', 'tokens.apply with 200 KiB of args'],
    ['junk-commands', 'commands without any body field'],
  ])('%s (%s): the proxy carries on; nothing written; bounded audit', async (mode) => {
    fake.mode = 'normal';
    fake.destroyAll();
    await until(() => p.proxy.camsAdmin.view().state === 'connected', 10_000);
    const files = snapshot();
    const before = fake.received.length;
    const conns = fake.connections;
    const audits = p.proxy.audit.list({ actions: ['admin-command'], limit: 500 }).records.length;
    fake.mode = mode;
    fake.destroyAll();
    lag.reset();
    const t0 = Date.now();
    await proxyCarriesOn();
    await new Promise((r) => setTimeout(r, Math.max(0, 3000 - (Date.now() - t0))));
    await proxyCarriesOn();
    expect(lag.percentile(99) / 1e6).toBeLessThan(LAG_P99_MS);
    expect(snapshot()).toBe(files);
    const sent = fake.received.slice(before).map((r) => r.msg);
    const results = sent.filter((m) => m.type === 'result').map((m) => m.body as { phase: string; status?: string; code?: string });
    expect(results.some((r) => r.phase === 'received'), mode).toBe(false);
    // Nack results at most 60 a minute per proxy.
    expect(results.length).toBeLessThanOrEqual(60 * 2);
    const codes = { 'command-flood': 'not_allowed', forged: 'bad_signature', replay: 'wrong_target', oversize: 'invalid_args' } as Record<string, string>;
    // The refusal is seen: a result, or (once the 60-a-minute nack budget is spent
    // by the modes before) the audit record of its code.
    const auditCodes = (p.proxy.audit.list({ actions: ['admin-command'], limit: 500 }).records as unknown as { cam_proxy?: { details?: { outcome?: string } } }[]).map((r) => JSON.stringify(r).match(/"outcome":"([a-z_]+)"/g) ?? []).flat().join(' ');
    if (codes[mode]) expect(`${results.map((r) => r.code).join(' ')} ${auditCodes}`, mode).toContain(codes[mode]);
    if (mode === 'junk-commands') {
      expect(sent.filter((m) => m.type === 'error' && (m.body as { code: string }).code === 'bad_message').length).toBeGreaterThanOrEqual(20);
      expect(fake.connections).toBeGreaterThan(conns + 1);
    }
    // At most one admin-command record per refusal code per 10 minutes (a few codes at most).
    expect(p.proxy.audit.list({ actions: ['admin-command'], limit: 500 }).records.length - audits).toBeLessThanOrEqual(2);
  }, 60_000);

  it('cams-admin fine again: connected again on its own', async () => {
    fake.mode = 'normal';
    fake.destroyAll();
    await until(() => p.proxy.camsAdmin.view().state === 'connected', 10_000);
  }, 20_000);

  it('a network drop (a blackholed link): noticed by the missing acks, reconnected once the link is back', async () => {
    await until(() => p.proxy.camsAdmin.view().state === 'connected', 10_000);
    const before = fake.connections;
    link.blackhole(true);
    try {
      lag.reset();
      await proxyCarriesOn();
      await until(() => p.proxy.camsAdmin.view().state !== 'connected', 15_000);
      expect(p.proxy.camsAdmin.view().lastError).toMatch(/ack|answer|welcome|closed/);
    } finally {
      link.blackhole(false);
    }
    await until(() => fake.connections > before && p.proxy.camsAdmin.view().state === 'connected', 15_000);
    expect(lag.percentile(99) / 1e6).toBeLessThan(LAG_P99_MS);
  }, 60_000);

  it('cams-admin restarted: the proxy reconnects', async () => {
    const before = fake.connections;
    fake.closeAll(1001);
    await until(() => fake.connections > before && p.proxy.camsAdmin.view().state === 'connected', 15_000);
  }, 20_000);
});
