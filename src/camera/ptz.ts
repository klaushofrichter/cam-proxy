// Reolink's pan/tilt/zoom commands and preset slots (spec
// 2026-10-30-ptz-capabilities-design §3, §6). The only module that knows
// PtzCtrl, its op names and slot ids; nothing of it reaches clients.
import type { CameraCommand } from './capabilities';

export const PTZ_DIRECTIONS = ['left', 'right', 'up', 'down', 'left-up', 'left-down', 'right-up', 'right-down'] as const;
export type PtzDirection = (typeof PTZ_DIRECTIONS)[number];
export type ZoomDirection = 'in' | 'out';
export type FocusDirection = 'near' | 'far';

// Measured on the E1 (§3): slots are ids 0–63 although GetPtzPreset's range
// says 1–64; a name over 31 characters is replaced by the camera's default.
export const PRESET_SLOTS = 64;
export const PRESET_NAME_BYTES = 31;

const OPS: Record<PtzDirection, string> = {
  left: 'Left', right: 'Right', up: 'Up', down: 'Down',
  'left-up': 'LeftUp', 'left-down': 'LeftDown', 'right-up': 'RightUp', 'right-down': 'RightDown',
};

// Zoom, focus and ToPos: the speed the measurement used.
const FIXED_SPEED = 32;

// Our speed 1–10 onto the camera's measured 1–64.
export function cameraSpeed(speed: number): number {
  return Math.round(1 + ((speed - 1) * 63) / 9);
}

// At most 31 UTF-8 bytes, cut between characters (code points); no leading,
// trailing or double spaces (the E1 ignores such a name, measured 2026-10-31).
export function presetName(name: string): string {
  let out = '';
  let bytes = 0;
  for (const ch of name.trim().replace(/\s+/g, ' ')) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > PRESET_NAME_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out.trimEnd();
}

export interface PresetSlot {
  id: number;
  enabled: boolean;
  name: string;
}

export class ReolinkPtz {
  constructor(
    private readonly command: CameraCommand,
    private readonly speed: () => boolean, // the camera takes a speed (supportPtzSpeed)
  ) {}

  private ctrl(op: string, extra: Record<string, number> = {}, speed?: number): Promise<unknown> {
    return this.command('PtzCtrl', { channel: 0, op, ...extra, ...(speed !== undefined && this.speed() ? { speed } : {}) });
  }

  async move(d: PtzDirection, speed: number): Promise<void> {
    await this.ctrl(OPS[d], {}, cameraSpeed(speed));
  }

  async zoom(d: ZoomDirection): Promise<void> {
    await this.ctrl(d === 'in' ? 'ZoomInc' : 'ZoomDec', {}, FIXED_SPEED);
  }

  // FocusInc raises the focus position toward its far end (measured on the E1, #282).
  async focus(d: FocusDirection): Promise<void> {
    await this.ctrl(d === 'far' ? 'FocusInc' : 'FocusDec', {}, FIXED_SPEED);
  }

  async goTo(slot: number): Promise<void> {
    await this.ctrl('ToPos', { id: slot }, FIXED_SPEED);
  }

  async stop(): Promise<void> {
    await this.ctrl('Stop');
  }

  async presets(): Promise<PresetSlot[]> {
    const v = (await this.command('GetPtzPreset', { channel: 0 })) as { PtzPreset?: unknown } | undefined;
    const list = Array.isArray(v?.PtzPreset) ? (v.PtzPreset as unknown[]) : [];
    const out: PresetSlot[] = [];
    for (const x of list) {
      const p = x as { id?: unknown; enable?: unknown; name?: unknown } | null;
      if (!p || !Number.isInteger(p.id) || (p.id as number) < 0 || (p.id as number) >= PRESET_SLOTS) continue;
      out.push({ id: p.id as number, enabled: p.enable === 1, name: typeof p.name === 'string' ? p.name : '' });
    }
    return out;
  }

  // Whole preset objects only (the camera's settings rule).
  async savePreset(slot: number, name: string): Promise<void> {
    await this.command('SetPtzPreset', { PtzPreset: { channel: 0, enable: 1, id: slot, name: presetName(name) } });
  }

  async clearPreset(slot: number): Promise<void> {
    await this.command('SetPtzPreset', { PtzPreset: { channel: 0, enable: 0, id: slot, name: '' } });
  }
}
