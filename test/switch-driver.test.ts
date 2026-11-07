import { describe, expect, it } from 'vitest';
import { PoeSwitch } from '../src/camera/poe-switch';
import { driverFor } from '../src/camera/switch/driver';
import { fakeSwitch } from './helpers/fake-switch';
import { startPoeSwitchMock } from './helpers/poe-switch-mock';

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
    const p = new PoeSwitch({ ref: () => ({ id: 'sw_test', model: 'sscpoe-web', host: 'fake', ports: 8, offSeconds: 5 }), password: () => 'pw', driver: () => sw.driver, sleep: async () => undefined });
    expect((await p.read(3)).poe).toBe(true);
    const offs: number[] = [];
    await p.cycle(3, (at) => offs.push(at), { verifyHost: null });
    expect(sw.log.filter((l) => l.startsWith('poe'))).toEqual(['poe 2 off', 'poe 2 on']);
    expect(sw.sessions()).toBe(0);
  });

  it('sscpoe-web reads the tx/rx rates as numbers by index; missing or invalid → 0', async () => {
    const m = await startPoeSwitchMock({ password: 'pw' });
    try {
      m.tx[5] = 40;
      m.rx[2] = 12.5;
      m.rawRates = { tx: ['1', 'x', null, '3'] };
      const s = driverFor('sscpoe-web')!.open(m.host, () => 1000);
      await s.login('pw');
      const d = await s.detail();
      await s.logout();
      // tx replaced by a short, partly broken list: padded with 0.
      expect(d.tx).toEqual([1, 0, 0, 3, 0, 0, 0, 0, 0, 0]);
      expect(d.rx).toEqual([1, 1, 12.5, 1, 1, 1, 1, 1, 1, 1]);
      m.rawRates = null;
      await s.login('pw');
      const e = await s.detail();
      await s.logout();
      expect(e.tx[5]).toBe(40);
      expect(e.tx).toHaveLength(10);
    } finally {
      await m.close();
    }
  });
});
