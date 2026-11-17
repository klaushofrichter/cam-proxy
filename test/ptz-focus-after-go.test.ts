import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { CameraError } from '../src/camera/client';
import { PRESET_SLOTS, type PresetSlot, type ReolinkPtz } from '../src/camera/ptz';
import { FocusAfterGo, GO_FOCUS_CAP_MS, GO_FOCUS_TICK_MS, type FocusOutcome } from '../src/ptz/focus-after-go';
import { MoveLease } from '../src/ptz/lease';
import { PtzPositions } from '../src/ptz/positions';

// A camera whose pan/tilt/zoom readings follow a script: each GetPtzCurPos
// takes the next entry (the last one repeats; its zoom stands for Zpos), and
// GetZoomFocus answers the zoom of the last entry read.
class FakeCam {
  calls: string[] = [];
  script: Array<{ pan: number; tilt: number; zoom: number }> = [];
  zoomNow = 7;
  failPosition = false;
  slots: PresetSlot[] = Array.from({ length: PRESET_SLOTS }, (_, id) => ({ id, enabled: false, name: `pos${id + 1}` }));
  private tick = 0;
  private cur() {
    return this.script[Math.min(this.tick, this.script.length - 1)];
  }
  async position(): Promise<{ pan: number; tilt: number; zoom: number }> {
    this.calls.push('position');
    if (this.failPosition) throw new CameraError('camera_error', 'not exist');
    const c = this.cur();
    this.tick++;
    return { pan: c.pan, tilt: c.tilt, zoom: c.zoom };
  }
  async zoomPos(): Promise<number> {
    this.calls.push('zoom');
    if (!this.script.length || this.tick === 0) return this.zoomNow;
    return this.script[Math.min(this.tick - 1, this.script.length - 1)].zoom;
  }
  async focusAt(zoom: number): Promise<void> {
    this.calls.push(`focus ${zoom}`);
  }
  async goTo(slot: number): Promise<void> {
    this.calls.push(`goto ${slot}`);
  }
  async stop(): Promise<void> {
    this.calls.push('stop');
  }
  async presets(): Promise<PresetSlot[]> {
    return this.slots.map((s) => ({ ...s }));
  }
  async savePreset(slot: number, name: string): Promise<void> {
    this.slots[slot] = { id: slot, enabled: true, name };
  }
}

const at = (pan: number, tilt: number, zoom: number) => ({ pan, tilt, zoom });

let cam: FakeCam;
let lease: MoveLease;
let enabled: boolean;
let focus: FocusAfterGo;

beforeEach(() => {
  vi.useFakeTimers();
  cam = new FakeCam();
  lease = new MoveLease({ stop: () => cam.stop() });
  enabled = true;
  focus = new FocusAfterGo({ cam: 'e1', lease, ptz: cam as unknown as ReolinkPtz, enabled: () => enabled });
});
afterEach(() => vi.useRealTimers());

// Starts a settle as a go would: the lease's mark taken when the go was sent.
const go = (before: number): Promise<FocusOutcome> => {
  void lease.then(async () => void cam.calls.push('goto'));
  return focus.start(before, lease.mark());
};

describe('FocusAfterGo (focus after going to a saved position)', () => {
  it('settles (two equal readings) at the same zoom → one autofocus at that zoom', async () => {
    cam.script = [at(100, 0, 7), at(200, 5, 7), at(300, 9, 7), at(300, 9, 7)];
    const p = go(7);
    await vi.advanceTimersByTimeAsync(GO_FOCUS_TICK_MS * 4);
    expect(await p).toBe('focused');
    expect(cam.calls).toEqual(['goto', ...Array(4).fill('position'), 'zoom', 'focus 7']);
  });

  it('settles at another zoom → the camera refocuses by itself: no autofocus', async () => {
    cam.script = [at(100, 0, 9), at(100, 0, 14), at(100, 0, 20), at(100, 0, 20)];
    const p = go(7);
    await vi.advanceTimersByTimeAsync(GO_FOCUS_TICK_MS * 4);
    expect(await p).toBe('self');
    expect(cam.calls.filter((c) => c.startsWith('focus'))).toEqual([]);
  });

  it('polls about every 300 ms, one read (GetPtzCurPos) per tick, nothing before the first tick', async () => {
    cam.script = [at(1, 0, 7), at(2, 0, 7), at(3, 0, 7), at(3, 0, 7)];
    const p = go(7);
    await vi.advanceTimersByTimeAsync(GO_FOCUS_TICK_MS - 1);
    expect(cam.calls).toEqual(['goto']);
    await vi.advanceTimersByTimeAsync(1);
    expect(cam.calls).toEqual(['goto', 'position']);
    await vi.advanceTimersByTimeAsync(GO_FOCUS_TICK_MS);
    expect(cam.calls).toEqual(['goto', 'position', 'position']);
    await vi.advanceTimersByTimeAsync(GO_FOCUS_TICK_MS * 2);
    expect(await p).toBe('focused');
    // GetZoomFocus (the scale focusAt takes) once, after settling.
    expect(cam.calls).toEqual(['goto', ...Array(4).fill('position'), 'zoom', 'focus 7']);
  });

  it('settles on Zpos too: a zoom still travelling at a standing pan/tilt is not settled', async () => {
    cam.script = [at(3, 0, 7), at(3, 0, 9), at(3, 0, 12), at(3, 0, 12)];
    const p = go(7);
    await vi.advanceTimersByTimeAsync(GO_FOCUS_TICK_MS * 4);
    expect(await p).toBe('self');
    expect(cam.calls.filter((c) => c === 'position')).toHaveLength(4);
  });

  it.each([
    ['a move', () => void lease.move(async () => void cam.calls.push('move'), 400)],
    ['a zoom', () => void lease.move(async () => void cam.calls.push('zoom-in'), 400, { zoom: 'in' })],
    ['a stop', () => void lease.stop()],
    ['another go or an autofocus (lease.then)', () => void lease.then(async () => void cam.calls.push('other'))],
  ])('%s while it settles cancels it: no more reads, no autofocus', async (_n, act) => {
    cam.script = [at(1, 0, 7), at(2, 0, 7), at(3, 0, 7), at(3, 0, 7)];
    const p = go(7);
    await vi.advanceTimersByTimeAsync(GO_FOCUS_TICK_MS);
    act();
    const reads = cam.calls.filter((c) => c === 'position').length;
    await vi.advanceTimersByTimeAsync(GO_FOCUS_TICK_MS * 6);
    expect(await p).toBe('cancelled');
    expect(cam.calls.filter((c) => c === 'position').length).toBe(reads);
    expect(cam.calls.filter((c) => c.startsWith('focus'))).toEqual([]);
  });

  it('an action queued between the settled reading and the autofocus wins: no autofocus', async () => {
    cam.script = [at(2, 0, 7), at(3, 0, 7)];
    // The settling read finishes, then a user's move takes the lease before
    // the autofocus runs.
    const orig = cam.position.bind(cam);
    let n = 0;
    cam.position = async () => {
      const r = await orig();
      if (++n === 3) void lease.move(async () => void cam.calls.push('move'), 400);
      return r;
    };
    const p = go(7);
    await vi.advanceTimersByTimeAsync(GO_FOCUS_TICK_MS * 4);
    expect(await p).toBe('cancelled');
    expect(cam.calls).toContain('move');
    expect(cam.calls.filter((c) => c.startsWith('focus'))).toEqual([]);
  });

  it('gives up quietly at the cap (20 s) when it never settles', async () => {
    let i = 0;
    cam.position = async () => (cam.calls.push('position'), { pan: i++, tilt: 0, zoom: 7 });
    const p = go(7);
    await vi.advanceTimersByTimeAsync(GO_FOCUS_CAP_MS + GO_FOCUS_TICK_MS * 2);
    expect(await p).toBe('timeout');
    expect(GO_FOCUS_CAP_MS).toBe(20_000);
    const reads = cam.calls.filter((c) => c === 'position').length;
    expect(reads).toBeLessThanOrEqual(GO_FOCUS_CAP_MS / GO_FOCUS_TICK_MS + 1);
    expect(reads).toBeGreaterThan(50);
    expect(cam.calls.filter((c) => c.startsWith('focus'))).toEqual([]);
    await vi.advanceTimersByTimeAsync(GO_FOCUS_TICK_MS * 10);
    expect(cam.calls.filter((c) => c === 'position').length).toBe(reads);
  });

  it('a failed read (a camera without GetPtzCurPos) gives up: no autofocus, never throws', async () => {
    cam.failPosition = true;
    const p = go(7);
    await vi.advanceTimersByTimeAsync(GO_FOCUS_TICK_MS * 3);
    expect(await p).toBe('failed');
    expect(cam.calls.filter((c) => c === 'position')).toHaveLength(1);
    expect(cam.calls.filter((c) => c.startsWith('focus'))).toEqual([]);
  });

  it('zoomBefore: the zoom, or undefined when the read fails', async () => {
    cam.zoomNow = 12;
    expect(await focus.zoomBefore()).toBe(12);
    cam.zoomPos = async () => {
      throw new CameraError('camera_error', 'x');
    };
    expect(await focus.zoomBefore()).toBeUndefined();
  });
});

describe('PtzPositions.goTo with FocusAfterGo', () => {
  let catalog: Catalog;
  let svc: PtzPositions;
  beforeEach(() => {
    catalog = openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-afgo-')), 'catalog.sqlite'));
    svc = new PtzPositions({ cam: 'e1', catalog, ptz: cam as unknown as ReolinkPtz, lease, online: () => true, changed: () => undefined, focus });
  });
  afterEach(() => catalog.close());

  it('reads the zoom before ToPos, answers at once, then focuses in the background (same zoom)', async () => {
    const a = await svc.save('Gate');
    cam.calls = [];
    cam.zoomNow = 7;
    await svc.goTo(a.id);
    expect(cam.calls).toEqual(['zoom', 'goto 0']);
    cam.script = [at(4, 0, 7), at(5, 0, 7), at(5, 0, 7)];
    await vi.advanceTimersByTimeAsync(GO_FOCUS_TICK_MS * 3);
    expect(cam.calls).toEqual(['zoom', 'goto 0', 'position', 'position', 'position', 'zoom', 'focus 7']);
  });

  it('a camera without autofocus: no zoom read, no settle, no focus', async () => {
    enabled = false;
    const a = await svc.save('Gate');
    cam.calls = [];
    await svc.goTo(a.id);
    await vi.advanceTimersByTimeAsync(GO_FOCUS_CAP_MS);
    expect(cam.calls).toEqual(['goto 0']);
  });

  it('a failed zoom read before ToPos still goes, with no focus after it', async () => {
    const a = await svc.save('Gate');
    cam.calls = [];
    cam.zoomPos = async () => {
      cam.calls.push('zoom');
      throw new CameraError('camera_error', 'x');
    };
    await svc.goTo(a.id);
    await vi.advanceTimersByTimeAsync(GO_FOCUS_TICK_MS * 5);
    expect(cam.calls).toEqual(['zoom', 'goto 0']);
  });

  it('a second go cancels the first one\'s settle; only the second focuses', async () => {
    const a = await svc.save('Gate');
    const b = await svc.save('Tree');
    cam.calls = [];
    cam.script = [at(5, 0, 7)];
    await svc.goTo(a.id);
    await vi.advanceTimersByTimeAsync(GO_FOCUS_TICK_MS);
    await svc.goTo(b.id);
    await vi.advanceTimersByTimeAsync(GO_FOCUS_TICK_MS * 4);
    expect(cam.calls.filter((c) => c.startsWith('focus') || c.startsWith('goto'))).toEqual(['goto 0', 'goto 1', 'focus 7']);
  });
});
