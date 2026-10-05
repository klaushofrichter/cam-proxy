// The PoE switch errors (issue #85), shared by the controller and the drivers.
export type PoeSwitchErrorCode = 'switch_busy' | 'switch_auth' | 'switch_unreachable' | 'switch_error' | 'no_power';

// poeOff: the PoE-off request was sent, so the port may have been cut;
// turnedOn then says whether the proxy got it on again (null: not applicable).
export class PoeSwitchError extends Error {
  constructor(readonly code: PoeSwitchErrorCode, message: string, readonly poeOff = false, readonly turnedOn: boolean | null = null) {
    super(message);
  }
}

// The switch answered, but said no (no config: ok): it may have done nothing.
export class SwitchRefusal extends PoeSwitchError {}
