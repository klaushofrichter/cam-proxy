import { describe, it, expect, afterEach } from 'vitest';
import { startSim } from './helpers/sim';
import { OnvifSubscription, OnvifGoneError, OnvifAuthError, type OnvifMessage } from '../src/events/onvif';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup(password?: string) {
  const s = await startSim();
  close = s.close;
  const sub = new OnvifSubscription({ host: '127.0.0.1', port: s.ports.onvif, user: 'proxy', password: password ?? s.password }, { subscribeMin: 1, pullTimeoutS: 1 });
  return { ...s, sub };
}

async function pullUntil(sub: OnvifSubscription, cond: (all: OnvifMessage[]) => boolean, ms = 8000): Promise<OnvifMessage[]> {
  const all: OnvifMessage[] = [];
  const t0 = Date.now();
  while (!cond(all)) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${all.length} messages`);
    all.push(...(await sub.pull()));
  }
  return all;
}

describe('ONVIF PullPoint client', () => {
  it('subscribes and first receives the state of every topic as Initialized', async () => {
    const { sub } = await setup();
    await sub.subscribe();
    const first = await sub.pull();
    expect(first).toHaveLength(9);
    expect(first.every((m) => m.op === 'Initialized' && m.state === false)).toBe(true);
    expect(first.map((m) => m.topic)).toContain('tns1:RuleEngine/MyRuleDetector/PeopleDetect');
    expect(first[0].utc).toBeGreaterThan(Date.now() - 60_000);
  });

  it('reports a person detection as Changed true, then false', async () => {
    const { sub, sim } = await setup();
    await sub.subscribe();
    await sub.pull();
    sim.engine.events.trigger('person', 1);
    const all = await pullUntil(sub, (a) => a.some((m) => m.topic.endsWith('PeopleDetect') && m.op === 'Changed' && !m.state));
    const people = all.filter((m) => m.topic.endsWith('PeopleDetect'));
    expect(people.map((m) => m.state)).toEqual([true, false]);
  });

  it('renews the subscription, moving its termination time', async () => {
    const { sub } = await setup();
    await sub.subscribe();
    const before = sub.terminationTime();
    await new Promise((r) => setTimeout(r, 1100));
    await sub.renew();
    expect(sub.terminationTime()).toBeGreaterThan(before);
  });

  it('after unsubscribe, a pull reports the subscription as gone', async () => {
    const { sub } = await setup();
    await sub.subscribe();
    await sub.unsubscribe();
    await expect(sub.pull()).rejects.toBeInstanceOf(OnvifGoneError);
  });

  it('a power-off during a pull reports the subscription as gone', async () => {
    const { sub, sim } = await setup();
    await sub.subscribe();
    await sub.pull();
    const pulling = sub.pull();
    setTimeout(() => sim.engine.powerOff(), 100);
    await expect(pulling).rejects.toBeInstanceOf(OnvifGoneError);
  });

  it('reports a wrong password as an auth error without the password', async () => {
    const { sub } = await setup('wrong-secret-pw');
    const err = await sub.subscribe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OnvifAuthError);
    expect(String((err as Error).message)).not.toContain('wrong-secret-pw');
  });
});
