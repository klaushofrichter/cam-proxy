// src/camera/baichuan/cipher.ts
// Baichuan ciphers, ported from reolink_aio 5d37cb3 (util.py L17-L22,
// L46-L70, L112-L118; baichuan.py L417-L458, L460-L500, L527-L532) and its
// PR #186 9a1bb52 (MIT; see THIRD_PARTY_NOTICES). The login uses the XOR
// ("BC") encoding; everything after it AES-128-CFB from a fixed IV, restarted
// for every encrypted part. Never log a key, a nonce or what goes in here.
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

export const XML_KEY: readonly number[] = [0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff];
export const AES_IV = Buffer.from('0123456789abcdef', 'ascii');

export function bcXor(buf: Buffer, offset: number): Buffer {
  const off = offset & 0xff;
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ XML_KEY[(off + i) % 8] ^ off;
  return out;
}

export function md5_31(s: string): string {
  return createHash('md5').update(s, 'utf8').digest('hex').slice(0, 31).toUpperCase();
}

export function aesKey(nonce: string, password: string): Buffer {
  return Buffer.from(md5_31(`${nonce}-${password}`).slice(0, 16), 'ascii');
}

export function aesEncrypt(key: Buffer, data: Buffer): Buffer {
  if (!data.length) return Buffer.alloc(0);
  const c = createCipheriv('aes-128-cfb', key, AES_IV);
  return Buffer.concat([c.update(data), c.final()]);
}

export function aesDecrypt(key: Buffer, data: Buffer): Buffer {
  if (!data.length) return Buffer.alloc(0);
  const d = createDecipheriv('aes-128-cfb', key, AES_IV);
  return Buffer.concat([d.update(data), d.final()]);
}

// A download chunk: the first `encryptLen` bytes are AES (a fresh IV), the
// rest is plain; without encryptLen the whole payload is plain.
export function decryptChunk(key: Buffer, payload: Buffer, encryptLen?: number): Buffer {
  if (!encryptLen) return Buffer.from(payload); // a copy, never the parser's view
  const n = Math.min(encryptLen, payload.length);
  return Buffer.concat([aesDecrypt(key, payload.subarray(0, n)), payload.subarray(n)]);
}

const isXml = (s: string) => s.trimStart().startsWith('<?xml');

// A reply's text: AES; if that isn't XML, XOR; else plain (aio's order).
export function decodeText(key: Buffer | null, data: Buffer, offset: number): string {
  if (!data.length) return '';
  if (key) {
    const a = aesDecrypt(key, data).toString('utf8');
    if (isXml(a)) return a;
  }
  const x = bcXor(data, offset).toString('utf8');
  if (isXml(x)) return x;
  return data.toString('utf8');
}
