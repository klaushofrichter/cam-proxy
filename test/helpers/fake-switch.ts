import { PoeSwitchError } from '../../src/camera/poe-switch';
import type { SwitchDriver, SwitchSession } from '../../src/camera/switch/driver';

// A switch in memory with the GPS-208's one-session rule (spec
// 2026-10-05-multi-camera-host-design §8.4: the queue is tested against a
// fake driver; the real switch is never used).
export function fakeSwitch(o: { ports?: number; watts?: number } = {}) {
  const n = o.ports ?? 8;
  const poe = Array.from({ length: n }, () => true);
  let open = 0;
  const log: string[] = [];
  const driver: SwitchDriver = {
    model: 'fake',
    singleSession: true,
    portIndex: (port) => port - 1,
    open(): SwitchSession {
      let mine = false;
      return {
        async login() {
          if (open > 0) throw new PoeSwitchError('switch_busy', 'someone is logged in');
          open++;
          mine = true;
          log.push('login');
        },
        async relogin() {},
        async detail() {
          log.push('detail');
          return { poe: [...poe], watts: poe.map((on) => (on ? (o.watts ?? 4.5) : 0)), link: poe.map(() => true), sn: 'FAKE', firmware: '1' };
        },
        async setPoe(index, on) {
          log.push(`poe ${index} ${on ? 'on' : 'off'}`);
          poe[index] = on;
        },
        async logout() {
          if (mine) open--;
          mine = false;
          log.push('logout');
        },
      };
    },
  };
  return { driver, poe, sessions: () => open, log };
}
