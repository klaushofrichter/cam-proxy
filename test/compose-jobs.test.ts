// test/compose-jobs.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createComposer, type Runner } from '../src/compose/jobs';
import { planComposition } from '../src/compose/plan';

const plan = planComposition({ clip: { id: 1, start: 0, end: 10_000, path: '/c.mp4' }, preS: 0, postS: 0, clips: [], hasStill: () => false });
if (!plan.ok) throw new Error('plan');
const req = { cam: 'cam1', plan, size: 'sd' as const, badge: true };

// A runner we drive by hand: resolve/reject/progress per job.
function manual() {
  const jobs: { onProgress: (p: number) => void; finish: () => void; fail: (e: Error) => void; signal: AbortSignal; out: string }[] = [];
  const runner: Runner = ({ onProgress, signal, out }) =>
    new Promise<void>((resolve, reject) => {
      jobs.push({ onProgress, finish: () => { writeFileSync(out, 'mp4'); resolve(); }, fail: reject, signal, out });
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  return { runner, jobs };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
let stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const s of stops) await s(); stops = []; });

function make(extra: Partial<Parameters<typeof createComposer>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
  const m = manual();
  let t = 0;
  const c = createComposer({ dir, runner: m.runner, now: () => t, ...extra });
  stops.push(() => c.stop());
  return { c, m, dir, advance: (ms: number) => { t += ms; } };
}

describe('composer jobs', () => {
  it('runs one at a time, queues up to 3, then says busy', async () => {
    const { c, m } = make();
    const a = c.start(req);
    const b = c.start(req);
    c.start(req); c.start(req);
    expect(c.start(req)).toBe('busy');
    await tick();
    expect(a).toMatchObject({ state: 'running' });
    expect(c.get('cam1', (b as { id: string }).id)).toMatchObject({ state: 'queued' });
    expect(m.jobs).toHaveLength(1);
  });

  it('reports progress, then done with a file; ids are random and per camera', async () => {
    const { c, m } = make();
    const a = c.start(req) as { id: string };
    await tick();
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    m.jobs[0].onProgress(0.4);
    expect(c.get('cam1', a.id)).toMatchObject({ state: 'running', progress: 0.4 });
    m.jobs[0].finish();
    await tick();
    expect(c.get('cam1', a.id)).toMatchObject({ state: 'done', progress: 1, durationS: 10 });
    expect(existsSync(c.file('cam1', a.id)!)).toBe(true);
    expect(c.get('other', a.id)).toBeUndefined();
    expect(c.file('other', a.id)).toBeUndefined();
  });

  it('cancel stops a running job, deletes its folder, and starts the next', async () => {
    const { c, m, dir } = make();
    const a = c.start(req) as { id: string };
    const b = c.start(req) as { id: string };
    await tick();
    expect(c.cancel('cam1', a.id)).toBe(true);
    await tick();
    expect(m.jobs[0].signal.aborted).toBe(true);
    expect(c.get('cam1', a.id)).toBeUndefined();
    expect(readdirSync(dir)).not.toContain(a.id);
    expect(c.get('cam1', b.id)).toMatchObject({ state: 'running' });
  });

  it('a failed run reports failed with the reason', async () => {
    const { c, m } = make();
    const a = c.start(req) as { id: string };
    await tick();
    m.jobs[0].fail(new Error('ffmpeg exited 1'));
    await tick();
    expect(c.get('cam1', a.id)).toMatchObject({ state: 'failed', error: 'ffmpeg exited 1' });
  });

  it('stops a job nobody polls for 30 s (a closed tab), and drops results after 15 min', async () => {
    const { c, m, advance } = make();
    const a = c.start(req) as { id: string };
    await tick();
    advance(29_000); c.sweep();
    expect(c.get('cam1', a.id)).toMatchObject({ state: 'running' }); // this poll resets the clock
    advance(31_000); c.sweep();
    await tick();
    expect(m.jobs[0].signal.aborted).toBe(true);
    expect(c.get('cam1', a.id)).toBeUndefined();
    const b = c.start(req) as { id: string };
    await tick();
    m.jobs[1].finish();
    await tick();
    advance(14 * 60_000); c.sweep();
    expect(c.get('cam1', b.id)).toMatchObject({ state: 'done' });
    advance(2 * 60_000); c.sweep();
    expect(c.get('cam1', b.id)).toBeUndefined();
  });

  it('removes leftover job folders at start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-'));
    mkdirSync(join(dir, 'old-job'));
    const c = createComposer({ dir, runner: manual().runner });
    stops.push(() => c.stop());
    expect(readdirSync(dir)).toEqual([]);
  });

  // Final review I7: an open modal keeps polling, so a hung encode would hold
  // the one encoder for ever.
  it('fails a job that runs longer than its limit, and frees the encoder', async () => {
    const { c, m, advance } = make({ maxRunMs: 5 * 60_000 });
    const a = c.start(req) as { id: string };
    const b = c.start(req) as { id: string };
    await tick();
    for (let i = 0; i < 6; i++) {
      advance(60_000);
      c.get('cam1', a.id); // still polled
      c.get('cam1', b.id);
      c.sweep();
    }
    await tick();
    expect(m.jobs[0].signal.aborted).toBe(true);
    expect(c.get('cam1', a.id)).toMatchObject({ state: 'failed', error: 'took longer than 5 minutes' });
    expect(c.get('cam1', b.id)).toMatchObject({ state: 'running' });
  });
});
