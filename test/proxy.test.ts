import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';
import request from 'supertest';
import { startSim } from './helpers/sim';
import { startProxy, auth, until } from './helpers/proxy';
import { sseConnect } from './helpers/sse';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

describe('proxy end to end with cam-sim', () => {
  it('a camera detection arrives on SSE as start and end, and is listed', async () => {
    const sim = await startSim();
    cleanup.push(() => sim.close());
    const p = await startProxy(sim);
    cleanup.push(() => p.proxy.stop());
    await until(() => p.proxy.intake.state().onvif === 'subscribed');
    // Person detections also set motion (as on the real camera): watch persons.
    const s = sseConnect(`${p.base}/api/stream?types=camera-event&kinds=person`, auth());
    cleanup.push(async () => void s.close());
    await s.until(() => s.status() === 200);
    await new Promise((r) => setTimeout(r, 300));
    sim.sim.engine.events.trigger('person', 1);
    await s.until(() => s.events.some((e) => (e.data as { phase: string }).phase === 'end'));
    expect(s.events.map((e) => `${(e.data as { kind: string }).kind}:${(e.data as { phase: string }).phase}`)).toEqual(['person:start', 'person:end']);
    const list = await request(p.proxy.app).get('/api/cameras/cam1/events').set(auth());
    expect(list.body[0]).toMatchObject({ kind: 'person', source: 'onvif' });
  });

  it('a client resumes across a proxy restart without gaps', async () => {
    const sim = await startSim();
    cleanup.push(() => sim.close());
    let p = await startProxy(sim);
    await until(() => p.proxy.intake.state().onvif === 'subscribed');
    sim.sim.engine.events.trigger('vehicle', 1);
    await until(() => p.proxy.log.lastId() >= 2);
    const seen = p.proxy.log.lastId();
    await p.proxy.stop();
    p = await startProxy(sim, { dir: p.dir });
    cleanup.push(() => p.proxy.stop());
    await until(() => p.proxy.intake.state().onvif === 'subscribed');
    sim.sim.engine.events.trigger('pet', 1);
    await until(() => p.proxy.log.lastId() >= seen + 2);
    // Everything after `seen` is replayed (the new run's camera-status too);
    // the pet event's start and end are among it, nothing from before.
    const s = sseConnect(`${p.base}/api/stream`, { ...auth(), 'Last-Event-ID': String(seen) });
    cleanup.push(async () => void s.close());
    await s.until(() => s.events.filter((e) => (e.data as { kind?: string }).kind === 'pet').length === 2);
    expect(Math.min(...s.ids())).toBe(seen + 1);
    expect(s.ids()).toEqual([...s.ids()].sort((a, b) => a - b));
    // Nothing from before `seen` again: the vehicle event only appears as its end
    // (it was still open when the proxy stopped, and ends at the restart).
    for (const e of s.events.filter((x) => x.event === 'camera-event' && (x.data as { kind: string }).kind === 'vehicle')) expect((e.data as { phase: string }).phase).toBe('end');
  });
});

describe('proxy restart with an open event', () => {
  it('ends events left open with an end message (reason restart), so stream clients see them close', async () => {
    const sim = await startSim();
    cleanup.push(() => sim.close());
    let p = await startProxy(sim);
    await until(() => p.proxy.intake.state().onvif === 'subscribed');
    sim.sim.engine.events.trigger('pet', 60);
    await until(() => p.proxy.log.since(0, { types: ['camera-event'], kinds: ['pet'] }, 10).length === 1);
    const started = p.proxy.log.since(0, { types: ['camera-event'], kinds: ['pet'] }, 10)[0];
    await p.proxy.stop();
    p = await startProxy(sim, { dir: p.dir });
    cleanup.push(() => p.proxy.stop());
    const pet = p.proxy.log.since(0, { types: ['camera-event'], kinds: ['pet'] }, 10);
    expect(pet.map((m) => m.data.phase)).toEqual(['start', 'end']);
    expect(pet[1].data).toMatchObject({ eventId: started.data.eventId, phase: 'end', reason: 'restart' });
  });
});

describe('proxy restart', () => {
  it('runs one restart at a time: a second call joins the first, and stop() waits for it', async () => {
    const sim = await startSim();
    cleanup.push(() => sim.close());
    const p = await startProxy(sim);
    await until(() => p.proxy.intake.state().onvif === 'subscribed');
    const a = p.proxy.restart();
    const b = p.proxy.restart();
    expect(b).toBe(a);
    await a;
    const current = p.proxy.intake;
    await until(() => current.state().onvif === 'subscribed');
    const r = p.proxy.restart();
    await p.proxy.stop();
    await r;
    expect(p.proxy.intake.state().source).toBe('none');
  });
});

describe('cli', () => {
  it('exits 2 with a clear message on a bad configuration', () => {
    const r = spawnSync(join(__dirname, '..', 'node_modules', '.bin', 'tsx'), [join(__dirname, '..', 'src', 'cli.ts')], {
      env: { PATH: process.env.PATH, CAMPROXY_CONFIG: join(__dirname, 'no-such-config.json') },
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/cam-proxy: no-such-config\.json: cannot read the file/);
    expect(r.stderr).not.toMatch(/\bat \w+ \(/); // no stack trace
  });
});
