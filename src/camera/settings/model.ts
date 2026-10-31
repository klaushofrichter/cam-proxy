// Typed cams settings <-> Reolink commands. Shapes measured on RLC-1224A
// firmware v3.2.0.6011 (see docs/reolink-api.md and the Plan 4 camera facts).
// Pure: no I/O, so every mapping is unit-tested against real replies.

export type Schedule = 'on' | 'off' | 'custom';
export type AiKind = 'person' | 'vehicle' | 'pet';
export const AI_KINDS: AiKind[] = ['person', 'vehicle', 'pet'];
export const AI_TYPE: Record<AiKind, 'people' | 'vehicle' | 'dog_cat'> = { person: 'people', vehicle: 'vehicle', pet: 'dog_cat' };
export const SCHEDULE_KEY: Record<AiKind, 'AI_PEOPLE' | 'AI_VEHICLE' | 'AI_DOG_CAT'> = {
  person: 'AI_PEOPLE',
  vehicle: 'AI_VEHICLE',
  pet: 'AI_DOG_CAT',
};

export interface DetectionSettings {
  recording: boolean;
  motionRecording: Schedule;
  motionSensitivity: number; // 1–50, higher = more sensitive (51 − sensDef)
  ai: Record<AiKind, { record: Schedule; sensitivity: number }>;
}

export const OSD_POSITIONS = ['Upper Left', 'Top Center', 'Upper Right', 'Lower Left', 'Bottom Center', 'Lower Right'] as const;
export type OsdPosition = (typeof OSD_POSITIONS)[number];
export type SpotlightMode = 'off' | 'auto' | 'night' | 'schedule';
const SPOTLIGHT_MODES: SpotlightMode[] = ['off', 'auto', 'night', 'schedule']; // index = WhiteLed.mode

export interface ImageSettings {
  dayNight: 'auto' | 'color' | 'blackwhite';
  irLights: 'auto' | 'off';
  spotlight: { mode: SpotlightMode; brightness: number };
  // Isp.rotation turns the picture upside down, Isp.mirroring mirrors it left-right;
  // both = rotated 180°, for a camera mounted upside down (measured 2026-09-29).
  flip: { vertical: boolean; mirror: boolean };
  osd: { showName: boolean; name: string; namePosition: OsdPosition; showTime: boolean; timePosition: OsdPosition; watermark: boolean };
}

type Toggle = 'on' | 'off';
export interface DetectionPatch {
  recording?: boolean;
  motionRecording?: Toggle;
  motionSensitivity?: number;
  ai?: Partial<Record<AiKind, { record?: Toggle; sensitivity?: number }>>;
}
export interface ImagePatch {
  dayNight?: ImageSettings['dayNight'];
  irLights?: ImageSettings['irLights'];
  spotlight?: Partial<ImageSettings['spotlight']>;
  flip?: Partial<ImageSettings['flip']>;
  osd?: Partial<Omit<ImageSettings['osd'], 'name'>>;
}

// One camera write. `fields` are the cams fields it carries: several changes
// to the same camera object travel in one command (two separate writes, each
// built from the same original, would undo each other).
export interface SettingsCommand {
  fields: string[];
  cmd: string;
  param: object;
}

// The raw Get replies a save is built from.
export interface RawDetection {
  rec: unknown;
  md: unknown;
  ai: Record<AiKind, unknown>;
}
export interface RawImage {
  isp: unknown;
  ir: unknown;
  wl: unknown;
  osd: unknown;
}

const DAYNIGHT: Record<ImageSettings['dayNight'], string> = { auto: 'Auto', color: 'Color', blackwhite: 'Black&White' };
const IR: Record<ImageSettings['irLights'], string> = { auto: 'Auto', off: 'Off' };
const HOURS = 168;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function scheduleOf(table: string | undefined): Schedule {
  if (!table) return 'off';
  if (/^1+$/.test(table)) return 'on';
  if (/^0+$/.test(table)) return 'off';
  return 'custom';
}

function reverse<T extends string>(map: Record<T, string>, value: unknown, fallback: T): T {
  const hit = (Object.keys(map) as T[]).find((k) => map[k] === value);
  return hit ?? fallback;
}

export function detectionFrom(raw: { rec: unknown; md: unknown; ai: Record<AiKind, unknown> }): DetectionSettings {
  const rec = obj(obj(raw.rec).Rec);
  const table = obj(obj(rec.schedule).table) as Record<string, string>;
  const md = obj(obj(raw.md).MdAlarm);
  const sensDef = num(obj(md.newSens).sensDef, 10);
  const ai = {} as DetectionSettings['ai'];
  for (const kind of AI_KINDS) {
    ai[kind] = { record: scheduleOf(table[SCHEDULE_KEY[kind]]), sensitivity: num(obj(obj(raw.ai[kind]).AiAlarm).sensitivity) };
  }
  return { recording: num(rec.enable) === 1, motionRecording: scheduleOf(table.MD), motionSensitivity: 51 - sensDef, ai };
}

export function imageFrom(raw: { isp: unknown; ir: unknown; wl: unknown; osd: unknown }): ImageSettings {
  const isp = obj(obj(raw.isp).Isp);
  const wl = obj(obj(raw.wl).WhiteLed);
  const osd = obj(obj(raw.osd).Osd);
  const ch = obj(osd.osdChannel);
  const time = obj(osd.osdTime);
  const pos = (p: unknown): OsdPosition => ((OSD_POSITIONS as readonly string[]).includes(p as string) ? (p as OsdPosition) : 'Upper Left');
  return {
    dayNight: reverse(DAYNIGHT, isp.dayNight, 'auto'),
    irLights: reverse(IR, obj(obj(raw.ir).IrLights).state, 'auto'),
    spotlight: { mode: SPOTLIGHT_MODES[num(wl.mode)] ?? 'off', brightness: num(wl.bright) },
    flip: { vertical: num(isp.rotation) === 1, mirror: num(isp.mirroring) === 1 },
    osd: {
      showName: num(ch.enable) === 1,
      name: typeof ch.name === 'string' ? ch.name : '',
      namePosition: pos(ch.pos),
      showTime: num(time.enable) === 1,
      timePosition: pos(time.pos),
      watermark: num(osd.watermark) === 1, // the Reolink logo on the video
    },
  };
}

// --- validation: exactly the camera's ranges; unknown keys are errors ---

function onlyKeys(o: Obj, allowed: string[], path: string, details: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) details.push(`${path}${k}: unknown field`);
}
const isInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isObj = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);

export function validateDetectionPatch(body: unknown): { ok: true; patch: DetectionPatch } | { ok: false; details: string[] } {
  if (!isObj(body)) return { ok: false, details: ['body must be an object'] };
  const b = body as Obj;
  const details: string[] = [];
  onlyKeys(b, ['recording', 'motionRecording', 'motionSensitivity', 'ai'], '', details);
  if ('recording' in b && typeof b.recording !== 'boolean') details.push('recording: must be true or false');
  if ('motionRecording' in b && b.motionRecording !== 'on' && b.motionRecording !== 'off') details.push('motionRecording: must be "on" or "off"');
  if ('motionSensitivity' in b && !isInt(b.motionSensitivity, 1, 50)) details.push('motionSensitivity: integer 1–50');
  if ('ai' in b) {
    if (!isObj(b.ai)) details.push('ai: must be an object');
    else {
      const ai = b.ai as Obj;
      onlyKeys(ai, AI_KINDS, 'ai.', details);
      for (const kind of AI_KINDS) {
        if (!(kind in ai)) continue;
        if (!isObj(ai[kind])) {
          details.push(`ai.${kind}: must be an object`);
          continue;
        }
        const k = ai[kind] as Obj;
        onlyKeys(k, ['record', 'sensitivity'], `ai.${kind}.`, details);
        if ('record' in k && k.record !== 'on' && k.record !== 'off') details.push(`ai.${kind}.record: must be "on" or "off"`);
        if ('sensitivity' in k && !isInt(k.sensitivity, 0, 100)) details.push(`ai.${kind}.sensitivity: integer 0–100`);
      }
    }
  }
  return details.length ? { ok: false, details } : { ok: true, patch: b as DetectionPatch };
}

export function validateImagePatch(body: unknown): { ok: true; patch: ImagePatch } | { ok: false; details: string[] } {
  if (!isObj(body)) return { ok: false, details: ['body must be an object'] };
  const b = body as Obj;
  const details: string[] = [];
  onlyKeys(b, ['dayNight', 'irLights', 'spotlight', 'flip', 'osd'], '', details);
  // Own keys only: `in` would accept inherited names such as 'toString'.
  if ('dayNight' in b && !Object.keys(DAYNIGHT).includes(b.dayNight as string)) details.push('dayNight: auto, color or blackwhite');
  if ('irLights' in b && !Object.keys(IR).includes(b.irLights as string)) details.push('irLights: auto or off');
  if ('spotlight' in b) {
    if (!isObj(b.spotlight)) details.push('spotlight: must be an object');
    else {
      const s = b.spotlight as Obj;
      onlyKeys(s, ['mode', 'brightness'], 'spotlight.', details);
      if ('mode' in s && !SPOTLIGHT_MODES.includes(s.mode as SpotlightMode)) details.push('spotlight.mode: off, auto, night or schedule');
      if ('brightness' in s && !isInt(s.brightness, 0, 100)) details.push('spotlight.brightness: integer 0–100');
    }
  }
  if ('flip' in b) {
    if (!isObj(b.flip)) details.push('flip: must be an object');
    else {
      const f = b.flip as Obj;
      onlyKeys(f, ['vertical', 'mirror'], 'flip.', details);
      for (const k of ['vertical', 'mirror']) if (k in f && typeof f[k] !== 'boolean') details.push(`flip.${k}: must be true or false`);
    }
  }
  if ('osd' in b) {
    if (!isObj(b.osd)) details.push('osd: must be an object');
    else {
      const o = b.osd as Obj;
      // No `name`: the OSD text is the camera's name (one value with
      // GetDevName, measured 2026-10-03), renamed only through PUT name.
      onlyKeys(o, ['showName', 'namePosition', 'showTime', 'timePosition', 'watermark'], 'osd.', details);
      for (const k of ['showName', 'showTime', 'watermark']) if (k in o && typeof o[k] !== 'boolean') details.push(`osd.${k}: must be true or false`);
      for (const k of ['namePosition', 'timePosition']) {
        if (k in o && !(OSD_POSITIONS as readonly string[]).includes(o[k] as string)) details.push(`osd.${k}: one of ${OSD_POSITIONS.join(', ')}`);
      }
    }
  }
  return details.length ? { ok: false, details } : { ok: true, patch: b as ImagePatch };
}

// --- commands: only what changed, in a stable order ---

// Every write sends the camera's COMPLETE current object with only the
// changed keys replaced. The firmware resets keys left out of a Set to a
// default in its saved configuration (measured 2026-09-26: a partial SetIsp
// changed rotation 0 -> 1, a partial SetOsd watermark 1 -> 0, a partial
// SetAiAlarm stay_time 3 -> 0, taking effect after a restart). A read-back
// right after the write does not show this, so it can't be caught by
// re-reading: the only safe write is a whole object.
function clone<T>(v: T): T {
  return structuredClone(v ?? {}) as T;
}

class Writes {
  private readonly byKey = new Map<string, SettingsCommand & { body: Obj }>();
  // `key` groups changes to one camera object; `seed` is its full current
  // value, cloned the first time the object is touched.
  edit(key: string, cmd: string, wrap: string, seed: () => Obj, field: string, change: (o: Obj) => void): void {
    let w = this.byKey.get(key);
    if (!w) {
      const body = clone(seed());
      w = { fields: [], cmd, param: { [wrap]: body }, body };
      this.byKey.set(key, w);
    }
    change(w.body);
    w.fields.push(field);
  }
  list(): SettingsCommand[] {
    return [...this.byKey.values()].map(({ fields, cmd, param }) => ({ fields, cmd, param }));
  }
}

export function detectionCommands(p: DetectionPatch, raw: RawDetection): SettingsCommand[] {
  const w = new Writes();
  const rec = () => ({ ...obj(obj(raw.rec).Rec) });
  const setTable = (key: string, t: Toggle) => (o: Obj) => {
    const sched = (o.schedule = { channel: 0, ...obj(o.schedule) }) as Obj;
    sched.table = { ...obj(sched.table), [key]: (t === 'on' ? '1' : '0').repeat(HOURS) };
  };
  if (p.recording !== undefined) w.edit('rec', 'SetRecV20', 'Rec', rec, 'recording', (o) => (o.enable = p.recording ? 1 : 0));
  if (p.motionRecording) w.edit('rec', 'SetRecV20', 'Rec', rec, 'motionRecording', setTable('MD', p.motionRecording));
  for (const kind of AI_KINDS) {
    const a = p.ai?.[kind];
    if (a?.record) w.edit('rec', 'SetRecV20', 'Rec', rec, `ai.${kind}.record`, setTable(SCHEDULE_KEY[kind], a.record));
  }
  if (p.motionSensitivity !== undefined) {
    const sensDef = 51 - p.motionSensitivity;
    w.edit('md', 'SetMdAlarm', 'MdAlarm', () => ({ channel: 0, ...obj(obj(raw.md).MdAlarm) }), 'motionSensitivity', (o) => {
      o.useNewSens = 1;
      o.newSens = { ...obj(o.newSens), sensDef };
    });
  }
  for (const kind of AI_KINDS) {
    const sensitivity = p.ai?.[kind]?.sensitivity;
    if (sensitivity === undefined) continue;
    w.edit(`ai.${kind}`, 'SetAiAlarm', 'AiAlarm', () => ({ channel: 0, ...obj(obj(raw.ai[kind]).AiAlarm), ai_type: AI_TYPE[kind] }), `ai.${kind}.sensitivity`, (o) => {
      o.sensitivity = sensitivity;
    });
  }
  return w.list();
}

export function imageCommands(p: ImagePatch, raw: RawImage): SettingsCommand[] {
  const w = new Writes();
  if (p.dayNight) {
    const v = DAYNIGHT[p.dayNight];
    w.edit('isp', 'SetIsp', 'Isp', () => ({ channel: 0, ...obj(obj(raw.isp).Isp) }), 'dayNight', (o) => (o.dayNight = v));
  }
  if (p.flip && Object.keys(p.flip).length) {
    const f = p.flip;
    w.edit('isp', 'SetIsp', 'Isp', () => ({ channel: 0, ...obj(obj(raw.isp).Isp) }), 'flip', (o) => {
      if (f.vertical !== undefined) o.rotation = f.vertical ? 1 : 0;
      if (f.mirror !== undefined) o.mirroring = f.mirror ? 1 : 0;
    });
  }
  if (p.irLights) {
    const v = IR[p.irLights];
    w.edit('ir', 'SetIrLights', 'IrLights', () => ({ channel: 0, ...obj(obj(raw.ir).IrLights) }), 'irLights', (o) => (o.state = v));
  }
  if (p.spotlight && Object.keys(p.spotlight).length) {
    const s = p.spotlight;
    w.edit('wl', 'SetWhiteLed', 'WhiteLed', () => ({ channel: 0, ...obj(obj(raw.wl).WhiteLed) }), 'spotlight', (o) => {
      if (s.mode !== undefined) o.mode = SPOTLIGHT_MODES.indexOf(s.mode);
      if (s.brightness !== undefined) o.bright = s.brightness;
    });
  }
  if (p.osd && Object.keys(p.osd).length) {
    const d = p.osd;
    w.edit('osd', 'SetOsd', 'Osd', () => ({ channel: 0, ...obj(obj(raw.osd).Osd) }), 'osd', (o) => {
      const ch = (o.osdChannel = { ...obj(o.osdChannel) }) as Obj;
      const time = (o.osdTime = { ...obj(o.osdTime) }) as Obj;
      if (d.showName !== undefined) ch.enable = d.showName ? 1 : 0;
      if (d.namePosition !== undefined) ch.pos = d.namePosition;
      if (d.showTime !== undefined) time.enable = d.showTime ? 1 : 0;
      if (d.timePosition !== undefined) time.pos = d.timePosition;
      if (d.watermark !== undefined) o.watermark = d.watermark ? 1 : 0;
    });
  }
  return w.list();
}

// Keys (dotted paths) that differ between two raw objects, for spotting a
// write that changed something it wasn't asked to.
export function changedKeys(before: unknown, after: unknown, prefix = ''): string[] {
  if (isObj(before) && isObj(after)) {
    const keys = new Set([...Object.keys(before as Obj), ...Object.keys(after as Obj)]);
    return [...keys].flatMap((k) => changedKeys((before as Obj)[k], (after as Obj)[k], prefix ? `${prefix}.${k}` : k));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
}

// A field counts as saved only if the re-read camera state shows the value
// asked for: the firmware answers rspCode 200 even for writes it ignores.
export function patchApplied(field: string, patch: DetectionPatch | ImagePatch, reread: DetectionSettings | ImageSettings): boolean {
  const want = field.split('.').reduce<unknown>((o, k) => obj(o)[k], patch);
  const got = field.split('.').reduce<unknown>((o, k) => obj(o)[k], reread);
  if (isObj(want)) return Object.entries(want as Obj).every(([k, v]) => obj(got)[k] === v);
  return want === got;
}
