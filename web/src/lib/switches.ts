// The PoE switches this proxy operates (GET /control/switches, spec
// 2026-11-07-poe-switches-design). The password is never in the answer.
export interface SwitchView { id: string; model: string; host: string; ports: number; offSeconds: number; passwordSet: boolean; passwordElsewhere?: boolean; busy: boolean; poeMaybeOff: number[] }

export const switchLine = (s: SwitchView): string =>
  `${s.host} · ${s.ports} ports · ${s.passwordSet ? 'password set' : s.passwordElsewhere ? 'password set for another address: set it again' : 'no password yet'}`;

export const poeOnLabel = (port: number): string => `Turn PoE on (port ${port})`;

export const poeOnText = (port: number, wasOn: boolean): string => (wasOn ? `Port ${port} had PoE on already.` : `PoE turned on at port ${port}.`);
