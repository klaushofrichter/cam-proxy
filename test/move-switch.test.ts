// The target side of a camera move (camera-move plan Task 8, S §9.1, §9.3,
// §10.1, §12): move.start (the X25519 pair, the leaf), then the switch-over
// runner MoveTarget (secrets → camera → cert → ftp → switched → copying).
// Part 1 drives MoveTarget with injected steps and a real journal; part 2 runs
// two proxies over one cam-sim, a FakeAdmin acting for cams-admin on each.
// Documentation addresses (RFC 5737) and made-up tokens only.
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { createServer as createHttpsServer } from 'https';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cameraPasswordStore } from '../src/config/camera-passwords';
import { loadConfig, type Loaded } from '../src/config/load';
import type { MoveStartArgs } from '../src/fleet/command-args';
import { writeKeyFile } from '../src/fleet/keyfile';
import { writePrivateJson } from '../src/fleet/private-file';
import type { Envelope } from '../src/fleet/protocol';
import { setLogLevel } from '../src/log';
import { MoveJournal, type MoveRecord } from '../src/moves/journal';
import { seal } from '../src/moves/seal';
import { fetchSecrets, MoveTarget, type TargetDeps } from '../src/moves/target';
import { hashMoveToken } from '../src/moves/token';
import type { MoveEvent, MovePlan, MoveSummary } from '../src/moves/types';
import { fingerprintOf, siteCa, type SiteCa } from '../src/tls/ca';
import { issueLeaf, type Leaf } from '../src/tls/leaf';
import type { PushResult } from '../src/tls/push';
import { servedFingerprint } from '../src/tls/served';
import { strict, why } from './helpers/contract';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { freePort, until } from './helpers/proxy';

const MOVE = 'mv_0123456789ABCDEFGHJK';
const TOKEN = 'switch-token-'.padEnd(43, 'q');
const PASSWORD = 'moved-camera-pw';
const SECRETS = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'x' };
const kind = () => ({ files: 0, bytes: 0, rows: 0, oldest: null, newest: null });
const SUMMARY: MoveSummary = { stills: kind(), clips: kind(), events: kind(), checks: kind(), archive: kind() };
const PLAN: MovePlan = { transfer: true, kinds: [], space: 'all', targetSettings: null, budgetS: 3600, estimateS: 60 };
const startArgs = (over: Partial<MoveStartArgs> = {}): MoveStartArgs => ({ v: 1, moveId: MOVE, plan: PLAN, settings: { name: 'Garden', statusPollS: 30 }, done: [], ...over });
const STEPS = ['secrets', 'camera', 'cert', 'ftp'];

beforeAll(() => setLogLevel('silent'));

// ---- Part 1: MoveTarget with injected steps ----

let unitCa: SiteCa;
beforeAll(async () => {
  unitCa = await siteCa(mkdtempSync(join(tmpdir(), 'camproxy-switch-ca-')), { site: 'u', cameraSubnet: '192.0.2.0/24', proxyAddresses: ['198.51.100.1'] });
}, 60_000);

// What move.offer journals on accept (Task 6, B4).
const offered = (over: Partial<MoveRecord> = {}): MoveRecord => ({
  v: 1, id: MOVE, role: 'target', camera: 'cam9', phase: 'opened', plan: null,
  peer: { proxyId: 'prx_1123456789ABCDEFGHJK', name: 'een', url: 'http://198.51.100.7:8480', caFingerprints: [`SHA256:${'A'.repeat(64)}`], tlsServername: 'proxy.s.internal', ip: '198.51.100.7' },
  token: TOKEN,
  cameraConnection: { proxyCameraId: 'cam9', name: 'Garden', host: '192.0.2.9', protocol: 'https', user: 'proxy', onvifPort: 8000, rtspPort: 554, baichuanPort: 9000 },
  summary: SUMMARY, settings: { name: 'Garden', statusPollS: 30, storage: { sharePercent: 40 } },
  chunks: {}, bytesDone: 0, startedAt: 1, ...over,
});

interface Unit {
  target: MoveTarget;
  deps: TargetDeps;
  journal: MoveJournal;
  dir: string;
  calls: string[];
  events: MoveEvent[];
  audits: { action: string; outcome: string; message: string; details?: Record<string, any> }[];
  stored: Map<string, string>;
  staged: (Leaf | null)[];
  copies: string[];
  get loaded(): Loaded;
}

function unit(o: { config?: object; overrides?: object; env?: Record<string, string>; store?: boolean; secrets?: () => Promise<{ status: number; sealed?: string }>; step?: Partial<Record<'camera' | 'cert' | 'ftp', () => Promise<unknown>>>; dir?: string; attempts?: number } = {}): Unit {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'camproxy-switch-'));
  if (!o.dir) writeFileSync(join(dir, 'config.json'), JSON.stringify({ cameras: [{ id: 'cam1', host: '' }], tls: { site: 'u', cameraSubnet: '192.0.2.0/24', proxyAddresses: '198.51.100.1' }, ...(o.config ?? {}) }));
  if (o.overrides) {
    const file = loadConfig(o.env ?? SECRETS, { cwd: dir }).files.overrides;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(o.overrides));
  }
  let loaded = loadConfig(o.env ?? SECRETS, { cwd: dir });
  // The real password file (what the camera step's configuration load reads), else a map only.
  const real = o.store ? cameraPasswordStore(loaded.config.server.dataDir) : undefined;
  const journal = new MoveJournal(join(dir, 'admin', 'moves'));
  const calls: string[] = [];
  const events: MoveEvent[] = [];
  const audits: Unit['audits'] = [];
  const stored = new Map<string, string>();
  const staged: (Leaf | null)[] = [];
  const copies: string[] = [];
  const deps: TargetDeps = {
    journal,
    audit: { write: (r) => (audits.push(r as Unit['audits'][number]), null) },
    emit: (e) => events.push(e),
    ca: () => unitCa,
    site: () => 'u',
    loaded: () => loaded,
    setLoaded: async (l) => {
      calls.push('camera');
      await o.step?.camera?.();
      loaded = l;
    },
    passwords: { set: (id, pw) => (calls.push('secrets'), stored.set(id, pw), real?.set(id, pw)) },
    stageLeaf: (_cam, l) => void staged.push(l),
    pushLeaf: async (_cam, l): Promise<PushResult> => {
      calls.push('cert');
      await o.step?.cert?.();
      return { outcome: 'pushed', served: l.fingerprint, leaf: l, tookMs: 1 };
    },
    ftp: async () => {
      calls.push('ftp');
      await o.step?.ftp?.();
      return { verified: true, mismatch: [] };
    },
    startCopy: (id) => void copies.push(id),
    proxyId: () => 'prx_2123456789ABCDEFGHJK',
    fetchSecrets: o.secrets ?? (async () => {
      const r = journal.load(MOVE)!;
      return { status: 200, sealed: seal(r.x25519!.publicSpki, Buffer.from(PASSWORD)) };
    }),
    timing: { attempts: o.attempts ?? 3, retryMs: 5, retryCapMs: 20, notReadyMs: 5000 },
  };
  return { target: new MoveTarget(deps), deps, journal, dir, calls, events, audits, stored, staged, copies, get loaded() { return loaded; } };
}

const phases = (u: Unit) => u.events.filter((e) => e.kind === 'move.phase').map((e) => (e as { phase: string }).phase);
const allText = (u: Unit) => JSON.stringify([u.events, u.audits]);

describe('move.start (unit)', () => {
  it('start returns a public key and the leaf fingerprint; the private parts stay in the journal (mode 600)', async () => {
    const u = unit();
    u.journal.save(offered());
    const d = await u.target.start(startArgs());
    expect(d.status).toBe('ok');
    const v = strict('commands/move.start.result');
    expect(v(d.result), why(v)).toBe(true);
    const r = u.journal.load(MOVE)!;
    expect(r.x25519!.publicSpki).toBe(d.result!.publicKey);
    expect(r.leaf!.fingerprint).toBe(d.result!.leafFingerprint);
    expect(r.plan).toEqual(PLAN);
    expect(statSync(join(u.dir, 'admin', 'moves', `${MOVE}.json`)).mode & 0o777).toBe(0o600);
    // The leaf: <id>.<site>.internal and the camera's address, from this proxy's CA; staged for the cert step.
    expect(u.staged.at(-1)).toMatchObject({ fingerprint: r.leaf!.fingerprint, names: ['cam9.u.internal'], ips: ['192.0.2.9'] });
    await u.target.idle(MOVE);
    const text = allText(u);
    expect(text).not.toContain(r.x25519!.privatePkcs8);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(TOKEN);
    expect(u.audits.find((a) => a.details?.step === 'start')?.details).toMatchObject({ moveId: MOVE, role: 'target', outcome: 'ok', leafFingerprint: r.leaf!.fingerprint, publicKeyFingerprint: `SHA256:${createHash('sha256').update(Buffer.from(r.x25519!.publicSpki, 'base64')).digest('hex').toUpperCase()}` });
  }, 60_000);

  it('move.start resent with the same moveId does not issue a second key or leaf', async () => {
    const u = unit({ secrets: async () => ({ status: 409 }) });
    u.journal.save(offered());
    const [a, b] = await Promise.all([u.target.start(startArgs()), u.target.start(startArgs())]);
    const c = await u.target.start(startArgs());
    expect(a).toEqual(b);
    expect(c).toEqual(a);
    expect(new Set(u.staged.map((l) => l?.fingerprint)).size).toBe(1);
    // Another plan for the same move: a conflict, nothing changes.
    expect(await u.target.start(startArgs({ plan: { ...PLAN, budgetS: 7200 } }))).toMatchObject({ status: 'failed', code: 'conflict' });
    await u.target.stop(MOVE);
  }, 60_000);

  it('refusals: an unknown move, a source record, no site CA', async () => {
    const u = unit();
    expect(await u.target.start(startArgs())).toMatchObject({ status: 'failed', code: 'unknown_move' });
    u.journal.save(offered({ role: 'source' }));
    expect(await u.target.start(startArgs())).toMatchObject({ status: 'failed', code: 'unknown_move' });
    u.journal.save(offered());
    u.deps.ca = () => null;
    expect(await u.target.start(startArgs())).toMatchObject({ status: 'failed', code: 'no_site_ca' });
    expect(u.journal.load(MOVE)!.x25519).toBeUndefined();
  });

  it('keeps cams-admin’s done chunks (B34): up to 512, the newest', async () => {
    const u = unit({ secrets: async () => ({ status: 409 }) });
    u.journal.save(offered());
    const done = ['clips:2026-10-20', 'events:2026-10-19'];
    await u.target.start(startArgs({ done }));
    expect(u.journal.load(MOVE)!.done).toEqual(done);
    await u.target.stop(MOVE);
  }, 60_000);
});

describe('the switch-over runner (unit)', () => {
  it('runs secrets → camera → cert → ftp, then switched and copying at once (P12)', async () => {
    const u = unit();
    u.journal.save(offered());
    await u.target.start(startArgs());
    await u.target.idle(MOVE);
    expect(u.calls).toEqual(STEPS);
    expect(phases(u)).toEqual(['switching', 'switched', 'copying']);
    for (const e of u.events) expect(e).toMatchObject({ moveId: MOVE, role: 'target', ok: true });
    expect(u.journal.load(MOVE)).toMatchObject({ phase: 'copying' });
    expect(u.copies).toEqual([MOVE]);
    // One move-switch record per step, ok; a move-phase record per phase.
    expect(u.audits.filter((a) => a.action === 'move-switch').map((a) => [a.details!.step, a.details!.outcome])).toEqual([['start', 'ok'], ...STEPS.map((s) => [s, 'ok'])]);
    expect(u.audits.filter((a) => a.action === 'move-phase').map((a) => a.details!.phase)).toEqual(['switching', 'switched', 'copying']);
    for (const a of u.audits) expect(a.details).toMatchObject({ moveId: MOVE, camera: 'cam9', source: 'prx_1123456789ABCDEFGHJK', target: 'prx_2123456789ABCDEFGHJK' });
  }, 60_000);

  it('secrets: waits while the source answers 409 not_ready, then stores the unsealed password; never in an event or record', async () => {
    let n = 0;
    const u = unit({
      secrets: async () => {
        if (++n < 4) return { status: 409 };
        return { status: 200, sealed: seal(u.journal.load(MOVE)!.x25519!.publicSpki, Buffer.from(PASSWORD)) };
      },
      attempts: 1,
    });
    u.journal.save(offered());
    await u.target.start(startArgs());
    await u.target.idle(MOVE);
    expect(n).toBe(4);
    expect(u.stored.get('cam9')).toBe(PASSWORD);
    expect(phases(u)).toContain('switched');
    expect(allText(u)).not.toContain(PASSWORD);
  }, 60_000);

  it('camera: the connection fields and the settings of move.start in one override write, live', async () => {
    const u = unit();
    u.journal.save(offered());
    await u.target.start(startArgs({ settings: { name: 'Garden', statusPollS: 30, storage: { sharePercent: 40 } } }));
    await u.target.idle(MOVE);
    expect(u.loaded.config.cameras.cam9).toMatchObject({ name: 'Garden', host: '192.0.2.9', protocol: 'https', user: 'proxy', onvifPort: 8000, rtspPort: 554, baichuanPort: 9000, statusPollS: 30, storage: { sharePercent: 40 } });
    const file = JSON.parse(readFileSync(u.loaded.files.overrides, 'utf8'));
    // A value equal to the default is not stored (statusPollS 30).
    expect(file.cameras.cam9).toMatchObject({ name: 'Garden', host: '192.0.2.9', storage: { sharePercent: 40 } });
  }, 60_000);

  it('camera: a hidden moved leftover loses `moved` in the same write (B7), and retention target settings apply (storage.maxBytes)', async () => {
    // Hidden by an earlier move away (the source's release writes `moved` as an override).
    const u = unit({ config: { cameras: [{ id: 'cam1', host: '' }, { id: 'cam9', host: '192.0.2.99' }] }, overrides: { cameras: { cam9: { moved: 'mv_AAAAAAAAAAAAAAAAAAAA' } } } });
    expect(u.loaded.config.cameras.cam9.moved).toBe('mv_AAAAAAAAAAAAAAAAAAAA');
    const proposal = { 'storage.maxBytes': 50 * 1024 ** 3, 'stills.maxGB': 9, 'previews.maxGB': 3 };
    u.journal.save(offered({ space: { needed: 10, available: 5, fits: false, perKind: {}, retentionProposal: proposal } }));
    const plan: MovePlan = { ...PLAN, space: 'retention', targetSettings: proposal };
    await u.target.start(startArgs({ plan }));
    await u.target.idle(MOVE);
    const c = u.loaded.config;
    expect(c.cameras.cam9.moved).toBeUndefined();
    expect(c.cameras.cam9.host).toBe('192.0.2.9');
    expect(c.storage.maxBytes).toBe(50 * 1024 ** 3);
    expect(c.stills.maxGB).toBe(9);
    const file = JSON.parse(readFileSync(u.loaded.files.overrides, 'utf8'));
    expect(JSON.stringify(file)).not.toContain('moved');
    expect(file.storage.maxBytes).toBe(50 * 1024 ** 3);
  }, 60_000);

  it('a target restart during switch-over resumes at the failed step', async () => {
    let first = true;
    const a = unit({ step: { cert: () => (first ? new Promise((_r, rej) => setTimeout(() => rej(new Error('process stopped')), 30)) : Promise.resolve()) } });
    a.journal.save(offered());
    await a.target.start(startArgs());
    await until(() => a.calls.includes('cert'));
    // The process stops while the cert step runs.
    await a.target.stop(MOVE);
    expect(a.journal.load(MOVE)).toMatchObject({ phase: 'switching', step: 'cert' });
    first = false;
    // A new process on the same data: the step that did not finish runs again, the ones before it do not.
    const b = unit({ dir: a.dir });
    b.target.resume();
    await b.target.idle(MOVE);
    expect(b.calls).toEqual(['cert', 'ftp']);
    expect(b.journal.load(MOVE)!.phase).toBe('copying');
    expect(phases(b)).toEqual(['switched', 'copying']);
    expect(b.copies).toEqual([MOVE]);
    // The secrets and camera steps were done before the stop: not again.
    expect(b.stored.size).toBe(0);
  }, 60_000);

  it('a resumed copying move goes straight to the copier', async () => {
    const u = unit();
    u.journal.save(offered({ phase: 'copying', plan: PLAN }));
    u.target.resume();
    await u.target.idle(MOVE);
    expect(u.calls).toEqual([]);
    expect(u.copies).toEqual([MOVE]);
  });

  it('a step that gives up after its retries: move.phase failed with a code, the journal failed (B46)', async () => {
    const u = unit({ step: { cert: () => Promise.reject(new Error('import refused')) } });
    u.journal.save(offered());
    await u.target.start(startArgs());
    await u.target.idle(MOVE);
    expect(u.calls.filter((c) => c === 'cert')).toHaveLength(3);
    expect(u.calls).not.toContain('ftp');
    const failed = u.events.filter((e) => e.kind === 'move.phase' && e.phase === 'failed');
    expect(failed).toEqual([{ kind: 'move.phase', moveId: MOVE, role: 'target', phase: 'failed', ok: false, code: 'cert_failed' }]);
    expect(u.journal.load(MOVE)).toMatchObject({ phase: 'failed', failure: 'cert_failed', step: 'cert' });
    expect(u.audits.find((a) => a.action === 'move-switch' && a.details!.step === 'cert')).toMatchObject({ outcome: 'failure', details: { outcome: 'failed' } });
    expect(u.audits.find((a) => a.action === 'move-phase' && a.details!.phase === 'failed')).toMatchObject({ outcome: 'failure', details: { code: 'cert_failed' } });
    // Not resumed: failed is final.
    const again = new MoveTarget(u.deps);
    again.resume();
    await again.idle(MOVE);
    expect(u.calls.filter((c) => c === 'cert')).toHaveLength(3);
  }, 60_000);

  it('a camera that never verifies its FTP gives up with ftp_failed; secrets that never open with secrets_failed', async () => {
    const f = unit();
    f.deps.ftp = async () => ({ verified: false, mismatch: ['server'] });
    f.journal.save(offered());
    await f.target.start(startArgs());
    await f.target.idle(MOVE);
    expect(f.journal.load(MOVE)).toMatchObject({ phase: 'failed', failure: 'ftp_failed' });
    const s = unit({ secrets: async () => ({ status: 200, sealed: 'v1.not.a.blob' }) });
    s.journal.save(offered());
    await s.target.start(startArgs());
    await s.target.idle(MOVE);
    expect(s.journal.load(MOVE)).toMatchObject({ phase: 'failed', failure: 'secrets_failed' });
    expect(s.stored.size).toBe(0);
  }, 60_000);

  it('stop(moveId) ends the runner without a phase change (Task 10 cancel)', async () => {
    const u = unit({ secrets: async () => ({ status: 409 }) });
    u.journal.save(offered());
    await u.target.start(startArgs());
    await until(() => u.journal.load(MOVE)!.phase === 'switching');
    await u.target.stop(MOVE);
    expect(u.journal.load(MOVE)).toMatchObject({ phase: 'switching', step: 'secrets' });
    expect(phases(u)).toEqual(['switching']);
  }, 60_000);
});

describe('fix round 1', () => {
  const PROPOSAL = { 'storage.maxBytes': 50 * 1024 ** 3, 'ftp.maxGB': 12 };
  const shortSpace = { needed: 10, available: 5, fits: false, perKind: {}, retentionProposal: PROPOSAL };
  const retention = (targetSettings: Record<string, number | string | boolean>): MovePlan => ({ ...PLAN, space: 'retention', targetSettings });

  it('move.start refuses target settings outside the stored proposal: nothing written, no runner', async () => {
    const forged: Record<string, number | string | boolean>[] = [{ 'camsAdmin.url': 'https://203.0.113.9' }, { 'cameras.cam1.host': '192.0.2.66' }, { 'storage.maxBytes': PROPOSAL['storage.maxBytes'] + 1 }, { 'ftp.maxGB': '12' }, { 'stills.maxGB': 3 }];
    for (const ts of forged) {
      const u = unit();
      u.journal.save(offered({ space: shortSpace }));
      expect(await u.target.start(startArgs({ plan: retention(ts) })), JSON.stringify(ts)).toMatchObject({ status: 'failed', code: 'invalid_args' });
      await u.target.idle(MOVE);
      const r = u.journal.load(MOVE)!;
      expect(r.x25519).toBeUndefined();
      expect(r.leaf).toBeUndefined();
      expect(r.plan).toBeNull();
      expect(u.calls).toEqual([]);
      expect(u.events).toEqual([]);
    }
    // Without a stored proposal no target settings at all.
    const n = unit();
    n.journal.save(offered());
    expect(await n.target.start(startArgs({ plan: retention({ 'ftp.maxGB': 12 }) }))).toMatchObject({ status: 'failed', code: 'invalid_args' });
  }, 60_000);

  it('move.start takes the proposal itself', async () => {
    const u = unit();
    u.journal.save(offered({ space: shortSpace }));
    expect((await u.target.start(startArgs({ plan: retention(PROPOSAL) }))).status).toBe('ok');
    await u.target.idle(MOVE);
    expect(u.loaded.config.ftp.maxGB).toBe(12);
    expect(u.loaded.config.storage.maxBytes).toBe(PROPOSAL['storage.maxBytes']);
  }, 60_000);

  it('cert: an open camera event is waited for without using up attempts', async () => {
    const u = unit({ attempts: 2 });
    let open = true;
    u.deps.eventOpen = () => open;
    u.journal.save(offered());
    await u.target.start(startArgs());
    // Longer than 2 attempts with their backoff (5 ms, 20 ms cap).
    await new Promise((r) => setTimeout(r, 300));
    expect(u.journal.load(MOVE)).toMatchObject({ phase: 'switching', step: 'cert' });
    open = false;
    await u.target.idle(MOVE);
    expect(u.journal.load(MOVE)!.phase).toBe('copying');
    expect(u.calls.filter((c) => c === 'cert')).toHaveLength(1);
  }, 60_000);

  it('cert: an event open beyond the wait gives up with cert_failed', async () => {
    const u = unit();
    u.deps.eventOpen = () => true;
    u.deps.timing = { ...u.deps.timing, eventWaitMs: 100 };
    u.journal.save(offered());
    await u.target.start(startArgs());
    await u.target.idle(MOVE);
    expect(u.journal.load(MOVE)).toMatchObject({ phase: 'failed', failure: 'cert_failed' });
  }, 60_000);

  it('camera: a camera with the same id added here since the offer is refused (id_taken), nothing written', async () => {
    const u = unit();
    u.journal.save(offered());
    // The local admin adds cam9 after the offer.
    const before = JSON.stringify(u.loaded.overrides);
    u.deps.loaded = () => ({ ...u.loaded, config: { ...u.loaded.config, cameras: { ...u.loaded.config.cameras, cam9: { ...u.loaded.config.cameras.cam1, host: '192.0.2.77' } } } });
    // The local camera's own stored password (final review 7).
    u.stored.set('cam9', 'local-camera-pw');
    const deleted: string[] = [];
    u.deps.end = { dataDir: u.dir, removeImported: () => ({ deleted: {} as never }), deletePassword: (c) => void deleted.push(c), forgetLeaf: () => undefined };
    await u.target.start(startArgs());
    await u.target.idle(MOVE);
    // Refused in the secrets step, before the password is stored (final review 7).
    expect(u.calls).toEqual([]);
    expect(u.stored.get('cam9')).toBe('local-camera-pw');
    expect(u.journal.load(MOVE)).toMatchObject({ phase: 'failed', failure: 'camera_failed' });
    expect(u.journal.load(MOVE)!.passwordWritten).toBeUndefined();
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'target', phase: 'failed', ok: false, code: 'camera_failed', detail: 'id_taken' });
    expect(JSON.stringify(u.loaded.overrides)).toBe(before);
    // The cancel deletes only a password the move wrote: none here.
    expect((await u.target.cancel({ v: 1, moveId: MOVE, role: 'target', copied: 'age-out' } as never)).status).toBe('ok');
    expect(deleted).toEqual([]);
  }, 60_000);

  it('cancel deletes the password the secrets step wrote (passwordWritten, final review 7)', async () => {
    const u = unit();
    // The secrets step stored the password, then the camera step failed before its write.
    u.journal.save(offered({ phase: 'failed', failure: 'camera_failed', plan: PLAN, passwordWritten: true }));
    const deleted: string[] = [];
    u.deps.end = { dataDir: u.dir, removeImported: () => ({ deleted: {} as never }), deletePassword: (c) => void deleted.push(c), forgetLeaf: () => undefined };
    expect((await u.target.cancel({ v: 1, moveId: MOVE, role: 'target', copied: 'age-out' } as never)).status).toBe('ok');
    expect(deleted).toEqual(['cam9']);
  });

  describe('a hidden leftover of the same id (final review 2)', () => {
    const LEFT = 'mv_AAAAAAAAAAAAAAAAAAAA';
    const leftover = (extra: object) => ({ config: { cameras: [{ id: 'cam1', host: '' }, { id: 'cam9', host: '192.0.2.9', ...extra }] }, overrides: { cameras: { cam9: { moved: LEFT } } } });

    it('no stale field survives: every Settings field set from the move, the rest defaulted', async () => {
      const u = unit(leftover({ name: 'Old', statusPollS: 60, webUiUrl: 'https://192.0.2.50/', ftp: { user: 'oldftp', enabled: false, stream: 'main' }, stills: { intervalS: 10, enabled: false }, analytics: { kinds: { vehicle: true } }, events: { poll: { enabled: false } } }));
      u.journal.save(offered());
      await u.target.start(startArgs({ settings: { name: 'Garden', statusPollS: 30, storage: { sharePercent: 40 } } }));
      await u.target.idle(MOVE);
      expect(u.journal.load(MOVE)!.phase).toBe('copying');
      const c = u.loaded.config;
      const cam = c.cameras.cam9;
      expect(cam.moved).toBeUndefined();
      expect(cam).toMatchObject({ name: 'Garden', statusPollS: 30, storage: { sharePercent: 40 } });
      expect(cam.webUiUrl === undefined || cam.webUiUrl === 'https://192.0.2.9/').toBe(true);
      expect(cam.ftp.user === undefined || cam.ftp.user === 'cam9').toBe(true);
      // Absent in the move: the host value, not the leftover's.
      expect(cam.ftp.enabled ?? c.ftp.enabled).toBe(c.ftp.enabled);
      expect(cam.ftp.stream ?? c.ftp.stream).toBe(c.ftp.stream);
      expect(cam.stills.intervalS ?? c.stills.intervalS).toBe(c.stills.intervalS);
      expect(cam.stills.enabled ?? c.stills.enabled).toBe(c.stills.enabled);
      expect(cam.analytics.kinds.vehicle ?? c.analytics.kinds.vehicle).toBe(c.analytics.kinds.vehicle);
      expect(cam.events.poll.enabled ?? c.events.poll.enabled).toBe(c.events.poll.enabled);
    }, 60_000);

    for (const [what, extra, env] of [
      ['a tlsName', { tlsName: 'cam9.example.org' }, {}],
      ['a PoE switch port', { poeSwitch: { port: 3 } }, {}],
      ['a per-camera env password', {}, { CAMPROXY_CAMERA_PASSWORD_CAM9: 'env-pw' }],
    ] as const) {
      it(`refused (camera_failed, stale_leftover) when the leftover has ${what}; no password stored`, async () => {
        const u = unit(leftover(extra));
        if (Object.keys(env).length) {
          const l = loadConfig({ ...SECRETS, ...env }, { cwd: u.dir });
          u.deps.loaded = () => l;
        }
        u.journal.save(offered());
        await u.target.start(startArgs());
        await u.target.idle(MOVE);
        expect(u.calls).toEqual([]);
        expect(u.stored.has('cam9')).toBe(false);
        expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'target', phase: 'failed', ok: false, code: 'camera_failed', detail: 'stale_leftover' });
      }, 60_000);
    }
  });

  it('no shared camera password on the target: the secrets step stores the moved password, the camera step loads it', async () => {
    // Only cam1's own password, no CAMPROXY_CAMERA_PASSWORD: cam9's comes with the move.
    const env = { CAMPROXY_TOKENS: SECRETS.CAMPROXY_TOKENS, CAMPROXY_ADMIN_TOKEN: SECRETS.CAMPROXY_ADMIN_TOKEN, CAMPROXY_CAMERA_PASSWORD_CAM1: 'own' };
    const u = unit({ env, store: true });
    u.journal.save(offered());
    await u.target.start(startArgs());
    await u.target.idle(MOVE);
    expect(u.calls).toEqual(STEPS);
    expect(phases(u)).toEqual(['switching', 'switched', 'copying']);
    expect(u.loaded.secrets.cameraPasswords).toEqual({ cam1: 'own', cam9: PASSWORD });
    expect(u.loaded.config.cameras.cam9).toMatchObject({ host: '192.0.2.9' });
  }, 60_000);

  it('camera: a resumed camera step after its own write is not id_taken', async () => {
    const a = unit({ step: { camera: () => Promise.reject(new Error('process stopped')) } });
    a.journal.save(offered());
    await a.target.start(startArgs());
    await until(() => a.calls.includes('camera'));
    await a.target.stop(MOVE);
    // The overrides were written before the stop; a new process loads them.
    const b = unit({ dir: a.dir });
    expect(b.loaded.config.cameras.cam9).toBeDefined();
    b.target.resume();
    await b.target.idle(MOVE);
    expect(b.journal.load(MOVE)!.phase).toBe('copying');
  }, 60_000);

  it('an unexpected throw in the runner ends the move failed (internal), with an event', async () => {
    const u = unit();
    u.journal.save(offered());
    const save = u.journal.save.bind(u.journal);
    let thrown = false;
    u.deps.journal = { load: (id) => u.journal.load(id), active: () => u.journal.active(), save: (r) => {
      if (!thrown && r.step === 'cert') { thrown = true; throw new Error('ENOSPC'); }
      save(r);
    } };
    const t = new MoveTarget(u.deps);
    await t.start(startArgs());
    await t.idle(MOVE);
    expect(u.events.at(-1)).toEqual({ kind: 'move.phase', moveId: MOVE, role: 'target', phase: 'failed', ok: false, code: 'internal' });
    expect(u.journal.load(MOVE)).toMatchObject({ phase: 'failed', failure: 'internal' });
  }, 60_000);

  it("move.start's settings win over the offer's and are kept in the record", async () => {
    const u = unit();
    u.journal.save(offered());
    await u.target.start(startArgs({ settings: { name: 'Porch', statusPollS: 15 } }));
    await u.target.idle(MOVE);
    expect(u.journal.load(MOVE)!.settings).toEqual({ name: 'Porch', statusPollS: 15 });
    expect(u.loaded.config.cameras.cam9).toMatchObject({ name: 'Porch', statusPollS: 15 });
    expect(u.loaded.config.cameras.cam9.storage.sharePercent).toBeUndefined();
  }, 60_000);
});

describe('the secrets fetch', () => {
  it('https: pinned to the offered CA like the probe; another CA gets no token', async () => {
    const leaf = await issueLeaf(unitCa, { cn: 'proxy.u.internal', dns: ['proxy.u.internal'], ips: ['198.51.100.1'], unconstrained: true });
    const seen: string[] = [];
    const server = createHttpsServer({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
      if (req.url === '/tls/ca.pem') return void res.end(unitCa.certPem);
      seen.push(`${req.url} ${req.headers.authorization}`);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ sealed: 'v1.sealed' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const src = { proxyId: 'prx_1123456789ABCDEFGHJK', name: 'een', url: `https://127.0.0.1:${(server.address() as { port: number }).port}`, caFingerprints: [unitCa.fingerprint], tlsServername: 'proxy.u.internal' };
      expect(await fetchSecrets(src, MOVE, TOKEN)).toEqual({ status: 200, sealed: 'v1.sealed' });
      expect(seen).toEqual([`/api/moves/${MOVE}/secrets Bearer ${TOKEN}`]);
      seen.length = 0;
      await expect(fetchSecrets({ ...src, caFingerprints: [`SHA256:${'B'.repeat(64)}`] }, MOVE, TOKEN)).rejects.toThrow('pinned');
      await expect(fetchSecrets({ ...src, tlsServername: 'other.u.internal' }, MOVE, TOKEN)).rejects.toThrow();
      expect(seen).toEqual([]);
    } finally {
      server.close();
    }
  }, 60_000);
});

// ---- Part 2: two proxies over one cam-sim ----

const bodyOf = (r: { msg: Envelope }) => r.msg.body as Record<string, any>;
const TLS = (site: string) => ({ site, cameraSubnet: '127.0.0.0/16', proxyAddresses: '127.0.0.1' });
const FTP_PASSWORD = 'ftp-secret-'.padEnd(24, 'z');

let sims: Sim[];
let fakeS: FakeAdmin;
let fakeT: FakeAdmin;
let S: Awaited<ReturnType<typeof startMultiProxy>>;
let T: Awaited<ReturnType<typeof startMultiProxy>>;
let sourceId = '';
let targetId = '';
let ftpPort = 0;

const done = async (fake: FakeAdmin, command: string, args: Record<string, unknown>, cmdId?: string) => {
  const sent = fake.sendCommand(command, args, { actor: 'admin@example.org', ...(cmdId ? { cmdId } : {}) });
  const n = cmdId ? fake.results(sent.cmdId).length : 0;
  await until(() => fake.results(sent.cmdId).length > n && fake.results(sent.cmdId).some((r) => ['done', 'refused', 'duplicate'].includes(bodyOf(r).phase)), 30_000);
  return bodyOf(fake.results(sent.cmdId).at(-1)!) as Record<string, any>;
};
const phaseEvents = (fake: FakeAdmin) => fake.events().map(bodyOf).filter((b) => b.kind === 'move.phase');
const tAudits = (action: string) => T.proxy.audit.list({ actions: [action], limit: 50 }).records as Record<string, any>[];

describe('two proxies, one camera (integration)', () => {
  let started: Record<string, any>;
  beforeAll(async () => {
    sims = await startSims(1);
    [fakeS, fakeT] = await Promise.all([startFakeAdmin(), startFakeAdmin()]);
    fakeS.welcomeHeartbeatS = 1;
    fakeT.welcomeHeartbeatS = 1;
    const timing = { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200 } }, tlsPush: { clearWaitMs: 50, verifyMs: 5000, pollMs: 100 } };
    // The source: cam3 on the sim, its site-CA leaf pushed.
    const sdir = mkdtempSync(join(tmpdir(), 'camproxy-switch-src-'));
    const sk = fakeS.keyFile();
    sourceId = sk.proxyId;
    writeKeyFile(join(sdir, 'data', 'admin', 'key.json'), sk);
    writePrivateJson(join(sdir, 'data', 'admin', 'policy.json'), { v: 1, allow: ['move.send'], consent: 3, changedAt: 1, changedBy: 'local' });
    S = await startMultiProxy(sims, { dir: sdir, https: true, proxy: timing, settings: { tls: TLS('s'), camsAdmin: { url: fakeS.url } } });
    // The target: only an idle camera of its own; a camera password that is not the sim's (the moved one must come from the source).
    const tdir = mkdtempSync(join(tmpdir(), 'camproxy-switch-tgt-'));
    const tk = fakeT.keyFile();
    targetId = tk.proxyId;
    writeKeyFile(join(tdir, 'data', 'admin', 'key.json'), tk);
    writePrivateJson(join(tdir, 'data', 'admin', 'policy.json'), { v: 1, allow: ['move.receive'], consent: 3, changedAt: 1, changedBy: 'local' });
    ftpPort = await freePort();
    const passive = await freePort();
    T = await startMultiProxy([], {
      dir: tdir, extra: [{ id: 'cam1', host: '' }], env: { CAMPROXY_CAMERA_PASSWORD: 'not-the-camera-pw', CAMPROXY_FTP_PASSWORD: FTP_PASSWORD },
      proxy: { ...timing, moves: { retryMs: 200, retryCapMs: 1000 } },
      settings: { tls: TLS('u'), camsAdmin: { url: fakeT.url }, ftp: { enabled: true, port: ftpPort, passive: `${passive}-${passive + 19}`, publicHost: '127.0.0.1', tls: true, stream: 'sub' } },
    });
    await until(() => fakeS.open() === 1 && fakeT.open() === 1 && S.proxy.cameras.get('cam3')!.status.state().online, 30_000);
    await S.proxy.certs!.tick();
    expect(S.proxy.certs!.state('cam3').mode).toBe('site-ca');
  }, 180_000);
  afterAll(async () => {
    await Promise.all([S?.proxy.stop(), T?.proxy.stop()]);
    await Promise.all([fakeS?.close(), fakeT?.close()]);
    await Promise.all((sims ?? []).map((s) => s.close()));
  });

  it('move.offer is accepted and audited on the target (move-offer)', async () => {
    const caPem = (await request(S.base).get('/tls/ca.pem').expect(200)).text;
    // The source's side as open/answer/approve leave it (Task 7).
    const sj = new MoveJournal(join(S.dir, 'data', 'admin', 'moves'));
    const node = S.proxy.running.cameras.cam3;
    const connection = { proxyCameraId: 'cam3', name: node.name, host: node.host, protocol: node.protocol, user: node.user, onvifPort: node.onvifPort, rtspPort: node.rtspPort, baichuanPort: node.baichuanPort };
    sj.save({ v: 1, id: MOVE, role: 'source', camera: 'cam3', phase: 'opened', plan: PLAN, approvedAt: 1, budgetS: PLAN.budgetS, peer: { proxyId: targetId, name: 'Mini PC', ip: '127.0.0.1' }, tokenHash: hashMoveToken(TOKEN), requestId: 'rq_0123456789ABCDEFGHJK', answer: { accept: true }, summary: SUMMARY, settings: { name: 'cam3', statusPollS: 5 }, cameraConnection: connection, chunks: {}, bytesDone: 0, startedAt: 1 });
    const offer = { v: 1, moveId: MOVE, token: TOKEN, source: { proxyId: sourceId, name: 'Source', url: S.base, caFingerprints: [fingerprintOf(caPem)], tlsServername: 'proxy.s.internal' }, camera: { camsId: 'garden-cam', ...connection }, summary: SUMMARY, settings: { name: 'cam3', statusPollS: 5 } };
    const r = await done(fakeT, 'move.offer', offer);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'ok', result: { accept: true } });
    const a = tAudits('move-offer')[0];
    expect(a).toMatchObject({ event: { outcome: 'success' }, cam_proxy: { moveId: MOVE, camera: 'cam3', source: sourceId, target: targetId, accept: true } });
    expect(JSON.stringify(a)).not.toContain(TOKEN);
  }, 60_000);

  it('start returns a public key and the leaf fingerprint', async () => {
    started = await done(fakeT, 'move.start', { ...startArgs(), settings: { name: 'cam3', statusPollS: 5 } });
    expect(started.status).toBe('ok');
    const v = strict('commands/move.start.result');
    expect(v(started.result), why(v)).toBe(true);
  }, 60_000);

  it('move.start resent with the same moveId does not issue a second key or leaf', async () => {
    const again = await done(fakeT, 'move.start', { ...startArgs(), settings: { name: 'cam3', statusPollS: 5 } });
    expect(again.result).toEqual(started.result);
    // The same command id twice: a duplicate, not a second run.
    const id = 'cmd_0123456789ABCDEFGHJK';
    await done(fakeT, 'move.start', { ...startArgs(), settings: { name: 'cam3', statusPollS: 5 } }, id);
    const dup = await done(fakeT, 'move.start', { ...startArgs(), settings: { name: 'cam3', statusPollS: 5 } }, id);
    expect(dup.phase === 'duplicate' || dup.result?.publicKey === started.result.publicKey).toBe(true);
  }, 60_000);

  it('switch-over adds the camera live with the source\'s settings and password', async () => {
    // cams-admin passes the key and the leaf to the source (move.go); the target's secrets step then gets its answer.
    const go = await done(fakeS, 'move.go', { v: 1, moveId: MOVE, plan: PLAN, targetPublicKey: started.result.publicKey, expectedLeaf: started.result.leafFingerprint });
    expect(go.status).toBe('ok');
    await until(() => phaseEvents(fakeT).some((e) => e.phase === 'switched'), 120_000);
    expect(T.proxy.loaded.config.cameras.cam3).toMatchObject({ name: 'cam3', host: S.proxy.running.cameras.cam3.host, protocol: 'https', statusPollS: 5 });
    expect(cameraPasswordStore(join(T.dir, 'data')).get('cam3')).toBe(sims[0].password);
    // It logs in with that password (the target's default is wrong for this camera).
    await until(() => T.proxy.cameras.get('cam3')?.status.state().online === true, 30_000);
  }, 180_000);

  it('camera serves the target\'s leaf after the cert step', async () => {
    expect(await servedFingerprint('127.0.0.1', sims[0].ports.https)).toBe(started.result.leafFingerprint);
    expect(T.proxy.certs!.state('cam3')).toMatchObject({ mode: 'site-ca', servername: 'cam3.u.internal', fingerprint: started.result.leafFingerprint });
    // The source's guard takes it as the expected leaf (P8): not unexpected.
    await S.proxy.certs!.tick();
    expect(S.proxy.certs!.state('cam3').problem).toBeNull();
  }, 60_000);

  it('camera FTP points at the target', () => {
    expect(sims[0].sim.engine.settings.running.Ftp).toMatchObject({ enable: 1, server: '127.0.0.1', port: ftpPort, userName: 'cam3' });
  });

  it('stills of the target start before the source is released (no gap)', async () => {
    // At switched the source still runs the camera: it is released only after (move.release).
    const sj = new MoveJournal(join(S.dir, 'data', 'admin', 'moves'));
    expect(sj.load(MOVE)!.phase).toBe('switching');
    expect(S.proxy.cameras.get('cam3')).toBeDefined();
    expect(T.proxy.cameras.get('cam3')!.status.state().online).toBe(true);
    if (process.env.CAMPROXY_TEST_GO2RTC) await until(() => T.proxy.cameras.get('cam3')!.stills?.grabber.up() === true, 30_000);
    // And it goes on to copying at once (P12).
    await until(() => phaseEvents(fakeT).some((e) => e.phase === 'copying'), 10_000);
    const order = phaseEvents(fakeT).filter((e) => e.moveId === MOVE).map((e) => e.phase);
    expect(order.slice(0, 3)).toEqual(['switching', 'switched', 'copying']);
    for (const e of fakeT.events().filter((x) => bodyOf(x).kind === 'move.phase')) expect(strict('event')(e.msg), why(strict('event'))).toBe(true);
  }, 60_000);

  it('audits each step on the target and never a secret', async () => {
    const steps = tAudits('move-switch').map((r) => [r.cam_proxy.step, r.cam_proxy.outcome]).reverse();
    expect(steps).toEqual([['start', 'ok'], ...STEPS.map((s) => [s, 'ok'])]);
    const tj = new MoveJournal(join(T.dir, 'data', 'admin', 'moves')).load(MOVE)!;
    const files = readdirSync(join(T.dir, 'data', 'audit')).map((f) => readFileSync(join(T.dir, 'data', 'audit', f), 'utf8')).join('\n');
    const events = JSON.stringify([...fakeT.events(), ...fakeT.results()].map((r) => r.msg));
    for (const secret of [sims[0].password, TOKEN, tj.x25519!.privatePkcs8, 'PRIVATE KEY', FTP_PASSWORD]) {
      expect(files).not.toContain(secret);
      expect(events).not.toContain(secret);
    }
  });
});
