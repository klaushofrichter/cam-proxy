// test/baichuan-frame.test.ts
import { describe, it, expect } from 'vitest';
import { BaichuanError } from '../src/camera/baichuan/errors';
import { encodeFrame, FrameParser, headerSize, HOST, msgIdOf } from '../src/camera/baichuan/frame';

const hex = (s: string) => Buffer.from(s.replace(/\s/g, ''), 'hex');

describe('Baichuan headers (as traced on the RLC-1224A)', () => {
  it('encodes the nonce request: 20 bytes, class 14 65, offer 12 dc', () => {
    const b = encodeFrame({ cmd: 1, msgId: msgIdOf(HOST, 1), code: 0xdc12, cls: '1465' }, Buffer.alloc(0), Buffer.alloc(0));
    expect(b).toEqual(hex('f0 de bc 0a 01 00 00 00 00 00 00 00 fa 01 00 00 12 dc 14 65'));
  });

  it('encodes the login header: 24 bytes, class 14 64, payload offset 0', () => {
    const b = encodeFrame({ cmd: 1, msgId: msgIdOf(HOST, 2), code: 0, cls: '1464' }, Buffer.alloc(0), Buffer.alloc(296));
    expect(b.subarray(0, 24)).toEqual(hex('f0 de bc 0a 01 00 00 00 28 01 00 00 fa 02 00 00 00 00 14 64 00 00 00 00'));
    expect(b.length).toBe(24 + 296);
  });

  it('writes the extension length as the payload offset', () => {
    const b = encodeFrame({ cmd: 8, msgId: msgIdOf(HOST, 3), code: 200, cls: '0000' }, Buffer.alloc(136), Buffer.alloc(39_400));
    expect(b.subarray(0, 24)).toEqual(hex('f0 de bc 0a 08 00 00 00 70 9a 00 00 fa 03 00 00 c8 00 00 00 88 00 00 00'));
  });

  it('header sizes come from the class', () => {
    expect([headerSize('1465'), headerSize('1466'), headerSize('1464'), headerSize('0000')]).toEqual([20, 20, 24, 24]);
  });

  it('parses a traced chunk header', () => {
    const [f] = new FrameParser().push(Buffer.concat([hex('f0 de bc 0a 08 00 00 00 70 9a 00 00 fa 03 00 00 c8 00 00 00 88 00 00 00'), Buffer.alloc(39_536)]));
    expect(f.header).toEqual({ cmd: 8, length: 39_536, msgId: 0x3fa, code: 200, cls: '0000', payloadOffset: 136 });
    expect(f.body.length).toBe(39_536);
  });

  it('parses the traced nonce reply (20 bytes, 12 dd)', () => {
    const [f] = new FrameParser().push(Buffer.concat([hex('f0 de bc 0a 01 00 00 00 37 01 00 00 fa 01 00 00 12 dd 14 66'), Buffer.alloc(311)]));
    expect(f.header).toEqual({ cmd: 1, length: 311, msgId: msgIdOf(HOST, 1), code: 0xdd12, cls: '1466', payloadOffset: 0 });
  });

  it('a push has message id 0', () => {
    const [f] = new FrameParser().push(Buffer.concat([hex('f0 de bc 0a 4e 00 00 00 d3 00 00 00 00 00 00 00 c8 00 00 00 00 00 00 00'), Buffer.alloc(211)]));
    expect(f.header.msgId).toBe(0);
    expect(f.header.cmd).toBe(78);
  });
});

describe('FrameParser', () => {
  const a = encodeFrame({ cmd: 8, msgId: msgIdOf(HOST, 3), code: 200, cls: '0000' }, Buffer.from('ext'), Buffer.from('payload-a'));
  const b = encodeFrame({ cmd: 1, msgId: msgIdOf(HOST, 1), code: 0xdd12, cls: '1466' }, Buffer.alloc(0), Buffer.from('nonce-xml'));

  it('reassembles a message split at every byte', () => {
    for (let cut = 1; cut < a.length; cut++) {
      const p = new FrameParser();
      expect(p.push(a.subarray(0, cut))).toEqual([]);
      const [f] = p.push(a.subarray(cut));
      expect(f.body.toString()).toBe('extpayload-a');
      expect(f.header.payloadOffset).toBe(3);
    }
  });

  it('cuts several messages from one read, both header sizes', () => {
    const frames = new FrameParser().push(Buffer.concat([a, b, a]));
    expect(frames.map((f) => f.header.cls)).toEqual(['0000', '1466', '0000']);
    expect(frames[1].body.toString()).toBe('nonce-xml');
  });

  it('keeps a partial message for the next read', () => {
    const p = new FrameParser();
    expect(p.push(Buffer.concat([a, b.subarray(0, 25)]))).toHaveLength(1);
    expect(p.push(b.subarray(25))[0].body.toString()).toBe('nonce-xml');
  });

  it('bad magic is a protocol error (no resync)', () => {
    const bad = Buffer.from(a);
    bad[0] = 0xa0;
    expect(() => new FrameParser().push(bad)).toThrow(BaichuanError);
    try {
      new FrameParser().push(bad);
    } catch (e) {
      expect((e as BaichuanError).code).toBe('protocol');
    }
  });

  it('an unknown class or a huge length is a protocol error', () => {
    const cls = Buffer.from(a);
    cls[18] = 0x82;
    expect(() => new FrameParser().push(cls)).toThrow(/class/);
    const big = Buffer.from(a);
    big.writeUInt32LE(5 * 1024 * 1024, 8);
    expect(() => new FrameParser().push(big)).toThrow(/too long/);
  });
});
