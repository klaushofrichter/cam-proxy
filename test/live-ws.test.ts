import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { logBuffer } from '../src/log';
import { LIVE } from '../src/stream/live';
import { CLIENT_TOKEN, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// Live video as MSE over a WebSocket (spec 2026-10-30-camera-onboarding-design
// §4.8, §10.3), relayed from the host go2rtc: needs go2rtc (CAMPROXY_TEST_GO2RTC).
const binary = process.env.CAMPROXY_TEST_GO2RTC;

let s: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
beforeAll(async () => {
  if (!binary) return;
  s = await startSim();
  p = await startProxy(s);
  await until(() => p.proxy.cameras.get('cam1')!.status.state().online && !!p.proxy.cameras.get('cam1')!.stills?.go2rtc.up(), 20_000);
}, 40_000);
afterAll(async () => {
  await p?.proxy.stop();
  await s?.close();
});

interface Live { ws: WebSocket; text: string[]; bins: Buffer[]; closed: Promise<{ code: number; reason: string }> }
function live(q = ''): Live {
  const ws = new WebSocket(`ws://127.0.0.1:${p.port}/api/cameras/cam1/live${q}`, { headers: { Authorization: `Bearer ${CLIENT_TOKEN}` } });
  const text: string[] = [];
  const bins: Buffer[] = [];
  ws.on('message', (d: Buffer, isBinary) => (isBinary ? bins.push(d) : text.push(d.toString())));
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  ws.on('error', () => undefined);
  return { ws, text, bins, closed };
}
const boxAt = (b: Buffer) => b.subarray(4, 8).toString('latin1');
const consumers = async (name: string) => ((await p.proxy.cameras.get('cam1')!.stills!.go2rtc.streams())[name]?.consumers.length ?? 0);

describe.skipIf(!binary)('live video over a WebSocket', () => {
  it('relays the sub stream as MSE: the mime first, then fMP4', async () => {
    const l = live();
    try {
      await until(() => l.bins.length >= 2, 15_000);
      expect(l.text).toHaveLength(1);
      const first = JSON.parse(l.text[0]) as { type: string; value: string };
      expect(first.type).toBe('mse');
      expect(first.value).toMatch(/^video\/mp4; codecs="avc1\./);
      expect(boxAt(l.bins[0])).toBe('ftyp');
      await until(() => l.bins.some((b) => boxAt(b) === 'moof'), 5_000);
    } finally {
      l.ws.close();
    }
  }, 30_000);

  it('relays main as h265 on request', async () => {
    const l = live('?stream=main');
    try {
      await until(() => l.text.length >= 1, 15_000);
      expect(JSON.parse(l.text[0]).value).toMatch(/hvc1|hev1/);
    } finally {
      l.ws.close();
    }
  }, 30_000);

  it('closes go2rtc\'s consumer when the client leaves', async () => {
    const before = await consumers('cam1_sub');
    const l = live();
    await until(() => l.bins.length >= 1, 15_000);
    expect(await consumers('cam1_sub')).toBe(before + 1);
    expect(p.proxy.live.count('cam1')).toBe(1);
    l.ws.close();
    await l.closed;
    await until(async () => (await consumers('cam1_sub')) === before && p.proxy.live.count('cam1') === 0, 10_000);
  }, 30_000);

  it('closes a stalled reader with 4008 slow_consumer', async () => {
    const l = live('?stream=main');
    await until(() => l.bins.length >= 1, 15_000);
    // The client stops reading: the proxy's queue grows until the limit.
    (l.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket.pause();
    await until(() => p.proxy.live.count('cam1') === 0, 90_000);
    (l.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket.resume();
    const c = await l.closed;
    expect([c.code, c.reason]).toEqual([4008, 'slow_consumer']);
    expect(LIVE.maxBufferedBytes).toBe(8 * 1024 * 1024);
  }, 120_000);

  it('counts streams per camera and answers the ninth too_many_streams', async () => {
    const ls = Array.from({ length: LIVE.maxPerCamera }, () => live());
    try {
      await until(() => ls.every((l) => l.text.length >= 1), 20_000);
      expect(p.proxy.live.count('cam1')).toBe(LIVE.maxPerCamera);
      const ninth = live();
      const c = await ninth.closed;
      expect([c.code, ninth.text]).toEqual([1013, [JSON.stringify({ type: 'error', value: 'too_many_streams' })]]);
    } finally {
      for (const l of ls) l.ws.close();
    }
    await until(() => p.proxy.live.count('cam1') === 0, 10_000);
  }, 40_000);

  it('never forwards go2rtc text but the mse message', async () => {
    // The camera's password changes and its RTSP cuts the readers: go2rtc's
    // next connection fails, and go2rtc answers with its own error text.
    await until(async () => (await consumers('cam1_main')) === 0, 10_000);
    expect(s.sim.engine.sessions.modifyUser('proxy', { password: 'changed-pw' })).toBeNull();
    s.sim.engine.faults.set({ name: 'rtsp.reset' });
    try {
      const l = live('?stream=main');
      const c = await l.closed;
      expect(l.text).toEqual([JSON.stringify({ type: 'error', value: 'stream_unavailable' })]);
      expect([c.code, c.reason]).toEqual([1011, 'stream_unavailable']);
      const everything = JSON.stringify(logBuffer.recent(5000)) + c.reason + l.text.join('');
      expect(everything).not.toContain('rtsp://');
      expect(everything).not.toContain(s.password);
    } finally {
      s.sim.engine.faults.clear('rtsp.reset');
      s.sim.engine.sessions.modifyUser('proxy', { password: s.password });
    }
  }, 30_000);
});
