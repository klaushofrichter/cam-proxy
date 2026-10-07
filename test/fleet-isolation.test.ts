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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { configRevision } from '../src/config/load';
import { leafPaths, SETTINGS } from '../src/config/schema';
import { ALLOW_ENTRIES, NEVER_REMOTE_ACTIONS } from '../src/fleet/policy';
import { DENIED } from '../src/fleet/remote-settable';
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

// P3 (plan P3 Task 12, Review Focus 1, 4, 5): a compromised cams-admin with
// every allow entry allowed. Trust paths, a new camera, data-destroying or
// spending settings and never-remote actions are refused (visible in the
// audit log); a flood is held to the windows; the proxy carries on.
describe('a hostile cams-admin with every P3 entry allowed', () => {
  type Res = { msg: { body: Record<string, any> } };
  const done = async (command: string, args: Record<string, unknown>) => {
    const { cmdId } = fake.sendCommand(command, args);
    await until(() => fake.results(cmdId).some((r) => (r as Res).msg.body.phase === 'done'), 10_000);
    return (fake.results(cmdId).find((r) => (r as Res).msg.body.phase === 'done') as Res).msg.body;
  };
  const overrides = () => {
    try {
      return readFileSync(join(p.dir, 'data', 'overrides.json'), 'utf8');
    } catch {
      return null;
    }
  };
  const failures = () => p.proxy.audit.list({ actions: ['admin-command'], limit: 200 }).records.filter((r) => (r as { event: { outcome: string } }).event.outcome === 'failure').length;
  beforeAll(async () => {
    fake.mode = 'normal';
    await until(() => p.proxy.camsAdmin.view().state === 'connected', 15_000);
    writePrivateJson(join(adminDir, 'policy.json'), { v: 1, allow: [...ALLOW_ENTRIES], changedAt: 2, changedBy: 'local' });
    // A fresh minute for the windows (earlier tests sent commands too).
    await new Promise((r) => setTimeout(r, 61_000));
  }, 90_000);
  afterAll(() => writePrivateJson(join(adminDir, 'policy.json'), { v: 1, allow: ['tokens.apply', 'tokens.apply.admin'], changedAt: 3, changedBy: 'local' }));
  const rev = () => configRevision(p.proxy.loaded);

  it('(a) every denied prefix and a new camera fail before planning; overrides.json byte-identical; each a failure record', async () => {
    const before = overrides();
    const f0 = failures();
    const leaves = leafPaths(SETTINGS, '', ['cam1']);
    const set = Object.fromEntries(DENIED.map((d) => d.replace('cameras.*.', 'cameras.cam1.')).map((d) => [leaves.find((l) => l === d || l.startsWith(`${d}.`))!, 1]).filter(([l]) => l));
    expect(Object.keys(set).length).toBe(DENIED.length);
    const r = await done('config.set', { v: 1, dryRun: false, baseRevision: rev(), set });
    expect(r).toMatchObject({ status: 'failed', code: 'not_remote_settable' });
    expect((r.result.paths as { code: string }[]).length).toBe(Object.keys(set).length);
    expect(await done('config.set', { v: 1, dryRun: false, baseRevision: rev(), set: { 'cameras.newcam.host': '192.0.2.9', 'cameras.newcam.name': 'x' } })).toMatchObject({ status: 'failed', code: 'unknown_camera' });
    expect(overrides()).toBe(before);
    expect(p.proxy.running.cameraOrder).toEqual(['cam1']);
    expect(failures()).toBe(f0 + 2);
  });
  it('(e) spending raised, any retention period or size cap lowered: widening_local_only; storage: not_remote_settable; nothing deleted, nothing written', async () => {
    const before = overrides();
    const clips = listClips(p.proxy.catalog, 'cam1', 0, Date.now() + 86_400_000).length;
    const lower = { 'retention.stillsDays': 1, 'retention.previewsDays': 1, 'retention.clipsDays': 1, 'retention.eventsDays': 1, 'retention.auditDays': 1, 'retention.streamLogDays': 1, 'stills.maxGB': 1, 'previews.maxGB': 1, 'ftp.maxGB': 1, 'analytics.googleVision.monthlyLimit': 100000 };
    const r = await done('config.set', { v: 1, dryRun: false, baseRevision: rev(), set: lower });
    expect(r).toMatchObject({ status: 'failed', code: 'widening_local_only' });
    expect((r.result.paths as { path: string }[]).map((x) => x.path).sort()).toEqual(Object.keys(lower).sort());
    const storage = Object.fromEntries(leafPaths(SETTINGS, '', ['cam1']).filter((x) => /^storage\.|^cameras\.cam1\.storage\./.test(x)).map((x) => [x, 1]));
    expect(await done('config.set', { v: 1, dryRun: false, baseRevision: rev(), set: storage })).toMatchObject({ status: 'failed', code: 'not_remote_settable' });
    p.proxy.storage.run({ dryRun: false });
    expect(listClips(p.proxy.catalog, 'cam1', 0, Date.now() + 86_400_000).length).toBe(clips);
    expect(overrides()).toBe(before);
  });
  it('(f) every never-remote action: not_allowed whatever the allow-list; none of their functions called', async () => {
    const a = p.proxy.actions;
    const spies = [vi.spyOn(a, 'findCamera'), vi.spyOn(a, 'restartProcess'), vi.spyOn(a, 'restart'), vi.spyOn(a.tls, 'rotate'), vi.spyOn(a.tls, 'clearTrust'), vi.spyOn(a.tls, 'dropPrevious'), vi.spyOn(a.archive, 'clear'), vi.spyOn(a.inventory, 'repair'), vi.spyOn(a.poeSwitch, 'poeOn')];
    try {
      for (const action of NEVER_REMOTE_ACTIONS) expect(await done('camera.action', { v: 1, camera: 'cam1', action }), action).toMatchObject({ status: 'refused', code: 'not_allowed' });
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
  it('(b, g) 20 config.set in a minute: at most 6 run in the minute (with the 4 above), the rest rate_limited; the proxy carries on meanwhile', async () => {
    lag.reset();
    const ids = Array.from({ length: 20 }, () => fake.sendCommand('config.set', { v: 1, dryRun: true, baseRevision: rev(), set: { 'sse.pingS': 7 } }).cmdId);
    await proxyCarriesOn();
    await until(() => ids.every((id) => fake.results(id).some((r) => (r as Res).msg.body.phase === 'done')), 15_000);
    const outcome = ids.map((id) => (fake.results(id).find((r) => (r as Res).msg.body.phase === 'done') as Res).msg.body);
    const ran = outcome.filter((b) => b.status !== 'refused');
    expect(ran.length).toBeLessThanOrEqual(2);
    // The rest refused: rate_limited, or busy while one ran (one command at a time).
    expect(outcome.filter((b) => b.code === 'rate_limited' || b.code === 'busy').length).toBe(20 - ran.length);
    expect(outcome.filter((b) => b.code === 'rate_limited').length).toBeGreaterThanOrEqual(12);
    expect(lag.percentile(99) / 1e6).toBeLessThan(LAG_P99_MS);
  }, 60_000);
});
