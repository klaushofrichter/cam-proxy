// What a camera can do, in the proxy's own terms (spec
// 2026-10-30-ptz-capabilities-design §4). The only place that reads Reolink's
// GetAbility; clients see the derived object, never Reolink's flags.

export const POSITIONS_MAX = 20;

export interface PtzCapability {
  move: true;
  zoom: boolean;
  focus: boolean;
  // A one-shot autofocus (POST .../ptz/autofocus): the camera has autofocus
  // and zoom (the autofocus is started by a zoom). Absent from an older proxy.
  autofocus?: boolean;
  speed: boolean;
  positions?: { max: number }; // present when the camera can store positions
}

// A live stream: main (the app's Clear), sub (Fluent), and on some models a
// third one, ext (Balanced; 896x512 H.264 on the CX820, measured 2026-11-03).
export type LiveStreamName = 'main' | 'ext' | 'sub';

export interface Capabilities {
  schema: 1;
  ptz: PtzCapability | null; // null: the camera can't pan or tilt
  // The live streams the camera offers, best first: ['main', 'ext', 'sub']
  // when GetAbility's live ver is 1 (CX820, E1 Outdoor Pro), else ['main', 'sub'].
  live?: LiveStreamName[]; // absent (a client's copy from an older proxy): main and sub
}

// One camera command (the client's `command`), as the PTZ modules use it.
export type CameraCommand = (cmd: string, param?: object) => Promise<unknown>;

const MAIN_SUB: LiveStreamName[] = ['main', 'sub'];
const WITH_EXT: LiveStreamName[] = ['main', 'ext', 'sub'];

// Reolink's abilityChn.live: ver 1 is main + ext + sub, ver 2 main + sub
// (RLC-1224A). Anything else (missing, 0, unknown) counts as main + sub: no
// ext is offered that the camera may not have.
function liveStreams(ch0: Record<string, unknown>): LiveStreamName[] {
  const live = ch0.live;
  const ver = live && typeof live === 'object' ? (live as { ver?: unknown }).ver : undefined;
  return ver === 1 ? [...WITH_EXT] : [...MAIN_SUB];
}

// Channel 0's abilities from a GetAbility value ({ Ability: { abilityChn: [...] } }).
// A flag is set when its permit is above 0. Fixed cameras report
// supportZoom/supportFocus too, so they count only with ptzCtrl.
export function deriveCapabilities(ability: unknown): Capabilities {
  const chn = (ability as { Ability?: { abilityChn?: unknown } } | null | undefined)?.Ability?.abilityChn;
  const ch0: unknown = Array.isArray(chn) ? chn[0] : undefined;
  if (!ch0 || typeof ch0 !== 'object') return { schema: 1, ptz: null, live: [...MAIN_SUB] };
  const set = (k: string): boolean => {
    const f = (ch0 as Record<string, unknown>)[k];
    const permit = f && typeof f === 'object' ? (f as { permit?: unknown }).permit : undefined;
    return typeof permit === 'number' && permit > 0;
  };
  const live = liveStreams(ch0 as Record<string, unknown>);
  if (!set('ptzCtrl')) return { schema: 1, ptz: null, live };
  const zoom = set('supportZoom');
  const ptz: PtzCapability = { move: true, zoom, focus: set('supportFocus'), autofocus: zoom && set('disableAutoFocus'), speed: set('supportPtzSpeed') };
  if (set('ptzPreset')) ptz.positions = { max: POSITIONS_MAX };
  return { schema: 1, ptz, live };
}

export async function readCapabilities(command: CameraCommand, user: string): Promise<Capabilities> {
  return deriveCapabilities(await command('GetAbility', { User: { userName: user } }));
}
