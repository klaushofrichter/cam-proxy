// move.summary (cams-admin pre-summary): the summary a move.request would
// carry, read only (no event, no move journal record, no audit of its own),
// cached for 30 s so a page polling it does not walk 55k stills each time.
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ARGS_VALIDATORS } from '../src/fleet/command-args';
import { entryFor, IMPLEMENTED, MOVE_COMMANDS } from '../src/fleet/policy';
import { moveHandlers } from '../src/moves/commands';
import { summarize } from '../src/moves/inventory';
import { MoveSource, type SourceDeps } from '../src/moves/source';
import { strict, why } from './helpers/contract';

const TARGET = 'prx_1123456789ABCDEFGHJK';

// A source over a data dir with one still of cam3 and an empty catalog.
function unit() {
  const dataDir = mkdtempSync(join(tmpdir(), 'camproxy-movesum-'));
  const still = join(dataDir, 'stills', 'cam3', '2026', '10', '25');
  mkdirSync(still, { recursive: true });
  writeFileSync(join(still, '1200.jpg'), Buffer.alloc(100));
  const db = { prepare: () => ({ all: () => [] }) };
  const inventory = { catalog: { db }, dataDir } as unknown as SourceDeps['inventory'];
  let t = 1_000_000;
  const events: unknown[] = [];
  const writes: unknown[] = [];
  const saves: unknown[] = [];
  const cameras = { cam3: { id: 'cam3', host: '192.0.2.3', protocol: 'https', user: 'proxy' } };
  const s = new MoveSource({
    running: () => ({ cameras, cameraOrder: ['cam3'], camera: cameras.cam3, tls: { site: 't', cameraCerts: true } }),
    loaded: () => ({}),
    siteReady: () => true, sendAllowed: () => true, inventory, now: () => t,
    emit: (e: unknown) => events.push(e), audit: { write: (r: unknown) => writes.push(r) },
    journal: { active: () => [], save: (r: unknown) => saves.push(r), all: () => [], load: () => undefined },
  } as unknown as SourceDeps);
  const run = (args: unknown) => s.handlers()['move.summary'](args, undefined as never);
  return { s, run, dataDir, inventory, events, writes, saves, still, advance: (ms: number) => (t += ms) };
}

describe('move.summary', () => {
  it('is a move.send command with a strict validator', () => {
    expect(MOVE_COMMANDS).toContain('move.summary');
    expect(IMPLEMENTED.has('move.summary')).toBe(true);
    expect(entryFor('move.summary', { v: 1, camera: 'cam3' })).toBe('move.send');
    const v = ARGS_VALIDATORS['move.summary'];
    expect(v({ v: 1, camera: 'cam3' })).toMatchObject({ ok: true });
    expect(v({ v: 1, camera: 'Cam 3' })).toMatchObject({ ok: false, code: 'invalid_args', detail: 'camera' });
    expect(v({ v: 1 })).toMatchObject({ ok: false, code: 'invalid_args', detail: 'camera' });
    expect(v({ v: 1, camera: 'cam3', extra: 1 })).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(v({ v: 2, camera: 'cam3' })).toMatchObject({ ok: false, code: 'unsupported_version' });
    const args = strict('commands/move.summary.args');
    expect(args({ v: 1, camera: 'cam3' }), why(args)).toBe(true);
    expect(args({ v: 1, camera: 'cam3', extra: 1 })).toBe(false);
  });

  it("answers the request's summary, without an event, a move record or an audit", async () => {
    const u = unit();
    const r = await u.run({ v: 1, camera: 'cam3' });
    expect(r.status).toBe('ok');
    expect(r.result).toEqual({ summary: summarize(u.inventory, 'cam3') });
    expect((r.result!.summary as Record<string, { files: number; bytes: number }>).stills).toMatchObject({ files: 1, bytes: 100 });
    const res = strict('commands/move.summary.result');
    expect(res(r.result), why(res)).toBe(true);
    expect([u.events, u.writes, u.saves]).toEqual([[], [], []]);
    // The same summary a request carries.
    u.s.request('cam3', TARGET, { actor: { origin: 'managed', label: 'x' }, user: 'x' });
    expect((u.events.at(-1) as { summary: unknown }).summary).toEqual(r.result!.summary);
  });

  it('is cached for 30 s; a request takes a fresh one and refreshes the cache', async () => {
    const u = unit();
    const first = (await u.run({ v: 1, camera: 'cam3' })).result!.summary as Record<string, { files: number }>;
    writeFileSync(join(u.still, '1201.jpg'), Buffer.alloc(50));
    u.advance(29_000);
    expect(((await u.run({ v: 1, camera: 'cam3' })).result!.summary as typeof first).stills.files).toBe(1);
    u.advance(2_000);
    expect(((await u.run({ v: 1, camera: 'cam3' })).result!.summary as typeof first).stills.files).toBe(2);
    writeFileSync(join(u.still, '1202.jpg'), Buffer.alloc(50));
    u.s.request('cam3', TARGET, { actor: { origin: 'managed', label: 'x' }, user: 'x' });
    expect((u.events.at(-1) as { summary: typeof first }).summary.stills.files).toBe(3);
    expect(((await u.run({ v: 1, camera: 'cam3' })).result!.summary as typeof first).stills.files).toBe(3);
  });

  it('an unknown camera fails unknown_camera', async () => {
    const u = unit();
    expect(await u.run({ v: 1, camera: 'cam7' })).toEqual({ status: 'failed', code: 'unknown_camera' });
    expect([u.events, u.writes]).toEqual([[], []]);
  });

  it('a proxy without the source side answers internal', async () => {
    expect(await moveHandlers({ emit: () => {}, audit: { write: () => true } as never })['move.summary']({ v: 1, camera: 'cam3' }, undefined as never)).toEqual({ status: 'failed', code: 'internal' });
  });
});
