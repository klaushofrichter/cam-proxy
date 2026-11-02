// The camera's video encoding (GetEnc / SetEnc) as a settings section: per
// stream the codec, size, frame rate, bit rate, GOP and profile, and the
// options the camera offers (GetEnc's range, action 1). Shapes measured on
// the E1 Outdoor Pro (cam-sim reference/E1-Outdoor-Pro/GetEnc.json): the
// range is a list of entries, each one main size paired with one sub size
// (and ext, on a camera that has one), with the lists allowed for each.
// Pure: no I/O.
import type { SettingsCommand } from './model';

export const ENC_STREAMS = ['main', 'sub', 'ext'] as const;
export type EncStreamName = (typeof ENC_STREAMS)[number];
const RAW_KEY: Record<EncStreamName, string> = { main: 'mainStream', sub: 'subStream', ext: 'extStream' };

export interface EncStreamSettings { codec: string; width: number; height: number; fps: number; bitRate: number; gop: number; profile: string }
export interface EncStreamOptions { width: number; height: number; codecs: string[]; fps: number[]; bitRates: number[]; profiles: string[]; gop: { min: number; max: number } | null }
// One of the camera's combinations: a main size with the sub size (and ext) it pairs with.
export type EncOption = Partial<Record<EncStreamName, EncStreamOptions>>;
export type EncodingSettings = Partial<Record<EncStreamName, EncStreamSettings>> & { options: EncOption[] };
export type EncodingPatch = Partial<Record<EncStreamName, Partial<EncStreamSettings>>>;

// GetEnc with action 1: `enc` its value ({Enc}), `range` its range ({Enc: [...]}).
export interface RawEncoding { enc: unknown; range: unknown }

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const isObj = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function streamFrom(s: Obj): EncStreamSettings | undefined {
  if (typeof s.width !== 'number' || typeof s.height !== 'number') return undefined;
  return {
    codec: typeof s.vType === 'string' ? s.vType : '',
    width: s.width,
    height: s.height,
    fps: typeof s.frameRate === 'number' ? s.frameRate : 0,
    bitRate: typeof s.bitRate === 'number' ? s.bitRate : 0,
    gop: typeof s.gop === 'number' ? s.gop : 0,
    profile: typeof s.profile === 'string' ? s.profile : '',
  };
}

function optionsFrom(r: Obj): EncStreamOptions | undefined {
  const size = /^(\d+)\*(\d+)$/.exec(typeof r.size === 'string' ? r.size : '');
  const width = typeof r.width === 'number' ? r.width : Number(size?.[1]);
  const height = typeof r.height === 'number' ? r.height : Number(size?.[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  const g = obj(r.gop);
  return {
    width, height,
    codecs: strs(r.vType), fps: nums(r.frameRate), bitRates: nums(r.bitRate), profiles: strs(r.profile),
    gop: typeof g.min === 'number' && typeof g.max === 'number' ? { min: g.min, max: g.max } : null,
  };
}

export function rangeEntries(range: unknown): Obj[] {
  const list = obj(range).Enc;
  return Array.isArray(list) ? list.filter(isObj) as Obj[] : [];
}

export function encodingFrom(raw: RawEncoding): EncodingSettings {
  const enc = obj(obj(raw.enc).Enc);
  const out: EncodingSettings = { options: [] };
  for (const name of ENC_STREAMS) {
    const s = streamFrom(obj(enc[RAW_KEY[name]]));
    if (s) out[name] = s;
  }
  for (const e of rangeEntries(raw.range)) {
    const o: EncOption = {};
    for (const name of ENC_STREAMS) {
      const x = isObj(e[RAW_KEY[name]]) ? optionsFrom(obj(e[RAW_KEY[name]])) : undefined;
      if (x) o[name] = x;
    }
    if (o.main) out.options.push(o);
  }
  return out;
}

// --- validation of the body: shape only (the camera's range is checked once it is read) ---

const FIELDS: (keyof EncStreamSettings)[] = ['codec', 'width', 'height', 'fps', 'bitRate', 'gop', 'profile'];
const isInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

export function validateEncodingPatch(body: unknown): { ok: true; patch: EncodingPatch } | { ok: false; details: string[] } {
  if (!isObj(body)) return { ok: false, details: ['body must be an object'] };
  const b = body as Obj;
  const details: string[] = [];
  for (const k of Object.keys(b)) if (!(ENC_STREAMS as readonly string[]).includes(k)) details.push(`${k}: unknown field`);
  for (const name of ENC_STREAMS) {
    if (!(name in b)) continue;
    if (!isObj(b[name])) {
      details.push(`${name}: must be an object`);
      continue;
    }
    const s = b[name] as Obj;
    for (const k of Object.keys(s)) if (!(FIELDS as string[]).includes(k)) details.push(`${name}.${k}: unknown field`);
    if ('codec' in s && s.codec !== 'h264' && s.codec !== 'h265') details.push(`${name}.codec: h264 or h265`);
    for (const k of ['width', 'height'] as const) if (k in s && !isInt(s[k], 16, 16384)) details.push(`${name}.${k}: integer 16–16384`);
    if (('width' in s) !== ('height' in s)) details.push(`${name}: width and height go together`);
    if ('fps' in s && !isInt(s.fps, 1, 120)) details.push(`${name}.fps: integer 1–120`);
    if ('bitRate' in s && !isInt(s.bitRate, 1, 1_000_000)) details.push(`${name}.bitRate: integer kbps`);
    if ('gop' in s && !isInt(s.gop, 1, 1000)) details.push(`${name}.gop: integer`);
    if ('profile' in s && (typeof s.profile !== 'string' || !/^[A-Za-z]{1,16}$/.test(s.profile))) details.push(`${name}.profile: a profile name such as High`);
    if (!Object.keys(s).length) details.push(`${name}: nothing to change`);
  }
  return details.length ? { ok: false, details } : { ok: true, patch: b as EncodingPatch };
}

// --- the change as the camera's whole Enc object ---

// The camera's Enc with the patch applied (a clone; channel 0).
export function patchedEnc(p: EncodingPatch, raw: RawEncoding): Obj {
  const enc = structuredClone({ ...obj(obj(raw.enc).Enc), channel: 0 }) as Obj;
  for (const name of ENC_STREAMS) {
    const c = p[name];
    if (!c) continue;
    const s = (enc[RAW_KEY[name]] = { ...obj(enc[RAW_KEY[name]]) }) as Obj;
    if (c.codec !== undefined) s.vType = c.codec;
    if (c.width !== undefined && c.height !== undefined) {
      s.width = c.width;
      s.height = c.height;
      s.size = `${c.width}*${c.height}`;
    }
    if (c.fps !== undefined) s.frameRate = c.fps;
    if (c.bitRate !== undefined) s.bitRate = c.bitRate;
    if (c.gop !== undefined) s.gop = c.gop;
    if (c.profile !== undefined) s.profile = c.profile;
  }
  return enc;
}

const sizeText = (s: Obj) => `${s.width}x${s.height}`;

// Whether the camera's range allows the patched streams: the sizes are one
// entry's pair, and every value is in that entry's lists. A camera that
// answered no range is not checked here (its own answer and the re-read are).
// `details` say what is not allowed, in the proxy's terms.
export function outOfRange(p: EncodingPatch, raw: RawEncoding): string[] {
  const entries = rangeEntries(raw.range);
  if (!entries.length) return [];
  const enc = patchedEnc(p, raw);
  const present = ENC_STREAMS.filter((n) => isObj(enc[RAW_KEY[n]]));
  const sameSize = (e: Obj, n: EncStreamName) => {
    const o = optionsFrom(obj(e[RAW_KEY[n]]));
    const s = obj(enc[RAW_KEY[n]]);
    return !!o && o.width === s.width && o.height === s.height;
  };
  const entry = entries.find((e) => present.every((n) => !isObj(e[RAW_KEY[n]]) || sameSize(e, n)));
  if (!entry) {
    return [`sizes ${present.map((n) => `${n} ${sizeText(obj(enc[RAW_KEY[n]]))}`).join(', ')}: not a combination the camera offers`];
  }
  const details: string[] = [];
  for (const n of present) {
    const o = optionsFrom(obj(entry[RAW_KEY[n]]));
    if (!o) continue;
    const s = obj(enc[RAW_KEY[n]]);
    if (o.codecs.length && !o.codecs.includes(s.vType as string)) details.push(`${n}.codec: one of ${o.codecs.join(', ')}`);
    if (o.fps.length && !o.fps.includes(s.frameRate as number)) details.push(`${n}.fps: one of ${o.fps.join(', ')} at ${sizeText(s)}`);
    if (o.bitRates.length && !o.bitRates.includes(s.bitRate as number)) details.push(`${n}.bitRate: one of ${o.bitRates.join(', ')} at ${sizeText(s)}`);
    if (o.profiles.length && !o.profiles.includes(s.profile as string)) details.push(`${n}.profile: one of ${o.profiles.join(', ')}`);
    if (o.gop && (typeof s.gop !== 'number' || s.gop < o.gop.min || s.gop > o.gop.max)) details.push(`${n}.gop: ${o.gop.min}–${o.gop.max}`);
  }
  return details;
}

// One SetEnc with the camera's whole Enc object, the asked streams changed.
// The fields are the streams the patch names.
export function encodingCommands(p: EncodingPatch, raw: RawEncoding): SettingsCommand[] {
  const fields = ENC_STREAMS.filter((n) => p[n]);
  return fields.length ? [{ fields: [...fields], cmd: 'SetEnc', param: { Enc: patchedEnc(p, raw) } }] : [];
}

// Whether the picture a client gets changes: a stream's codec, size or frame rate.
export function videoChanged(a: EncodingSettings, b: EncodingSettings): EncStreamName[] {
  return ENC_STREAMS.filter((n) => {
    const x = a[n], y = b[n];
    return !!x !== !!y || (!!x && !!y && (x.codec !== y.codec || x.width !== y.width || x.height !== y.height || x.fps !== y.fps));
  });
}
