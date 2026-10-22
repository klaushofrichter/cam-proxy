// The target's evaluation of a move offer (camera-move plan Task 6, S §6, §7,
// Review Focus 4). Documentation addresses (RFC 5737) and made-up tokens only.
import express from 'express';
import { createServer as createHttpsServer } from 'https';
import { createServer, type Server } from 'net';
import { mkdtempSync, statSync, writeFileSync } from 'fs';
import type { Server as HttpServer } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { movesSourceApi } from '../src/api/moves-api';
import { AuditLog } from '../src/audit/audit-log';
import { openCatalog } from '../src/catalog/db';
import { loadConfig } from '../src/config/load';
import type { MoveOfferArgs } from '../src/fleet/command-args';
import { setLogLevel } from '../src/log';
import { evaluate, probeSource, spaceFor, tcpConnect, type EvaluateDeps } from '../src/moves/evaluate';
import { moveHandlers } from '../src/moves/commands';
import { MoveJournal, type MoveRecord } from '../src/moves/journal';
import { hashMoveToken } from '../src/moves/token';
import { siteCa, type SiteCa } from '../src/tls/ca';
import { issueLeaf } from '../src/tls/leaf';

const MOVE = 'mv_0123456789ABCDEFGHJK';
const TOKEN = 'offer-token-'.padEnd(43, 'q');
const GB = 1024 ** 3;
const SECRETS = { CAMPROXY_TOKENS: 'a'.repeat(32), CAMPROXY_ADMIN_TOKEN: 'c'.repeat(32), CAMPROXY_CAMERA_PASSWORD: 'x' };
const SITE = { site: 'garage', cameraSubnet: '192.0.2.0/24', proxyAddresses: '198.51.100.1' };
beforeAll(() => setLogLevel('silent'));

const kind = (bytes = 0) => ({ files: bytes ? 1 : 0, bytes, rows: 0, oldest: bytes ? 1 : null, newest: bytes ? 2 : null });
const summary = (b: Partial<Record<'stills' | 'clips' | 'events' | 'checks' | 'archive', number>> = {}): MoveOfferArgs['summary'] => ({ stills: kind(b.stills), clips: kind(b.clips), events: kind(b.events), checks: kind(b.checks), archive: kind(b.archive) });
const offer = (over: Partial<MoveOfferArgs> = {}): MoveOfferArgs => ({
  v: 1, moveId: MOVE, token: TOKEN,
  source: { proxyId: 'prx_1123456789ABCDEFGHJK', name: 'een', url: 'http://198.51.100.7:8480', caFingerprints: [`SHA256:${'A'.repeat(64)}`], tlsServername: 'proxy.garage.internal' },
  camera: { camsId: 'cam_0123456789ABCDEFGHJK', proxyCameraId: 'cam9', name: 'Garden', host: '192.0.2.9', protocol: 'https', user: 'proxy', onvifPort: 8000, rtspPort: 554, baichuanPort: 9000 },
  summary: summary({ clips: 1000 }), settings: { statusPollS: 30 }, ...over,
});

const fakeCa: SiteCa = { certPem: '', keyPem: '', fingerprint: '', notAfter: 0, covers: (ip) => ip.startsWith('192.0.2.'), coversName: (n) => n.endsWith('.garage.internal') };

function fixture(o: { config?: object; allowed?: boolean; ca?: SiteCa | null; free?: number; usage?: { stills: number; previews: number; clips: number; used?: number; budget?: number }; connect?: boolean; probe?: number; journal?: Pick<MoveJournal, 'active' | 'save'> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-offer-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ cameras: [{ id: 'cam3', host: '192.0.2.3' }], tls: SITE, storage: { minFreeBytes: 1 * GB }, ...(o.config ?? {}) }));
  const loaded = loadConfig(SECRETS, { cwd: dir });
  const journal = new MoveJournal(join(dir, 'admin', 'moves'));
  const connects: [string, number][] = [];
  const deps: EvaluateDeps = {
    receiveAllowed: () => o.allowed ?? true,
    journal: o.journal ?? journal,
    loaded: () => loaded,
    ca: () => (o.ca === undefined ? fakeCa : o.ca),
    usage: () => ({ used: 0, budget: 1000 * GB, ...(o.usage ?? { stills: 0, previews: 0, clips: 0 }) }),
    freeBytes: () => o.free ?? 100 * GB,
    now: () => 5000,
    connect: async (h, p) => (connects.push([h, p]), o.connect ?? true),
    resolve: async (h) => (h === '198.51.100.7' ? h : '203.0.113.5'),
    probe: async () => o.probe ?? 123456,
  };
  return { deps, journal, dir, connects, loaded };
}

describe('refusals, in the plan order', () => {
  it('moves_not_allowed without move.receive', async () => {
    expect(await evaluate(fixture({ allowed: false }).deps, offer())).toEqual({ accept: false, reason: 'moves_not_allowed' });
  });
  it('a busy target answers busy', async () => {
    const f = fixture();
    f.journal.save({ v: 1, id: 'mv_other', role: 'source', camera: 'cam3', phase: 'copying', plan: null, peer: { proxyId: 'p', name: 'n' }, chunks: {}, bytesDone: 0, startedAt: 1 });
    expect(await evaluate(f.deps, offer())).toEqual({ accept: false, reason: 'busy' });
  });
  it('an unreadable journal answers busy', async () => {
    const journal = { active: () => { throw new Error('EACCES'); }, save: () => undefined };
    expect(await evaluate(fixture({ journal }).deps, offer())).toEqual({ accept: false, reason: 'busy' });
  });
  it('no_site_ca without tls.site (the Pi) or without a loaded CA', async () => {
    expect(await evaluate(fixture({ config: { tls: undefined } }).deps, offer())).toEqual({ accept: false, reason: 'no_site_ca' });
    expect(await evaluate(fixture({ ca: null }).deps, offer())).toEqual({ accept: false, reason: 'no_site_ca' });
  });
  it('id_taken when the camera id is configured', async () => {
    const o = offer();
    o.camera.proxyCameraId = 'cam3';
    expect(await evaluate(fixture().deps, o)).toEqual({ accept: false, reason: 'id_taken' });
  });
  it('leftover moved entry: free when hidden and no active move names it, taken otherwise (Review Focus 4)', async () => {
    const cfg = { cameras: [{ id: 'cam3', host: '192.0.2.3' }, { id: 'cam9', host: '192.0.2.9', moved: 'mv_AAAAAAAAAAAAAAAAAAAA' }] };
    expect((await evaluate(fixture({ config: cfg }).deps, offer())).accept).toBe(true);
    // Not hidden: taken.
    expect(await evaluate(fixture({ config: { cameras: [{ id: 'cam9', host: '192.0.2.9' }] } }).deps, offer())).toEqual({ accept: false, reason: 'id_taken' });
    // Hidden, but an active record names the camera: taken (the journal sees it first as busy in practice; the camera check alone must also hold).
    const f = fixture({ config: cfg });
    f.deps.journal = { active: () => [{ camera: 'cam9' } as MoveRecord], save: () => undefined };
    expect(await evaluate(f.deps, offer())).toEqual({ accept: false, reason: 'busy' });
  });
  it('a leftover is free only for the same camera: host, protocol and user as offered (final review 2)', async () => {
    const left = (extra: object) => ({ cameras: [{ id: 'cam3', host: '192.0.2.3' }, { id: 'cam9', host: '192.0.2.9', moved: 'mv_AAAAAAAAAAAAAAAAAAAA', ...extra }] });
    expect(await evaluate(fixture({ config: left({ host: '192.0.2.10' }) }).deps, offer())).toEqual({ accept: false, reason: 'id_taken' });
    expect(await evaluate(fixture({ config: left({ protocol: 'http' }) }).deps, offer())).toEqual({ accept: false, reason: 'id_taken' });
    expect(await evaluate(fixture({ config: left({ user: 'admin2' }) }).deps, offer())).toEqual({ accept: false, reason: 'id_taken' });
    expect((await evaluate(fixture({ config: left({}) }).deps, offer())).accept).toBe(true);
  });
  it('camera_limit counts the cameras that run', async () => {
    expect(await evaluate(fixture({ config: { moves: { maxCameras: 1 } } }).deps, offer())).toEqual({ accept: false, reason: 'camera_limit' });
    expect((await evaluate(fixture({ config: { moves: { maxCameras: 2 } } }).deps, offer())).accept).toBe(true);
    // A hidden moved camera does not count.
    const cfg = { moves: { maxCameras: 1 }, cameras: [{ id: 'cam3', host: '192.0.2.3', moved: 'mv_AAAAAAAAAAAAAAAAAAAA' }] };
    expect((await evaluate(fixture({ config: cfg }).deps, offer())).accept).toBe(true);
  });
  it('incompatible when the settings do not make a valid camera node', async () => {
    const o = offer({ settings: { stills: { intervalS: 7 } } });
    expect(await evaluate(fixture().deps, o)).toEqual({ accept: false, reason: 'incompatible' });
  });
  it('ca_does_not_cover_camera for an address or a name outside the CA', async () => {
    const o = offer();
    o.camera.host = '192.0.2.200:8443';
    expect((await evaluate(fixture().deps, o)).accept).toBe(true);
    o.camera.host = '203.0.113.9';
    expect(await evaluate(fixture().deps, o)).toEqual({ accept: false, reason: 'ca_does_not_cover_camera' });
    const other = fixture({ ca: { ...fakeCa, coversName: () => false } });
    expect(await evaluate(other.deps, offer())).toEqual({ accept: false, reason: 'ca_does_not_cover_camera' });
  });
  it('camera_unreachable when the HTTPS port does not accept a connection', async () => {
    const f = fixture({ connect: false });
    expect(await evaluate(f.deps, offer())).toEqual({ accept: false, reason: 'camera_unreachable' });
    expect(f.connects).toEqual([['192.0.2.9', 443]]);
  });
  it('a refusal writes nothing', async () => {
    const f = fixture({ connect: false });
    await evaluate(f.deps, offer());
    expect(f.journal.all()).toEqual([]);
  });
});

describe('the camera port', () => {
  let srv: Server;
  afterEach(() => void srv?.close());
  it('the real TCP connect: open port reachable, closed port not', async () => {
    srv = createServer((s) => s.destroy());
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    expect(await tcpConnect('127.0.0.1', port, 1000)).toBe(true);
    await new Promise((r) => srv.close(r));
    expect(await tcpConnect('127.0.0.1', port, 1000)).toBe(false);
  });
});

describe('space (P4, S §7)', () => {
  it('space fits', () => {
    const f = fixture();
    expect(spaceFor(f.deps, summary({ clips: 1000, events: 24 }))).toEqual({ needed: 1024, available: 1024, fits: true, perKind: { clips: 1000, events: 24 }, retentionProposal: null });
  });
  it('space short lists perKind and a retentionProposal when the disk has room', () => {
    const f = fixture({ config: { ftp: { maxGB: 10 } }, usage: { stills: 0, previews: 0, clips: 9 * GB } });
    const s = spaceFor(f.deps, summary({ clips: 3 * GB, events: 100 }));
    expect(s).toEqual({ needed: 3 * GB + 100, available: 1 * GB + 100, fits: false, perKind: { clips: 3 * GB, events: 100 }, retentionProposal: { 'ftp.maxGB': 12 } });
  });
  it('the stills cap is stills.maxGB + previews.maxGB together; the proposal raises both', () => {
    const f = fixture({ config: { stills: { maxGB: 2 }, previews: { maxGB: 1 } }, usage: { stills: 2 * GB, previews: 1 * GB, clips: 0 } });
    const s = spaceFor(f.deps, summary({ stills: 3 * GB }));
    expect(s.fits).toBe(false);
    expect(s.retentionProposal).toEqual({ 'stills.maxGB': 4, 'previews.maxGB': 2 });
  });
  it('retentionProposal null when the disk is short', () => {
    // 5 GB free, 1 GB must stay: 4 GB usable; the caps are not what is short.
    const f = fixture({ free: 5 * GB });
    const s = spaceFor(f.deps, summary({ clips: 6 * GB }));
    expect([s.fits, s.available, s.retentionProposal]).toEqual([false, 4 * GB, null]);
    const capped = fixture({ free: 5 * GB, config: { ftp: { maxGB: 1 } } });
    expect(spaceFor(capped.deps, summary({ clips: 6 * GB })).retentionProposal).toBeNull();
  });
});

describe('the storage budget (ruling: budget headroom caps available)', () => {
  it('fits false when the caps fit but total use plus the move exceeds the budget', () => {
    const f = fixture({ usage: { stills: 0, previews: 0, clips: 0, used: 90 * GB, budget: 92 * GB } });
    const s = spaceFor(f.deps, summary({ clips: 5 * GB }));
    expect([s.fits, s.available]).toEqual([false, 2 * GB]);
  });
  it('the proposal includes storage.maxBytes when the disk has room', () => {
    const f = fixture({ usage: { stills: 0, previews: 0, clips: 0, used: 90 * GB, budget: 92 * GB } });
    expect(spaceFor(f.deps, summary({ clips: 5 * GB })).retentionProposal).toEqual({ 'storage.maxBytes': 95 * GB });
  });
  it('no maxBytes proposal when the disk is short', () => {
    const f = fixture({ free: 3 * GB, usage: { stills: 0, previews: 0, clips: 0, used: 90 * GB, budget: 90 * GB } });
    expect(spaceFor(f.deps, summary({ clips: 5 * GB })).retentionProposal).toBeNull();
  });
});

describe('accepting writes the target record (B4, B32)', () => {
  it('journals peer, connection, summary, settings and the token as phase opened', async () => {
    const f = fixture({ probe: 777 });
    const o = offer();
    const r = await evaluate(f.deps, o);
    expect(r).toEqual({ accept: true, space: { needed: 1000, available: 1000, fits: true, perKind: { clips: 1000 }, retentionProposal: null }, probeBps: 777 });
    const rec = f.journal.load(MOVE)!;
    expect(rec).toMatchObject({
      v: 1, id: MOVE, role: 'target', camera: 'cam9', phase: 'opened', plan: null, token: TOKEN, startedAt: 5000, chunks: {}, bytesDone: 0,
      peer: { proxyId: o.source.proxyId, name: 'een', url: o.source.url, caFingerprints: o.source.caFingerprints, tlsServername: 'proxy.garage.internal', ip: '198.51.100.7' },
      cameraConnection: { proxyCameraId: 'cam9', name: 'Garden', host: '192.0.2.9', protocol: 'https', user: 'proxy', onvifPort: 8000, rtspPort: 554, baichuanPort: 9000 },
      summary: o.summary, settings: { statusPollS: 30 },
      // The target's own space answer: move.start checks targetSettings against its proposal.
      space: r.accept ? r.space : null,
    });
    expect(rec.cameraConnection).not.toHaveProperty('camsId');
    expect(statSync(join(f.dir, 'admin', 'moves', `${MOVE}.json`)).mode & 0o777).toBe(0o600);
  });
  it('a hostname in the source url is resolved to its address', async () => {
    const f = fixture();
    await evaluate(f.deps, offer({ source: { ...offer().source, url: 'https://een.lan.example:8443' } }));
    expect(f.journal.load(MOVE)!.peer.ip).toBe('203.0.113.5');
  });
  it('the handler answers ok with the evaluation and never carries the token', async () => {
    const f = fixture();
    const h = moveHandlers({ emit: () => undefined, audit: { write: () => undefined } as never, evaluate: f.deps })['move.offer'];
    const done = await h(offer(), {} as never);
    expect(done.status).toBe('ok');
    expect(done.result).toMatchObject({ accept: true, probeBps: 123456 });
    expect(JSON.stringify(done)).not.toContain(TOKEN);
    const bad = moveHandlers({ emit: () => undefined, audit: { write: () => undefined } as never, evaluate: { ...fixture().deps, loaded: () => { throw new Error(`boom ${TOKEN}`); } } })['move.offer'];
    const failed = await bad(offer(), {} as never);
    expect(failed).toEqual({ status: 'failed', code: 'internal' });
  });
});

describe('the throughput probe', () => {
  const servers: HttpServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  it('probe measures a rate > 0 against the source endpoint', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-offerprobe-'));
    const journal = new MoveJournal(join(dataDir, 'admin', 'moves'));
    const record: MoveRecord = { v: 1, id: MOVE, role: 'source', camera: 'cam9', phase: 'opened', plan: null, peer: { proxyId: 'p', name: 't', ip: '127.0.0.1' }, tokenHash: hashMoveToken(TOKEN), chunks: {}, bytesDone: 0, startedAt: 1 };
    journal.save(record);
    const app = express();
    app.use('/api', movesSourceApi({ journal, audit: new AuditLog({ dir: join(dataDir, 'audit'), version: 'test' }), inventory: { catalog: openCatalog(join(dataDir, 'catalog.db')), dataDir }, busy: () => false, password: () => 'pw' }));
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const bps = await probeSource({ ...offer().source, url }, MOVE, TOKEN);
    expect(bps).toBeGreaterThan(1_000_000);
    // A wrong token gets nothing: 0, no throw.
    expect(await probeSource({ ...offer().source, url }, MOVE, 'wrong-token-'.padEnd(43, 'z'))).toBe(0);
  }, 30_000);

  it('a source that is down measures 0 and does not throw', async () => {
    expect(await probeSource({ ...offer().source, url: 'http://127.0.0.1:1' }, MOVE, TOKEN)).toBe(0);
  });

  it('https: pinned to the offered CA fingerprint and the offered name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-offerca-'));
    const ca = await siteCa(dir, { site: 'garage', cameraSubnet: '192.0.2.0/24', proxyAddresses: ['127.0.0.1'] });
    const leaf = await issueLeaf(ca, { cn: 'proxy.garage.internal', dns: ['proxy.garage.internal'], ips: ['127.0.0.1'] });
    const seen: string[] = [];
    const server = createHttpsServer({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
      if (req.url === '/tls/ca.pem') return void res.end(ca.certPem);
      seen.push(String(req.headers.authorization));
      res.end(Buffer.alloc(1_000_000, 1));
    });
    servers.push(server as unknown as HttpServer);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    const src = { ...offer().source, url, caFingerprints: [ca.fingerprint], tlsServername: 'proxy.garage.internal' };
    expect(await probeSource(src, MOVE, TOKEN)).toBeGreaterThan(0);
    expect(seen).toEqual([`Bearer ${TOKEN}`]);
    // Another CA fingerprint: nothing is sent.
    seen.length = 0;
    expect(await probeSource({ ...src, caFingerprints: [`SHA256:${'B'.repeat(64)}`] }, MOVE, TOKEN)).toBe(0);
    // A bundle whose first certificate matches: refused, no token sent.
    const bundle = `${ca.certPem}\n${leaf.certPem}`;
    const bundled = createHttpsServer({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
      if (req.url === '/tls/ca.pem') return void res.end(bundle);
      seen.push(String(req.headers.authorization));
      res.end('x');
    });
    servers.push(bundled as unknown as HttpServer);
    await new Promise<void>((r) => bundled.listen(0, '127.0.0.1', r));
    expect(await probeSource({ ...src, url: `https://127.0.0.1:${(bundled.address() as { port: number }).port}` }, MOVE, TOKEN)).toBe(0);
    expect(seen).toEqual([]);
    // The right CA but a name the leaf does not carry.
    expect(await probeSource({ ...src, tlsServername: 'other.garage.internal' }, MOVE, TOKEN)).toBe(0);
    expect(seen).toEqual([]);
    // The pinned CA served by a source whose leaf another CA issued: refused before
    // any token goes out (ca.pem is fetched pinned to the served leaf, CodeQL
    // js/disabling-certificate-validation).
    const otherDir = mkdtempSync(join(tmpdir(), 'camproxy-offerca2-'));
    const other = await siteCa(otherDir, { site: 'garage', cameraSubnet: '192.0.2.0/24', proxyAddresses: ['127.0.0.1'] });
    const foreign = await issueLeaf(other, { cn: 'proxy.garage.internal', dns: ['proxy.garage.internal'], ips: ['127.0.0.1'] });
    const impostor = createHttpsServer({ cert: foreign.certPem, key: foreign.keyPem }, (req, res) => {
      if (req.url === '/tls/ca.pem') return void res.end(ca.certPem);
      seen.push(String(req.headers.authorization));
      res.end('x');
    });
    servers.push(impostor as unknown as HttpServer);
    await new Promise<void>((r) => impostor.listen(0, '127.0.0.1', r));
    expect(await probeSource({ ...src, url: `https://127.0.0.1:${(impostor.address() as { port: number }).port}` }, MOVE, TOKEN)).toBe(0);
    expect(seen).toEqual([]);
  }, 60_000);
});

