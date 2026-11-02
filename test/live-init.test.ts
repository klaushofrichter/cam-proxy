// End to end through the host go2rtc: a camera whose RTSP SDP has no
// sprop-parameter-sets (cam-sim's E1 Outdoor Pro and RLC-1224A, as the real
// ones) gets go2rtc's placeholder init (avc1 128x96, SPS 6742000af841a2,
// avc1.640029); the relay sends the stream's own instead. Needs go2rtc
// (CAMPROXY_TEST_GO2RTC) and MediaMTX.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FaultSpec } from 'cam-sim';
import request from 'supertest';
import { videoTrackOf } from '../src/stream/mse-init';
import { ADMIN_TOKEN, CLIENT_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { E1_MODEL, startSim } from './helpers/sim';

const binary = process.env.CAMPROXY_TEST_GO2RTC;
const STRICT: FaultSpec = { name: 'settings.strictPartial' };

async function firstMessages(port: number, q = ''): Promise<{ mime: string; init: Buffer; next: Buffer }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/cameras/cam1/live${q}`, { headers: { Authorization: `Bearer ${CLIENT_TOKEN}` } });
  const text: string[] = [];
  const bins: Buffer[] = [];
  ws.on('message', (d: Buffer, isBinary) => (isBinary ? bins.push(d) : text.push(d.toString())));
  ws.on('error', () => undefined);
  try {
    await until(() => bins.length >= 2, 20_000);
    return { mime: (JSON.parse(text[0]) as { value: string }).value, init: bins[0], next: bins[1] };
  } finally {
    ws.close();
  }
}

describe.skipIf(!binary)('the live init carries the stream\'s own parameter sets', () => {
  for (const [model, size] of [[E1_MODEL, [640, 360]], ['RLC-1224A', [896, 512]]] as const) {
    describe(model, () => {
      let s: Awaited<ReturnType<typeof startSim>>;
      let p: Awaited<ReturnType<typeof startProxy>>;
      beforeAll(async () => {
        s = await startSim({ model, faults: [STRICT], encRestartMs: 1_500 });
        p = await startProxy(s);
        await until(() => p.proxy.cameras.get('cam1')!.status.state().online && !!p.proxy.cameras.get('cam1')!.stills?.go2rtc.up(), 20_000);
      }, 40_000);
      afterAll(async () => {
        await p?.proxy.stop();
        await s?.close();
      });

      it(`sub: ${size.join('x')}, not go2rtc's 128x96 placeholder`, async () => {
        const m = await firstMessages(p.port);
        const t = videoTrackOf(m.init)!;
        expect([t.width, t.height]).toEqual(size);
        expect(t.config.sps[0].toString('hex')).not.toBe('6742000af841a2');
        expect(m.mime).not.toMatch(/avc1\.640029/);
        expect(m.mime).toMatch(new RegExp(`avc1\\.${t.config.sps[0].subarray(1, 4).toString('hex').toUpperCase()}`));
        expect(m.next.subarray(4, 8).toString('latin1')).toBe('moof');
      }, 40_000);

      if (model !== E1_MODEL) return;

      it('main (H.265): the stream\'s own size, not go2rtc\'s 2560x1440 placeholder', async () => {
        const t = videoTrackOf((await firstMessages(p.port, '?stream=main')).init)!;
        expect(t.kind).toBe('hevc');
        // cam-sim's prepared main is 1280x720, whatever GetEnc says.
        expect([t.width, t.height]).toEqual([1280, 720]);
      }, 40_000);

      it('an encoding PUT survives the camera\'s restart: 200 with the new settings, the status and the live init follow', async () => {
        const r = await request(p.base).put('/api/cameras/cam1/settings/encoding').set(auth(ADMIN_TOKEN)).send({ main: { width: 2560, height: 1440, fps: 25, bitRate: 3072 } });
        expect(r.status).toBe(200);
        expect(r.body.settings.main).toMatchObject({ width: 2560, height: 1440, fps: 25 });
        expect(r.body.restarted.ms).toBeGreaterThan(0);
        await until(async () => (await request(p.base).get('/api/cameras/cam1/status').set(auth())).body.streams?.main?.width === 2560, 20_000);
        await until(() => p.proxy.cameras.get('cam1')!.status.state().online, 20_000);
        const m = await firstMessages(p.port);
        const t = videoTrackOf(m.init)!;
        expect([t.width, t.height]).toEqual([640, 360]);
      }, 90_000);
    });
  }
});
