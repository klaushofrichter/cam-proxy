// test/helpers/bc-camera.ts
// A scripted Baichuan camera for the client's unit tests (framing and
// ciphers from src/camera/baichuan; cam-sim is the independent check).
import net from 'net';
import { aesDecrypt, aesEncrypt, aesKey, bcXor, md5_31 } from '../../src/camera/baichuan/cipher';
import { encodeFrame, FrameParser, type Frame } from '../../src/camera/baichuan/frame';

export const NONCE = 'TESTNONCE0123456789';
export const CAM_USER = 'proxy';
export const CAM_PASSWORD = 'test-password';
const XML = '<?xml version="1.0" encoding="UTF-8" ?>\n';
const EXT_INFO = `${XML}<Extension version="1.1">\n<binaryData>1</binaryData>\n</Extension>\n`;
const EXT_CHUNK = `${XML}<Extension version="1.1">\n<binaryData>1</binaryData>\n<encryptLen>1024</encryptLen>\n</Extension>\n`;
// The 32-byte record before the file data (the trace's sub-stream record).
export const INFO_RECORD = Buffer.from('31303032200000008003000000020000000a7e0a0204073a7e0a020408130000', 'hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FakeOptions {
  files?: Record<string, Buffer>; // camera path → content
  chunkSize?: number; // 39 400, as traced
  delayMs?: number; // before each chunk
  firstChunkDelayMs?: number; // before the first file chunk
  stallAfterChunks?: number; // stop sending after this many chunks, keep the connection
  pushBetween?: boolean; // a push (message id 0) before replies and between chunks
  staleAfterStop?: number; // chunks still sent with the old message id after cmd 9
  resetAtFirstMessage?: boolean; // the 13th session: reset, no reply
  silentCmds?: number[]; // never answered
  noLoginReply?: boolean;
  badMagicOn?: number; // answer this cmd with bad magic
}

export interface FakeCamera {
  port: number;
  connections: number;
  open: () => number;
  loginAttempts: number;
  logins: number;
  downloads: number;
  requests: { cmd: number; xml: string }[];
  dropAll(): void;
  close(): Promise<void>;
}

export async function fakeCamera(o: FakeOptions = {}): Promise<FakeCamera> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    cam.connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const parser = new FrameParser();
    let key: Buffer | null = null;
    let transfer = 0; // message id of the running download
    const send = (cmd: number, msgId: number, status: number, ext: Buffer, payload: Buffer) =>
      socket.destroyed ? true : socket.write(encodeFrame({ cmd, msgId, code: status, cls: '0000' }, ext, payload));
    const push = () => send(78, 0, 200, Buffer.alloc(0), aesEncrypt(key!, Buffer.from(`${XML}<body>\n<VideoInput version="1.1"/>\n</body>\n`)));
    const sendChunk = (msgId: number, data: Buffer) =>
      send(8, msgId, 200, aesEncrypt(key!, Buffer.from(EXT_CHUNK)), Buffer.concat([aesEncrypt(key!, data.subarray(0, 1024)), data.subarray(1024)]));

    const handle = async (f: Frame) => {
      const { cmd, msgId, cls } = f.header;
      const ch = msgId & 0xff;
      if (o.badMagicOn === cmd) return void socket.write(Buffer.alloc(24, 0x55));
      if (cmd === 1 && cls === '1465') {
        const xml = `${XML}<body>\n<Encryption version="1.1">\n<type>md5</type>\n<nonce>${NONCE}</nonce>\n</Encryption>\n</body>\n`;
        return void socket.write(encodeFrame({ cmd: 1, msgId, code: 0xdd12, cls: '1466' }, Buffer.alloc(0), bcXor(Buffer.from(xml), ch)));
      }
      if (cmd === 1) {
        cam.loginAttempts++;
        if (o.noLoginReply) return;
        const xml = bcXor(f.body, ch).toString('utf8');
        const user = /<userName>([^<]*)</.exec(xml)?.[1];
        const pass = /<password>([^<]*)</.exec(xml)?.[1];
        if (user !== md5_31(CAM_USER + NONCE) || pass !== md5_31(CAM_PASSWORD + NONCE)) {
          return void send(1, msgId, 401, Buffer.alloc(0), bcXor(Buffer.from(`${XML}<body>\n<LoginErrInfo version="1.1">\n<remainTimes>10</remainTimes>\n</LoginErrInfo>\n</body>\n`), ch));
        }
        cam.logins++;
        key = aesKey(NONCE, CAM_PASSWORD);
        send(1, msgId, 200, Buffer.alloc(0), bcXor(Buffer.from(`${XML}<body>\n<DeviceInfo version="1.1">\n<type>ipc</type>\n</DeviceInfo>\n</body>\n`), ch));
        if (o.pushBetween) push();
        return;
      }
      if (!key) return void socket.destroy(); // a request before login: closed, no reply
      const xml = aesDecrypt(key, f.body.subarray(f.header.payloadOffset)).toString('utf8');
      cam.requests.push({ cmd, xml });
      if (o.silentCmds?.includes(cmd)) return;
      if (o.pushBetween) push();
      if (cmd === 9) {
        const old = transfer;
        transfer = 0;
        send(9, msgId, 200, Buffer.alloc(0), Buffer.alloc(0));
        for (let i = 0; old && i < (o.staleAfterStop ?? 0); i++) sendChunk(old, Buffer.alloc(1000, 7));
        return;
      }
      if (cmd !== 8) return void send(cmd, msgId, 405, Buffer.alloc(0), Buffer.alloc(0));
      const id = /<Id>([^<]*)<\/Id>/.exec(xml)?.[1] ?? '';
      const file = o.files?.[id];
      if (!file) return void send(8, msgId, 400, Buffer.alloc(0), Buffer.alloc(0));
      cam.downloads++;
      transfer = msgId;
      send(8, msgId, 200, aesEncrypt(key, Buffer.from(EXT_INFO)), INFO_RECORD);
      if (o.firstChunkDelayMs) await sleep(o.firstChunkDelayMs);
      const size = o.chunkSize ?? 39_400;
      for (let off = 0, n = 0; off < file.length; off += size, n++) {
        if (transfer !== msgId || socket.destroyed) return; // stopped or replaced
        if (o.stallAfterChunks !== undefined && n >= o.stallAfterChunks) return;
        if (o.delayMs) await sleep(o.delayMs);
        if (o.pushBetween && n === 1) push();
        if (!sendChunk(msgId, file.subarray(off, off + size))) await new Promise((r) => socket.once('drain', r));
      }
      // No terminator: the end is the size.
    };

    socket.on('data', (d: Buffer) => {
      if (o.resetAtFirstMessage) return void socket.resetAndDestroy();
      let frames: Frame[];
      try {
        frames = parser.push(d);
      } catch {
        return void socket.destroy(); // bad magic: closed, no reply
      }
      for (const f of frames) void handle(f);
    });
  });
  const cam: FakeCamera = {
    port: 0,
    connections: 0,
    open: () => sockets.size,
    loginAttempts: 0,
    logins: 0,
    downloads: 0,
    requests: [],
    dropAll: () => {
      for (const s of sockets) s.destroy();
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cam.port = (server.address() as net.AddressInfo).port;
  return cam;
}
