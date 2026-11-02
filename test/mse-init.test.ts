// The live relay's init fix (src/stream/mse-init.ts): go2rtc's placeholder
// parameter sets for a camera whose SDP has none (E1 Outdoor Pro, RLC-1224A;
// measured 2026-11-02) are replaced by the stream's own, from the first
// keyframe. Boxes as go2rtc writes them (test/helpers/fmp4.ts).
import { describe, expect, it } from 'vitest';
import { avcSps, codecOf, fixInit, hevcSps, InitHold, nalUnits, segmentSets, videoTrackOf, withCodec, type Out } from '../src/stream/mse-init';
import {
  annexB, AVC_IDR, avcc, E1_SUB_PPS, E1_SUB_SPS, fragment, H265_4K_PPS, H265_4K_SPS, H265_4K_VPS, HEVC_IDR, initSegment,
  PLACEHOLDER_AVCC, PLACEHOLDER_HVCC, RLC_SUB_SPS, SIM_SUB_PPS, SIM_SUB_SPS,
} from './helpers/fmp4';

const placeholderInit = () => initSegment({ kind: 'avc', width: 128, height: 96, config: PLACEHOLDER_AVCC });
const e1Keyframe = () => fragment(1, avcc(E1_SUB_SPS, E1_SUB_PPS, AVC_IDR));
const MIME = 'video/mp4; codecs="avc1.640029,mp4a.40.2"';

// The sample entry's and tkhd's sizes, and the avcC's SPS, of an init.
function sizes(init: Buffer) {
  const at = init.indexOf('avc1') >= 0 ? init.indexOf('avc1') : init.indexOf('hev1');
  const tk = init.indexOf('tkhd');
  return { entry: [init.readUInt16BE(at + 4 + 24), init.readUInt16BE(at + 4 + 26)], tkhd: [init.readUInt32BE(tk + 4 + 76) / 65536, init.readUInt32BE(tk + 4 + 80) / 65536] };
}

describe('SPS parsing', () => {
  it('H.264: the E1 sub, coded 640x368 with frame_crop_bottom_offset 4, is 640x360 (High 4.1)', () => {
    expect(avcSps(E1_SUB_SPS)).toMatchObject({ width: 640, height: 360, profile: 100, level: 41, chromaFormat: 1, bitDepthLuma: 8 });
  });
  it('H.264: cam-sim\'s Constrained Baseline E1 sub is 640x360, the RLC-1224A\'s sub 896x512', () => {
    expect(avcSps(SIM_SUB_SPS)).toMatchObject({ width: 640, height: 360, profile: 66 });
    expect(avcSps(RLC_SUB_SPS)).toMatchObject({ width: 896, height: 512 });
  });
  it('H.264: go2rtc\'s placeholder is 128x96', () => {
    expect(avcSps(Buffer.from('6742000af841a2', 'hex'))).toMatchObject({ width: 128, height: 96 });
  });
  it('H.265: 3840x2160 Main', () => {
    expect(hevcSps(H265_4K_SPS)).toMatchObject({ width: 3840, height: 2160, chromaFormat: 1, bitDepthLuma: 8, subLayers: 1 });
  });
});

describe('the init and the fragments', () => {
  it('finds the video track and its placeholder', () => {
    const t = videoTrackOf(placeholderInit())!;
    expect(t).toMatchObject({ trackId: 1, kind: 'avc', entry: 'avc1', width: 128, height: 96 });
    expect(t.config.sps[0].toString('hex')).toBe('6742000af841a2');
    expect(videoTrackOf(e1Keyframe())).toBeNull();
  });

  it('reads the parameter sets of the video track\'s fragment, not the audio\'s', () => {
    expect(segmentSets(fragment(2, Buffer.alloc(300, 1)), 1, 'avc')).toBeNull();
    const ps = segmentSets(e1Keyframe(), 1, 'avc')!;
    expect([ps.sps[0], ps.pps[0]]).toEqual([E1_SUB_SPS, E1_SUB_PPS]);
  });

  it('reads Annex-B samples too', () => {
    expect(nalUnits(annexB(E1_SUB_SPS, E1_SUB_PPS, AVC_IDR), 'avc')).toEqual([E1_SUB_SPS, E1_SUB_PPS, AVC_IDR]);
  });

  it('opens an H.265 aggregation packet (as go2rtc passes MediaMTX\'s on)', () => {
    const ap = Buffer.concat([Buffer.from([0x60, 0x01]), ...[H265_4K_VPS, H265_4K_SPS, H265_4K_PPS].flatMap((n) => [Buffer.from([n.length >> 8, n.length & 255]), n])]);
    const ps = segmentSets(fragment(1, avcc(ap, HEVC_IDR)), 1, 'hevc')!;
    expect([ps.vps[0], ps.sps[0], ps.pps[0]]).toEqual([H265_4K_VPS, H265_4K_SPS, H265_4K_PPS]);
  });
});

describe('fixInit', () => {
  it('E1 sub: avcC with the real SPS/PPS, 640x360 in avc1 and tkhd, codec avc1.640029 -> avc1.640029 with the real profile', () => {
    const f = fixInit(placeholderInit(), { vps: [], sps: [E1_SUB_SPS], pps: [E1_SUB_PPS] })!;
    expect(f).toMatchObject({ width: 640, height: 360, codec: 'avc1.640029' });
    expect(sizes(f.init)).toEqual({ entry: [640, 360], tkhd: [640, 360] });
    const t = videoTrackOf(f.init)!;
    expect([t.config.sps[0], t.config.pps[0]]).toEqual([E1_SUB_SPS, E1_SUB_PPS]);
    // The audio track and the rest are kept.
    expect(f.init.indexOf('mp4a')).toBeGreaterThan(0);
    expect(f.init.indexOf('mvex')).toBeGreaterThan(0);
  });

  it('cam-sim\'s Baseline sub: codec avc1.42C016', () => {
    expect(fixInit(placeholderInit(), { vps: [], sps: [SIM_SUB_SPS], pps: [SIM_SUB_PPS] })).toMatchObject({ codec: 'avc1.42C016', width: 640, height: 360 });
  });

  it('nothing to change when the init already has the stream\'s parameter sets (the CX820)', () => {
    const own = Buffer.concat([Buffer.from([1, 0x64, 0, 0x29, 0xff, 0xe1, 0, E1_SUB_SPS.length]), E1_SUB_SPS, Buffer.from([1, 0, E1_SUB_PPS.length]), E1_SUB_PPS]);
    expect(fixInit(initSegment({ kind: 'avc', width: 640, height: 360, config: own }), { vps: [], sps: [E1_SUB_SPS], pps: [E1_SUB_PPS] })).toBeNull();
  });

  it('H.265: go2rtc\'s 2560x1440 placeholder hvcC becomes the stream\'s 3840x2160', () => {
    const init = initSegment({ kind: 'hevc', width: 2560, height: 1440, config: PLACEHOLDER_HVCC });
    expect(videoTrackOf(init)!.config.sps).toHaveLength(1);
    const f = fixInit(init, { vps: [H265_4K_VPS], sps: [H265_4K_SPS], pps: [H265_4K_PPS] })!;
    expect(f).toMatchObject({ width: 3840, height: 2160, codec: 'hev1.1.6.L150.90' });
    expect(sizes(f.init)).toEqual({ entry: [3840, 2160], tkhd: [3840, 2160] });
    const t = videoTrackOf(f.init)!;
    expect([t.config.vps[0], t.config.sps[0], t.config.pps[0]]).toEqual([H265_4K_VPS, H265_4K_SPS, H265_4K_PPS]);
  });

  // go2rtc's mse message says hvc1.1.6.L153.B0 whatever its placeholder
  // holds; the placeholder's own parameter sets say this (Annex E).
  it('the codec of go2rtc\'s H.265 placeholder parameter sets is hvc1.1.2.L153', () => {
    const ps = videoTrackOf(initSegment({ kind: 'hevc', width: 2560, height: 1440, config: PLACEHOLDER_HVCC }))!.config;
    expect(codecOf(ps, 'hevc', 'hvc1')).toBe('hvc1.1.2.L153');
  });

  it('withCodec swaps the video codec only, keeping go2rtc\'s prefix', () => {
    expect(withCodec(MIME, 'avc1.42C016')).toBe('video/mp4; codecs="avc1.42C016,mp4a.40.2"');
    expect(withCodec('video/mp4; codecs="hvc1.1.6.L153.B0,mp4a.40.2"', 'hev1.1.6.L150.90')).toBe('video/mp4; codecs="hvc1.1.6.L150.90,mp4a.40.2"');
  });
});

describe('InitHold', () => {
  const texts = (o: Out[]) => o.flatMap((x) => ('text' in x ? [x.text] : []));
  const bins = (o: Out[]) => o.flatMap((x) => ('bin' in x ? [x.bin] : []));

  it('holds the mse message and the init until the first video fragment, then sends them fixed, in order', () => {
    const h = new InitHold();
    expect(h.text(MIME)).toEqual([]);
    expect(h.binary(placeholderInit())).toEqual([]);
    expect(h.holding).toBe(true);
    const audio = fragment(2, Buffer.alloc(100, 1));
    expect(h.binary(audio)).toEqual([]);
    const key = e1Keyframe();
    const out = h.binary(key);
    expect(h.done).toBe('fixed');
    expect(texts(out)).toEqual(['video/mp4; codecs="avc1.640029,mp4a.40.2"']);
    expect('text' in out[0]).toBe(true);
    expect(bins(out)).toHaveLength(3);
    expect(sizes(bins(out)[0]).entry).toEqual([640, 360]);
    expect(bins(out).slice(1)).toEqual([audio, key]);
    // Afterwards: straight through.
    const next = fragment(1, avcc(AVC_IDR));
    expect(h.binary(next)).toEqual([{ bin: next }]);
  });

  it('sends the original when the stream\'s parameter sets are the init\'s', () => {
    const h = new InitHold();
    h.text(MIME);
    const own = Buffer.concat([Buffer.from([1, 0x64, 0, 0x29, 0xff, 0xe1, 0, E1_SUB_SPS.length]), E1_SUB_SPS, Buffer.from([1, 0, E1_SUB_PPS.length]), E1_SUB_PPS]);
    const init = initSegment({ kind: 'avc', width: 640, height: 360, config: own });
    h.binary(init);
    const out = h.binary(e1Keyframe());
    expect(h.done).toBe('same');
    expect(out).toEqual([{ text: MIME }, { bin: init }, { bin: e1Keyframe() }]);
  });

  it('sends the original when the first video fragment has no parameter sets, or on expiry', () => {
    const h = new InitHold();
    h.text(MIME);
    const init = placeholderInit();
    h.binary(init);
    expect(h.binary(fragment(1, avcc(AVC_IDR)))).toEqual([{ text: MIME }, { bin: init }, { bin: fragment(1, avcc(AVC_IDR)) }]);
    expect(h.done).toBe('no_params');
    const g = new InitHold();
    g.text(MIME);
    g.binary(init);
    expect(g.expire()).toEqual([{ text: MIME }, { bin: init }]);
    expect(g.done).toBe('timeout');
    expect(g.expire()).toEqual([]);
  });

  it('passes a stream without a video track straight through, and gives up past its byte limit', () => {
    const h = new InitHold();
    h.text(MIME);
    const notInit = fragment(2, Buffer.alloc(10));
    expect(h.binary(notInit)).toEqual([{ text: MIME }, { bin: notInit }]);
    expect(h.done).toBe('no_video');
    const g = new InitHold(500);
    g.text(MIME);
    g.binary(placeholderInit());
    expect(g.binary(fragment(2, Buffer.alloc(300)))).toEqual([]);
    expect(bins(g.binary(fragment(2, Buffer.alloc(300))))).toHaveLength(3);
    expect(g.done).toBe('overflow');
  });
});
