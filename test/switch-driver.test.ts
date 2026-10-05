import { describe, expect, it } from 'vitest';
import { PoeSwitch } from '../src/camera/poe-switch';
import { driverFor } from '../src/camera/switch/driver';
import { fakeSwitch } from './helpers/fake-switch';

describe('a PoE switch driver per model (spec 2026-10-05-multi-camera-host-design §8.4)', () => {
  it('sscpoe-web is the GPS-208 driver: one session, reversed ports on GPS2…', () => {
    const d = driverFor('sscpoe-web')!;
    expect(d.singleSession).toBe(true);
    expect(d.portIndex(8, 8, 'GPS208ABC')).toBe(0);
    expect(d.portIndex(8, 8, 'PS208G')).toBe(7);
    expect(driverFor('none')).toBeUndefined();
    expect(driverFor('__proto__')).toBeUndefined();
  });

  it('the controller works through any driver: a read and a power-cycle on the fake', async () => {
    const sw = fakeSwitch();
    const p = new PoeSwitch({ config: () => ({ model: 'sscpoe-web', host: 'fake', port: 3, ports: 8, offSeconds: 5 }), password: () => 'pw', driver: () => sw.driver, sleep: async () => undefined });
    expect((await p.read()).poe).toBe(true);
    const offs: number[] = [];
    await p.cycle((at) => offs.push(at));
    expect(sw.log.filter((l) => l.startsWith('poe'))).toEqual(['poe 2 off', 'poe 2 on']);
    expect(sw.sessions()).toBe(0);
  });
});
