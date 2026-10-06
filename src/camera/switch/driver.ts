import { sscpoeWeb } from './sscpoe-web';
export { SwitchRefusal } from './errors';

// A PoE switch model behind one interface (spec 2026-10-05-multi-camera-host-design
// §8.4): log in, read the ports, set one port's PoE, log out, and whether the
// switch takes only one web session at a time. A new model is a driver here.

// The ports by the switch's internal index.
export interface SwitchDetail { poe: boolean[]; watts: number[]; link: (boolean | null)[]; sn: string | null; firmware: string | null }

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
