// The PoE switch errors (issue #85), shared by the controller and the drivers.
export type PoeSwitchErrorCode = 'switch_busy' | 'switch_auth' | 'switch_unreachable' | 'switch_error' | 'no_power' | 'not_verified' | 'password_unset' | 'switch_unknown';

// The HTTP status of a switch error: a refusal that changed nothing and that a
// person can act on (busy, no power, no password, the camera not verified on
// the port) is 409; the rest 502.
export const poeHttpStatus = (code: PoeSwitchErrorCode): 404 | 409 | 502 => (code === 'switch_unknown' ? 404 : code === 'switch_busy' || code === 'no_power' || code === 'password_unset' || code === 'not_verified' ? 409 : 502);

// poeOff: the PoE-off request was sent, so the port may have been cut;
// turnedOn then says whether the proxy got it on again (null: not applicable).
export class PoeSwitchError extends Error {
  constructor(readonly code: PoeSwitchErrorCode, message: string, readonly poeOff = false, readonly turnedOn: boolean | null = null) {
    super(message);
  }
}

// The switch answered, but said no (no config: ok): it may have done nothing.
export class SwitchRefusal extends PoeSwitchError {}
