import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { FaultSpec } from 'cam-sim';
import { auditText, lastAudit, managedAdminToken } from './helpers/onboarding';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { E1_MODEL, startSim } from './helpers/sim';

// GET/PUT /api/cameras/:cam/settings/encoding: the camera's streams (GetEnc
// with action 1 for the options), written as one whole SetEnc, checked
// against the camera's own range, re-read and audited; a changed picture
// refreshes the status's streams and the live and stills side.
const go2rtc = process.env.CAMPROXY_TEST_GO2RTC;
const STRICT: FaultSpec = { name: 'settings.strictPartial' };

async function setup(o: { model?: typeof E1_MODEL; faults?: FaultSpec[]; encRange?: Array<Record<string, any>>; stills?: boolean } = {}) {
  const s = await startSim({ model: o.model, faults: [STRICT, ...(o.faults ?? [])], encRange: o.encRange });
  const dir = mkdtempSync(join(tmpdir(), 'calls-encoding-'));
  const managed = managedAdminToken(dir);
  const p = await startProxy(s, { dir, ...(o.stills === false ? { settings: { stills: { enabled: false } } } : {}) });
  await until(() => p.proxy.cameras.get('cam1')!.status.state().online, 10_000);
  return { s, p, managed, close: async () => (await p.proxy.stop(), await s.close()) };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const put = (x: Setup, body: unknown, t = ADMIN_TOKEN) => request(x.p.base).put('/api/cameras/cam1/settings/encoding').set(auth(t)).send(body as object);
const get = (x: Setup, t?: string) => request(x.p.base).get('/api/cameras/cam1/settings/encoding').set(auth(t));
const runningEnc = (x: Setup) => structuredClone(x.s.sim.engine.settings.running.Enc) as Record<string, any>;
const setCalls = (x: Setup) => x.s.sim.engine.counters.setCalls as string[];

describe('encoding on an E1 Outdoor Pro (its captured range)', () => {
  let x: Setup;
  beforeAll(async () => {
    x = await setup({ model: E1_MODEL, stills: false });
  }, 30_000);
  afterAll(async () => x?.close());

  it('reads the streams and the options the camera offers, with a client token', async () => {
    const r = await get(x).expect(200);
    expect(r.body.main).toEqual({ codec: 'h265', width: 3840, height: 2160, fps: 20, bitRate: 4096, gop: 2, profile: 'High' });
    expect(r.body.sub).toEqual({ codec: 'h264', width: 640, height: 360, fps: 10, bitRate: 256, gop: 4, profile: 'High' });
    expect(r.body).not.toHaveProperty('ext');
    expect(r.body.options.map((o: any) => `${o.main.width}x${o.main.height}+${o.sub.width}x${o.sub.height}`)).toEqual(['3840x2160+640x360', '2560x1440+640x360', '2304x1296+640x360']);
    expect(r.body.options[1].main).toEqual({ width: 2560, height: 1440, codecs: ['h264', 'h265'], fps: [25, 22, 20, 18, 16, 15, 12, 10, 8, 6, 4, 2], bitRates: [2048, 3072, 4096], profiles: ['Base', 'Main', 'High'], gop: { min: 1, max: 2 } });
    expect(r.body.options[0].sub).toMatchObject({ codecs: ['h264'], fps: [15, 10, 7, 4] });
    // GET /settings stays cams's two sections.
    expect(Object.keys((await request(x.p.base).get('/api/cameras/cam1/settings').set(auth()).expect(200)).body)).toEqual(['detection', 'image']);
  });

  it('sends the whole Enc object with one SetEnc, answers the re-read and audits old -> new', async () => {
    const w = x.p.proxy.cameras.get('cam1')!;
    const before = runningEnc(x);
    const spy = vi.spyOn(w.client, 'command');
    let r: request.Response;
    try {
      r = await put(x, { main: { width: 2304, height: 1296, fps: 15, bitRate: 2560 } });
      const sets = spy.mock.calls.filter(([c]) => c === 'SetEnc');
      expect(sets).toHaveLength(1);
      expect(sets[0][1]).toEqual({
        Enc: {
          audio: 1, channel: 0,
          mainStream: { bitRate: 2560, frameRate: 15, gop: 2, height: 1296, profile: 'High', size: '2304*1296', vType: 'h265', width: 2304 },
          subStream: before.subStream,
        },
      });
    } finally {
      spy.mockRestore();
    }
    expect(r.status).toBe(200);
    expect(r.body.fields).toEqual({ main: { ok: true } });
    expect(r.body.settings.main).toEqual({ codec: 'h265', width: 2304, height: 1296, fps: 15, bitRate: 2560, gop: 2, profile: 'High' });
    expect(runningEnc(x)).toEqual({ ...before, mainStream: { ...before.mainStream, size: '2304*1296', width: 2304, height: 1296, frameRate: 15, bitRate: 2560 } });
    const a = lastAudit(x.p.dir, 'camera-settings')!;
    expect(a).toMatchObject({ event: { outcome: 'success' }, user: { name: 'admin' } });
    expect(a.cam_proxy).toMatchObject({
      section: 'encoding', patch: { main: { width: 2304, height: 1296, fps: 15, bitRate: 2560 } }, fields: { main: 'ok' }, unexpected: [], sent: true, refreshed: ['main'],
      from: { main: { width: 3840, height: 2160, fps: 20, bitRate: 4096 } }, to: { main: { width: 2304, height: 1296, fps: 15, bitRate: 2560 } },
    });
    expect(auditText(x.p.dir)).not.toContain(x.s.password);
  });

  it('the status answers the new streams at once', async () => {
    const st = await request(x.p.base).get('/api/cameras/cam1/status').set(auth()).expect(200);
    expect(st.body.streams.main).toEqual({ codec: 'h265', width: 2304, height: 1296, fps: 15 });
    expect((await put(x, { main: { width: 3840, height: 2160, fps: 20, bitRate: 4096 } })).status).toBe(200);
    const again = await request(x.p.base).get('/api/cameras/cam1/status').set(auth()).expect(200);
    expect(again.body.streams.main).toMatchObject({ width: 3840, height: 2160, fps: 20 });
  });

  it.each([
    [{ sub: { width: 896, height: 512 } }, /sizes main 3840x2160, sub 896x512: not a combination/],
    [{ main: { fps: 25 } }, /main\.fps: one of 20, 18, .* at 3840x2160/],
    [{ sub: { codec: 'h265' } }, /sub\.codec: one of h264/],
    [{ main: { bitRate: 9999 } }, /main\.bitRate: one of 2048, 3072, 4096, 5120/],
  ])('refuses %j outside the camera\'s range: 400 not_allowed with the allowed values, nothing sent', async (body, detail) => {
    const n = setCalls(x).length;
    const before = runningEnc(x);
    const r = await put(x, body);
    expect([r.status, r.body.error]).toEqual([400, 'not_allowed']);
    expect(r.body.details.join('; ')).toMatch(detail);
    expect(r.body.allowed).toHaveLength(3);
    expect(r.body.allowed[0].main).toMatchObject({ width: 3840, height: 2160 });
    expect(setCalls(x).length).toBe(n);
    expect(runningEnc(x)).toEqual(before);
    expect(lastAudit(x.p.dir, 'camera-settings')).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'not_allowed' }, cam_proxy: { section: 'encoding', sent: false } });
  });

  it.each([
    [{ sub: { width: 320 } }],
    [{ sub: { fps: 0 } }],
    [{ main: { codec: 'mjpeg' } }],
    [{ main: {} }],
    [{ audio: 1 }],
    [{ sub: { size: '320*180' } }],
  ])('answers 400 invalid for %j before asking the camera', async (body) => {
    const n = setCalls(x).length;
    const r = await put(x, body);
    expect([r.status, r.body.error]).toEqual([400, 'invalid']);
    expect(setCalls(x).length).toBe(n);
  });

  it('refuses a client token (403 admin_only) and a managed admin token (local admin only)', async () => {
    const n = setCalls(x).length;
    expect((await put(x, { sub: { fps: 7 } }, CLIENT_TOKEN)).status).toBe(403);
    const m = await put(x, { sub: { fps: 7 } }, x.managed);
    expect([m.status, m.body.error]).toEqual([403, 'local_admin_only']);
    expect(setCalls(x).length).toBe(n);
  });

  it('logs out after a write', async () => {
    const w = x.p.proxy.cameras.get('cam1')!;
    const spy = vi.spyOn(w.client, 'logout');
    try {
      expect((await put(x, { sub: { fps: 7 } })).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect((await put(x, { sub: { fps: 10 } })).status).toBe(200);
  });
});

describe('a camera that does not keep the encoding', () => {
  it('answers 207 not_applied when the camera ignores SetEnc', async () => {
    const y = await setup({ model: E1_MODEL, faults: [{ name: 'settings.ignore', cmds: ['SetEnc'] }], stills: false });
    try {
      const r = await put(y, { sub: { fps: 15 } });
      expect(r.status).toBe(207);
      expect(r.body.fields.sub).toEqual({ ok: false, error: 'not_applied' });
      expect(r.body.settings.sub.fps).toBe(10);
      expect(lastAudit(y.p.dir, 'camera-settings')).toMatchObject({ event: { outcome: 'failure' }, error: { message: 'not_applied' }, cam_proxy: { section: 'encoding', fields: { sub: 'not_applied' }, refreshed: [] } });
    } finally {
      await y.close();
    }
  }, 30_000);

  it('answers 207 camera_rejected when the camera refuses SetEnc', async () => {
    const y = await setup({ model: E1_MODEL, faults: [{ name: 'settings.fail', cmds: ['SetEnc'] }], stills: false });
    try {
      const r = await put(y, { main: { codec: 'h264' } });
      expect(r.status).toBe(207);
      expect(r.body.fields.main).toEqual({ ok: false, error: 'camera_rejected' });
      expect(JSON.stringify(r.body)).not.toMatch(/rspCode|SetEnc/);
    } finally {
      await y.close();
    }
  }, 30_000);
});

// The RLC-1224A with a small second sub size (a test range: its real range is
// not captured), so the live side can be checked at a size that encodes fast.
describe('a sub size change reaches the status and the live side', () => {
  let x: Setup;
  beforeAll(async () => {
    const s = await startSim();
    const [own] = structuredClone(s.sim.engine.profile.encRange) as Array<Record<string, any>>;
    await s.close();
    const small = structuredClone(own);
    Object.assign(small.subStream, { size: '320*180', width: 320, height: 180 });
    x = await setup({ encRange: [own, small] });
  }, 30_000);
  afterAll(async () => x?.close());

  it('PUT sub 320x180: status streams at once, and the go2rtc sub frame at the new size', async () => {
    const w = x.p.proxy.cameras.get('cam1')!;
    expect((await request(x.p.base).get('/api/cameras/cam1/status').set(auth())).body.streams.sub).toMatchObject({ width: 896, height: 512 });
    // A live client on sub before the change: closed with camera_restarting (1013), to reconnect.
    let closed: Promise<{ code: number; reason: string }> | undefined;
    if (go2rtc) {
      await until(() => !!w.stills?.go2rtc.up(), 20_000);
      const ws = new WebSocket(`ws://127.0.0.1:${x.p.port}/api/cameras/cam1/live`, { headers: { Authorization: `Bearer ${CLIENT_TOKEN}` } });
      let bins = 0;
      ws.on('message', (_d, isBinary) => void (isBinary && bins++));
      ws.on('error', () => undefined);
      closed = new Promise((res) => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
      await until(() => bins >= 2, 15_000);
    }
    const refresh = vi.spyOn(w, 'refreshVideo');
    const r = await put(x, { sub: { width: 320, height: 180 } });
    expect(r.status).toBe(200);
    expect(r.body.settings.sub).toMatchObject({ width: 320, height: 180 });
    expect(refresh).toHaveBeenCalledTimes(1);
    refresh.mockRestore();
    expect((await request(x.p.base).get('/api/cameras/cam1/status').set(auth())).body.streams.sub).toEqual({ codec: 'h264', width: 320, height: 180, fps: 10 });
    if (!go2rtc) return;
    expect(await closed).toEqual({ code: 1013, reason: 'camera_restarting' });
    // Through the proxy's go2rtc (the sub snapshot is a frame of its stream).
    const size = async () => {
      const res = await request(x.p.base).get('/api/cameras/cam1/snapshot.jpg?stream=sub').set(auth()).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      if (res.status !== 200) return '';
      const { stdout } = await import('child_process').then(({ execFileSync }) => ({ stdout: execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', '-i', '-'], { input: res.body as Buffer }).toString() }));
      return stdout.trim();
    };
    await expect.poll(size, { timeout: 30_000, interval: 1000 }).toBe('320,180');
  }, 60_000);
});
