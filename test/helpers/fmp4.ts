// fMP4 boxes as go2rtc 1.9.14 writes them for MSE (layout recorded from a
// cam-sim E1 Outdoor Pro behind go2rtc, 2026-11-02): an init segment
// (ftyp, moov: mvhd, a video trak, an audio trak, mvex) and one fragment per
// sample (moof: mfhd, traf: tfhd, tfdt, trun; then mdat). Built here, so no
// media file is committed: the samples are parameter sets and filler bytes.

export function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(body.length + 8);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const zeros = (n: number) => Buffer.alloc(n);

// go2rtc's placeholders for an SDP without parameter sets (measured).
export const PLACEHOLDER_AVCC = Buffer.from('0142000affe100076742000af841a201000468ce3880', 'hex');
export const PLACEHOLDER_HVCC = Buffer.from('0101400000000000000000000000000000000000000303200001001840010c01ffff01400000030000030000030000030099ac09210001002142010101400000030000030000030000030099a001402005a1fe5aee46c1ae550422000100074401c073c04c90', 'hex');

// Parameter sets. E1_SUB_*: x264 High 640x360, coded 640x368 with
// frame_crop_bottom_offset 4 and no aspect_ratio_info, as the E1 Outdoor
// Pro's sub stream (measured). SIM_SUB_*: cam-sim's E1 sub (Constrained
// Baseline, also 640x368 cropped). RLC_SUB_SPS: x264 High 896x512.
// H265_4K_*: x265 Main 3840x2160.
export const E1_SUB_SPS = Buffer.from('67640029acd940a02ff961000003000100000300140f183196', 'hex');
export const E1_SUB_PPS = Buffer.from('68ebe3cb22c0', 'hex');
export const SIM_SUB_SPS = Buffer.from('6742c016da0280bfe584000003000400000300503c58ba80', 'hex');
export const SIM_SUB_PPS = Buffer.from('68ce0fc8', 'hex');
export const RLC_SUB_SPS = Buffer.from('67640029acd940e0106840000003004000000503c60c6580', 'hex');
export const H265_4K_VPS = Buffer.from('40010c01ffff016000000300900000030000030096959809', 'hex');
export const H265_4K_SPS = Buffer.from('420101016000000300900000030000030096a001e020021c596566924caf0168080000030008000003005040', 'hex');
export const H265_4K_PPS = Buffer.from('4401c172b46240', 'hex');

function tkhd(trackId: number, w: number, h: number): Buffer {
  return box('tkhd', Buffer.from([0, 0, 0, 3]), zeros(8), u32(trackId), zeros(4), zeros(4), zeros(8), zeros(4), zeros(4),
    Buffer.from('000100000000000000000000000000000000000000010000000000000000000000000000000040000000', 'hex'), u32(w * 65536), u32(h * 65536));
}

function sampleEntry(type: string, w: number, h: number, cfgType: string, cfg: Buffer): Buffer {
  const head = zeros(78);
  head.writeUInt16BE(1, 6);
  head.writeUInt16BE(w, 24);
  head.writeUInt16BE(h, 26);
  head.writeUInt32BE(0x00480000, 28);
  head.writeUInt32BE(0x00480000, 32);
  head.writeUInt16BE(1, 40);
  head.writeUInt16BE(24, 74);
  head.writeInt16BE(-1, 76);
  return box(type, head, box(cfgType, cfg), box('pasp', u32(1), u32(1)));
}

const stblRest = () => [box('stts', zeros(8)), box('stsc', zeros(8)), box('stsz', zeros(12)), box('stco', zeros(8))];

function trak(trackId: number, w: number, h: number, handler: string, entry: Buffer): Buffer {
  const media = handler === 'vide' ? box('vmhd', Buffer.from([0, 0, 0, 1]), zeros(8)) : box('smhd', zeros(8));
  return box('trak', tkhd(trackId, w, h), box('mdia',
    box('mdhd', zeros(4), zeros(8), u32(90000), zeros(4), zeros(4)),
    box('hdlr', zeros(8), Buffer.from(handler, 'latin1'), zeros(12), Buffer.from('go2rtc\0', 'latin1')),
    box('minf', media, box('dinf', box('dref', zeros(4), u32(1), box('url ', Buffer.from([0, 0, 0, 1])))),
      box('stbl', box('stsd', zeros(4), u32(1), entry), ...stblRest()))));
}

// An init segment: video (track 1: avc1 + avcC, or hev1 + hvcC) and AAC audio (track 2).
export function initSegment(o: { kind: 'avc' | 'hevc'; width: number; height: number; config: Buffer }): Buffer {
  const video = o.kind === 'avc' ? sampleEntry('avc1', o.width, o.height, 'avcC', o.config) : sampleEntry('hev1', o.width, o.height, 'hvcC', o.config);
  const mp4a = box('mp4a', zeros(6), Buffer.from([0, 1]), zeros(8), Buffer.from([0, 1, 0, 16]), zeros(4), u32(16000 * 65536), box('esds', zeros(30)));
  return Buffer.concat([
    box('ftyp', Buffer.from('iso5', 'latin1'), u32(512), Buffer.from('iso5iso6mp41', 'latin1')),
    box('moov', box('mvhd', zeros(96)), trak(1, o.width, o.height, 'vide', video), trak(2, 0, 0, 'soun', mp4a),
      box('mvex', box('trex', zeros(4), u32(1), u32(1), zeros(12)), box('trex', zeros(4), u32(2), u32(1), zeros(12)))),
  ]);
}

// AVCC: each NAL unit with a 4-byte length.
export const avcc = (...nals: Buffer[]) => Buffer.concat(nals.flatMap((n) => [u32(n.length), n]));
// Annex-B: each NAL unit after a 4-byte start code.
export const annexB = (...nals: Buffer[]) => Buffer.concat(nals.flatMap((n) => [u32(1), n]));

// One fragment of one sample of `trackId` (go2rtc's flags: tfhd 0x020038, trun 0x000001).
export function fragment(trackId: number, sample: Buffer): Buffer {
  const traf = (dataOffset: number) => box('traf',
    box('tfhd', Buffer.from([0, 2, 0, 0x38]), u32(trackId), u32(3600), u32(sample.length), u32(0x02000000)),
    box('tfdt', Buffer.from([1, 0, 0, 0]), zeros(8)),
    box('trun', Buffer.from([0, 0, 0, 1]), u32(1), u32(dataOffset)));
  const moofOf = (off: number) => box('moof', box('mfhd', zeros(4), u32(1)), traf(off));
  const size = moofOf(0).length;
  return Buffer.concat([moofOf(size + 8), box('mdat', sample)]);
}

// An IDR slice stand-in: the NAL header byte and filler.
export const AVC_IDR = Buffer.concat([Buffer.from([0x65, 0x88, 0x84]), Buffer.alloc(200, 0x5a)]);
export const HEVC_IDR = Buffer.concat([Buffer.from([0x26, 0x01, 0xaf]), Buffer.alloc(200, 0x5a)]);
