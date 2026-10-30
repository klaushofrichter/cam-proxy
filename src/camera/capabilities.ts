// What a camera can do, in the proxy's own terms (spec
// 2026-10-30-ptz-capabilities-design §4). The only place that reads Reolink's
// GetAbility; clients see the derived object, never Reolink's flags.

export const POSITIONS_MAX = 20;

export interface PtzCapability {
  move: true;
  zoom: boolean;
  focus: boolean;
  speed: boolean;
  positions?: { max: number }; // present when the camera can store positions
}

export interface Capabilities {
  schema: 1;
  ptz: PtzCapability | null; // null: the camera can't pan or tilt
}

// One camera command (the client's `command`), as the PTZ modules use it.
export type CameraCommand = (cmd: string, param?: object) => Promise<unknown>;

const NONE: Capabilities = { schema: 1, ptz: null };

// Channel 0's abilities from a GetAbility value ({ Ability: { abilityChn: [...] } }).
// A flag is set when its permit is above 0. Fixed cameras report
// supportZoom/supportFocus too, so they count only with ptzCtrl.
export function deriveCapabilities(ability: unknown): Capabilities {
  const chn = (ability as { Ability?: { abilityChn?: unknown } } | null | undefined)?.Ability?.abilityChn;
  const ch0: unknown = Array.isArray(chn) ? chn[0] : undefined;
  if (!ch0 || typeof ch0 !== 'object') return { ...NONE };
  const set = (k: string): boolean => {
    const f = (ch0 as Record<string, unknown>)[k];
    const permit = f && typeof f === 'object' ? (f as { permit?: unknown }).permit : undefined;
    return typeof permit === 'number' && permit > 0;
  };
  if (!set('ptzCtrl')) return { ...NONE };
  const ptz: PtzCapability = { move: true, zoom: set('supportZoom'), focus: set('supportFocus'), speed: set('supportPtzSpeed') };
  if (set('ptzPreset')) ptz.positions = { max: POSITIONS_MAX };
  return { schema: 1, ptz };
}

export async function readCapabilities(command: CameraCommand, user: string): Promise<Capabilities> {
  return deriveCapabilities(await command('GetAbility', { User: { userName: user } }));
}
