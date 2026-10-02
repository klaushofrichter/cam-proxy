// test/baichuan-cipher.test.ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { aesDecrypt, aesEncrypt, aesKey, bcXor, decodeText, decryptChunk, md5_31 } from '../src/camera/baichuan/cipher';

// Test credentials only (reolink_aio as the oracle, 2026-10-02).
const NONCE = 'TESTNONCE0123456789';
const PASSWORD = 'test-password';
const XML = Buffer.from('<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n');
const key = aesKey(NONCE, PASSWORD);

describe('Baichuan ciphers (reolink_aio vectors)', () => {
  it('md5_31: uppercase hex MD5, 31 characters', () => {
    expect(md5_31('admin')).toBe('21232F297A57A5A743894A0E4A801FC');
    expect(md5_31(`proxy${NONCE}`)).toBe('549605C6E2776B73D2871DD76070126');
    expect(md5_31(`${PASSWORD}${NONCE}`)).toBe('50605965E1AE2C85381D7F6F0A5D501');
  });

  it('the AES key: the first 16 characters of md5_31(nonce-password), as ASCII', () => {
    expect(key.toString('ascii')).toBe('15464B50166A7E4E');
    expect(key.length).toBe(16);
  });

  it('BC XOR with offset 250 (ch_id) and 0, symmetric', () => {
    expect(bcXor(XML, 250).toString('hex')).toBe('fa8ed8feee2593b2b4c2c9fcec38c7e6e88182b3e76b86b8a2d8cef4bf27b083809c98b1a23adbddfad3cff7fb3bef');
    expect(bcXor(Buffer.from('hello'), 0).toString('hex')).toBe('7748502735');
    expect(bcXor(bcXor(XML, 250), 250)).toEqual(XML);
  });

  it('AES-128-CFB from the fixed IV, restarted for every part', () => {
    const enc = aesEncrypt(key, XML);
    expect(enc.toString('hex')).toBe('c3151717ce134df0e06c82fc00abe8c16f62465f81fdeffab7d6c70c26e40a893220ff8b2060945f54239158321946');
    expect(aesDecrypt(key, enc)).toEqual(XML);
    expect(aesEncrypt(key, XML)).toEqual(enc); // a fresh IV: same input, same bytes
    // The extension and the body are separate parts, not one stream.
    const ext = Buffer.from('<?xml version="1.0" encoding="UTF-8" ?>\n<Extension version="1.1">\n</Extension>\n');
    expect(Buffer.concat([aesEncrypt(key, ext), aesEncrypt(key, XML)])).not.toEqual(aesEncrypt(key, Buffer.concat([ext, XML])));
    expect(aesEncrypt(key, Buffer.alloc(0))).toEqual(Buffer.alloc(0));
  });

  it('a chunk: only the first encryptLen bytes are AES, the rest is plain', () => {
    const plain = Buffer.from(Array.from({ length: 1100 }, (_, i) => (i * 7 + 3) % 256));
    const wire = Buffer.concat([aesEncrypt(key, plain.subarray(0, 1024)), plain.subarray(1024)]);
    expect(wire.subarray(0, 16).toString('hex')).toBe('fc207e62bd1516a1a95da2c339c8af9c');
    expect(wire.subarray(1020, 1030).toString('hex')).toBe('254ff709030a11181f26');
    expect(createHash('sha256').update(wire).digest('hex')).toBe('cc030d5270e2444eb35c65e87b5b10926ad8e6fa9ce9677736a4f5b812640fa8');
    expect(decryptChunk(key, wire, 1024)).toEqual(plain);
    expect(decryptChunk(key, plain, undefined)).toEqual(plain); // no encryptLen: plain
    expect(decryptChunk(key, aesEncrypt(key, plain.subarray(0, 500)), 1024)).toEqual(plain.subarray(0, 500)); // shorter than encryptLen
  });

  it('decodeText: AES, else XOR, else plain', () => {
    expect(decodeText(key, aesEncrypt(key, XML), 250)).toBe(XML.toString());
    expect(decodeText(key, bcXor(XML, 250), 250)).toBe(XML.toString());
    expect(decodeText(null, bcXor(XML, 250), 250)).toBe(XML.toString());
    expect(decodeText(key, Buffer.from('plain text'), 250)).toBe('plain text');
    expect(decodeText(key, Buffer.alloc(0), 250)).toBe('');
  });

  it('never modifies its input and returns new buffers', () => {
    const enc = aesEncrypt(key, XML);
    const copy = Buffer.from(enc);
    const dec = aesDecrypt(key, enc);
    expect(enc).toEqual(copy);
    expect(dec).not.toBe(enc);
    const x = bcXor(XML, 250);
    const xcopy = Buffer.from(x);
    bcXor(x, 250);
    expect(x).toEqual(xcopy);
    const plain = Buffer.alloc(1100, 5);
    const wire = Buffer.concat([aesEncrypt(key, plain.subarray(0, 1024)), plain.subarray(1024)]);
    const wcopy = Buffer.from(wire);
    const out = decryptChunk(key, wire, 1024);
    expect(wire).toEqual(wcopy);
    expect(out).not.toBe(wire);
    expect(decryptChunk(key, wire, undefined)).not.toBe(wire);
    const frame = Buffer.concat([Buffer.from('xx'), enc]).subarray(2); // a view, like a parser body
    const fcopy = Buffer.from(frame);
    decodeText(key, frame, 250);
    expect(frame).toEqual(fcopy);
  });
});
