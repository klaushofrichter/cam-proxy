// Auto-approval at the source (R2, B5, B7): a move cams-admin began with
// bounds is approved by the source's own approve() when the target's answer
// fits them, else it waits for a person with the reason audited. Over the
// fleet, with a proxy of its own (the runner takes 30 commands a minute; the
// cases on a source alone are in move-source.test.ts). Documentation
// addresses (RFC 5737) and made-up tokens only.
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeKeyFile } from '../src/fleet/keyfile';
import { writePrivateJson } from '../src/fleet/private-file';
import type { Envelope } from '../src/fleet/protocol';
import { MoveJournal } from '../src/moves/journal';
import { autoPlan, kindsWithContent } from '../src/moves/plan';
import { hashMoveToken } from '../src/moves/token';
import type { MoveBounds, MoveKind, MovePlan, Space } from '../src/moves/types';
import { strict, why } from './helpers/contract';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { ADMIN_TOKEN, auth, until } from './helpers/proxy';

const TARGET = 'prx_1123456789ABCDEFGHJK';
const TOKEN = 'move-token-'.padEnd(43, 'q');
const LEAF = `SHA256:${'A'.repeat(64)}`;
const TLS = { site: 't', cameraSubnet: '127.0.0.0/16', proxyAddresses: '127.0.0.1' };
const bodyOf = (r: { msg: Envelope }) => r.msg.body as Record<string, any>;
const fits: Space = { needed: 10, available: 1000, fits: true, perKind: { clips: 10 }, retentionProposal: null };

let sims: Sim[];
let fake: FakeAdmin;
let p: Awaited<ReturnType<typeof startMultiProxy>>;
let journal: MoveJournal;
let targetKey: string;

const done = async (command: string, args: Record<string, unknown>) => {
  const sent = fake.sendCommand(command, args, { actor: 'admin@example.org' });
  await until(() => fake.results(sent.cmdId).some((r) => bodyOf(r).phase === 'done'), 20_000);
  const b = bodyOf(fake.results(sent.cmdId).find((r) => bodyOf(r).phase === 'done')!);
  if (b.status === 'ok') {
    const v = strict(`commands/${command}.result`);
    expect(v(b.result ?? {}), `${command}: ${why(v)}`).toBe(true);
  }
  return { cmdId: sent.cmdId, ...b } as Record<string, any> & { cmdId: string };
};
const moveEvents = (kind: string) => fake.events().map(bodyOf).filter((b) => b.kind === kind);
const admin = () => auth(ADMIN_TOKEN);
const audits = (action: string) => p.proxy.audit.list({ actions: [action], limit: 50 }).records as Record<string, any>[];

beforeAll(async () => {
  sims = await startSims(1);
  fake = await startFakeAdmin();
  fake.welcomeHeartbeatS = 1;
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-autoapprove-'));
  writeKeyFile(join(dir, 'data', 'admin', 'key.json'), fake.keyFile());
  writePrivateJson(join(dir, 'data', 'admin', 'policy.json'), { v: 1, allow: ['move.send'], consent: 3, changedAt: 1, changedBy: 'local' });
  p = await startMultiProxy(sims, {
    dir, https: true,
    proxy: { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200 } } },
    settings: { tls: TLS, camsAdmin: { url: fake.url } },
  });
  journal = new MoveJournal(join(dir, 'data', 'admin', 'moves'));
  await until(() => fake.open() === 1 && p.proxy.cameras.get('cam3')!.status.state().online, 30_000);
  targetKey = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}, 180_000);
afterAll(async () => {
  await p?.proxy.stop();
  await fake?.close();
  await Promise.all((sims ?? []).map((s) => s.close()));
});

describe('auto-approval within bounds (R2)', () => {
  // A move per test, removed afterwards (one move per proxy).
  const FIRST = 'mv_3123456789ABCDEFGHJK';
  const used = new Set<string>();
  let id = '';
  const all5: MoveKind[] = ['stills', 'clips', 'events', 'checks', 'archive'];
  const within: MoveBounds = { transfer: true, kinds: all5, space: 'fit', maxBudgetS: 3600 };
  const accepted = { accept: true, space: fits, estimateS: 540 };
  const use = (m: string) => { id = m; used.add(m); };
  const begin = async (b: MoveBounds | null) => (await done('move.begin', { v: 1, camera: 'cam3', target: TARGET, bounds: b })).result.requestId as string;
  const open = (rid: string) => done('move.open', { v: 1, moveId: id, requestId: rid, camera: 'cam3', tokenHash: hashMoveToken(TOKEN), targetIp: '192.0.2.20' });
  const answer = (rid: string, a: object = accepted) => done('move.answer', { v: 1, moveId: id, requestId: rid, target: { proxyId: TARGET, name: 'Mini PC' }, ...a });
  // Filtered by move id (other moves' events and records stay in the lists).
  const approvals = () => moveEvents('move.approve').filter((e) => e.moveId === id);
  const notes = () => audits('move-auto-approve').filter((a) => a.cam_proxy.moveId === id);
  const approveAudits = () => audits('move-approve').filter((a) => a.cam_proxy.moveId === id);
  const view = async () => (await request(p.base).get('/control/moves').set(admin())).body.items.find((i: { id?: string }) => i.id === id);
  let firstRid = '';
  afterAll(() => {
    for (const m of used) journal.remove(m);
  });

  it('an accepted answer within bounds approves at once', async () => {
    use(FIRST);
    firstRid = await begin(within);
    expect((await open(firstRid)).status).toBe('ok');
    expect((await answer(firstRid)).status).toBe('ok');
    const r = journal.load(id)!;
    const want = autoPlan(within, r.summary!, accepted);
    expect('plan' in want).toBe(true);
    const plan0 = (want as { plan: MovePlan }).plan;
    expect(approvals()).toHaveLength(1);
    expect(approvals()[0].plan).toEqual(plan0);
    const env = fake.events().find((e) => bodyOf(e).kind === 'move.approve' && bodyOf(e).moveId === id)!;
    expect(strict('event')(env.msg), why(strict('event'))).toBe(true);
    expect(r).toMatchObject({ plan: plan0, phase: 'opened', autoApproval: { state: 'approved', at: expect.any(Number) } });
    expect(approveAudits()).toHaveLength(1);
    expect(approveAudits()[0]).toMatchObject({ user: { name: 'cams-admin' }, cam_proxy: { origin: 'managed', label: 'cams-admin auto-approval', plan: plan0 } });
    expect(notes()).toEqual([]);
    expect(await view()).toMatchObject({ phase: 'approved', bounds: within, autoApproval: { state: 'approved' } });
  });

  it('a repeated answer does not approve twice', async () => {
    use(FIRST);
    expect((await answer(firstRid)).status).toBe('ok');
    expect(approvals()).toHaveLength(1);
    expect(approveAudits()).toHaveLength(1);
  });

  it('approval re-sent after welcome (B7)', async () => {
    use(FIRST);
    const n = approvals().length;
    fake.destroyAll();
    await until(() => approvals().length > n, 15_000);
    await until(() => fake.open() === 1, 15_000);
    for (const e of approvals()) expect(e.plan).toEqual(journal.load(id)!.plan);
    expect(approveAudits()).toHaveLength(1);
  }, 20_000);

  it('go accepts the auto-approved plan', async () => {
    use(FIRST);
    try {
      const plan0 = journal.load(id)!.plan!;
      expect((await done('move.go', { v: 1, moveId: id, plan: plan0, targetPublicKey: targetKey, expectedLeaf: LEAF })).status).toBe('ok');
      expect(journal.load(id)!.phase).toBe('switching');
    } finally {
      p.proxy.certs!.setExpected('cam3', null, { user: 'test' });
      journal.remove(id);
    }
  });

  it('over the budget waits for a person', async () => {
    use('mv_4123456789ABCDEFGHJK');
    try {
      const rid = await begin({ ...within, maxBudgetS: 300 });
      expect((await open(rid)).status).toBe('ok');
      expect((await answer(rid)).status).toBe('ok');
      expect(approvals()).toEqual([]);
      expect(notes()).toHaveLength(1);
      expect(notes()[0]).toMatchObject({
        event: { outcome: 'failure' }, user: { name: 'cams-admin' },
        message: `Camera move ${id} (cam3 to Mini PC): not approved automatically (over_budget); waiting for approval here`,
        cam_proxy: { moveId: id, camera: 'cam3', target: TARGET, role: 'source', reason: 'over_budget', bounds: { ...within, maxBudgetS: 300 }, estimateS: 540 },
      });
      expect(journal.load(id)).toMatchObject({ plan: null, autoApproval: { state: 'waiting', reason: 'over_budget' } });
      expect(await view()).toMatchObject({ phase: 'awaiting-approval', autoApproval: { state: 'waiting', reason: 'over_budget' } });
      // A person may still approve it here.
      const manual: MovePlan = { transfer: true, kinds: kindsWithContent(journal.load(id)!.summary!), space: 'all', targetSettings: null, budgetS: 600, estimateS: 540 };
      expect((await request(p.base).post(`/control/moves/${id}/approve`).set(admin()).send({ plan: manual })).status).toBe(202);
      expect(approvals()).toHaveLength(1);
      expect(approveAudits()[0]).toMatchObject({ user: { name: 'admin' } });
    } finally {
      journal.remove(id);
    }
  });

  it('answer before open is approved at open', async () => {
    use('mv_5123456789ABCDEFGHJK');
    try {
      const rid = await begin(within);
      expect((await answer(rid)).status).toBe('ok');
      expect(approvals()).toEqual([]);
      const before = fake.events().length;
      expect((await open(rid)).status).toBe('ok');
      await until(() => approvals().length === 1, 10_000);
      const at = fake.events().findIndex((e) => bodyOf(e).kind === 'move.approve' && bodyOf(e).moveId === id);
      const opened = fake.events().findIndex((e) => bodyOf(e).kind === 'move.phase' && bodyOf(e).moveId === id && bodyOf(e).phase === 'opened');
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeGreaterThan(opened);
      expect(journal.load(id)!.autoApproval!.state).toBe('approved');
      expect(approveAudits()).toHaveLength(1);
    } finally {
      journal.remove(id);
    }
  });

  it('bounds null never approves (a page request)', async () => {
    use('mv_6123456789ABCDEFGHJK');
    try {
      const rid = (await request(p.base).post('/control/moves').set(admin()).send({ camera: 'cam3', target: TARGET }).expect(202)).body.requestId;
      expect((await open(rid)).status).toBe('ok');
      expect((await answer(rid)).status).toBe('ok');
      expect(approvals()).toEqual([]);
      expect(notes()).toEqual([]);
      expect(journal.load(id)!.autoApproval).toBeUndefined();
      expect(await view()).toMatchObject({ phase: 'awaiting-approval', bounds: null });
      expect(await view()).not.toHaveProperty('autoApproval');
    } finally {
      journal.remove(id);
    }
  });

  it('no password, move token or key in any event or audit record', () => {
    const text = JSON.stringify([...fake.events().map((e) => e.msg), ...p.proxy.audit.list({ limit: 500 }).records]);
    for (const s of [sims[0].password, TOKEN, targetKey]) expect(text).not.toContain(s);
  });
});
