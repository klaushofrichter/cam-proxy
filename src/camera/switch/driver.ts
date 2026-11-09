import { sscpoeWeb } from './sscpoe-web';
export { SwitchRefusal } from './errors';

// A PoE switch model behind one interface (spec 2026-10-05-multi-camera-host-design
// §8.4): log in, read the ports, set one port's PoE, log out, and whether the
// switch takes only one web session at a time. A new model is a driver here.

// The ports by the switch's internal index. tx/rx: the current rates (not
// counters), one per index, also past the PoE ports (sscpoe-web: index 9 is
// the uplink); 0 when the switch sent none.
export interface SwitchDetail { poe: boolean[]; watts: number[]; link: (boolean | null)[]; tx: number[]; rx: number[]; sn: string | null; firmware: string | null }

// A switch as cams-admin sends it (contract switchRef; vendored in a later
// step, spec 2026-11-07-poe-switches-design).
export interface SwitchRef { id: string; model: 'sscpoe-web'; host: string; ports: number; offSeconds: number }

// Where a camera's traffic showed up (contract switch.locate result).
export interface LocateResult {
  found: boolean;
  port?: number;
  poe?: boolean;
  watts?: number;
  link?: boolean | null;
  // switch_error (#364 m3, a survey only): the switch failed for this camera; detail says how (1 to 200 characters).
  reason?: 'not_reachable' | 'ambiguous' | 'no_traffic' | 'switch_error';
  ratio?: number;
  detail?: string;
}

export interface SwitchSession {
  login(password: string): Promise<void>;
  relogin(password: string): Promise<void>; // a new session after a lost one
  detail(): Promise<SwitchDetail>;
  setPoe(index: number, on: boolean): Promise<void>; // throws SwitchRefusal when the switch said no
  logout(): Promise<void>;
}

export interface SwitchDriver {
  model: string;
  singleSession: boolean; // the switch takes one web session at a time
  open(host: string, timeoutMs: () => number): SwitchSession;
  portIndex(port: number, ports: number, sn: string): number; // UI port (1-based) → internal index
}

const DRIVERS: Record<string, SwitchDriver> = { 'sscpoe-web': sscpoeWeb };
export const driverFor = (model: string): SwitchDriver | undefined => (Object.hasOwn(DRIVERS, model) ? DRIVERS[model] : undefined);
