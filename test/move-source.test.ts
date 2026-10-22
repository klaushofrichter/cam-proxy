// The source side of a camera move (camera-move plan Task 7, S §4, §7, §9.1,
// §12): starting a move on the source's page, the target's answer, approval,
// go (the expected leaf, the frozen manifest) and release (the camera hidden).
// A FakeAdmin acts for cams-admin; cam-sim is the camera. Documentation
// addresses (RFC 5737) and made-up tokens only.
import { createHash, generateKeyPairSync, randomBytes } from 'crypto';
import https from 'https';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeKeyFile } from '../src/fleet/keyfile';
import { writePrivateJson } from '../src/fleet/private-file';
import type { Envelope } from '../src/fleet/protocol';
import { MoveJournal } from '../src/moves/journal';
import { approveProblem } from '../src/moves/source';
import { hashMoveToken } from '../src/moves/token';
import type { MovePlan, MoveSummary, Space } from '../src/moves/types';
import { siteCa } from '../src/tls/ca';
import { issueLeaf, type Leaf } from '../src/tls/leaf';
import { servedFingerprint } from '../src/tls/served';
import { strict, why } from './helpers/contract';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';

const TARGET = 'prx_1123456789ABCDEFGHJK';
const MOVE = 'mv_0123456789ABCDEFGHJK';
const TOKEN = 'move-token-'.padEnd(43, 'q');
const MANAGED_ADMIN = randomBytes(32).toString('base64url');
const TLS = { site: 't', cameraSubnet: '127.0.0.0/16', proxyAddresses: '127.0.0.1' };
const bodyOf = (r: { msg: Envelope }) => r.msg.body as Record<string, any>;
const tokenHashOf = (t: string) => `sha256:${createHash('sha256').update(t).digest('hex')}`;

let sims: Sim[];
let fake: FakeAdmin;
let p: Awaited<ReturnType<typeof startMultiProxy>>;
let journal: MoveJournal;
let targetLeaf: Leaf;
let targetKey: string;

const done = async (command: string, args: Record<string, unknown>, cmdId?: string) => {
  const sent = fake.sendCommand(command, args, { actor: 'admin@example.org', ...(cmdId ? { cmdId } : {}) });
  const n = fake.results(sent.cmdId).filter((r) => bodyOf(r).phase === 'done').length;
  await until(() => fake.results(sent.cmdId).filter((r) => bodyOf(r).phase === 'done').length > (cmdId ? n : 0), 20_000);
  const b = bodyOf(fake.results(sent.cmdId).filter((r) => bodyOf(r).phase === 'done').at(-1)!);
  if (b.status === 'ok') {
    const v = strict(`commands/${command}.result`);
    expect(v(b.result ?? {}), `${command}: ${why(v)}`).toBe(true);
  }
  return { cmdId: sent.cmdId, ...b } as Record<string, any> & { cmdId: string };
};
const moveEvents = (kind?: string) => fake.events().map(bodyOf).filter((b) => (kind ? b.kind === kind : String(b.kind).startsWith('move.')));
const admin = () => auth(ADMIN_TOKEN);
const audits = (action: string) => p.proxy.audit.list({ actions: [action], limit: 50 }).records as Record<string, any>[];
const allow = (list: string[]) => request(p.base).put('/control/admin/commands').set(admin()).send({ allow: list }).expect(200);

beforeAll(async () => {
  sims = await startSims(1);
  fake = await startFakeAdmin();
  fake.welcomeHeartbeatS = 1;
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-movesrc-'));
  writeKeyFile(join(dir, 'data', 'admin', 'key.json'), fake.keyFile());
  writePrivateJson(join(dir, 'data', 'admin', 'policy.json'), { v: 1, allow: ['move.send'], consent: 3, changedAt: 1, changedBy: 'local' });
  writePrivateJson(join(dir, 'data', 'admin', 'tokens.json'), { v: 1, revision: 1, blocked: [], tokens: [{ id: `tok_${'1'.repeat(20)}`, kind: 'admin', hash: tokenHashOf(MANAGED_ADMIN), label: 'cams cluster', retireAt: null }] });
  p = await startMultiProxy(sims, {
    dir, https: true,
    // cam9: a camera whose certificate is managed elsewhere (its public name).
    extra: [{ id: 'cam9', host: '127.0.0.1:9', protocol: 'https', user: 'proxy', tlsName: 'cam9.example.org' }],
    proxy: { tlsPush: { clearWaitMs: 50, verifyMs: 3000, pollMs: 100 }, camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200 } } },
    settings: { tls: TLS, camsAdmin: { url: fake.url } },
  });
  journal = new MoveJournal(join(dir, 'data', 'admin', 'moves'));
  await until(() => fake.open() === 1 && p.proxy.cameras.get('cam3')!.status.state().online, 30_000);
  await p.proxy.certs!.tick();
  expect(p.proxy.certs!.state('cam3').mode).toBe('site-ca');
  // The target's own site CA and the leaf it will push to cam3.
  const target = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-movesrc-ca-')), { site: 'u', cameraSubnet: '127.0.0.0/16', proxyAddresses: ['127.0.0.1'] });
  targetLeaf = await issueLeaf(target, { cn: 'cam3.u.internal', dns: ['cam3.u.internal'], ips: ['127.0.0.1'] });
  targetKey = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}, 180_000);
afterAll(async () => {
  await p?.proxy.stop();
  await fake?.close();
  await Promise.all((sims ?? []).map((s) => s.close()));
});

let requestId = '';
// kinds: filled with the kinds that have content before the approval (a bare sim may have none).
const plan: MovePlan = { transfer: true, kinds: [], space: 'all', targetSettings: null, budgetS: 3600, estimateS: 1800 };
const fits: Space = { needed: 10, available: 1000, fits: true, perKind: { clips: 10 }, retentionProposal: null };

describe('starting a move (S §4, P10)', () => {
  it('request on a proxy without tls.site is refused no_site_ca (the Pi), before any event', async () => {
    const q = await startProxy(sims[0]);
    try {
      for (const [path, body] of [['/control/moves/targets', { camera: 'cam1' }], ['/control/moves', { camera: 'cam1', target: TARGET }]] as const) {
        const r = await request(q.base).post(path).set(admin()).send(body);
        expect([r.status, r.body], path).toEqual([409, { error: 'move_refused', reason: 'no_site_ca' }]);
      }
      // Also for an unknown camera: nothing says what exists.
      expect((await request(q.base).post('/control/moves').set(admin()).send({ camera: 'cam7', target: TARGET })).body.reason).toBe('no_site_ca');
    } finally {
      await q.proxy.stop();
    }
  }, 60_000);

  it('request for a camera with tlsName is refused external_cert', async () => {
    const n = moveEvents().length;
    const r = await request(p.base).post('/control/moves').set(admin()).send({ camera: 'cam9', target: TARGET });
    expect([r.status, r.body]).toEqual([409, { error: 'move_refused', reason: 'external_cert' }]);
    expect((await request(p.base).post('/control/moves/targets').set(admin()).send({ camera: 'cam9' })).body.reason).toBe('external_cert');
    expect(moveEvents().length).toBe(n);
  });

  it('without move.send: moves_not_allowed; bad input is 400, an unknown camera 404', async () => {
    await allow([]);
    try {
      expect((await request(p.base).post('/control/moves').set(admin()).send({ camera: 'cam3', target: TARGET })).body).toEqual({ error: 'move_refused', reason: 'moves_not_allowed' });
    } finally {
      await allow(['move.send']);
    }
    expect((await request(p.base).post('/control/moves').set(admin()).send({ camera: 'cam3', target: 'elsewhere' })).status).toBe(400);
    expect((await request(p.base).post('/control/moves').set(admin()).send({ camera: 'cam7', target: TARGET })).status).toBe(404);
    expect((await request(p.base).post('/control/moves/targets').set(admin()).send({})).status).toBe(400);
  });

  it('the target list: move.targets out, the command fills it in', async () => {
    const r = await request(p.base).post('/control/moves/targets').set(admin()).send({ camera: 'cam3' }).expect(202);
    const rid = r.body.requestId;
    expect(rid).toMatch(/^rq_[0-9A-HJKMNP-TV-Z]{20}$/);
    await until(() => moveEvents('move.targets').some((e) => e.requestId === rid), 10_000);
    const ev = fake.events().find((e) => bodyOf(e).requestId === rid)!;
    expect(strict('event')(ev.msg), why(strict('event'))).toBe(true);
    expect(bodyOf(ev)).toMatchObject({ kind: 'move.targets', requestId: rid, camera: 'cam3' });
    expect((await request(p.base).get(`/control/moves/targets/${rid}`).set(admin())).body).toEqual({ targets: null });
    const targets = [{ proxyId: TARGET, name: 'Mini PC', site: 'u' }];
    expect((await done('move.targets', { v: 1, requestId: rid, targets })).status).toBe('ok');
    expect((await request(p.base).get(`/control/moves/targets/${rid}`).set(admin())).body).toEqual({ targets });
    // Idempotent: the same list again, a new command.
    expect((await done('move.targets', { v: 1, requestId: rid, targets })).status).toBe('ok');
    // A request this proxy never made.
    expect(await done('move.targets', { v: 1, requestId: 'rq_ZZZZZZZZZZZZZZZZZZZZ', targets })).toMatchObject({ status: 'failed', code: 'unknown_request' });
    expect((await request(p.base).get('/control/moves/targets/rq_ZZZZZZZZZZZZZZZZZZZZ').set(admin())).status).toBe(404);
  });

  it('request emits move.request with summary and settings and no password', async () => {
    const r = await request(p.base).post('/control/moves').set(admin()).send({ camera: 'cam3', target: TARGET }).expect(202);
    requestId = r.body.requestId;
    await until(() => moveEvents('move.request').some((e) => e.requestId === requestId), 10_000);
    const env = fake.events().find((e) => bodyOf(e).kind === 'move.request' && bodyOf(e).requestId === requestId)!;
    expect(strict('event')(env.msg), why(strict('event'))).toBe(true);
    expect(fake.verifyFromProxy(env.msg)).toBe(true);
    const port = sims[0].ports;
    expect(bodyOf(env)).toMatchObject({
      kind: 'move.request', requestId, target: TARGET, actor: { origin: 'local', label: 'local admin' },
      camera: { proxyCameraId: 'cam3', name: 'cam3', host: `127.0.0.1:${port.https}`, protocol: 'https', user: 'proxy', onvifPort: port.onvif, rtspPort: port.rtsp || 554, baichuanPort: sims[0].camera.baichuanPort },
      settings: { name: 'cam3', statusPollS: 5 },
    });
    const summary = bodyOf(env).summary as MoveSummary;
    expect(Object.keys(summary).sort()).toEqual(['archive', 'checks', 'clips', 'events', 'stills']);
    const text = JSON.stringify(env.msg);
    expect(text).not.toContain(sims[0].password);
    expect(text).not.toMatch(/password/i);
    const rec = audits('move-request')[0];
    expect(rec).toMatchObject({ user: { name: 'admin' }, cam_proxy: { requestId, target: TARGET, origin: 'local' } });
    expect(JSON.stringify(rec)).not.toContain(sims[0].password);
    const view = (await request(p.base).get('/control/moves').set(admin())).body.items.find((i: { requestId: string }) => i.requestId === requestId);
    expect(view).toMatchObject({ requestId, camera: 'cam3', target: { proxyId: TARGET, name: 'Mini PC' }, phase: 'requested', settings: { name: 'cam3' }, budgetExceeded: false });
  });

  it('managed session may start a move only when move.send is allowed', async () => {
    const code = (await request(p.base).post('/control/login-links').set(auth(MANAGED_ADMIN)).expect(201)).body.code;
    const cookie = String((await request(p.base).get(`/control/login-link?code=${code}`).expect(302)).headers['set-cookie']).split(';')[0];
    const ui = { Cookie: cookie, 'x-camproxy-ui': '1' };
    const n = moveEvents('move.request').length;
    const r = await request(p.base).post('/control/moves').set(ui).send({ camera: 'cam3', target: TARGET }).expect(202);
    await until(() => moveEvents('move.request').length === n + 1, 10_000);
    expect(moveEvents('move.request').at(-1)).toMatchObject({ requestId: r.body.requestId, actor: { origin: 'managed', label: 'cams cluster' } });
    // Without the CSRF header: refused as for any session write.
    expect((await request(p.base).post('/control/moves').set({ Cookie: cookie }).send({ camera: 'cam3', target: TARGET })).body.error).toBe('csrf');
    // The managed token itself: never (move.send unlocks the sign-in only).
    expect((await request(p.base).post('/control/moves').set(auth(MANAGED_ADMIN)).send({ camera: 'cam3', target: TARGET })).body.error).toBe('local_admin_only');
    await allow([]);
    try {
      for (const path of ['/control/moves', '/control/moves/targets', `/control/moves/${MOVE}/approve`, `/control/moves/${MOVE}/cancel`]) {
        const x = await request(p.base).post(path).set(ui).send({ camera: 'cam3', target: TARGET });
        expect([x.status, x.body.error], path).toEqual([403, 'local_admin_only']);
      }
      // Reading stays open to an admin sign-in.
      expect((await request(p.base).get('/control/moves').set(ui)).status).toBe(200);
    } finally {
      await allow(['move.send']);
    }
    expect(moveEvents('move.request').length).toBe(n + 1);
  });
});

describe('open, answer, approve', () => {
  it('move.open writes the source journal (token hash, target address), phase opened; idempotent', async () => {
    const args = { v: 1, moveId: MOVE, requestId, camera: 'cam3', tokenHash: hashMoveToken(TOKEN), targetIp: '192.0.2.20' };
    const first = await done('move.open', args);
    expect(first.status).toBe('ok');
    const r = journal.load(MOVE)!;
    expect(r).toMatchObject({ role: 'source', camera: 'cam3', phase: 'opened', requestId, tokenHash: hashMoveToken(TOKEN), peer: { proxyId: TARGET, name: 'Mini PC', ip: '192.0.2.20' } });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    await until(() => moveEvents('move.phase').some((e) => e.moveId === MOVE && e.phase === 'opened'), 10_000);
    // Same cmdId twice: the runner's duplicate; same moveId with a new cmdId: the same state.
    const dup = await done('move.open', args, first.cmdId);
    expect(dup).toMatchObject({ status: 'ok', duplicate: true });
    const again = await done('move.open', args);
    expect(again.status).toBe('ok');
    expect(journal.load(MOVE)).toEqual(r);
    // Another token for the same move: refused, the record unchanged.
    expect(await done('move.open', { ...args, tokenHash: hashMoveToken('other-token-'.padEnd(43, 'z')) })).toMatchObject({ status: 'failed', code: 'move_exists' });
    expect(journal.load(MOVE)).toEqual(r);
    // One move per proxy: a new request is busy now.
    expect((await request(p.base).post('/control/moves').set(admin()).send({ camera: 'cam3', target: TARGET })).body).toEqual({ error: 'move_refused', reason: 'busy' });
    const view = (await request(p.base).get('/control/moves').set(admin())).body.items.find((i: { id?: string }) => i.id === MOVE);
    expect(view).toMatchObject({ id: MOVE, requestId, phase: 'offered' });
  });

  it('move.answer stores the answer; the panel shows it', async () => {
    const args = { v: 1, moveId: MOVE, requestId, target: { proxyId: TARGET, name: 'Mini PC' }, accept: true, space: fits, estimateS: 1800 };
    expect((await done('move.answer', args)).status).toBe('ok');
    expect((await done('move.answer', args)).status).toBe('ok');
    expect(journal.load(MOVE)!.answer).toEqual({ accept: true, space: fits, estimateS: 1800 });
    const view = (await request(p.base).get('/control/moves').set(admin())).body.items.find((i: { id?: string }) => i.id === MOVE);
    expect(view).toMatchObject({ phase: 'awaiting-approval', answer: { accept: true, space: fits, estimateS: 1800 } });
    expect(await done('move.answer', { ...args, requestId: 'rq_ZZZZZZZZZZZZZZZZZZZZ' })).toMatchObject({ status: 'failed', code: 'mismatch' });
  });

  it('approve with budget below the estimate is 400 (and other plans the answer does not allow)', async () => {
    const post = (pl: unknown) => request(p.base).post(`/control/moves/${MOVE}/approve`).set(admin()).send({ plan: pl });
    for (const [bad, detail] of [
      [{ ...plan, budgetS: 1799 }, 'plan.budgetS'],
      [{ ...plan, estimateS: 60, budgetS: 60 }, 'plan.estimateS'],
      [{ ...plan, kinds: ['archive'] }, 'plan.kinds'],
      [{ ...plan, space: 'omit' }, 'plan.space'],
      [{ ...plan, targetSettings: { 'ftp.maxGB': 9 } }, 'plan.targetSettings'],
      [{ ...plan, surprise: 1 }, 'plan'],
    ] as const) {
      const r = await post(bad);
      expect([r.status, r.body.error, r.body.detail], JSON.stringify(bad)).toEqual([400, 'invalid', detail]);
    }
    expect(moveEvents('move.approve')).toEqual([]);
    expect((await request(p.base).post('/control/moves/mv_ZZZZZZZZZZZZZZZZZZZZ/approve').set(admin()).send({ plan })).status).toBe(404);
  });

  it('approve emits move.approve and records move-approve', async () => {
    const summary = journal.load(MOVE)!.summary!;
    const kinds = (['clips', 'events', 'checks'] as const).filter((k) => summary[k].files + summary[k].rows > 0);
    plan.kinds = [...kinds];
    const r = await request(p.base).post(`/control/moves/${MOVE}/approve`).set(admin()).send({ plan });
    expect(r.status).toBe(202);
    await until(() => moveEvents('move.approve').length === 1, 10_000);
    const env = fake.events().find((e) => bodyOf(e).kind === 'move.approve')!;
    expect(strict('event')(env.msg), why(strict('event'))).toBe(true);
    expect(bodyOf(env)).toMatchObject({ moveId: MOVE, plan });
    expect(journal.load(MOVE)).toMatchObject({ plan, phase: 'opened' });
    expect(audits('move-approve')[0]).toMatchObject({ user: { name: 'admin' }, cam_proxy: { moveId: MOVE, plan, budgetS: 3600, estimateS: 1800 } });
    const view = (await request(p.base).get('/control/moves').set(admin())).body.items.find((i: { id?: string }) => i.id === MOVE);
    expect(view.phase).toBe('approved');
    // Approved once: a second approval is a conflict.
    expect((await request(p.base).post(`/control/moves/${MOVE}/approve`).set(admin()).send({ plan: { ...plan, budgetS: 7200 } })).status).toBe(409);
  });
});

// What the target's cert step does to the camera (Task 8): CertificateClear, then the import.
async function pushTargetLeaf(sim: Sim): Promise<void> {
  sim.sim.engine.clearCertificate();
  await until(() => !sim.sim.engine.certRestarting && sim.sim.engine.certs.state.enable === 0, 10_000);
  expect(sim.sim.engine.importCertificate(targetLeaf.certPem, targetLeaf.keyPem)).toBeNull();
}

describe('go and release (S §9.1, P8, P12)', () => {
  const goArgs = () => ({ v: 1, moveId: MOVE, plan, targetPublicKey: targetKey, expectedLeaf: targetLeaf.fingerprint });

  it('go with a plan other than the approved one fails plan_mismatch, nothing changes', async () => {
    expect(await done('move.go', { ...goArgs(), plan: { ...plan, budgetS: 99999 } })).toMatchObject({ status: 'failed', code: 'plan_mismatch' });
    expect(journal.load(MOVE)!.phase).toBe('opened');
    expect(p.proxy.certs!.expected('cam3')).toBeNull();
  });

  it("go stores the expected leaf and the camera's cert check accepts it (sim serving the target leaf)", async () => {
    const r = await done('move.go', goArgs());
    expect(r.status).toBe('ok');
    const rec = journal.load(MOVE)!;
    expect(rec).toMatchObject({ phase: 'switching', plan, targetPublicSpki: targetKey, expectedLeaf: targetLeaf.fingerprint });
    expect(Array.isArray(rec.manifest)).toBe(true);
    expect(rec.manifest!.every((c) => plan.kinds.includes(c.kind))).toBe(true);
    expect(p.proxy.certs!.expected('cam3')).toBe(targetLeaf.fingerprint);
    await until(() => moveEvents('move.phase').some((e) => e.moveId === MOVE && e.phase === 'switching'), 10_000);
    const sw = audits('move-switch')[0];
    expect(sw).toMatchObject({ cam_proxy: { moveId: MOVE, step: 'go', leafFingerprint: targetLeaf.fingerprint, publicKeyFingerprint: expect.stringMatching(/^SHA256:[0-9A-F]{64}$/) } });
    expect(JSON.stringify(sw)).not.toContain(targetKey);
    // The target pushes its leaf: the source's client goes on talking to the camera, no push of its own.
    const sim = sims[0];
    const before = sim.sim.engine.counters.setCalls.length;
    await pushTargetLeaf(sim);
    await until(async () => (await servedFingerprint('127.0.0.1', sim.ports.https)) === targetLeaf.fingerprint, 10_000);
    https.globalAgent.destroy();
    await p.proxy.certs!.checkExpected();
    expect(p.proxy.certs!.expectedTrust('cam3')).toEqual({ fingerprint: targetLeaf.fingerprint, pem: expect.stringContaining('BEGIN CERTIFICATE') });
    const w = p.proxy.cameras.get('cam3')!;
    await until(() => w.client.command('GetDevInfo').then(() => true, () => false), 20_000);
    await p.proxy.certs!.tick();
    expect(p.proxy.certs!.state('cam3').problem).toBeNull();
    expect(await servedFingerprint('127.0.0.1', sim.ports.https)).toBe(targetLeaf.fingerprint);
    expect(sim.sim.engine.counters.setCalls.length).toBe(before);
  }, 60_000);

  it('an unrelated cert is still unexpected: refused by the client, a problem, no push', async () => {
    const sim = sims[0];
    const w = p.proxy.cameras.get('cam3')!;
    sim.sim.engine.clearCertificate();
    await until(async () => ![null, targetLeaf.fingerprint].includes(await servedFingerprint('127.0.0.1', sim.ports.https)), 10_000);
    https.globalAgent.destroy();
    await p.proxy.certs!.checkExpected();
    expect(p.proxy.certs!.expectedTrust('cam3')).toBeNull();
    await expect(w.client.command('GetDevInfo')).rejects.toThrow(/TLS certificate check failed/);
    await p.proxy.certs!.tick();
    expect(p.proxy.certs!.state('cam3').problem).toMatch(/^cam3 serves an unexpected certificate \(SHA256:[0-9A-F]{64}\)/);
    expect(sim.sim.engine.certs.state.enable).toBe(0);
    // The target's leaf back: accepted again.
    await pushTargetLeaf(sim);
    await until(async () => (await servedFingerprint('127.0.0.1', sim.ports.https)) === targetLeaf.fingerprint, 10_000);
    https.globalAgent.destroy();
    await p.proxy.certs!.checkExpected();
    await until(() => w.client.command('GetDevInfo').then(() => true, () => false), 20_000);
  }, 60_000);

  it('go again (a new cmdId): the same state, the manifest not listed again', async () => {
    const before = journal.load(MOVE)!;
    expect((await done('move.go', goArgs())).status).toBe('ok');
    expect(journal.load(MOVE)).toEqual(before);
    expect(await done('move.go', { ...goArgs(), expectedLeaf: `SHA256:${'C'.repeat(64)}` })).toMatchObject({ status: 'failed', code: 'conflict' });
    expect(p.proxy.certs!.expected('cam3')).toBe(targetLeaf.fingerprint);
  });

  it('release hides the camera live and emits released', async () => {
    const r = await done('move.release', { v: 1, moveId: MOVE });
    expect(r.status).toBe('ok');
    await until(() => !p.proxy.cameras.get('cam3'), 10_000);
    expect(p.proxy.running.cameras.cam3.moved).toBe(MOVE);
    expect(p.proxy.loaded.config.cameras.cam3.moved).toBe(MOVE);
    expect(((await request(p.base).get('/api/cameras').set(auth())).body as { id: string }[]).map((c) => c.id)).not.toContain('cam3');
    const rec = journal.load(MOVE)!;
    expect(rec.phase).toBe('released');
    expect(rec.manifestRefreshedAt).toEqual(expect.any(Number));
    await until(() => moveEvents('move.phase').some((e) => e.moveId === MOVE && e.phase === 'released'), 10_000);
    const ev = fake.events().find((e) => bodyOf(e).kind === 'move.phase' && bodyOf(e).phase === 'released')!;
    expect(strict('event')(ev.msg), why(strict('event'))).toBe(true);
    expect(bodyOf(ev)).toMatchObject({ role: 'source', ok: true });
    expect(audits('move-phase').map((a) => a.cam_proxy.phase)).toEqual(expect.arrayContaining(['opened', 'switching', 'released']));
  }, 30_000);

  it('every handler is idempotent (same cmdId twice → duplicate; same moveId new cmdId → same state)', async () => {
    const rec = journal.load(MOVE)!;
    const first = await done('move.release', { v: 1, moveId: MOVE });
    expect(first.status).toBe('ok');
    expect(await done('move.release', { v: 1, moveId: MOVE }, first.cmdId)).toMatchObject({ status: 'ok', duplicate: true });
    expect((await done('move.go', goArgs())).status).toBe('ok');
    expect((await done('move.open', { v: 1, moveId: MOVE, requestId, camera: 'cam3', tokenHash: hashMoveToken(TOKEN), targetIp: '192.0.2.20' })).status).toBe('ok');
    expect(journal.load(MOVE)).toEqual(rec);
    expect(p.proxy.running.cameras.cam3.moved).toBe(MOVE);
    // A move this proxy doesn't have.
    expect(await done('move.release', { v: 1, moveId: 'mv_ZZZZZZZZZZZZZZZZZZZZ' })).toMatchObject({ status: 'failed', code: 'unknown_move' });
  });

  it('after a reconnect the current phase is sent again (B2)', async () => {
    const n = moveEvents('move.phase').filter((e) => e.moveId === MOVE && e.phase === 'released').length;
    fake.destroyAll();
    await until(() => moveEvents('move.phase').filter((e) => e.moveId === MOVE && e.phase === 'released').length > n, 15_000);
  }, 20_000);

  it('cancel emits move.cancel with the choice for copied content', async () => {
    expect((await request(p.base).post(`/control/moves/${MOVE}/cancel`).set(admin()).send({ copied: 'later' })).status).toBe(400);
    expect((await request(p.base).post(`/control/moves/${MOVE}/cancel`).set(admin()).send({ copied: 'age-out' })).status).toBe(202);
    await until(() => moveEvents('move.cancel').length === 1, 10_000);
    expect(moveEvents('move.cancel')[0]).toMatchObject({ moveId: MOVE, copied: 'age-out' });
  });

  it('no password, move token or public key in any event or audit record', () => {
    const text = JSON.stringify([...fake.events().map((e) => e.msg), ...p.proxy.audit.list({ limit: 500 }).records]);
    for (const s of [sims[0].password, TOKEN, targetKey, targetLeaf.keyPem]) expect(text).not.toContain(s);
  });
});

describe('approveProblem (the panel rules, S §7)', () => {
  const kind = (bytes: number) => ({ files: bytes ? 1 : 0, bytes, rows: 0, oldest: bytes ? 1 : null, newest: bytes ? 2 : null });
  const summary: MoveSummary = { stills: kind(100), clips: kind(200), events: kind(0), checks: kind(0), archive: kind(50) };
  const short: Space = { needed: 350, available: 250, fits: false, perKind: { stills: 100, clips: 200, archive: 50 }, retentionProposal: { 'stills.maxGB': 4, 'previews.maxGB': 2, 'storage.maxBytes': 5000 } };
  const base: MovePlan = { transfer: true, kinds: ['stills', 'clips', 'archive'], space: 'fit', targetSettings: null, budgetS: 100, estimateS: 100 };
  const answer = { accept: true, space: short, estimateS: 100 };
  it('a short space: omit must fit, retention takes the proposal (storage.maxBytes too), fit takes all', () => {
    expect(approveProblem(base, summary, answer)).toBeNull();
    expect(approveProblem({ ...base, space: 'all' }, summary, answer)).toBe('plan.space');
    expect(approveProblem({ ...base, space: 'omit' }, summary, answer)).toBe('plan.kinds');
    expect(approveProblem({ ...base, space: 'omit', kinds: ['clips', 'archive'] }, summary, answer)).toBeNull();
    expect(approveProblem({ ...base, space: 'retention', targetSettings: short.retentionProposal }, summary, answer)).toBeNull();
    expect(approveProblem({ ...base, space: 'retention', targetSettings: { 'storage.maxBytes': 6000 } }, summary, answer)).toBeNull();
    expect(approveProblem({ ...base, space: 'retention', targetSettings: { 'storage.maxBytes': 4000 } }, summary, answer)).toBe('plan.targetSettings');
    expect(approveProblem({ ...base, space: 'retention', targetSettings: { 'retention.clipsDays': 400 } }, summary, answer)).toBe('plan.targetSettings');
    expect(approveProblem({ ...base, space: 'retention', targetSettings: null }, summary, answer)).toBe('plan.targetSettings');
    expect(approveProblem({ ...base, space: 'retention', targetSettings: short.retentionProposal }, summary, { ...answer, space: { ...short, retentionProposal: null } })).toBe('plan.space');
  });
  it('the estimate is the answer\'s, the budget at least that; kinds only with content; no answer, no approval', () => {
    expect(approveProblem({ ...base, budgetS: 99 }, summary, answer)).toBe('plan.budgetS');
    expect(approveProblem({ ...base, estimateS: 50, budgetS: 50 }, summary, answer)).toBe('plan.estimateS');
    expect(approveProblem({ ...base, kinds: ['events'] }, summary, answer)).toBe('plan.kinds');
    expect(approveProblem(base, summary, undefined)).toBe('answer');
    expect(approveProblem(base, summary, { accept: false, reason: 'busy' })).toBe('answer');
    // Transfer no: nothing to fit, but no target settings either.
    expect(approveProblem({ ...base, transfer: false, kinds: [], space: 'all' }, summary, answer)).toBeNull();
    expect(approveProblem({ ...base, transfer: false, kinds: [], space: 'retention', targetSettings: { 'stills.maxGB': 4 } }, summary, answer)).toBe('plan.targetSettings');
  });
});
