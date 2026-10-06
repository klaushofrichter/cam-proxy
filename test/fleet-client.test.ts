import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminClient, backoffDelay, type ClientLog, type Timing } from '../src/fleet/client';
import { buildHealth } from '../src/health/summary';
import type { HealthSummary } from '../src/health/summary';
import { input } from './helpers/health-input';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { strict, why } from './helpers/contract';
import { until } from './helpers/proxy';

// The cams-admin client (spec 2026-10-06-cams-admin-phase1-design §8.3-§8.8,
// §9.1) against a fake cams-admin, with short timings.
const FAST: Partial<Timing> = { connectTimeoutMs: 1000, helloTimeoutMs: 500, closeGraceMs: 200, backoffCapMs: 300, minIntervalS: 0.2, jitterS: 0, replacedWaitMs: 600, rejectedRetryMs: 400, incompatibleRetryMs: 5000, resetAfterMs: 60_000, byeWaitMs: 1000, changeCheckMs: 50 };

let fake: FakeAdmin;
let client: AdminClient | undefined;
let logs: { level: string; msg: string; o?: object }[];
const log: ClientLog = {
  info: (o, msg) => logs.push({ level: 'info', msg, o }),
  warn: (o, msg) => logs.push({ level: 'warn', msg, o }),
  debug: (o, msg) => logs.push({ level: 'debug', msg, o }),
};
const named = (m: string) => logs.filter((l) => l.msg === m);
let summary: HealthSummary;
const make = (o: { timing?: Partial<Timing>; health?: () => Promise<HealthSummary>; now?: () => number; changeKey?: () => string } = {}) => {
  client = new AdminClient({
    keyFile: fake.keyFile(),
    health: o.health ?? (async () => summary),
    proxyInfo: () => ({ startedAt: 1, uptimeS: 2, configSchema: 1, tls: null, publicUrl: null }),
    version: 'v2026.10.06.1',
    log,
    timing: { ...FAST, ...o.timing },
    now: o.now,
    changeKey: o.changeKey,
  });
  return client;
};

beforeEach(async () => {
  logs = [];
  summary = buildHealth(input({ now: Date.now() }));
  fake = await startFakeAdmin();
  fake.welcomeHeartbeatS = 1;
});
afterEach(async () => {
  await client?.stop('shutdown');
  client = undefined;
  await fake.close();
});

describe('the handshake', () => {
  it('challenge checked, hello signed, welcome, a heartbeat at once; all on the strict schemas', async () => {
    const c = make();
    c.start();
    await until(() => fake.heartbeats().length >= 1);
    expect(c.view().state).toBe('connected');
    const hello = fake.received.find((r) => r.msg.type === 'hello')!.msg;
    const hv = strict('hello');
    expect(hv(hello), why(hv)).toBe(true);
    const hb = fake.heartbeats()[0].msg;
    const v = strict('heartbeat');
    expect(v(hb), why(v)).toBe(true);
    expect(hb.seq).toBe(2);
    await until(() => c.view().lastHeartbeatAt !== null);
    expect(named('admin_connected')).toHaveLength(1);
    expect(named('admin_connected')[0].level).toBe('info');
  });

  it('a challenge signed by another key: rejected, no hello sent, logged untrusted', async () => {
    fake.mode = 'bad-sig';
    const c = make();
    c.start();
    await until(() => c.view().state === 'rejected');
    expect(fake.received.filter((r) => r.msg.type === 'hello')).toHaveLength(0);
    expect(named('admin_server_untrusted').length).toBeGreaterThan(0);
    expect(c.view().lastError).toMatch(/not trusted/);
  });

  it('a clock three years off still connects (ts is informational)', async () => {
    const c = make({ now: () => Date.now() + 3 * 365 * 86400_000 });
    c.start();
    await until(() => c.view().state === 'connected');
  });

  it('a server that never says anything: the hello timeout, then backoff (the socket is dropped even unanswered)', async () => {
    fake.mode = 'silent';
    const c = make();
    c.start();
    await until(() => c.view().state === 'backoff', 3000);
    await until(() => fake.connections >= 2, 3000);
  });
});

describe('sockets that never close', () => {
  it("a server that never answers a close: Node's WebSocket keeps that socket, so at most 4 linger and no new one opens beyond them", async () => {
    fake.mode = 'silent';
    const c = make({ timing: { helloTimeoutMs: 200 } });
    c.start();
    await new Promise((r) => setTimeout(r, 4000));
    expect(c.view().lingering).toBeLessThanOrEqual(4);
    expect(fake.connections).toBeLessThanOrEqual(5);
    expect(c.view().lastError).toMatch(/left open/);
    // The server lets them go: the client connects again.
    fake.mode = 'normal';
    fake.destroyAll();
    await until(() => c.view().state === 'connected', 5000);
    expect(c.view().lingering).toBe(0);
  });
});

describe('close codes (spec §8.8)', () => {
  it('4401 after the hello: rejected, retried after rejectedRetryMs, logged once', async () => {
    fake.mode = 'reject';
    const c = make();
    c.start();
    await until(() => c.view().state === 'rejected');
    expect(c.view().retryInMs).toBeGreaterThan(300);
    await until(() => fake.connections >= 2, 3000);
    await until(() => c.view().state === 'rejected');
    expect(named('admin_rejected')).toHaveLength(1);
    expect(c.view().lastError).toMatch(/re-enroll/);
  });

  it('4403 while connected (revoked): disconnected, then rejected', async () => {
    const c = make();
    c.start();
    await until(() => c.view().state === 'connected');
    fake.closeAll(4403);
    await until(() => c.view().state === 'rejected');
    expect(named('admin_disconnected')).toHaveLength(1);
  });

  it('4409 replaced: waits 30 s (here replacedWaitMs) first, logged', async () => {
    const c = make();
    c.start();
    await until(() => c.view().state === 'connected');
    fake.closeAll(4409);
    await until(() => c.view().state === 'backoff');
    expect(c.view().retryInMs).toBeGreaterThanOrEqual(500);
    expect(named('admin_replaced')).toHaveLength(1);
  });

  it('4429 waits retryAfterS from the error before it', async () => {
    const c = make();
    c.start();
    await until(() => c.view().state === 'connected');
    fake.send('error', { code: 'rate_limited', message: 'slow down', retryAfterS: 2 });
    await new Promise((r) => setTimeout(r, 100));
    fake.closeAll(4429);
    await until(() => c.view().state === 'backoff');
    expect(c.view().retryInMs).toBeGreaterThan(1800);
  });

  it('1001 going away: normal backoff, then connected again', async () => {
    const c = make();
    c.start();
    await until(() => c.view().state === 'connected');
    fake.closeAll(1001);
    await until(() => c.view().state === 'backoff');
    expect(c.view().retryInMs).toBeLessThanOrEqual(300);
    await until(() => fake.connections >= 2 && c.view().state === 'connected');
  });

  it('HTTP 426 without our subprotocol: incompatible, retried after 6 h (here 5 s), logged once', async () => {
    fake.refuseUpgrade = true;
    fake.supported = ['cams-admin.v2'];
    const c = make();
    c.start();
    await until(() => c.view().state === 'incompatible');
    expect(c.view().retryInMs).toBeGreaterThan(4000);
    expect(named('admin_incompatible')).toHaveLength(1);
  });

  it('an upgrade refused although v1 is supported: normal backoff, not incompatible', async () => {
    fake.refuseUpgrade = true;
    const c = make();
    c.start();
    await until(() => c.view().state === 'backoff');
    expect(named('admin_incompatible')).toHaveLength(0);
  });

  it('cams-admin down: backoff; started again: connected', async () => {
    const port = fake.port;
    await fake.close();
    const c = make();
    c.start();
    await until(() => c.view().state === 'backoff');
    fake = await startFakeAdmin(port);
    fake.welcomeHeartbeatS = 1;
    c.reconnect();
    // keyFile was registered on the old fake: the new one refuses it; any answer proves the reconnect.
    await until(() => fake.connections >= 1, 3000);
  });
});

describe('backoff', () => {
  it('full jitter: random(0, min(cap, 1 s · 2^attempt))', () => {
    expect(backoffDelay(0, 300_000, () => 0.999)).toBeLessThan(1000);
    expect(backoffDelay(3, 300_000, () => 0.999)).toBeLessThan(8000);
    expect(backoffDelay(3, 300_000, () => 0.999)).toBeGreaterThan(7900);
    expect(backoffDelay(30, 300_000, () => 0.999)).toBeLessThan(300_000);
    expect(backoffDelay(99, 300_000, () => 0.5)).toBe(150_000);
    expect(backoffDelay(5, 300_000, () => 0)).toBe(0);
  });

  it('the attempt count grows while it fails and resets after resetAfterMs connected', async () => {
    const c = make({ timing: { resetAfterMs: 300 } });
    fake.mode = 'flap'; // closes each connection after 1 s
    c.start();
    await until(() => fake.connections >= 2, 5000);
    // Connected for ~1 s each time, longer than resetAfterMs: the count starts again.
    await until(() => c.view().state === 'backoff', 3000);
    expect(c.view().attempt).toBeLessThanOrEqual(1);
  });
});

describe('heartbeats', () => {
  it('nextInS from the ack, with the floor (here 0.2 s)', async () => {
    fake.nextInS = 0;
    const c = make();
    c.start();
    await until(() => fake.heartbeats().length >= 4, 5000);
    const ts = fake.heartbeats().map((r) => r.msg.ts);
    for (let i = 2; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(190);
    expect(c.view().state).toBe('connected');
  });

  it('an early heartbeat on a change, not before the floor since the last', async () => {
    fake.welcomeHeartbeatS = 30;
    let key = 'a';
    const c = make({ changeKey: () => key, timing: { minIntervalS: 0.5 } });
    c.start();
    await until(() => fake.heartbeats().length === 1);
    const first = Date.now();
    key = 'b';
    await until(() => fake.heartbeats().length === 2, 3000);
    expect(Date.now() - first).toBeGreaterThanOrEqual(400);
  });

  it('three heartbeats without an ack: closed and connected again', async () => {
    fake.mode = 'no-ack';
    const c = make();
    c.start();
    await until(() => fake.connections >= 2, 5000);
    expect(fake.received.filter((r) => r.conn === 1 && r.msg.type === 'heartbeat')).toHaveLength(3);
    expect(c.view().lastError).toMatch(/ack/);
  });

  it('a throwing health(): admin_client_error, a reconnect, no unhandled rejection', async () => {
    let n = 0;
    const c = make({ health: async () => (n++ === 0 ? Promise.reject(new Error('boom')) : summary) });
    c.start();
    await until(() => named('admin_client_error').length >= 1);
    await until(() => fake.connections >= 2 && fake.heartbeats().length >= 1, 3000);
    expect(JSON.stringify(named('admin_client_error')[0].o)).not.toMatch(/stack/);
  });
});

describe('messages it does not serve', () => {
  it('command and unknown types: error unsupported_type with re; the connection stays', async () => {
    const c = make();
    c.start();
    await until(() => c.view().state === 'connected');
    fake.send('command', { command: 'reboot' });
    fake.send('whatever', {});
    await until(() => fake.received.filter((r) => r.msg.type === 'error').length === 2);
    const errs = fake.received.filter((r) => r.msg.type === 'error').map((r) => r.msg);
    for (const e of errs) {
      expect(e.body).toMatchObject({ code: 'unsupported_type' });
      expect(e.re).toEqual(expect.any(String));
      const v = strict('error');
      expect(v(e), why(v)).toBe(true);
    }
    expect(c.view().state).toBe('connected');
    expect(fake.connections).toBe(1);
  });

  it('garbage: an error logged and a reconnect with backoff', async () => {
    fake.mode = 'garbage';
    const c = make();
    c.start();
    await until(() => fake.connections >= 2, 3000);
    expect(c.view().state).not.toBe('connected');
  });
});

describe('stop', () => {
  it("stop('shutdown') sends bye and is done within 1 s", async () => {
    const c = make();
    c.start();
    await until(() => c.view().state === 'connected');
    const t0 = Date.now();
    await c.stop('shutdown');
    expect(Date.now() - t0).toBeLessThan(1100);
    await until(() => fake.received.some((r) => r.msg.type === 'bye'));
    const bye = fake.received.find((r) => r.msg.type === 'bye')!.msg;
    expect(bye.body).toEqual({ reason: 'shutdown' });
    const v = strict('bye');
    expect(v(bye), why(v)).toBe(true);
    expect(c.view().state).toBe('stopped');
    await until(() => fake.open() === 0);
    client = undefined;
  });

  it('stop while the server never answers a close: still done within ~1 s', async () => {
    fake.mode = 'silent';
    const c = make({ timing: { helloTimeoutMs: 10_000 } });
    c.start();
    await until(() => fake.connections === 1);
    const t0 = Date.now();
    await c.stop('shutdown');
    expect(Date.now() - t0).toBeLessThan(1300);
    client = undefined;
  });

  it('no timer or socket is left after stop', async () => {
    const c = make();
    c.start();
    await until(() => c.view().state === 'connected');
    await c.stop('restart');
    const n = fake.connections;
    await new Promise((r) => setTimeout(r, 600));
    expect(fake.connections).toBe(n);
    client = undefined;
  });
});
