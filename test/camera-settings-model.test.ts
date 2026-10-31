import { describe, expect, it } from 'vitest';
import {
  detectionCommands, detectionFrom, imageCommands, imageFrom, patchApplied,
  validateDetectionPatch, validateImagePatch,
} from '../src/camera/settings/model';

const ALL = '1'.repeat(168);
const NONE = '0'.repeat(168);
// Shapes as returned by the real RLC-1224A (fw v3.2.0.6011), trimmed.
const REAL = {
  rec: { Rec: { enable: 1, schedule: { channel: 0, table: { MD: ALL, AI_PEOPLE: ALL, AI_VEHICLE: ALL, AI_DOG_CAT: ALL, TIMING: NONE } } } },
  md: { MdAlarm: { channel: 0, useNewSens: 1, newSens: { sensDef: 10 } } },
  ai: {
    person: { AiAlarm: { ai_type: 'people', sensitivity: 60 } },
    vehicle: { AiAlarm: { ai_type: 'vehicle', sensitivity: 50 } },
    pet: { AiAlarm: { ai_type: 'dog_cat', sensitivity: 40 } },
  },
  isp: { Isp: { channel: 0, dayNight: 'Auto', antiFlicker: '60HZ', rotation: 1, mirroring: 1 } },
  ir: { IrLights: { state: 'Auto' } },
  wl: { WhiteLed: { channel: 0, mode: 1, bright: 100, state: 0 } },
  osd: { Osd: { channel: 0, osdChannel: { enable: 1, name: 'Den', pos: 'Lower Right' }, osdTime: { enable: 1, pos: 'Top Center' }, watermark: 1 } },
};

describe('reading settings', () => {
  it('maps the real camera replies', () => {
    expect(detectionFrom(REAL)).toEqual({
      recording: true,
      motionRecording: 'on',
      motionSensitivity: 41, // 51 - sensDef 10: higher = more sensitive
      ai: {
        person: { record: 'on', sensitivity: 60 },
        vehicle: { record: 'on', sensitivity: 50 },
        pet: { record: 'on', sensitivity: 40 },
      },
    });
    expect(imageFrom(REAL)).toEqual({
      dayNight: 'auto',
      irLights: 'auto',
      spotlight: { mode: 'auto', brightness: 100 },
      flip: { vertical: true, mirror: true },
      osd: { showName: true, name: 'Den', namePosition: 'Lower Right', showTime: true, timePosition: 'Top Center', watermark: true },
    });
  });

  // Review focus 5.
  it('reports a partly-on schedule as custom', () => {
    const custom = '1'.repeat(84) + '0'.repeat(84);
    const d = detectionFrom({ ...REAL, rec: { Rec: { enable: 0, schedule: { table: { MD: custom, AI_PEOPLE: NONE, AI_VEHICLE: ALL, AI_DOG_CAT: ALL } } } } });
    expect(d.recording).toBe(false);
    expect(d.motionRecording).toBe('custom');
    expect(d.ai.person.record).toBe('off');
  });

  it('maps every day/night, spotlight and IR value', () => {
    const img = (isp: string, mode: number, ir: string) =>
      imageFrom({ ...REAL, isp: { Isp: { dayNight: isp } }, wl: { WhiteLed: { mode, bright: 5 } }, ir: { IrLights: { state: ir } } });
    expect(img('Color', 0, 'Off')).toMatchObject({ dayNight: 'color', irLights: 'off', spotlight: { mode: 'off', brightness: 5 } });
    expect(img('Black&White', 2, 'Auto')).toMatchObject({ dayNight: 'blackwhite', spotlight: { mode: 'night' } });
    expect(img('Auto', 3, 'Auto').spotlight.mode).toBe('schedule');
  });
});

describe('validating patches', () => {
  it('accepts valid detection and image patches', () => {
    expect(validateDetectionPatch({ recording: false, motionSensitivity: 50, ai: { pet: { sensitivity: 0, record: 'off' } } })).toEqual({
      ok: true,
      patch: { recording: false, motionSensitivity: 50, ai: { pet: { sensitivity: 0, record: 'off' } } },
    });
    expect(validateImagePatch({ spotlight: { brightness: 0 }, osd: { showName: false } }).ok).toBe(true);
  });

  // Review focus 2.
  it.each([
    [{ motionSensitivity: 0 }],
    [{ motionSensitivity: 51 }],
    [{ motionSensitivity: 10.5 }],
    [{ ai: { person: { sensitivity: 101 } } }],
    [{ ai: { cat: { sensitivity: 5 } } }],
    [{ motionRecording: 'custom' }],
    [{ recording: 'yes' }],
    [{ surprise: 1 }],
    ['not an object'],
  ])('rejects detection patch %j', (body) => {
    expect(validateDetectionPatch(body).ok).toBe(false);
  });

  it.each([
    [{ dayNight: 'Purple' }],
    [{ dayNight: 'toString' }],
    [{ dayNight: 'constructor' }],
    [{ irLights: 'hasOwnProperty' }],
    [{ irLights: 'on' }],
    [{ spotlight: { mode: 'disco' } }],
    [{ spotlight: { brightness: 101 } }],
    // The OSD text is the camera's name: only PUT /api/cameras/:id/name writes it.
    [{ osd: { name: 'Front door' } }],
    [{ osd: { name: '' } }],
    [{ osd: { namePosition: 'Middle' } }],
    [{ osd: { extra: true } }],
  ])('rejects image patch %j', (body) => {
    expect(validateImagePatch(body).ok).toBe(false);
  });
});

describe('building commands', () => {
  // The firmware resets keys a Set leaves out (measured 2026-09-26), so every
  // write carries the camera's complete current object with only the changed
  // keys replaced — including keys cams doesn't model (rotation, stay_time,
  // watermark, LightingSchedule, …).
  const FULL = {
    rec: { Rec: { enable: 1, postRec: '15 Seconds', preRec: 1, saveDay: 7, schedule: { channel: 0, table: { MD: ALL, AI_PEOPLE: ALL, AI_VEHICLE: ALL, AI_DOG_CAT: ALL, TIMING: NONE } } } },
    md: { MdAlarm: { channel: 0, useNewSens: 1, newSens: { sensDef: 10, sens: [{ id: 0, sensitivity: 10 }] }, scope: { cols: 70 } } },
    ai: {
      person: { AiAlarm: { channel: 0, ai_type: 'people', sensitivity: 60, stay_time: 3, scope: { area: '11' } } },
      vehicle: { AiAlarm: { channel: 0, ai_type: 'vehicle', sensitivity: 50, stay_time: 0 } },
      pet: { AiAlarm: { channel: 0, ai_type: 'dog_cat', sensitivity: 40, stay_time: 0 } },
    },
    isp: { Isp: { channel: 0, dayNight: 'Auto', antiFlicker: '60HZ', rotation: 0, mirroring: 0, bd_day: { mode: 'Auto' } } },
    ir: { IrLights: { state: 'Auto' } },
    wl: { WhiteLed: { channel: 0, mode: 5, bright: 100, state: 0, LightingSchedule: { StartHour: 18 } } },
    osd: { Osd: { channel: 0, osdChannel: { enable: 1, name: 'Den', pos: 'Lower Right' }, osdTime: { enable: 1, pos: 'Custom Pos' }, watermark: 1, bgcolor: 0 } },
  };

  it('writes the complete current object with only the changed keys replaced', () => {
    expect(imageCommands({ dayNight: 'color', osd: { namePosition: 'Upper Left' }, spotlight: { brightness: 40 } }, FULL)).toEqual([
      { fields: ['dayNight'], cmd: 'SetIsp', param: { Isp: { ...FULL.isp.Isp, dayNight: 'Color' } } },
      { fields: ['spotlight'], cmd: 'SetWhiteLed', param: { WhiteLed: { ...FULL.wl.WhiteLed, bright: 40 } } },
      {
        fields: ['osd'],
        cmd: 'SetOsd',
        param: { Osd: { ...FULL.osd.Osd, osdChannel: { enable: 1, name: 'Den', pos: 'Upper Left' } } },
      },
    ]);
    expect(detectionCommands({ motionSensitivity: 50, ai: { person: { sensitivity: 80 } } }, FULL)).toEqual([
      { fields: ['motionSensitivity'], cmd: 'SetMdAlarm', param: { MdAlarm: { ...FULL.md.MdAlarm, newSens: { ...FULL.md.MdAlarm.newSens, sensDef: 1 } } } },
      { fields: ['ai.person.sensitivity'], cmd: 'SetAiAlarm', param: { AiAlarm: { ...FULL.ai.person.AiAlarm, sensitivity: 80 } } },
    ]);
  });

  it('carries several changes to one camera object in a single write', () => {
    const cmds = detectionCommands({ recording: false, motionRecording: 'off', ai: { vehicle: { record: 'off' } } }, FULL);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].fields).toEqual(['recording', 'motionRecording', 'ai.vehicle.record']);
    expect(cmds[0].param).toEqual({
      Rec: { ...FULL.rec.Rec, enable: 0, schedule: { channel: 0, table: { ...FULL.rec.Rec.schedule.table, MD: NONE, AI_VEHICLE: NONE } } },
    });
  });

  it('never mutates the raw replies it is given', () => {
    const before = JSON.stringify(FULL);
    detectionCommands({ recording: false, motionSensitivity: 20, ai: { pet: { sensitivity: 1, record: 'off' } } }, FULL);
    imageCommands({ dayNight: 'color', irLights: 'off', spotlight: { mode: 'off' }, osd: { showTime: false } }, FULL);
    expect(JSON.stringify(FULL)).toBe(before);
  });

  // The Reolink logo on the video: Osd.watermark, written with the whole object.
  it('reads, validates and writes the watermark', () => {
    expect(imageFrom({ ...REAL, osd: { Osd: { ...REAL.osd.Osd, watermark: 0 } } }).osd.watermark).toBe(false);
    expect(validateImagePatch({ osd: { watermark: false } }).ok).toBe(true);
    expect(validateImagePatch({ osd: { watermark: 0 } }).ok).toBe(false);
    expect(imageCommands({ osd: { watermark: false } }, FULL)).toEqual([
      { fields: ['osd'], cmd: 'SetOsd', param: { Osd: { ...FULL.osd.Osd, watermark: 0 } } },
    ]);
    expect(patchApplied('osd', { osd: { watermark: true } }, imageFrom(REAL))).toBe(true);
  });

  // Isp.rotation flips the picture upside down, Isp.mirroring left-right;
  // both = rotated 180° (measured on cam1, 2026-09-29).
  it('reads, validates and writes the picture flip', () => {
    expect(imageFrom({ ...REAL, isp: { Isp: { dayNight: 'Auto', rotation: 0, mirroring: 1 } } }).flip).toEqual({ vertical: false, mirror: true });
    expect(validateImagePatch({ flip: { vertical: true } }).ok).toBe(true);
    expect(validateImagePatch({ flip: { vertical: 1 } }).ok).toBe(false);
    expect(validateImagePatch({ flip: { sideways: true } }).ok).toBe(false);
    expect(imageCommands({ flip: { vertical: false } }, FULL)).toEqual([
      { fields: ['flip'], cmd: 'SetIsp', param: { Isp: { ...FULL.isp.Isp, rotation: 0 } } },
    ]);
    // With day/night in the same save: one SetIsp carrying both.
    const both = imageCommands({ dayNight: 'color', flip: { vertical: true, mirror: true } }, FULL);
    expect(both).toEqual([{ fields: ['dayNight', 'flip'], cmd: 'SetIsp', param: { Isp: { ...FULL.isp.Isp, dayNight: 'Color', rotation: 1, mirroring: 1 } } }]);
    expect(patchApplied('flip', { flip: { mirror: true } }, imageFrom(REAL))).toBe(true);
  });

  it('sends nothing for an empty spotlight or OSD patch', () => {
    expect(imageCommands({ spotlight: {}, osd: {} }, REAL)).toEqual([]);
  });

  it('checks each field against the re-read state', () => {
    const reread = detectionFrom(REAL);
    expect(patchApplied('motionSensitivity', { motionSensitivity: 41 }, reread)).toBe(true);
    expect(patchApplied('motionSensitivity', { motionSensitivity: 20 }, reread)).toBe(false);
    expect(patchApplied('ai.person.record', { ai: { person: { record: 'on' } } }, reread)).toBe(true);
    const img = imageFrom(REAL);
    expect(patchApplied('osd', { osd: { showName: img.osd.showName } }, img)).toBe(true);
    expect(patchApplied('spotlight', { spotlight: { mode: 'off' } }, img)).toBe(false);
  });
});
