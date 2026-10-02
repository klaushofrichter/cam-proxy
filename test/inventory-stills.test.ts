import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import sharp from 'sharp';
import { AuditLog } from '../src/audit/audit-log';
import { openCatalog, type Catalog } from '../src/catalog/db';
import { insertClip } from '../src/catalog/clips';
import { MinuteStore, minutePath, readPackFooter } from '../src/stills/store';
import { stillsCheck, STARTUP_MS, OUTAGE_MS, type StillsInventoryDeps, type StillsSettings } from '../src/inventory/stills';
import type { CheckContext, Progress } from '../src/inventory/runner';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const M = Date.UTC(2026, 8, 27, 0, 10); // 2026-09-27 00:10 UTC: the fixture's first minute
const NOW = M + 11 * MIN + 5000; // the window ends at M + 10 min: minute 10 is left out
const at = (k: number, s = 0) => M + k * MIN + s * 1000;
const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const ALL = range(0, 60);

const stills: Buffer[] = [];
const tiles: Buffer[] = [];
let dir: string;
let catalog: Catalog;
let audit: AuditLog;

const store = (intervalS: number) =>
  new MinuteStore({ dataDir: dir, cam: 'cam1', intervalS, still: { size: '64x36', quality: 5 }, tile: { size: '16x9', grid: intervalS === 1 ? '10x6' : '6x5', quality: 7 } });
async function writeMinute(s: MinuteStore, k: number, slots: number[], intervalS = 1) {
  for (const i of slots) s.add({ ts: at(k) + i * intervalS * 1000, still: stills[i], tile: tiles[i] });
  await s.flush();
}
const settings = (o: Partial<StillsSettings> = {}): StillsSettings => ({ cam: 'cam1', intervalS: 1, stillsDays: 7, previewsDays: 14, keepHours: 24, ...o });
const deps = (o: Partial<StillsInventoryDeps> = {}): StillsInventoryDeps => ({ dataDir: dir, settings: () => settings(), audit, catalog, ...o });
const ctx = (o: Partial<CheckContext> = {}): CheckContext => ({ signal: new AbortController().signal, progress: () => undefined, now: NOW, ...o });
// A pack written by hand: `footer` is the JSON footer (any shape), `stills` bytes before it.
function rawPack(file: string, footer: unknown, stills = 0) {
  const json = Buffer.from(JSON.stringify(footer));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(json.length, 0);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([Buffer.alloc(stills, 1), json, len, Buffer.from('CPK1')]));
}
const fullFooter = (minute: number) => ({ v: 1, minute, intervalS: 1, size: '64x36', quality: 5, slots: range(0, 60).map((i) => [i * 10, 10]) });
// A proxy start; a clean one's previous stop is at `stop` (default 00:13:00, the start of the fixture's minute 3).
const start = (a: AuditLog, unclean: boolean, stop = at(3)) =>
  a.write({ action: 'proxy-start', category: ['process'], type: ['start'], outcome: 'success', user: 'system', message: 'started', details: { previousStop: unclean ? null : new Date(stop).toISOString(), uncleanStop: unclean } });

// The fixture, minute by minute from M (00:10 UTC):
//  0 full · 1 missing 10–19 · 2 full · 3 nothing (a clean proxy start at +20 s) ·
//  4 full, its sprite deleted · 5 an unreadable pack · 6 full ·
//  7 pack deleted, sprite kept (a crash start at +50 s) · 8 missing 0–29 ·
//  9 full at intervalS 2 · 10 full (left out: the minute being written)
// Clips: [1:15, 1:40) restores 5 s, [8:00, 8:15) restores 15 s, [9:00, 9:30) covers stills that are there.
beforeAll(async () => {
  for (let i = 0; i < 60; i++) {
    const background = { r: i * 4, g: 255 - i * 4, b: 100 };
    stills.push(await sharp({ create: { width: 64, height: 36, channels: 3, background } }).jpeg().toBuffer());
    tiles.push(await sharp({ create: { width: 16, height: 9, channels: 3, background } }).jpeg().toBuffer());
  }
  dir = mkdtempSync(join(tmpdir(), 'camproxy-inv-stills-'));
  const one = store(1);
  await writeMinute(one, 0, ALL);
  await writeMinute(one, 1, ALL.filter((i) => i < 10 || i >= 20));
  await writeMinute(one, 2, ALL);
  await writeMinute(one, 4, ALL);
  await writeMinute(one, 5, ALL);
  await writeMinute(one, 6, ALL);
  await writeMinute(one, 7, ALL);
  await writeMinute(one, 8, range(30, 60));
  await writeMinute(store(2), 9, range(0, 30), 2);
  await writeMinute(one, 10, ALL);
  rmSync(`${minutePath(dir, 'previews', 'cam1', at(4))}.json`);
  rmSync(`${minutePath(dir, 'previews', 'cam1', at(4))}.jpg`);
  writeFileSync(`${minutePath(dir, 'stills', 'cam1', at(5))}.pack`, 'garbage');
  rmSync(`${minutePath(dir, 'stills', 'cam1', at(7))}.pack`);

  catalog = openCatalog(join(dir, 'catalog.sqlite'));
  const clip = (s: number, e: number) => insertClip(catalog, { cam: 'cam1', start_ts: s, end_ts: e, path: join(dir, `clip-${s}.mp4`), stream: 'sub', size: 1, received_at: e, snapshot: null });
  clip(at(1, 15), at(1, 40));
  clip(at(8), at(8, 15));
  clip(at(9), at(9, 30));

  let clock = 0;
  audit = new AuditLog({ dir: join(dir, 'audit'), version: 't', camera: () => 'cam1', now: () => clock });
  clock = at(3, 20);
  start(audit, false);
  clock = at(7, 50);
  start(audit, true);
}, 60_000);

describe('readPackFooter', () => {
  it('reads a good footer and refuses a corrupt, short or missing pack', async () => {
    expect(await readPackFooter(`${minutePath(dir, 'stills', 'cam1', at(0))}.pack`)).toMatchObject({ v: 1, minute: at(0), intervalS: 1 });
    expect((await readPackFooter(`${minutePath(dir, 'stills', 'cam1', at(9))}.pack`))!.slots).toHaveLength(30);
    expect(await readPackFooter(`${minutePath(dir, 'stills', 'cam1', at(5))}.pack`)).toBeNull();
    writeFileSync(join(dir, 'short.pack'), 'CPK');
    expect(await readPackFooter(join(dir, 'short.pack'))).toBeNull();
    expect(await readPackFooter(join(dir, 'nope.pack'))).toBeNull();
  });

  it('accepts only an interval that divides the minute', async () => {
    for (const intervalS of [0.001, 7, 0, -1, 120, '1']) {
      rawPack(join(dir, 'bad-interval.pack'), { ...fullFooter(at(0)), intervalS }, 600);
      expect(await readPackFooter(join(dir, 'bad-interval.pack'))).toBeNull();
    }
    for (const intervalS of [1, 2, 5, 60]) {
      rawPack(join(dir, 'good-interval.pack'), { ...fullFooter(at(0)), intervalS }, 600);
      expect(await readPackFooter(join(dir, 'good-interval.pack'))).toMatchObject({ intervalS });
    }
  });

  it('reads a footer larger than the first tail read, and a pack smaller than it', async () => {
    rawPack(join(dir, 'big-footer.pack'), { ...fullFooter(at(0)), pad: 'x'.repeat(6000) }, 20_000);
    expect(await readPackFooter(join(dir, 'big-footer.pack'))).toMatchObject({ minute: at(0), intervalS: 1 });
    rawPack(join(dir, 'tiny.pack'), fullFooter(at(0)), 0);
    expect((await readPackFooter(join(dir, 'tiny.pack')))!.slots).toHaveLength(60);
  });
});

describe('stills inventory', () => {
  it('counts the missing seconds, the gaps, the restorable seconds and the file problems', async () => {
    const r = await stillsCheck(deps())(ctx());
    expect(r.window).toMatchObject({ from: M, to: at(10), reason: 'store-younger', retentionFrom: Date.UTC(2026, 8, 20), protectedFrom: NOW - 24 * HOUR });
    expect(r.counts).toEqual({
      stillsDays: 7, minutes: 10, packs: 8, expectedSeconds: 600, presentSeconds: 380, missingSeconds: 220, missingPct: 36.67,
      gaps: 4, explainedSeconds: 150, unexplainedSeconds: 70, restorableSeconds: 20,
      unreadablePacks: 1, packsWithoutSprite: 1, spritesWithoutPack: 1, previewsPruned: 0,
    });
    expect(r.items).toEqual([
      { type: 'pack-without-sprite', minute: at(4) },
      { type: 'unreadable-pack', minute: at(5) },
      { type: 'sprite-without-pack', minute: at(7) },
    ]);
    expect(r.message).toBe('3 min 40 s of 10 min missing (36.67%) since 2026-09-27T00:10:00.000Z, 4 gaps (longest 1 min 30 s), 2 min 30 s explained by proxy stops or camera reboots, 20 s restorable from clips (camera clock), 3 file problems');
    expect(r.window.notes).toEqual([expect.stringMatching(/^Restorable .*camera's clock.*not aligned/)]);
  });

  it('has no clock note when no clip covers a gap (nothing restorable)', async () => {
    const empty = openCatalog(join(dir, 'empty.sqlite'));
    const r = await stillsCheck(deps({ catalog: empty }))(ctx());
    expect(r.counts.restorableSeconds).toBe(0);
    expect(r.window.notes).toEqual([]);
  });

  it('lists the longest gaps first, explained by a clean or an unclean proxy start', async () => {
    const r = await stillsCheck(deps())(ctx());
    expect(r.top).toEqual([
      { from: at(7), to: at(8, 30), seconds: 90, explained: 'crash', explainedSeconds: 90 },
      { from: at(3), to: at(4), seconds: 60, explained: 'stop', explainedSeconds: 60 },
      { from: at(5), to: at(6), seconds: 60, explained: null, explainedSeconds: 0 },
      { from: at(1, 10), to: at(1, 20), seconds: 10, explained: null, explainedSeconds: 0 },
    ]);
  });

  it('retention: the window starts at the cutoff; a start explains up to 120 s past itself', async () => {
    expect(STARTUP_MS).toBe(120_000);
    let clock = Date.UTC(2026, 8, 27, 0, 1);
    const a2 = new AuditLog({ dir: join(dir, 'audit-2'), version: 't', camera: () => 'cam1', now: () => clock });
    start(a2, true);
    clock = 0;
    const r = await stillsCheck(deps({ settings: () => settings({ stillsDays: 0 }), audit: a2 }))(ctx());
    expect(r.window).toMatchObject({ from: Date.UTC(2026, 8, 27), to: at(10), reason: 'retention', retentionFrom: Date.UTC(2026, 8, 27) });
    expect(r.counts).toMatchObject({ stillsDays: 0, minutes: 20, expectedSeconds: 1200, missingSeconds: 820, gaps: 5, explainedSeconds: 180 });
    expect(r.top[0]).toEqual({ from: Date.UTC(2026, 8, 27), to: M, seconds: 600, explained: 'crash', explainedSeconds: 180 });
  });

  // Ruling (final review): a clean restart explains a gap only from its previous stop.
  it('a clean restart explains a gap only from the previous stop; the stall before it stays unexplained', async () => {
    const d4 = mkdtempSync(join(tmpdir(), 'camproxy-inv-stall-'));
    const D = Date.UTC(2026, 8, 26);
    for (const m of [...range(0, 10), ...range(370, 380)]) rawPack(`${minutePath(d4, 'stills', 'cam1', D + m * MIN)}.pack`, fullFooter(D + m * MIN), 600);
    let clock = 0;
    const a4 = new AuditLog({ dir: join(d4, 'audit'), version: 't', camera: () => 'cam1', now: () => clock });
    clock = D + 365 * MIN; // the grabber stalled at 00:10; the proxy stopped at 06:05 and started at 06:15
    start(a4, false, D + 355 * MIN);
    const r = await stillsCheck(deps({ dataDir: d4, audit: a4 }))(ctx({ now: D + 381 * MIN + 5000 }));
    expect(r.top).toEqual([{ from: D + 10 * MIN, to: D + 370 * MIN, seconds: 6 * 3600, explained: 'stop', explainedSeconds: 10 * 60 + 120 }]);
    expect(r.counts).toMatchObject({ missingSeconds: 6 * 3600, explainedSeconds: 720, unexplainedSeconds: 6 * 3600 - 720 });
  });

  it('a crash start (no stop time) still explains its gap from the gap start', async () => {
    const d5 = mkdtempSync(join(tmpdir(), 'camproxy-inv-crash-'));
    const D = Date.UTC(2026, 8, 26);
    for (const m of [...range(0, 10), ...range(370, 380)]) rawPack(`${minutePath(d5, 'stills', 'cam1', D + m * MIN)}.pack`, fullFooter(D + m * MIN), 600);
    let clock = 0;
    const a5 = new AuditLog({ dir: join(d5, 'audit'), version: 't', camera: () => 'cam1', now: () => clock });
    clock = D + 365 * MIN;
    start(a5, true);
    const r = await stillsCheck(deps({ dataDir: d5, audit: a5 }))(ctx({ now: D + 381 * MIN + 5000 }));
    expect(r.top[0]).toMatchObject({ explained: 'crash', explainedSeconds: 357 * 60 });
  });

  it('budget: a daily storage record saw older stills than are kept', async () => {
    const a3 = new AuditLog({ dir: join(dir, 'audit-3'), version: 't', camera: () => 'cam1', now: () => M - HOUR });
    a3.write({ action: 'storage-daily', category: ['host'], type: ['info'], outcome: 'success', user: 'system', message: 'Storage', details: { kinds: { stills: { oldest: M - 2 * DAY } } } });
    const r = await stillsCheck(deps({ audit: a3 }))(ctx());
    expect(r.window).toMatchObject({ from: M, reason: 'budget' });
  });

  it('an empty store: reason empty, nothing counted', async () => {
    const r = await stillsCheck(deps({ dataDir: mkdtempSync(join(tmpdir(), 'camproxy-inv-empty-')) }))(ctx());
    expect(r).toEqual({
      window: { from: null, to: at(10), reason: 'empty', retentionFrom: Date.UTC(2026, 8, 20), protectedFrom: NOW - 24 * HOUR, notes: [] },
      counts: expect.objectContaining({ minutes: 0, missingSeconds: 0, gaps: 0 }),
      top: [], items: [], message: 'no stills stored',
    });
  });

  it('reports progress per day, and stops walking once cancelled', async () => {
    const seen: Progress[] = [];
    await stillsCheck(deps())(ctx({ progress: (p) => seen.push(p) }));
    expect(seen[0]).toEqual({ phase: 'stills', done: 0, total: 1 });
    expect(seen.at(-1)).toEqual({ phase: 'stills', done: 1, total: 1, note: '2026-09-27' });
    const ac = new AbortController();
    ac.abort();
    const r = await stillsCheck(deps())(ctx({ signal: ac.signal }));
    expect(r.window).toMatchObject({ from: M });
    expect(r.counts).toMatchObject({ minutes: 0, missingSeconds: 0, gaps: 0 });
  });
});

// Ruling (ledger): camera reboots and power-cycles also explain a gap that
// overlaps them, from the request (a power-cycle: the cut) to the camera's
// answer plus STARTUP_MS; without an end record, OUTAGE_MS after the start.
describe('stills inventory: camera reboots and power-cycles', () => {
  const rec = (a: AuditLog, action: string, outcome: 'success' | 'failure' | 'unknown', details: Record<string, unknown>) =>
    a.write({ action, category: ['host'], type: [details.phase === 'requested' ? 'change' : 'end'], outcome, user: 'admin', message: action, details });
  const log = (name: string, write: (a: AuditLog, set: (t: number) => void) => void) => {
    let clock = 0;
    const a = new AuditLog({ dir: join(dir, name), version: 't', camera: () => 'cam1', now: () => clock });
    start(a, false); // clock 0: outside the window
    write(a, (t) => void (clock = t));
    return a;
  };

  it('a reboot explains the gap it overlaps; a power-cycle counts from its cut', async () => {
    const a = log('audit-reboot', (a, set) => {
      set(at(4, 58));
      rec(a, 'camera-reboot', 'success', { phase: 'requested', confirmed: true, requestedBy: 'session' });
      set(at(5, 30));
      rec(a, 'camera-reboot', 'success', { phase: 'back', downSec: 32, confirmed: true });
      set(at(1, 13)); // the request record is written once PoE is on again
      rec(a, 'camera-powercycle', 'success', { phase: 'requested', offSeconds: 1, watts: 3, offAt: at(1, 12), onAt: at(1, 13) });
      set(at(1, 15));
      rec(a, 'camera-powercycle', 'success', { phase: 'back', downSec: 3 });
    });
    const r = await stillsCheck(deps({ audit: a }))(ctx());
    expect(r.top).toEqual([
      { from: at(7), to: at(8, 30), seconds: 90, explained: 'reboot', explainedSeconds: 30 }, // back at 5:30, + 120 s
      { from: at(3), to: at(4), seconds: 60, explained: 'powercycle', explainedSeconds: 15 }, // back at 1:15, + 120 s
      { from: at(5), to: at(6), seconds: 60, explained: 'reboot', explainedSeconds: 60 },
      { from: at(1, 10), to: at(1, 20), seconds: 10, explained: 'powercycle', explainedSeconds: 8 }, // from the cut at 1:12
    ]);
    expect(r.counts).toMatchObject({ explainedSeconds: 113, unexplainedSeconds: 107 });
  });

  it('a request that never reached the camera explains nothing', async () => {
    const a = log('audit-reboot-2', (a, set) => {
      set(at(5, 1));
      rec(a, 'camera-reboot', 'failure', { phase: 'requested', confirmed: false, requestedBy: 'session' });
      rec(a, 'camera-powercycle', 'failure', { phase: 'requested', offSeconds: 1, poeOff: false });
    });
    const r = await stillsCheck(deps({ audit: a }))(ctx());
    expect(r.counts).toMatchObject({ explainedSeconds: 0 });
    expect(r.top.every((g) => (g as { explained: unknown }).explained === null)).toBe(true);
  });

  it('a reboot without an end record lasts OUTAGE_MS, then STARTUP_MS', async () => {
    expect(OUTAGE_MS).toBe(300_000);
    const a = log('audit-reboot-4', (a, set) => {
      set(at(0, 40));
      rec(a, 'camera-reboot', 'unknown', { phase: 'requested', confirmed: false, requestedBy: 'token' }); // [0:40, 7:40)
    });
    const r = await stillsCheck(deps({ audit: a }))(ctx());
    expect(r.top).toEqual([
      { from: at(7), to: at(8, 30), seconds: 90, explained: 'reboot', explainedSeconds: 40 },
      { from: at(3), to: at(4), seconds: 60, explained: 'reboot', explainedSeconds: 60 },
      { from: at(5), to: at(6), seconds: 60, explained: 'reboot', explainedSeconds: 60 },
      { from: at(1, 10), to: at(1, 20), seconds: 10, explained: 'reboot', explainedSeconds: 10 },
    ]);
  });

  it('a failed power-cycle that cut the PoE explains the gap; overlapping causes count once', async () => {
    const a = log('audit-reboot-3', (a, set) => {
      set(at(3, 0));
      rec(a, 'camera-reboot', 'success', { phase: 'requested', confirmed: true, requestedBy: 'session' });
      set(at(3, 5));
      rec(a, 'camera-reboot', 'success', { phase: 'back', downSec: 5, confirmed: true }); // [3:00, 5:05)
      set(at(3, 20));
      start(a, false); // [3:00, 5:20): ties with the reboot in its gap; the proxy start names it
      set(at(5, 30));
      rec(a, 'camera-powercycle', 'failure', { phase: 'requested', offSeconds: 1, poeOff: true, turnedOn: true });
      set(at(5, 40));
      rec(a, 'camera-powercycle', 'success', { phase: 'back', downSec: 10 }); // [5:30, 7:40)
    });
    const r = await stillsCheck(deps({ audit: a }))(ctx());
    expect(r.top).toEqual([
      { from: at(7), to: at(8, 30), seconds: 90, explained: 'powercycle', explainedSeconds: 40 },
      { from: at(3), to: at(4), seconds: 60, explained: 'stop', explainedSeconds: 60 },
      { from: at(5), to: at(6), seconds: 60, explained: 'powercycle', explainedSeconds: 35 },
      { from: at(1, 10), to: at(1, 20), seconds: 10, explained: null, explainedSeconds: 0 },
    ]);
    expect(r.counts).toMatchObject({ explainedSeconds: 135, unexplainedSeconds: 85 });
  });
});

describe('stills inventory: previews pruned before stills, cancel, audit reads', () => {
  const NOW2 = Date.UTC(2026, 8, 27, 0, 0, 30);
  const A = Date.UTC(2026, 8, 22, 10, 0); // before dayStart(now − 3 d): previews gone by retention
  const B = Date.UTC(2026, 8, 25, 10, 0); // after it, but before the oldest preview (a cap pruned it)
  const C = Date.UTC(2026, 8, 26, 10, 0); // the oldest preview
  const E = Date.UTC(2026, 8, 26, 10, 5); // a newer minute that lost its sprite: a file problem

  it('flags packs without a sprite only where previews are kept; earlier ones count as previewsPruned', async () => {
    const d2 = mkdtempSync(join(tmpdir(), 'camproxy-inv-prev-'));
    const s = new MinuteStore({ dataDir: d2, cam: 'cam1', intervalS: 1, still: { size: '64x36', quality: 5 }, tile: { size: '16x9', grid: '10x6', quality: 7 } });
    for (const m of [A, B, C, E]) {
      for (const i of ALL) s.add({ ts: m + i * 1000, still: stills[i], tile: tiles[i] });
      await s.flush();
    }
    for (const m of [A, B, E]) for (const ext of ['json', 'jpg']) rmSync(`${minutePath(d2, 'previews', 'cam1', m)}.${ext}`);
    const r = await stillsCheck(deps({ dataDir: d2, settings: () => settings({ stillsDays: 7, previewsDays: 3 }) }))(ctx({ now: NOW2 }));
    expect(r.counts).toMatchObject({ packs: 4, packsWithoutSprite: 1, previewsPruned: 2 });
    expect(r.items).toEqual([{ type: 'pack-without-sprite', minute: E }]);
  });

  it('a cancel lands within a day, not only between days', async () => {
    const d3 = mkdtempSync(join(tmpdir(), 'camproxy-inv-cancel-'));
    const day = Date.UTC(2026, 8, 26);
    for (let m = day; m < day + 600 * MIN; m += MIN) rawPack(`${minutePath(d3, 'stills', 'cam1', m)}.pack`, fullFooter(m), 600);
    let reads = 0;
    const signal = { get aborted() { return reads++ >= 1; } } as AbortSignal; // cancelled right after the walk begins
    const r = await stillsCheck(deps({ dataDir: d3 }))(ctx({ now: NOW2, signal }));
    expect(r.counts.minutes).toBeGreaterThan(0);
    expect(r.counts.minutes).toBeLessThan(600);
  });

  it('reads the audit log once for all the actions it needs', async () => {
    const calls: unknown[] = [];
    const counting = { list: (q: Parameters<AuditLog['list']>[0]) => (calls.push(q), audit.list(q)) };
    await stillsCheck(deps({ audit: counting, dataDir: dir, settings: () => settings({ stillsDays: 0 }) }))(ctx());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ actions: expect.arrayContaining(['storage-daily', 'proxy-start', 'camera-reboot', 'camera-powercycle']) });
  });
});
