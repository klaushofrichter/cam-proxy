import { beforeEach, describe, expect, it } from 'vitest';
import { LiveSources, type LiveGo2rtc } from '../src/stream/live-sources';
import type { StreamSource } from '../src/stills/go2rtc';

// #296: live video without stills. A camera without stills gets its go2rtc
// stream on demand for live clients, removed after the last one leaves; the
// host go2rtc is started for it when none runs, and stopped again when
// nothing else needs it. A camera with stills keeps its stream as it is.
class FakeGo2rtc implements LiveGo2rtc {
  calls: string[] = [];
  isUp = true;
  up = () => this.isUp;
  ready = () => (this.isUp ? Promise.resolve() : new Promise<void>(() => undefined));
  wsUrl = (cam: string, stream: 'sub' | 'main') => `ws://go2rtc/${cam}_${stream}`;
  setStream = async (s: StreamSource) => void this.calls.push(`set ${s.cam}`);
  removeStream = async (cam: string) => void this.calls.push(`remove ${cam}`);
}

let host: FakeGo2rtc | undefined;
let started: number;
let stopped: number;
let stills: Set<string>;
let srcs: LiveSources;
const source = (cam: string): StreamSource => ({ cam, host: '192.0.2.3', port: 554, user: 'proxy', password: 'pw' });

beforeEach(() => {
  host = undefined;
  started = 0;
  stopped = 0;
  stills = new Set();
  srcs = new LiveSources({
    go2rtc: () => host,
    start: () => (started++, (host = new FakeGo2rtc())),
    stop: async () => void (stopped++, (host = undefined)),
    stillsOn: (cam) => stills.has(cam),
    anyStills: () => stills.size > 0,
    source,
    readyMs: 50,
  });
});

describe('LiveSources', () => {
  it('stills off everywhere: go2rtc starts with the first client and stops after the last', async () => {
    const a = await srcs.acquire('cam1');
    expect(a).toBe(host);
    expect(started).toBe(1);
    expect(srcs.users('cam1')).toBe(1);
    expect(host!.calls).toEqual(['set cam1']);
    const g = host!;
    expect(await srcs.acquire('cam1')).toBe(g);
    expect(g.calls).toEqual(['set cam1']); // the second client shares the stream
    await srcs.release('cam1');
    expect([stopped, g.calls]).toEqual([0, ['set cam1']]);
    await srcs.release('cam1');
    expect(stopped).toBe(1); // the go2rtc goes, with its streams
    expect(g.calls).toEqual(['set cam1']);
    expect(srcs.users()).toBe(0);
    expect(srcs.users('cam1')).toBe(0);
  });

  it('two cameras: go2rtc stops only after the last client of either', async () => {
    await srcs.acquire('cam1');
    await srcs.acquire('cam2');
    expect(started).toBe(1);
    await srcs.release('cam1');
    expect(stopped).toBe(0);
    expect(host!.calls).toEqual(['set cam1', 'set cam2', 'remove cam1']);
    await srcs.release('cam2');
    expect(stopped).toBe(1);
  });

  it('a camera with stills: its stream and the go2rtc are left as they are', async () => {
    stills.add('cam1');
    host = new FakeGo2rtc();
    const g = host;
    expect(await srcs.acquire('cam1')).toBe(g);
    await srcs.release('cam1');
    expect([started, stopped, g.calls]).toEqual([0, 0, []]);
  });

  it('another camera has stills: this one\'s stream comes and goes, the go2rtc stays', async () => {
    stills.add('cam2');
    host = new FakeGo2rtc();
    const g = host;
    await srcs.acquire('cam1');
    await srcs.release('cam1');
    expect([started, stopped, g.calls]).toEqual([0, 0, ['set cam1', 'remove cam1']]);
  });

  it('go2rtc not up in time: null, nothing held, the go2rtc it started stopped again', async () => {
    srcs = new LiveSources({
      go2rtc: () => host,
      start: () => {
        started++;
        host = new FakeGo2rtc();
        host.isUp = false;
        return host;
      },
      stop: async () => void (stopped++, (host = undefined)),
      stillsOn: () => false,
      anyStills: () => false,
      source,
      readyMs: 50,
    });
    expect(await srcs.acquire('cam1')).toBeNull();
    expect([srcs.users(), started, stopped]).toEqual([0, 1, 1]);
  });

  it('no go2rtc can be made: null', async () => {
    srcs = new LiveSources({ go2rtc: () => undefined, start: () => undefined, stop: async () => undefined, stillsOn: () => false, anyStills: () => false, source, readyMs: 50 });
    expect(await srcs.acquire('cam1')).toBeNull();
    expect(srcs.users()).toBe(0);
  });

  it('a release without an acquire changes nothing', async () => {
    await srcs.release('cam1');
    expect([started, stopped, srcs.users()]).toEqual([0, 0, 0]);
  });

  it('concurrent acquires and releases run one at a time', async () => {
    await Promise.all([srcs.acquire('cam1'), srcs.acquire('cam1'), srcs.acquire('cam2')]);
    expect(started).toBe(1);
    expect(host!.calls.sort()).toEqual(['set cam1', 'set cam2']);
    await Promise.all([srcs.release('cam1'), srcs.release('cam1'), srcs.release('cam2')]);
    expect(stopped).toBe(1);
  });
});
