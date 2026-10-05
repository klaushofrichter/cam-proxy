import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { InventoryRunner, type CheckResult } from '../src/inventory/runner';

const result = (n: number): CheckResult => ({ window: { from: null, to: 0, reason: 'test' }, counts: { n }, top: [], items: [], message: `n=${n}` });

describe('inventory runs per camera (spec §3.1)', () => {
  it('passes the camera to the check and records it in the report and the audit record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-invmulti-'));
    const writes: { camera?: string; details?: unknown }[] = [];
    const seen: string[] = [];
    const runner = new InventoryRunner({
      dir: join(dir, 'inventory'),
      audit: { write: (r: { camera?: string; details?: unknown }) => void writes.push(r) } as never,
      checks: { stills: { label: 'Stills', run: async (ctx) => (seen.push(ctx.cam), result(1)) } },
    });
    const { done } = runner.start('stills', { requestedBy: 'token' }, { cam: 'cam4' });
    const report = await done;
    expect(seen).toEqual(['cam4']);
    expect(report.camera).toBe('cam4');
    expect(writes.at(-1)?.camera).toBe('cam4');
  });

  it('one run at a time across cameras', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'camproxy-invmulti2-'));
    let release!: () => void;
    const runner = new InventoryRunner({
      dir: join(dir, 'inventory'), audit: { write: () => undefined } as never,
      checks: { stills: { label: 'Stills', run: () => new Promise((r) => (release = () => r(result(0)))) } },
    });
    const a = runner.start('stills', { requestedBy: 'token' }, { cam: 'cam3' });
    expect(() => runner.start('stills', { requestedBy: 'token' }, { cam: 'cam4' })).toThrow(/an inventory is running/);
    release();
    await a.done;
  });
});
