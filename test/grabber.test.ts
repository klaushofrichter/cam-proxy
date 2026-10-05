import { describe, it, expect, afterEach } from 'vitest';
import sharp from 'sharp';
import { Readable } from 'stream';
import { startSim } from './helpers/sim';
import { freePort } from './helpers/proxy';
import { Go2rtc } from '../src/stills/go2rtc';
import { FrameGrabber, splitJpegs, nextStamp, type Frame } from '../src/stills/grabber';

const binary = process.env.CAMPROXY_TEST_GO2RTC;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
const until = async (cond: () => boolean, ms: number) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('nextStamp', () => {
  const S = 1000;
  it('continues the sequence at the expected pace, despite arrival jitter', () => {
    expect(nextStamp(10_000, 11_300, S)).toBe(11_000);
    expect(nextStamp(11_000, 12_900, S)).toBe(12_000); // late, still its own slot
    expect(nextStamp(12_000, 13_050, S)).toBe(13_000);
  });
  it('drops a burst frame in the same slot instead of stamping it into the future', () => {
    expect(nextStamp(11_000, 11_100, S)).toBeNull();
    expect(nextStamp(11_000, 11_700, S)).toBeNull();
    // the stamp never runs ahead of the clock by more than a quarter interval
    for (const now of [11_000, 11_300, 11_760, 12_000, 12_400]) {
      const ts = nextStamp(11_000, now, S);
      if (ts !== null) expect(ts).toBeLessThanOrEqual(now + S / 4);
    }
  });
  it('keeps consecutive slots when the stream delivers a second late, then catches up (#61)', () => {
    // Measured on cam-sim's RTSP (4 s keyframe grid): ffmpeg's 1 fps output
    // arrives at +0, +1.0, +2.0, then +2.2 s (a second of frames comes in a
    // burst), then +4.0. Every output frame is its own stream second.
    const replay = (arrivals: number[]) => {
      let last = -1;
      const stamps: number[] = [];
      for (const now of arrivals) {
        const ts = nextStamp(last, now, S);
        if (ts === null) continue;
        expect(ts).toBeLessThanOrEqual(now + S / 4); // never into the future
        stamps.push((last = ts));
      }
      return stamps;
    };
    // Arrivals from a failing run (ms since a whole second): start-up pair,
    // then the 1 s / 1 s / 0.2 s / 1.8 s cycle.
    const failing = [38_409, 38_606, 40_402, 41_405, 42_400, 42_605, 44_499, 45_496, 46_500, 46_701, 48_495, 49_497, 50_498, 50_707, 52_499, 53_501];
    expect(replay(failing).length).toBe(failing.length - 1); // only the start-up pair shares a slot
    // Any phase against the clock, with up to 0.3 s of extra delay under load.
    for (let phase = 0; phase < 1000; phase += 50) {
      for (const load of [0, 300]) {
        const arrivals = Array.from({ length: 24 }, (_, k) => 100_000 + phase + k * 1000 + ((k + 1) % 4 ? 800 : 0) + (k % 3) * (load / 2));
        const stamps = replay(arrivals);
        const gaps = stamps.slice(3).map((x, i) => x - stamps[i + 2]);
        expect(gaps.every((g) => g === S), `phase ${phase} load ${load}: ${gaps}`).toBe(true);
      }
    }
  });
  it('resyncs to the clock after a stall, and starts on the clock', () => {
    expect(nextStamp(11_000, 20_500, S)).toBe(20_000);
    expect(nextStamp(-1, 20_500, S)).toBe(20_000);
    expect(nextStamp(-1, 20_500, 10 * S)).toBe(20_000);
  });
});

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
  async function setup(staleMs = 3000) {
    const sim = await startSim();
    cleanup.push(() => sim.close());
    const g = new Go2rtc({ binary, rtspPort: await freePort(), apiPort: await freePort(), sources: () => [{ cam: 'cam1', host: '127.0.0.1', port: sim.ports.rtsp, user: 'proxy', password: sim.password }] });
    cleanup.push(() => g.stop());
    await g.start();
    const grabber = new FrameGrabber({ input: g.streamUrl('cam1', 'sub'), intervalS: 1, size: '896x512', tileSize: '160x90', quality: 5, tileQuality: 7, staleMs });
    cleanup.push(() => grabber.stop());
    const frames: Frame[] = [];
    grabber.on('frame', (f: Frame) => frames.push(f));
    grabber.start();
    return { sim, grabber, frames, g };
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

  it('restarts ffmpeg when the stream stalls silently (no reset), and recovers', async () => {
    const { g, grabber, frames } = await setup(2000);
    await until(() => frames.length >= 2, 20000);
    const first = grabber.pid()!;
    process.kill(g.pid()!, 'SIGSTOP'); // go2rtc freezes: the socket stays open, no data
    try {
      await until(() => !grabber.up(), 10000);
      await until(() => grabber.pid() !== undefined && grabber.pid() !== first, 15000);
    } finally {
      process.kill(g.pid()!, 'SIGCONT');
    }
    const n = frames.length;
    await until(() => frames.length > n + 1, 40000);
  }, 90000);

  it('stop() ends ffmpeg', async () => {
    const { grabber, frames } = await setup();
    await until(() => frames.length >= 1, 20000);
    const pid = grabber.pid()!;
    await grabber.stop();
    expect(() => process.kill(pid, 0)).toThrow();
  }, 40000);
});
