import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cameraIds } from '../src/config/cameras';
import { writeKeyFile } from '../src/fleet/keyfile';
import { writePrivateJson } from '../src/fleet/private-file';
import type { Envelope } from '../src/fleet/protocol';
import { startFakeAdmin, type FakeAdmin } from './helpers/fake-admin';
import { strict, why } from './helpers/contract';
import { startMultiProxy, startSims, type Sim } from './helpers/multi';
import { ADMIN_TOKEN, auth, until } from './helpers/proxy';

// camera.remove.preview, camera.remove, proxy.unenroll through the proxy
// (decommission spec A1-A3, C3; cams-admin contract "Remove a camera,
// decommission a proxy").
const bodyOf = (r: { msg: Envelope }) => r.msg.body as Record<string, any>;
const HASH = `sha256:${'a'.repeat(64)}`;

describe('remove a camera, decommission the proxy (cams-admin commands)', () => {
  let sims: Sim[];
  let fake: FakeAdmin;
  let p: Awaited<ReturnType<typeof startMultiProxy>>;
  let data: string;
  const setPolicy = (o: Record<string, unknown>) => writePrivateJson(join(p.dir, 'data', 'admin', 'policy.json'), { v: 1, changedAt: Date.now(), changedBy: 'local', consent: 3, ...o });
  const done = async (command: string, args: Record<string, unknown>) => {
    const { cmdId } = fake.sendCommand(command, args);
    await until(() => fake.results(cmdId).some((r) => bodyOf(r).phase === 'done'), 15_000);
    return bodyOf(fake.results(cmdId).find((r) => bodyOf(r).phase === 'done')!);
  };
  const audits = (action: string) => p.proxy.audit.list({ actions: [action], limit: 50 }).records as Record<string, any>[];
  const put = (path: string, bytes: number) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes, 1));
  };
  // Two clips, three stills (and a preview), one archived clip of `cam`.
  const seed = (cam: string) => {
    const db = p.proxy.catalog.db;
    for (const n of [1, 2]) {
      const clip = join(data, 'clips', cam, '2026/11/01', `120${n}-1.mp4`);
      put(clip, 300);
      db.prepare("INSERT INTO clips (cam, start_ts, path, stream, size, received_at) VALUES (?, ?, ?, 'sub', 300, 1)").run(cam, Date.UTC(2026, 10, 1, 12, n), clip);
    }
    for (const m of ['1200', '1201', '1202']) put(join(data, 'stills', cam, '2026/11/01', `${m}.pack`), 100);
    put(join(data, 'previews', cam, '2026/11/01', '1200.jpg'), 20);
    const id = Number(db.prepare("INSERT INTO archive (cam, name, labels, created_at, recorded_from, recorded_to, quality, original, duration_s, bytes, files, source, thumb_from, created_by, metadata) VALUES (?, 'a', '[]', 1, 1, 2, 'sub', 1, 1, 70, '[]', 's', 'f', 'u', '{}')").run(cam).lastInsertRowid);
    put(join(data, 'archive', cam, String(id), 'clip.mp4'), 70);
  };
  const addCamera = async (id: string) => {
    const s = sims[0];
    await request(p.base).put('/control/config').set(auth(ADMIN_TOKEN)).send({ cameras: { [id]: { host: s.camera.host, protocol: 'http', user: 'proxy', onvifPort: s.ports.onvif, rtspPort: s.ports.rtsp || 554, baichuanPort: s.camera.baichuanPort } } }).expect(200);
  };

  beforeAll(async () => {
    sims = await startSims(1);
    fake = await startFakeAdmin();
    fake.welcomeHeartbeatS = 3600;
    fake.nextInS = 3600;
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-decomm-'));
    writeKeyFile(join(dir, 'data', 'admin', 'key.json'), fake.keyFile());
    p = await startMultiProxy(sims, { dir, settings: { camsAdmin: { url: fake.url } }, proxy: { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200, changeCheckMs: 100 } } } });
    data = join(dir, 'data');
    await until(() => fake.open() === 1 && fake.heartbeats().length >= 1, 10_000);
  }, 60_000);
  afterAll(async () => {
    await p?.proxy.stop();
    await fake?.close();
    await Promise.all((sims ?? []).map((s) => s.close()));
  });

  it('camera.remove.preview is on by default (a read): the counts, strict; unknown camera not_found', async () => {
    await addCamera('cam6');
    seed('cam6');
    const r = await done('camera.remove.preview', { v: 1, camera: 'cam6' });
    expect(r).toMatchObject({ status: 'ok', result: { camera: 'cam6', clips: 2, stills: 3, archivedClips: 1, bytes: 2 * 300 + 3 * 100 + 20 + 70 } });
    expect(strict('commands/camera.remove.preview.result')(r.result), why(strict('commands/camera.remove.preview.result'))).toBe(true);
    expect(await done('camera.remove.preview', { v: 1, camera: 'nope' })).toMatchObject({ status: 'failed', code: 'not_found' });
  });

  it('camera.remove and proxy.unenroll are off by default (disruptive): not_allowed, nothing changed', async () => {
    expect(await done('camera.remove', { v: 1, camera: 'cam6', content: 'keep', archive: false })).toMatchObject({ status: 'refused', code: 'not_allowed' });
    expect(await done('proxy.unenroll', { v: 1 })).toMatchObject({ status: 'refused', code: 'not_allowed' });
    expect(cameraIds(p.proxy.loaded.config)).toContain('cam6');
    // archive: true with keep is refused by the args check.
    setPolicy({ allow: ['camera.remove'] });
    expect(await done('camera.remove', { v: 1, camera: 'cam6', content: 'keep', archive: true })).toMatchObject({ status: 'refused', code: 'invalid_args' });
  });

  it('camera.remove keep: the local remove runs, the files stay for retention, the archive stays; strict result', async () => {
    setPolicy({ allow: ['camera.remove'] });
    const r = await done('camera.remove', { v: 1, camera: 'cam6', content: 'keep', archive: false });
    expect(r).toMatchObject({ status: 'ok', result: { camera: 'cam6', removed: expect.arrayContaining(['configuration']), leftovers: [], deleted: { clips: 0, stills: 0, archivedClips: 0 } } });
    expect(strict('commands/camera.remove.result')(r.result), why(strict('commands/camera.remove.result'))).toBe(true);
    expect(cameraIds(p.proxy.loaded.config)).not.toContain('cam6');
    expect(existsSync(join(data, 'stills', 'cam6', '2026/11/01', '1200.pack'))).toBe(true);
    const rec = audits('camera-remove').find((x) => x.labels?.camera === 'cam6')!;
    expect(rec.cam_proxy).toMatchObject({ requestedBy: 'cams-admin', cmdId: r.cmdId });
    expect(audits('camera-content-delete')).toHaveLength(0);
    // The preview still sees the files (the camera is known by them).
    expect(await done('camera.remove.preview', { v: 1, camera: 'cam6' })).toMatchObject({ status: 'ok', result: { clips: 2, stills: 3, archivedClips: 1 } });
  });

  it('camera.remove delete: clips and stills now, the archive only with archive: true; another camera untouched', async () => {
    setPolicy({ allow: ['camera.remove'] });
    await addCamera('cam7');
    seed('cam7');
    seed('cam8');
    const r = await done('camera.remove', { v: 1, camera: 'cam7', content: 'delete', archive: false });
    expect(r).toMatchObject({ status: 'ok', result: { deleted: { clips: 2, stills: 3, archivedClips: 0 }, leftovers: [] } });
    expect(await done('camera.remove.preview', { v: 1, camera: 'cam7' })).toMatchObject({ result: { clips: 0, stills: 0, archivedClips: 1 } });
    expect(audits('camera-content-delete')[0]).toMatchObject({ labels: { camera: 'cam7' }, cam_proxy: { archive: false, deleted: { clips: 2, stills: 3, archivedClips: 0 } } });
    // The archive goes too: the camera is known by its files only now, the remove finds nothing to configure.
    const r2 = await done('camera.remove', { v: 1, camera: 'cam6', content: 'delete', archive: true });
    expect(r2).toMatchObject({ status: 'failed', code: 'not_found' });
    await addCamera('cam6');
    const r3 = await done('camera.remove', { v: 1, camera: 'cam6', content: 'delete', archive: true });
    expect(r3).toMatchObject({ status: 'ok', result: { deleted: { clips: 2, stills: 3, archivedClips: 1 } } });
    expect(existsSync(join(data, 'archive', 'cam6'))).toBe(false);
    expect(await done('camera.remove.preview', { v: 1, camera: 'cam8' })).toMatchObject({ result: { clips: 2, stills: 3, archivedClips: 1 } });
  });

  it('a config.json camera on a several-camera host: failed config_json; unknown: not_found', async () => {
    setPolicy({ allow: ['camera.remove'] });
    expect(await done('camera.remove', { v: 1, camera: 'cam3', content: 'keep', archive: false })).toMatchObject({ status: 'failed', code: 'config_json' });
    expect(await done('camera.remove', { v: 1, camera: 'cam9', content: 'keep', archive: false })).toMatchObject({ status: 'failed', code: 'not_found' });
  });

  it('camera.remove counts toward the disruptive journal budget (6 an hour)', async () => {
    setPolicy({ allow: ['camera.remove'] });
    // 3 journaled so far (keep, delete, delete+archive) plus the failed ones: every camera.remove counts, whatever its status.
    let r: Record<string, any> = {};
    for (let i = 0; i < 6 && r.code !== 'rate_limited'; i++) r = await done('camera.remove', { v: 1, camera: 'cam9', content: 'keep', archive: false });
    expect(r).toMatchObject({ status: 'refused', code: 'rate_limited' });
  });

  it('proxy.unenroll while a camera runs here: failed has_cameras, still enrolled', async () => {
    setPolicy({ allow: ['proxy.unenroll'] });
    expect(await done('proxy.unenroll', { v: 1 })).toMatchObject({ status: 'failed', code: 'has_cameras' });
    expect(existsSync(join(data, 'admin', 'key.json'))).toBe(true);
  });
});

describe('proxy.unenroll on an empty host', () => {
  let fake: FakeAdmin;
  let p: Awaited<ReturnType<typeof startMultiProxy>>;
  let data: string;
  const done = async (command: string, args: Record<string, unknown>) => {
    const { cmdId } = fake.sendCommand(command, args);
    await until(() => fake.results(cmdId).some((r) => bodyOf(r).phase === 'done'), 15_000);
    return bodyOf(fake.results(cmdId).find((r) => bodyOf(r).phase === 'done')!);
  };
  const audits = (action: string) => p.proxy.audit.list({ actions: [action], limit: 50 }).records as Record<string, any>[];
  beforeAll(async () => {
    fake = await startFakeAdmin();
    fake.welcomeHeartbeatS = 3600;
    fake.nextInS = 3600;
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-unenroll-'));
    data = join(dir, 'data');
    writeKeyFile(join(data, 'admin', 'key.json'), fake.keyFile());
    writePrivateJson(join(data, 'admin', 'tokens.json'), { v: 1, revision: 14, tokens: [{ id: 'tok_1', kind: 'client', hash: HASH, label: 'old', retireAt: null }], blocked: [] });
    writePrivateJson(join(data, 'admin', 'policy.json'), { v: 1, changedAt: Date.now(), changedBy: 'local', consent: 3, allow: ['proxy.unenroll', 'config.get'], off: ['analytics.usage.get'] });
    // Enrolled as admin-enroll leaves it: camsAdmin.url in overrides.json.
    writeFileSync(join(data, 'overrides.json'), JSON.stringify({ camsAdmin: { url: fake.url } }));
    p = await startMultiProxy([], { dir, proxy: { camsAdmin: { timing: { minIntervalS: 0.2, jitterS: 0, backoffCapMs: 300, closeGraceMs: 200, changeCheckMs: 100 } } } });
    await until(() => fake.open() === 1 && fake.heartbeats().length >= 1, 10_000);
  }, 60_000);
  afterAll(async () => {
    await p?.proxy.stop();
    await fake?.close();
  });

  it('unenrolls after the result: key deleted, camsAdmin.url cleared, managed tokens and the allowed commands cleared', async () => {
    expect(cameraIds(p.proxy.loaded.config)).toEqual([]);
    const r = await done('proxy.unenroll', { v: 1 });
    expect(r).toMatchObject({ status: 'ok', result: { unenrollAt: expect.any(Number) } });
    expect(strict('commands/proxy.unenroll.result')(r.result), why(strict('commands/proxy.unenroll.result'))).toBe(true);
    await until(() => audits('admin-unenroll').length > 0, 10_000);
    expect(existsSync(join(data, 'admin', 'key.json'))).toBe(false);
    expect(p.proxy.running.camsAdmin.url).toBeUndefined();
    const tokens = JSON.parse(readFileSync(join(data, 'admin', 'tokens.json'), 'utf8'));
    expect([tokens.revision, tokens.tokens]).toEqual([0, []]);
    const policy = JSON.parse(readFileSync(join(data, 'admin', 'policy.json'), 'utf8'));
    expect([policy.allow, policy.off]).toEqual([[], []]);
    expect(audits('admin-unenroll')[0]).toMatchObject({ cam_proxy: { managedSet: 'cleared', policy: 'reset', cmdId: r.cmdId } });
    expect(audits('admin-unenroll')[0].event.outcome).toBe('success');
    expect((await request(p.base).get('/control/admin').set(auth(ADMIN_TOKEN))).body.state).toBe('off');
  });
});
