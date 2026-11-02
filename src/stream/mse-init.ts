// The MSE init segment's real parameter sets. go2rtc (1.9.14) builds its MSE
// init segment from the RTSP SDP: a camera whose SDP has no
// sprop-parameter-sets (the E1 Outdoor Pro and the RLC-1224A; the CX820 sends
// them) gets go2rtc's placeholder, an H.264 SPS of 128x96
// (avcC 6742000af841a2, codecs avc1.640029) or an H.265 VPS/SPS/PPS of
// 2560x1440 (hvc1.1.6.L153.B0), whatever the stream is (measured 2026-11-02).
// A browser then shows the picture at the placeholder's aspect ratio (the
// E1's 640x360 sub as 640x480). The real parameter sets come in band, in the
// first keyframe: InitHold keeps the mse message and the init back until the
// first video fragment, and when its parameter sets differ from the init's,
// rewrites the init (avcC/hvcC, the sample entry's and tkhd's width and
// height) and the codec in the mse message. Pure: no I/O.

// --- boxes ---------------------------------------------------------------

interface Box { type: string; head: Buffer; kids?: Box[]; body?: Buffer }

// Containers, and the bytes a box carries before its children.
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'dinf', 'edts', 'moof', 'traf']);
const PREFIX: Record<string, number> = { stsd: 8, avc1: 78, avc3: 78, hvc1: 78, hev1: 78 };
export const VIDEO_ENTRIES = new Set(['avc1', 'avc3', 'hvc1', 'hev1']);

// The boxes in `b`; null when they don't add up (64-bit or open-ended sizes included).
function parseBoxes(b: Buffer, depth = 0): Box[] | null {
  const out: Box[] = [];
  let off = 0;
  while (off < b.length) {
    if (off + 8 > b.length || depth > 12) return null;
    const size = b.readUInt32BE(off);
    if (size < 8 || off + size > b.length) return null;
    const type = b.toString('latin1', off + 4, off + 8);
    const body = b.subarray(off + 8, off + size);
    const pre = CONTAINERS.has(type) ? 0 : PREFIX[type];
    if (pre === undefined) out.push({ type, head: Buffer.alloc(0), body });
    else {
      if (body.length < pre) return null;
      const kids = parseBoxes(body.subarray(pre), depth + 1);
      if (!kids) return null;
      out.push({ type, head: body.subarray(0, pre), kids });
    }
    off += size;
  }
  return out;
}

function serialize(boxes: Box[]): Buffer {
  return Buffer.concat(boxes.map((x) => {
    const inner = x.kids ? Buffer.concat([x.head, serialize(x.kids)]) : x.body!;
    const h = Buffer.alloc(8);
    h.writeUInt32BE(inner.length + 8, 0);
    h.write(x.type, 4, 'latin1');
    return Buffer.concat([h, inner]);
  }));
}

const kid = (x: Box | undefined, type: string) => x?.kids?.find((k) => k.type === type);
const path = (x: Box | undefined, ...types: string[]) => types.reduce<Box | undefined>((b, t) => kid(b, t), x);

// --- bits ----------------------------------------------------------------

// The RBSP of a NAL unit (emulation prevention bytes removed).
export function rbsp(nal: Buffer): Buffer {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of nal) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

class Bits {
  private pos = 0;
  constructor(private readonly b: Buffer) {}
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.b[this.pos >> 3];
      if (byte === undefined) throw new RangeError('sps: out of data');
      v = v * 2 + ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) if (++zeros > 31) throw new RangeError('sps: bad exp-golomb');
    return 2 ** zeros - 1 + this.u(zeros);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
  skip(n: number): void {
    this.u(n);
  }
}

export interface SpsInfo { width: number; height: number; chromaFormat: number; bitDepthLuma: number; bitDepthChroma: number }

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

// An H.264 SPS (with its NAL header byte): the cropped size, chroma format and bit depths.
export function avcSps(nal: Buffer): SpsInfo & { profile: number; constraints: number; level: number } {
  const r = new Bits(rbsp(nal).subarray(1));
  const profile = r.u(8), constraints = r.u(8), level = r.u(8);
  r.ue();
  let chromaFormat = 1, separate = 0, bitDepthLuma = 8, bitDepthChroma = 8;
  if (HIGH_PROFILES.has(profile)) {
    chromaFormat = r.ue();
    if (chromaFormat === 3) separate = r.u(1);
    bitDepthLuma = r.ue() + 8;
    bitDepthChroma = r.ue() + 8;
    r.skip(1);
    if (r.u(1)) {
      for (let i = 0; i < (chromaFormat !== 3 ? 8 : 12); i++) {
        if (!r.u(1)) continue;
        let last = 8, next = 8;
        for (let j = 0; j < (i < 6 ? 16 : 64) && next !== 0; j++) {
          next = (last + r.se() + 256) % 256;
          if (next !== 0) last = next;
        }
      }
    }
  }
  r.ue();
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.skip(1);
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue();
  r.skip(1);
  const wMbs = r.ue() + 1, hUnits = r.ue() + 1;
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.skip(1);
  r.skip(1);
  let cl = 0, cr = 0, ct = 0, cb = 0;
  if (r.u(1)) {
    cl = r.ue();
    cr = r.ue();
    ct = r.ue();
    cb = r.ue();
  }
  const arrayType = separate ? 0 : chromaFormat;
  const unitX = arrayType === 0 ? 1 : arrayType === 3 ? 1 : 2;
  const unitY = (arrayType === 0 ? 1 : arrayType === 1 ? 2 : 1) * (2 - frameMbsOnly);
  return {
    profile, constraints, level, chromaFormat, bitDepthLuma, bitDepthChroma,
    width: wMbs * 16 - unitX * (cl + cr),
    height: (2 - frameMbsOnly) * hUnits * 16 - unitY * (ct + cb),
  };
}

// An H.265 SPS (with its 2-byte NAL header): the size inside the
// conformance window, chroma format, bit depths, sub-layers, and the
// general profile_tier_level (12 bytes, as hvcC carries it).
export function hevcSps(nal: Buffer): SpsInfo & { ptl: Buffer; subLayers: number; nesting: number } {
  const data = rbsp(nal).subarray(2);
  const r = new Bits(data);
  r.skip(4);
  const maxSubMinus1 = r.u(3);
  const nesting = r.u(1);
  const ptl = Buffer.from(data.subarray(1, 13));
  if (ptl.length < 12) throw new RangeError('sps: short profile_tier_level');
  r.skip(96);
  const subProfile: number[] = [], subLevel: number[] = [];
  for (let i = 0; i < maxSubMinus1; i++) {
    subProfile.push(r.u(1));
    subLevel.push(r.u(1));
  }
  if (maxSubMinus1 > 0) for (let i = maxSubMinus1; i < 8; i++) r.skip(2);
  for (let i = 0; i < maxSubMinus1; i++) {
    if (subProfile[i]) r.skip(88);
    if (subLevel[i]) r.skip(8);
  }
  r.ue();
  const chromaFormat = r.ue();
  if (chromaFormat === 3) r.skip(1);
  let width = r.ue(), height = r.ue();
  if (r.u(1)) {
    const l = r.ue(), rt = r.ue(), t = r.ue(), b = r.ue();
    width -= (chromaFormat === 1 || chromaFormat === 2 ? 2 : 1) * (l + rt);
    height -= (chromaFormat === 1 ? 2 : 1) * (t + b);
  }
  const bitDepthLuma = r.ue() + 8, bitDepthChroma = r.ue() + 8;
  return { width, height, chromaFormat, bitDepthLuma, bitDepthChroma, ptl, subLayers: maxSubMinus1 + 1, nesting };
}

// --- parameter sets ------------------------------------------------------

export type VideoKind = 'avc' | 'hevc';
export interface ParamSets { vps: Buffer[]; sps: Buffer[]; pps: Buffer[] }

const avcType = (n: Buffer) => n[0] & 0x1f;
const hevcType = (n: Buffer) => (n[0] >> 1) & 0x3f;

// The NAL units of a sample: 4-byte lengths (as go2rtc writes them), or
// Annex-B start codes. An H.265 aggregation packet (type 48, which go2rtc
// passes on from RTP) is opened.
export function nalUnits(sample: Buffer, kind: VideoKind): Buffer[] {
  const out: Buffer[] = [];
  const annexB = sample.length >= 4 && sample.readUInt32BE(0) === 1 || sample.length >= 3 && sample.readUIntBE(0, 3) === 1;
  if (annexB) {
    const starts: Array<[number, number]> = [];
    for (let i = 0; i + 3 <= sample.length; i++) {
      if (sample[i] === 0 && sample[i + 1] === 0 && sample[i + 2] === 1) {
        starts.push([i, i + 3]);
        i += 2;
      }
    }
    for (let k = 0; k < starts.length; k++) {
      let end = k + 1 < starts.length ? starts[k + 1][0] : sample.length;
      while (end > starts[k][1] && sample[end - 1] === 0) end--;
      out.push(sample.subarray(starts[k][1], end));
    }
  } else {
    let off = 0;
    while (off + 4 <= sample.length) {
      const n = sample.readUInt32BE(off);
      if (n === 0 || off + 4 + n > sample.length) break;
      out.push(sample.subarray(off + 4, off + 4 + n));
      off += 4 + n;
    }
  }
  if (kind !== 'hevc') return out;
  return out.flatMap((n) => {
    if (n.length < 2 || hevcType(n) !== 48) return [n];
    const inner: Buffer[] = [];
    for (let off = 2; off + 2 <= n.length;) {
      const len = n.readUInt16BE(off);
      if (!len || off + 2 + len > n.length) break;
      inner.push(n.subarray(off + 2, off + 2 + len));
      off += 2 + len;
    }
    return inner;
  });
}

function setsOf(nals: Buffer[], kind: VideoKind): ParamSets {
  const ps: ParamSets = { vps: [], sps: [], pps: [] };
  for (const n of nals) {
    if (!n.length) continue;
    const t = kind === 'avc' ? avcType(n) : hevcType(n);
    if (kind === 'avc' ? t === 7 : t === 33) ps.sps.push(n);
    else if (kind === 'avc' ? t === 8 : t === 34) ps.pps.push(n);
    else if (kind === 'hevc' && t === 32) ps.vps.push(n);
  }
  return ps;
}

const complete = (ps: ParamSets, kind: VideoKind) => ps.sps.length > 0 && ps.pps.length > 0 && (kind === 'avc' || ps.vps.length > 0);

// --- the init segment ----------------------------------------------------

export interface VideoTrack { trackId: number; kind: VideoKind; entry: string; config: ParamSets; width: number; height: number }

function trackOf(trak: Box): VideoTrack | null {
  const tkhd = kid(trak, 'tkhd')?.body;
  const stsd = path(trak, 'mdia', 'minf', 'stbl', 'stsd');
  const entry = stsd?.kids?.find((k) => VIDEO_ENTRIES.has(k.type));
  if (!tkhd || !entry || entry.head.length < 78) return null;
  const kind: VideoKind = entry.type.startsWith('avc') ? 'avc' : 'hevc';
  const cfg = kid(entry, kind === 'avc' ? 'avcC' : 'hvcC')?.body;
  if (!cfg) return null;
  const trackId = tkhd.readUInt32BE(tkhd[0] === 1 ? 20 : 12);
  return { trackId, kind, entry: entry.type, config: configSets(cfg, kind), width: entry.head.readUInt16BE(24), height: entry.head.readUInt16BE(26) };
}

// The parameter sets an avcC or hvcC holds (empty when it doesn't parse).
function configSets(cfg: Buffer, kind: VideoKind): ParamSets {
  const ps: ParamSets = { vps: [], sps: [], pps: [] };
  try {
    if (kind === 'avc') {
      let off = 5;
      for (const list of [ps.sps, ps.pps]) {
        const n = cfg[off++] & (list === ps.sps ? 0x1f : 0xff);
        for (let i = 0; i < n; i++) {
          const len = cfg.readUInt16BE(off);
          list.push(cfg.subarray(off + 2, off + 2 + len));
          off += 2 + len;
        }
      }
    } else {
      let off = 23;
      for (let a = 0, arrays = cfg[22]; a < arrays; a++) {
        const type = cfg[off] & 0x3f, n = cfg.readUInt16BE(off + 1);
        off += 3;
        for (let i = 0; i < n; i++) {
          const len = cfg.readUInt16BE(off);
          const nal = cfg.subarray(off + 2, off + 2 + len);
          if (type === 32) ps.vps.push(nal);
          else if (type === 33) ps.sps.push(nal);
          else if (type === 34) ps.pps.push(nal);
          off += 2 + len;
        }
      }
    }
  } catch {
    return { vps: [], sps: [], pps: [] };
  }
  return ps;
}

// The init segment's video track (the first), or null (not an init, no video).
export function videoTrackOf(init: Buffer): VideoTrack | null {
  const boxes = parseBoxes(init);
  const moov = boxes?.find((x) => x.type === 'moov');
  for (const trak of moov?.kids?.filter((k) => k.type === 'trak') ?? []) {
    const t = trackOf(trak);
    if (t) return t;
  }
  return null;
}

// The parameter sets in a media segment's fragments of `trackId` (null: the
// segment has no fragment of that track). go2rtc sends one fragment per
// sample: moof (one traf) + mdat. A segment that doesn't parse: null.
export function segmentSets(seg: Buffer, trackId: number, kind: VideoKind): ParamSets | null {
  const boxes = parseBoxes(seg);
  if (!boxes) return null;
  let found: ParamSets | null = null;
  for (let i = 0; i < boxes.length; i++) {
    if (boxes[i].type !== 'moof') continue;
    const trafs = boxes[i].kids?.filter((k) => k.type === 'traf') ?? [];
    const mdat = boxes[i + 1]?.type === 'mdat' ? boxes[i + 1].body! : null;
    const ids = trafs.map((t) => kid(t, 'tfhd')?.body?.readUInt32BE(4));
    if (!mdat || !ids.includes(trackId)) continue;
    // One track in the fragment: the mdat is its samples. Several: not split here.
    if (ids.length !== 1) return found ?? { vps: [], sps: [], pps: [] };
    const ps = setsOf(nalUnits(mdat, kind), kind);
    found = found ? { vps: [...found.vps, ...ps.vps], sps: [...found.sps, ...ps.sps], pps: [...found.pps, ...ps.pps] } : ps;
  }
  return found;
}

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const withLen = (list: Buffer[]) => Buffer.concat(list.flatMap((n) => [u16(n.length), n]));

function avcC(ps: ParamSets): Buffer {
  const s = avcSps(ps.sps[0]);
  const head = Buffer.from([1, ps.sps[0][1], ps.sps[0][2], ps.sps[0][3], 0xff, 0xe0 | ps.sps.length]);
  const ext = HIGH_PROFILES.has(s.profile)
    ? Buffer.from([0xfc | s.chromaFormat, 0xf8 | (s.bitDepthLuma - 8), 0xf8 | (s.bitDepthChroma - 8), 0])
    : Buffer.alloc(0);
  return Buffer.concat([head, withLen(ps.sps), Buffer.from([ps.pps.length]), withLen(ps.pps), ext]);
}

function hvcC(ps: ParamSets): Buffer {
  const s = hevcSps(ps.sps[0]);
  const head = Buffer.concat([
    Buffer.from([1]), s.ptl,
    Buffer.from([0xf0, 0x00, 0xfc, 0xfc | s.chromaFormat, 0xf8 | (s.bitDepthLuma - 8), 0xf8 | (s.bitDepthChroma - 8), 0, 0,
      ((s.subLayers & 7) << 3) | (s.nesting << 2) | 3, 3]),
  ]);
  const arrays = ([[32, ps.vps], [33, ps.sps], [34, ps.pps]] as const).map(([t, list]) => Buffer.concat([Buffer.from([0x80 | t]), u16(list.length), withLen(list)]));
  return Buffer.concat([head, ...arrays]);
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');

// The RFC 6381 codec of the parameter sets: avc1.PPCCLL, or hvc1/hev1 as
// ISO/IEC 14496-15 Annex E writes it.
export function codecOf(ps: ParamSets, kind: VideoKind, entry: string): string {
  if (kind === 'avc') return `${entry}.${hex2(ps.sps[0][1])}${hex2(ps.sps[0][2])}${hex2(ps.sps[0][3])}`;
  const ptl = hevcSps(ps.sps[0]).ptl;
  const space = ['', 'A', 'B', 'C'][ptl[0] >> 6];
  const tier = ptl[0] & 0x20 ? 'H' : 'L';
  const profile = ptl[0] & 0x1f;
  let compat = ptl.readUInt32BE(1), reversed = 0;
  for (let i = 0; i < 32; i++) {
    reversed = (reversed * 2) + (compat & 1);
    compat >>>= 1;
  }
  const cons = [...ptl.subarray(5, 11)];
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  return [`${entry}`, `${space}${profile}`, reversed.toString(16).toUpperCase(), `${tier}${ptl[11]}`, ...cons.map((c) => c.toString(16).toUpperCase())].join('.');
}

const sameSets = (a: Buffer[], b: Buffer[]) => a.length === b.length && a.every((x, i) => x.equals(b[i]));

export interface Fixed { init: Buffer; codec: string; width: number; height: number }

// The init rewritten for the parameter sets `ps` of its video track: the
// avcC/hvcC, the sample entry's width and height, tkhd's width and height.
// null: nothing to change (the same parameter sets), or it can't be done.
export function fixInit(init: Buffer, ps: ParamSets): Fixed | null {
  const boxes = parseBoxes(init);
  const moov = boxes?.find((x) => x.type === 'moov');
  const trak = moov?.kids?.find((k) => k.type === 'trak' && trackOf(k));
  const t = trak && trackOf(trak);
  if (!boxes || !trak || !t || !complete(ps, t.kind)) return null;
  if (sameSets(t.config.sps, ps.sps) && sameSets(t.config.pps, ps.pps) && sameSets(t.config.vps, ps.vps)) return null;
  let size: { width: number; height: number };
  let cfg: Buffer;
  try {
    size = t.kind === 'avc' ? avcSps(ps.sps[0]) : hevcSps(ps.sps[0]);
    cfg = t.kind === 'avc' ? avcC(ps) : hvcC(ps);
  } catch {
    return null;
  }
  if (!(size.width > 0 && size.width < 65536 && size.height > 0 && size.height < 65536)) return null;
  const entry = path(trak, 'mdia', 'minf', 'stbl', 'stsd')!.kids!.find((k) => VIDEO_ENTRIES.has(k.type))!;
  const head = Buffer.from(entry.head);
  head.writeUInt16BE(size.width, 24);
  head.writeUInt16BE(size.height, 26);
  entry.head = head;
  const c = kid(entry, t.kind === 'avc' ? 'avcC' : 'hvcC')!;
  c.body = cfg;
  const tkhd = kid(trak, 'tkhd')!;
  const tb = Buffer.from(tkhd.body!);
  const at = tb[0] === 1 ? 88 : 76;
  if (tb.length >= at + 8) {
    tb.writeUInt32BE(size.width * 65536, at);
    tb.writeUInt32BE(size.height * 65536, at + 4);
  }
  tkhd.body = tb;
  return { init: serialize(boxes), codec: codecOf(ps, t.kind, t.entry), width: size.width, height: size.height };
}

// The mse message's MIME type with the video codec replaced (its own
// prefix kept: go2rtc says hvc1 for an hev1 sample entry).
export function withCodec(mime: string, codec: string): string {
  const rest = codec.slice(codec.indexOf('.'));
  return mime.replace(/codecs="([^"]*)"/, (_m, list: string) => {
    const kind = codec.startsWith('avc') ? /^avc[13]\./ : /^(hvc1|hev1)\./;
    return `codecs="${list.split(',').map((c) => (kind.test(c) ? c.slice(0, 4) + rest : c)).join(',')}"`;
  });
}

// --- holding the start back ----------------------------------------------

export type Out = { text: string } | { bin: Buffer };
export type HoldResult = 'fixed' | 'same' | 'no_params' | 'no_video' | 'timeout' | 'overflow';

// The relay's start: the mse message and the init are held until the first
// video fragment says what the stream is, at most `maxBytes` of fragments
// (then, and on expire(), the original goes out). After that, everything
// passes straight through.
export class InitHold {
  private mime: string | null = null;
  private init: Buffer | null = null;
  private track: VideoTrack | null = null;
  private held: Buffer[] = [];
  private heldBytes = 0;
  done: HoldResult | null = null;
  fixed: Fixed | null = null;

  constructor(private readonly maxBytes = 8 * 1024 * 1024) {}

  // Waiting for the first video fragment (the caller's timer runs).
  get holding(): boolean {
    return this.done === null && this.init !== null;
  }

  text(mime: string): Out[] {
    if (this.done) return [{ text: mime }];
    this.mime = mime;
    return [];
  }

  binary(b: Buffer): Out[] {
    if (this.done) return [{ bin: b }];
    if (!this.init) {
      const t = videoTrackOf(b);
      this.init = b;
      if (!t) return this.finish('no_video');
      this.track = t;
      return [];
    }
    this.held.push(b);
    this.heldBytes += b.length;
    const ps = segmentSets(b, this.track!.trackId, this.track!.kind);
    if (ps) {
      if (!complete(ps, this.track!.kind)) return this.finish('no_params');
      this.fixed = fixInit(this.init, ps);
      return this.finish(this.fixed ? 'fixed' : 'same');
    }
    return this.heldBytes > this.maxBytes ? this.finish('overflow') : [];
  }

  expire(): Out[] {
    return this.done ? [] : this.finish('timeout');
  }

  private finish(why: HoldResult): Out[] {
    this.done = why;
    const f = this.fixed;
    const out: Out[] = [];
    if (this.mime !== null) out.push({ text: f ? withCodec(this.mime, f.codec) : this.mime });
    if (this.init) out.push({ bin: f ? f.init : this.init });
    for (const b of this.held) out.push({ bin: b });
    this.held = [];
    this.init = null;
    return out;
  }
}
