// src/camera/baichuan/frame.ts
// Baichuan framing, ported from reolink_aio 5d37cb3 (base_protocol.py
// L321-L375, util.py L15) and its PR #186 9a1bb52 (MIT; see
// THIRD_PARTY_NOTICES). Header layout: magic, cmd, body length, channel byte +
// 24-bit counter (the message id replies echo), status or encryption offer,
// class, and on 24-byte headers the payload offset (the extension's length).
import { BaichuanError } from './errors';

export type FrameClass = '1464' | '1465' | '1466' | '0000';
export interface Header { cmd: number; length: number; msgId: number; code: number; cls: FrameClass; payloadOffset: number }
export interface Frame { header: Header; body: Buffer }

export const MAGIC = Buffer.from([0xf0, 0xde, 0xbc, 0x0a]);
export const HOST = 250; // ch_id for host requests (and the XOR offset)
export const MAX_BODY = 4 * 1024 * 1024;
const SIZES: Record<string, 20 | 24> = { '1465': 20, '1466': 20, '1464': 24, '0000': 24 };

export const msgIdOf = (channel: number, counter: number): number => ((channel & 0xff) | ((counter & 0xffffff) << 8)) >>> 0;

export function headerSize(cls: FrameClass): 20 | 24 {
  return SIZES[cls];
}

export function encodeFrame(h: { cmd: number; msgId: number; code: number; cls: FrameClass }, ext: Buffer, payload: Buffer): Buffer {
  const size = headerSize(h.cls);
  if (size === 20 && ext.length) throw new BaichuanError('protocol', 'a 20-byte header has no extension');
  const head = Buffer.alloc(size);
  MAGIC.copy(head, 0);
  head.writeUInt32LE(h.cmd, 4);
  head.writeUInt32LE(ext.length + payload.length, 8);
  head.writeUInt32LE(h.msgId >>> 0, 12);
  head.writeUInt16LE(h.code, 16);
  Buffer.from(h.cls, 'hex').copy(head, 18);
  if (size === 24) head.writeUInt32LE(ext.length, 20);
  return Buffer.concat([head, ext, payload]);
}

// A streaming parser: messages split across reads and several in one read.
// Bad magic closes the connection (the caller's job): no resync.
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Frame[] = [];
    for (;;) {
      if (this.buf.length < 20) break;
      if (!this.buf.subarray(0, 4).equals(MAGIC)) throw new BaichuanError('protocol', 'bad magic');
      const cls = this.buf.subarray(18, 20).toString('hex');
      const size = SIZES[cls];
      if (!size) throw new BaichuanError('protocol', `unknown message class ${cls}`);
      if (this.buf.length < size) break;
      const length = this.buf.readUInt32LE(8);
      if (length > MAX_BODY) throw new BaichuanError('protocol', `message too long (${length} bytes)`);
      if (this.buf.length < size + length) break;
      const payloadOffset = size === 24 ? this.buf.readUInt32LE(20) : 0;
      if (payloadOffset > length) throw new BaichuanError('protocol', 'payload offset past the end');
      out.push({
        header: { cmd: this.buf.readUInt32LE(4), length, msgId: this.buf.readUInt32LE(12), code: this.buf.readUInt16LE(16), cls: cls as FrameClass, payloadOffset },
        body: this.buf.subarray(size, size + length),
      });
      this.buf = this.buf.subarray(size + length);
    }
    return out;
  }
}
