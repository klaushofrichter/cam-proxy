import { describe, it, expect, afterEach } from 'vitest';
import net from 'net';
import sharp from 'sharp';
import { Readable } from 'stream';
import { startSim } from './helpers/sim';
import { Go2rtc } from '../src/stills/go2rtc';
import { FrameGrabber, splitJpegs, type Frame } from '../src/stills/grabber';

const binary = process.env.CAMPROXY_TEST_GO2RTC;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const freePort = () =>
  new Promise<number>((r) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => r(p));
    });
  });
const until = async (cond: () => boolean, ms: number) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('splitJpegs', () => {
  it('gives whole JPEGs however the bytes are chunked, even inside a marker', async () => {
    const a = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#f00' } }).jpeg().toBuffer();
    const b = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#00f' } }).jpeg().toBuffer();
    const all = Buffer.concat([a, b, a]);
    for (const size of [1, 2, 3, 7, 100, all.length]) {
      const chunks: Buffer[] = [];
      for (let i = 0; i < all.length; i += size) chunks.push(all.subarray(i, i + size));
      const out: Buffer[] = [];
      await new Promise<void>((resolve) => Readable.from(chunks).pipe(splitJpegs()).on('data', (j: Buffer) => out.push(j)).on('end', resolve));
      expect(out.map((x) => x.length)).toEqual([a.length, b.length, a.length]);
      expect(Buffer.compare(out[1], b)).toBe(0);
    }
  });
});

describe.skipIf(!binary)('FrameGrabber against go2rtc and cam-sim', () => {
  async function setup() {
    const sim = await startSim();
    cleanup.push(() => sim.close());
    const g = new Go2rtc({ binary, rtspPort: await freePort(), apiPort: await freePort(), cam: 'cam1', source: { host: '127.0.0.1', port: sim.ports.rtsp, user: 'proxy', password: sim.password } });
    cleanup.push(() => g.stop());
    await g.start();
    const grabber = new FrameGrabber({ input: g.streamUrl('sub'), intervalS: 1, size: '896x512', tileSize: '160x90', quality: 5, tileQuality: 7, staleMs: 3000 });
    cleanup.push(() => grabber.stop());
    const frames: Frame[] = [];
    grabber.on('frame', (f: Frame) => frames.push(f));
    grabber.start();
    return { sim, grabber, frames };
  }

  it('delivers a still and a tile about once a second, stamped on whole seconds', async () => {
    const { frames, grabber } = await setup();
    await until(() => frames.length >= 4, 20000);
    expect(grabber.up()).toBe(true);
    const f = frames[1];
    expect(f.ts % 1000).toBe(0);
    expect(await sharp(f.still).metadata()).toMatchObject({ format: 'jpeg', width: 896, height: 512 });
    expect(await sharp(f.tile).metadata()).toMatchObject({ format: 'jpeg', width: 160, height: 90 });
    const gaps = frames.slice(1).map((x, i) => x.ts - frames[i].ts);
    expect(gaps.every((g) => g >= 1000 && g <= 3000)).toBe(true);
    expect(new Set(frames.map((x) => x.ts)).size).toBe(frames.length);
  }, 40000);

  it('stamps consecutive seconds without gaps on a steady stream', async () => {
    const { frames } = await setup();
    await until(() => frames.length >= 12, 30000);
    const gaps = frames.slice(3).map((x, i) => x.ts - frames[i + 2].ts); // skip the start-up frames
    const oneSecond = gaps.filter((g) => g === 1000).length;
    expect(oneSecond / gaps.length).toBeGreaterThanOrEqual(0.9);
  }, 40000);

  it('reports the stream down when the camera cuts it, and recovers', async () => {
    const { sim, grabber, frames } = await setup();
    await until(() => frames.length >= 2, 20000);
    sim.sim.engine.faults.set({ name: 'rtsp.reset' });
    await until(() => !grabber.up(), 20000);
    sim.sim.engine.faults.clear('rtsp.reset');
    const n = frames.length;
    await until(() => grabber.up() && frames.length > n + 1, 40000);
  }, 90000);

  it('stop() ends ffmpeg', async () => {
    const { grabber, frames } = await setup();
    await until(() => frames.length >= 1, 20000);
    const pid = grabber.pid()!;
    await grabber.stop();
    expect(() => process.kill(pid, 0)).toThrow();
  }, 40000);
});
