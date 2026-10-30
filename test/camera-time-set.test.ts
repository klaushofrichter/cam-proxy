import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { ReolinkClient } from '../src/camera/client';
import { timeInfoFromGetTime } from '../src/camera/time';
import { setCameraZone } from '../src/camera/time-set';
import { zoneRule } from '../src/onboarding/zone';
import { audits } from './helpers/onboarding';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';
import { startSim } from './helpers/sim';

// camera-time-set (spec 2026-10-30-camera-onboarding-design §4.7): the
// camera's zone and DST rule from time.zone, one whole-object SetTime, re-read.
type Sim = Awaited<ReturnType<typeof startSim>>;
const stops: (() => Promise<unknown>)[] = [];
afterAll(async () => void (await Promise.all(stops.map((f) => f()))), 60_000);
const getTime = async (s: Sim) => {
  const c = new ReolinkClient({ id: 't', host: s.camera.host, protocol: 'http', user: 'proxy', password: s.password }, { quiet: true });
  try {
    return await c.command<{ Time: Record<string, number>; Dst: Record<string, number> }>('GetTime');
  } finally {
    await c.logout();
  }
};
async function setup(o: { model?: Parameters<typeof startSim>[0] extends infer T ? T extends { model?: infer M } ? M : never : never; zone?: string } = {}) {
  const s = await startSim(o.model ? { model: o.model } : {});
  const p = await startProxy(s, { settings: o.zone ? { time: { zone: o.zone } } : {}, proxy: { hostZone: { intl: () => 'UTC' } } });
  stops.push(async () => (await p.proxy.stop(), await s.close()));
  await until(async () => (await request(p.base).get('/api/cameras/cam1').set(auth())).body.online === true, 20_000);
  const post = () => request(p.base).post('/control/cameras/cam1/actions/camera-time-set').set(auth(ADMIN_TOKEN)).send({});
  return { s, p, post };
}

describe('camera-time-set', () => {
  it.each(['RLC-1224A', 'CX820', 'E1-Outdoor-Pro'] as const)('%s: sets zone and DST rule as one whole object, re-reads, logs out', async (model) => {
    const { s, p, post } = await setup({ model, zone: 'Europe/Berlin' });
    const r = await post();
    expect([r.status, r.body.outcome, r.body.zone]).toEqual([200, 'set', 'Europe/Berlin']);
    expect(s.sim.engine.counters.setCalls.filter((c) => c === 'SetTime')).toHaveLength(1);
    const raw = await getTime(s);
    const t = timeInfoFromGetTime(raw);
    expect([t.stdOffsetMinutes, t.dstRule?.startWeek, t.dstRule?.endMon, t.dstRule?.endHour]).toEqual([60, 5, 10, 3]);
    // The camera's clock is still right (the time sent is now, in the new zone).
    const local = new Date(Date.UTC(raw.Time.year, raw.Time.mon - 1, raw.Time.day, raw.Time.hour, raw.Time.min, raw.Time.sec) - (raw.Time.isDst ? 120 : 60) * 60_000);
    expect(Math.abs(local.getTime() - Date.now())).toBeLessThan(5_000);
    expect((await post()).body.outcome).toBe('already');
    expect(s.sim.engine.counters.setCalls.filter((c) => c === 'SetTime')).toHaveLength(1);
    expect(s.sim.engine.sessions.online().filter((x) => x.userName === 'proxy').length).toBeLessThanOrEqual(1); // the worker's own session only
    const rec = audits(p.dir, 'camera-time').at(-1)!;
    expect([rec.event.outcome, rec.labels.camera, rec.cam_proxy.zone, rec.cam_proxy.after.stdOffsetMinutes]).toEqual(['success', 'cam1', 'Europe/Berlin', 60]);
    expect(audits(p.dir, 'control-action').filter((x) => x.cam_proxy?.action === 'camera-time-set')).toHaveLength(0);
  }, 40_000);

  it('no zone known: 409 zone_unknown, nothing written', async () => {
    const { s, post } = await setup();
    const r = await post();
    expect([r.status, r.body.error]).toEqual([409, 'zone_unknown']);
    expect(s.sim.engine.counters.setCalls).not.toContain('SetTime');
  }, 30_000);

  it('the onboarding time step turns ok after the set', async () => {
    const { p, post } = await setup({ zone: 'Asia/Tokyo' });
    const step = async () => (await request(p.base).get('/control/cameras/cam1/onboarding').set(auth(ADMIN_TOKEN))).body.steps.time;
    await until(async () => (await step()).ok !== null, 20_000);
    expect((await step()).action).toBe('camera-time-set');
    expect((await post()).body.outcome).toBe('set');
    await until(async () => (await step()).ok === true, 20_000);
  }, 40_000);
});

describe('setCameraZone', () => {
  it('a zone without DST turns the camera DST off; a refused value is failed with the rspCode', async () => {
    const s = await startSim();
    stops.push(() => s.close());
    const c = new ReolinkClient({ id: 't', host: s.camera.host, protocol: 'http', user: 'proxy', password: s.password }, { quiet: true });
    const tokyo = zoneRule('Asia/Tokyo', 2026);
    if (tokyo === 'unsupported') throw new Error('no rule');
    expect((await setCameraZone(c, tokyo, 'Asia/Tokyo')).outcome).toBe('set');
    const raw = await getTime(s);
    expect([raw.Time.timeZone, raw.Dst.enable]).toEqual([-32400, 0]);
    expect((await setCameraZone(c, { stdOffsetMinutes: 900, dst: null }, 'Pacific/Nowhere')).outcome).toBe('failed');
    expect(s.sim.engine.sessions.online().filter((x) => x.userName === 'proxy')).toHaveLength(0);
  }, 30_000);
});
