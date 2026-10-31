import { describe, it, expect } from 'vitest';
import { cameraSpeed, presetName, ReolinkPtz, PRESET_SLOTS, PRESET_NAME_BYTES, PTZ_DIRECTIONS } from '../src/camera/ptz';

function stub(reply: (cmd: string) => unknown = () => ({ rspCode: 200 }), speed = true) {
  const sent: [string, unknown][] = [];
  const p = new ReolinkPtz(async (cmd, param) => {
    sent.push([cmd, param]);
    return reply(cmd);
  }, () => speed);
  return { p, sent };
}

describe('Reolink PTZ mapping', () => {
  it('constants', () => {
    expect(PRESET_SLOTS).toBe(64);
    expect(PRESET_NAME_BYTES).toBe(31);
    expect(PTZ_DIRECTIONS).toHaveLength(8);
  });

  it('cameraSpeed maps 1–10 onto 1–64', () => {
    expect([1, 2, 5, 10].map(cameraSpeed)).toEqual([1, 8, 29, 64]);
  });

  it('presetName: ASCII cut to 31', () => expect(presetName('x'.repeat(40))).toBe('x'.repeat(31)));
  it('presetName: short names unchanged', () => expect(presetName('Gate')).toBe('Gate'));

  // The E1 ignores a name with a leading or trailing space or two spaces in a
  // row (measured 2026-10-31, #282): the camera gets it without them.
  it('presetName: no leading, trailing or double spaces', () => {
    expect(presetName('Gate ')).toBe('Gate');
    expect(presetName(' Gate')).toBe('Gate');
    expect(presetName('Front  gate')).toBe('Front gate');
    expect(presetName('Front \u00a0 gate')).toBe('Front gate');
    expect(presetName('Größe Tür')).toBe('Größe Tür');
  });
  it('presetName: a cut never ends in a space', () => expect(presetName('x'.repeat(30) + ' yz')).toBe('x'.repeat(30)));

  it('presetName: never splits a character', () => {
    const full = 'Einfahrt Süd – Tor 🌳🌳🌳🌳🌳';
    const n = presetName(full);
    expect(Buffer.byteLength(n)).toBeLessThanOrEqual(31);
    expect(n).not.toContain('�');
    expect(full.startsWith(n)).toBe(true);
    // As much as fits: one more character would be over 31 bytes.
    expect(Buffer.byteLength(full.slice(0, n.length + 2))).toBeGreaterThan(31);
  });

  it('move sends the op and the camera speed', async () => {
    const { p, sent } = stub();
    await p.move('left-up', 10);
    expect(sent).toEqual([['PtzCtrl', { channel: 0, op: 'LeftUp', speed: 64 }]]);
  });

  it('every direction has its op', async () => {
    const { p, sent } = stub();
    for (const d of PTZ_DIRECTIONS) await p.move(d, 1);
    expect(sent.map(([, x]) => (x as { op: string }).op)).toEqual(['Left', 'Right', 'Up', 'Down', 'LeftUp', 'LeftDown', 'RightUp', 'RightDown']);
  });

  it('without speed support no speed key', async () => {
    const { p, sent } = stub(undefined, false);
    await p.move('down', 5);
    await p.zoom('in');
    expect(sent).toEqual([['PtzCtrl', { channel: 0, op: 'Down' }], ['PtzCtrl', { channel: 0, op: 'ZoomInc' }]]);
  });

  it('zoom/focus/goTo use speed 32; stop has none', async () => {
    const { p, sent } = stub();
    await p.zoom('in');
    await p.zoom('out');
    await p.focus('far');
    await p.focus('near');
    await p.goTo(5);
    await p.stop();
    expect(sent).toEqual([
      ['PtzCtrl', { channel: 0, op: 'ZoomInc', speed: 32 }],
      ['PtzCtrl', { channel: 0, op: 'ZoomDec', speed: 32 }],
      ['PtzCtrl', { channel: 0, op: 'FocusInc', speed: 32 }],
      ['PtzCtrl', { channel: 0, op: 'FocusDec', speed: 32 }],
      ['PtzCtrl', { channel: 0, op: 'ToPos', id: 5, speed: 32 }],
      ['PtzCtrl', { channel: 0, op: 'Stop' }],
    ]);
  });

  it('presets: ids 0–63 only, enabled from enable', async () => {
    const { p, sent } = stub(() => ({ PtzPreset: [{ channel: 0, enable: 1, id: 0, name: 'Gate' }, { channel: 0, enable: 0, id: 63, name: 'pos64' }, { channel: 0, enable: 1, id: 64, name: 'x' }, { id: 'bad' }] }));
    expect(await p.presets()).toEqual([{ id: 0, enabled: true, name: 'Gate' }, { id: 63, enabled: false, name: 'pos64' }]);
    expect(sent).toEqual([['GetPtzPreset', { channel: 0 }]]);
  });

  it('presets: a reply without a list is no slots', async () => {
    const { p } = stub(() => ({}));
    expect(await p.presets()).toEqual([]);
  });

  it('savePreset sends the whole object with the cut name; clearPreset enable 0 and empty name', async () => {
    const { p, sent } = stub();
    await p.savePreset(3, 'y'.repeat(40));
    await p.clearPreset(3);
    expect(sent).toEqual([
      ['SetPtzPreset', { PtzPreset: { channel: 0, enable: 1, id: 3, name: 'y'.repeat(31) } }],
      ['SetPtzPreset', { PtzPreset: { channel: 0, enable: 0, id: 3, name: '' } }],
    ]);
  });

  it('camera errors pass through', async () => {
    const p = new ReolinkPtz(async () => {
      throw new Error('param error');
    }, () => true);
    await expect(p.move('left', 5)).rejects.toThrow('param error');
  });
});
