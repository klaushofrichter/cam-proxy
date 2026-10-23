// The completeness check on the receiving side (step 4 spec §3): per chunk,
// the sender's listing against what the target verified; the counts per kind.
import { describe, expect, it } from 'vitest';
import { compareChunk, tallyCheck, type ManifestFile } from '../src/moves/check';
import { MoveTarget, type TargetDeps } from '../src/moves/target';
import type { MoveRecord } from '../src/moves/journal';
import type { MoveEvent } from '../src/moves/types';
import { strict, why } from './helpers/contract';

const f = (path: string): ManifestFile => ({ path, size: 1, sha256: '0'.repeat(64) });

describe('compareChunk', () => {
  it('compareChunk sorts listed files into missing, failed and expired', () => {
    expect(compareChunk({ kind: 'clips', listed: [f('a'), f('b'), f('c')], verified: new Set(['a']), failed: new Set(['b']), expired: new Set(['x']) }))
      .toEqual({ missing: ['c'], failed: ['b'], expired: ['x'] });
  });

  it('an expired path still listed is not expired; a verified one is neither missing nor failed', () => {
    expect(compareChunk({ kind: 'stills', listed: [f('a'), f('x')], verified: new Set(['a', 'x']), failed: new Set(['a']), expired: new Set(['x', 'y']) }))
      .toEqual({ missing: [], failed: [], expired: ['y'] });
  });

  it('a failed file no longer listed stays failed', () => {
    expect(compareChunk({ kind: 'clips', listed: [], verified: new Set(), failed: new Set(['b']), expired: new Set() }))
      .toEqual({ missing: [], failed: ['b'], expired: [] });
  });
});

describe('tallyCheck', () => {
  it('tallyCheck is complete only without missing and failed', () => {
    expect(tallyCheck([{ kind: 'stills', missing: 0, recovered: 2, failed: 0, expired: 1 }])).toEqual({ complete: true, missing: {}, recovered: { stills: 2 }, failed: {}, expired: { stills: 1 } });
    expect(tallyCheck([
      { kind: 'clips', missing: 1, recovered: 0, failed: 0, expired: 0 },
      { kind: 'clips', missing: 2, recovered: 1, failed: 3, expired: 0 },
      { kind: 'archive', missing: 0, recovered: 0, failed: 1, expired: 0 },
    ])).toEqual({ complete: false, missing: { clips: 3 }, recovered: { clips: 1 }, failed: { clips: 3, archive: 1 }, expired: {} });
    expect(tallyCheck([])).toEqual({ complete: true, missing: {}, recovered: {}, failed: {}, expired: {} });
  });
});

describe('MoveTarget.setPhase', () => {
  it('puts check, keepDays and returnPending on the move.phase event (contract-valid)', () => {
    const events: MoveEvent[] = [];
    const audits: unknown[] = [];
    const t = new MoveTarget({ journal: { load: () => null, save: () => undefined, active: () => [] }, emit: (e: MoveEvent) => events.push(e), audit: { write: (r: unknown) => (audits.push(r), null) }, proxyId: () => 'prx_2123456789ABCDEFGHJK' } as unknown as TargetDeps);
    const r = { id: 'mv_0123456789ABCDEFGHJK', role: 'target', camera: 'cam9', phase: 'copying', peer: { proxyId: 'prx_1123456789ABCDEFGHJK', name: 'een' } } as unknown as MoveRecord;
    const check = { complete: false, missing: {}, recovered: { clips: 1 }, failed: { clips: 1 }, expired: {} };
    t.setPhase(r, 'copied', { detail: 'done', check, keepDays: 30, returnPending: true });
    expect(events).toEqual([{ kind: 'move.phase', moveId: r.id, role: 'target', phase: 'copied', ok: true, detail: 'done', check, keepDays: 30, returnPending: true }]);
    const envelope = { v: 1, type: 'event', id: '01K60000000000000000000003', seq: 3, ts: 1791273600003, body: { proxyId: 'prx_0123456789ABCDEFGHJK', connId: 'con_0123456789ABCDEFGHJK', ...events[0] }, sig: 'JojJ327EFbgVe76kOH467QFrkhQ65wwqRg5NhfAxO7okv/1ohIH+jMV0iNBquQLoWaHyOEe5qJ+wvykQ/qwUDw==' };
    expect(strict('event')(envelope), why(strict('event'))).toBe(true);
    // Without them, the event carries none of the three.
    t.setPhase(r, 'finished');
    expect(events[1]).toEqual({ kind: 'move.phase', moveId: r.id, role: 'target', phase: 'finished', ok: true });
  });
});
