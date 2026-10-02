# Recordings over Baichuan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cam-proxy lists the camera's SD-card recordings (HTTP `Search`) and serves any of them as MP4 with `Range`, fetched over Reolink's Baichuan protocol (TCP 9000) into a disk cache and streamed to the first client while it arrives.

**Architecture:**
- **`src/camera/baichuan/`**: a small Baichuan client, ported from reolink_aio and its PR #186 (MIT). `frame.ts` (header codec, streaming parser), `cipher.ts` (BC XOR, AES-128-CFB, partial chunk decryption), `session.ts` (one TCP connection per camera: nonce, login, replies matched by cmd and message id, idle close at 20 s), `vod.ts` (cmd 8 download with backpressure, then cmd 9).
- **`src/recordings/`**: `names.ts` (SD names: times, kinds, ids), `list.ts` (HTTP `Search` per camera-local day, one at a time, 30 s cache; the month's days), `cache.ts` (files, LRU by mtime, the cap, pins), `fetcher.ts` (one download at a time, two priorities, the tee to the first client), `side.ts` (assembly, status, the info log line).
- **Wiring:** three routes in `src/api/client-api.ts`; the `recordings` storage kind (deleted first for the budget); two settings; `recordings` in `/control/status`, a metric, and a Status page card.

**Tech Stack:** Node 26, TypeScript (strict, CommonJS), Express 5, `node:net`, `node:crypto`, `node:sqlite` (the catalog), pino, prom-client, Svelte 5, Vitest, cam-sim (in process, the release with its Baichuan server). No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-10-02-baichuan-recordings-design.md` (the shared protocol design). The server the integration tests talk to: cam-sim's `docs/superpowers/specs/2026-10-02-baichuan-server-design.md`. Measured traces: cam-sim `reference/rlc-1224a/baichuan/` (on cam-sim `main`).

## Global Constraints

- **Dependencies:** the client uses only `node:net` and `node:crypto`. No new runtime dependency (not nodelink-js, not Python).
- **License:** every file in `src/camera/baichuan/` says it is ported from reolink_aio `5d37cb3` and PR #186 `9a1bb52` (MIT). A new `THIRD_PARTY_NOTICES` at the repo root carries reolink_aio's MIT notice. Nothing is ported from Neolink (AGPL-3.0).
- **Wire format:** little-endian; magic `f0 de bc 0a`; client classes `14 65` (nonce request, 20-byte header, bytes 16-17 `12 dc`) and `14 64` (24 bytes); camera classes `14 66` (nonce reply, 20 bytes) and `00 00` (24 bytes). VOD requests go to ch_id 250 with no extension.
- **Statuses:** 200, 201 and 300 are OK; 400 on cmd 8 is a refusal or a missing file; 401 at login is bad credentials. The client **never retries a 400**.
- **Ciphers:** XOR `out[i] = in[i] ^ XML_KEY[(off + i) % 8] ^ off`, `XML_KEY = 1F 2D 3C 4B 5A 69 78 FF`, `off = ch_id`. After login AES-128-CFB (Node `aes-128-cfb`), key = the first 16 characters of `md5_31(nonce + "-" + password)` as ASCII, IV `0123456789abcdef` restarted per encrypted part. Chunks: only the first `encryptLen` bytes are AES.
- **Commands used:** 1 (nonce, login), 8 (download, `<Id>` + `<channelId>`), 9 (stop, `handle` 0). Never 2 (logout), 13, 14/15/16, 93.
- **Timeouts:** connect 5 s, login 10 s, first chunk 15 s after cmd 8, a stall of 20 s between chunks. Idle close **20 s** after the last request, no keep-alive. At most one login attempt per 15 s after a rejected login (fails fast with `auth`).
- **Errors:** `BaichuanError` codes `offline`, `auth`, `refused`, `not_found`, `timeout`, `protocol`.
- **Never logged, at any level:** the password, the nonce, the derived key, login bodies. Other bodies only at debug. Info level: one line per download with camera, id, stream, bytes, ms, result.
- **API:** `GET /api/cameras/:cam/recordings?from=&to=&stream=` (unix ms, `to` ≥ `from`, at most 48 hours apart; `stream` `sub` or `main`, required). `GET /api/cameras/:cam/recordings/days?month=YYYY-MM` (registered **before** `/:id`). `GET` (and `HEAD`) `/api/cameras/:cam/recordings/:id`. Client-token access; unknown `:cam` answers `404 {"error":"not_found"}`.
- **Id pattern:** `^Rec[MS][0-9A-Za-z]{2}_(DST)?\d{8}_\d{6}_\d{6}_[0-9A-Za-z_]+\.mp4$`, at most 128 characters, else 400. The camera path for `<Id>` always comes from the camera's Search, never from the request.
- **List:** one HTTP `Search` per camera-local day the range touches (at most three), one Search at a time, `-54` retried once after 1 s, each (day, stream) kept 30 s, concurrent requests share one Search. The month's days: `Search` `onlyStatus: 1`, main stream, kept 5 minutes. A recording still being written (end `000000`, start before `235500`) is left out. `clipId`: the FTP clip with the same stream and a start within 5 s, else `null`.
- **Errors table:** 400 `{"error":"invalid","detail":"…"}`; 404 `{"error":"unknown_recording"}`; 503 `{"error":"camera_offline"}`; 502 `{"error":"recordings_unavailable","reason":"…","detail":"…"}` with `reason` `refused`, `auth`, `timeout`, `protocol` or `search_failed`. `detail` never contains a path, a password or a key.
- **Files:** `Cache-Control: private, max-age=604800, immutable`; `Accept-Ranges: bytes`; an unsatisfiable `Range` answers 416 with `Content-Range: bytes */size`.
- **One download at a time per camera**, two priorities: client API requests are `high`; `low` is reserved for #74 and unused. A `high` request goes ahead of every queued `low` one; a request whose client disconnects while queued leaves the queue; a second request for an id being fetched waits for that fetch.
- **Cache:** `<dataDir>/recordings/<cam>/<id>`, written as `<id>.part`, renamed when complete; leftover `.part` deleted at start. Storage kind `recordings`, deleted **first** for the budget, least-recently-used first, no `keepHours`. Cap `recordings.cacheMB`. Last use = the file's mtime, touched on every read. A file being written or read is never deleted.
- **Settings:** `recordings.cacheMB` (default 2048, 64 to 1,048,576) and `camera.baichuanPort` (default 9000, 1 to 65535). The Baichuan host is the host part of `camera.host`. Both apply without a restart (a port at the next connection, a cap at the next fetch or storage run).
- **Status:** `GET /control/status` gains `recordings: { last: { at, result, stream, bytes, ms } | null, cache: { bytes, files, capBytes } }`; `result` is `ok`, `offline`, `refused`, `auth`, `timeout`, `protocol` or `not_found`. Metric `camproxy_recording_downloads_total{cam,stream,result}`; the disk gauges gain `kind="recordings"`. No audit record per download.
- **Repo rules (CLAUDE.md):** user-visible changes under `## Unreleased` in CHANGELOG.md; no version in the sources; no clips or media to GitHub (tests make their bytes); `npm run schema` after a setting change; stage files explicitly.

## Review Focus

1. **The DST fall-back night:** two recordings named 01:30, one with the `DST` flag and one without, must come out an hour apart and sorted by real time, and a window over that 25-hour night must still Search the right camera-local days. (Task 6: "the fall-back night".)
2. **A client that drops mid-stream while a second request waits for the same id:** the fetch carries on into the cache, and the waiting request gets the whole file, not a short one. (Task 10: "a waiter gets the whole file after the first client left".)
3. **Eviction while someone reads:** a file a Range reader holds must survive both the cache's `makeRoom` and the storage budget; the next least-recently-used file goes instead. (Task 7: "never evicts a pinned file"; Task 8: "skips a file in use".)
4. **The camera's time can't be read (GetTime fails) while Search works:** the list answers 502 `search_failed` (or 503 when the camera is offline), never a 500. (Task 9: "a failed GetTime is search_failed, not a crash".)
5. **Hostile or odd ids:** `..%2F` paths, a lowercase `.MP4`, 129 characters, a name whose date doesn't exist (`20261340`): 400 or 404, never a camera request built from the request. (Task 12: "odd ids never reach the camera".)

## Assumed cam-sim API

The integration tests need cam-sim's Baichuan server, released before this work. Its spec fixes the behaviour; these names come from that spec and are checked in Task 1, Step 3. If the release names something differently, use the release's name in every place this table lists.

| What | Assumed | Used in |
|---|---|---|
| Port option of `listen()` and field of `Ports` | `baichuan` | `test/helpers/sim.ts` (Task 1) |
| Faults (`sim.engine.faults.set/clear`) | `baichuan.refuse`, `baichuan.dropMidway`, `baichuan.delayMs` (`ms`), `baichuan.loginFail` (`count`), `baichuan.sessionLimit` (`max`); existing `downloads.refuse`, `offline` (which also drops Baichuan connections) | `test/recordings-api.test.ts` (Task 12), `test/recordings-faults.test.ts` (Task 13) |
| Counters (`sim.engine.counters`) | `baichuanSessions`, `baichuanLogins`, `baichuanDownloads` | Tasks 11, 12, 13 |
| SD card | `sim.engine.sd.all()`: recordings with `date`, `end` (`null` while open) and `files.sub` / `files.main` (`{ name, size }`) | Tasks 11, 12, 13 |

## File Structure

| File | Responsibility |
|---|---|
| `src/camera/baichuan/errors.ts` (create) | `BaichuanError` and its codes |
| `src/camera/baichuan/frame.ts` (create) | header encode/decode (20- and 24-byte forms), `FrameParser` |
| `src/camera/baichuan/cipher.ts` (create) | `bcXor`, `md5_31`, `aesKey`, `aesEncrypt`/`aesDecrypt`, `decryptChunk`, `decodeText` |
| `src/camera/baichuan/session.ts` (create) | `BaichuanSession`: connect, nonce, login, dispatch by cmd and message id, idle close, the login guard |
| `src/camera/baichuan/vod.ts` (create) | `downloadXml`, `stopXml`, `download()` |
| `THIRD_PARTY_NOTICES` (create) | reolink_aio's MIT notice |
| `src/recordings/names.ts` (create) | SD names: parse, kinds, ids, UTC times, camera-local days |
| `src/recordings/cache.ts` (create) | `RecordingCache` |
| `src/recordings/list.ts` (create) | `RecordingList`, `SearchError` |
| `src/recordings/fetcher.ts` (create) | `RecordingFetcher`, `Fetch`, the tee |
| `src/recordings/side.ts` (create) | `createRecordingsSide`, status, the info line |
| `src/catalog/clips.ts` (modify) | `clipNear()` |
| `src/storage.ts` (modify) | the `recordings` kind |
| `src/config/schema.ts`, `src/config/defaults.ts`, `src/config/load.ts`, `config.schema.json`, `config.example.json` (modify) | the two settings |
| `src/api/client-api.ts` (modify) | the three routes |
| `src/api/control-api.ts`, `src/api/metrics.ts`, `src/proxy.ts` (modify) | status, metric, gauges, wiring, `stop()` |
| `web/src/lib/recordings.ts` (create), `web/src/lib/state.ts`, `web/src/pages/Status.svelte` (modify) | the Status card |
| `openapi.yaml`, `README.md`, `docs/audit-log.md`, `CHANGELOG.md`, `deploy/cluster/REQUEST.md` (modify) | docs |
| `package.json`, `package-lock.json`, `test/helpers/sim.ts`, `test/helpers/proxy.ts` (modify) | the cam-sim release, the Baichuan port |
| Tests (create): `test/baichuan-frame.test.ts`, `test/baichuan-cipher.test.ts`, `test/baichuan-session.test.ts`, `test/baichuan-vod.test.ts`, `test/helpers/bc-camera.ts`, `test/recording-names.test.ts`, `test/recording-cache.test.ts`, `test/recording-list.test.ts`, `test/recording-fetcher.test.ts`, `test/recordings-side.test.ts`, `test/recordings-api.test.ts`, `test/recordings-faults.test.ts`, `test/sim-baichuan.test.ts`; (modify) `test/storage.test.ts`, `test/config.test.ts`, `test/status-ui.test.ts` | |

## Conventions for every task

- Run single files with `npx vitest run <file>`. The type check for tests is `npm run lint:types`; for the web UI `npm run check`.
- Commit messages: the subject given in the task, then a blank line and the trailer lines your session's attribution instructions require. Stage only the files the task lists (`git add <files>`), never `git add -A`.
- Test bytes are generated (`randomBytes`, patterns); no media file is added to the repo.

---

### Task 1: The cam-sim release with the Baichuan server

**Files:**
- Modify: `package.json`, `package-lock.json`, `test/helpers/sim.ts`
- Create: `test/sim-baichuan.test.ts`

**Interfaces:**
- Produces: `startSim()` listens on a Baichuan port too and returns `camera.baichuanPort: number` and `ports.baichuan: number`.

- [ ] **Step 1: Find the release**

Run: `gh release list -R klaushofrichter/cam-sim --limit 5` and `gh release view <tag> -R klaushofrichter/cam-sim`.
Pick **the cam-sim release that ships the Baichuan server** (its notes mention Baichuan / port 9000). Call its tag `V` below (form `vYYYY.MM.DD.N`). If no such release exists yet, stop here and report: the rest of the plan's integration tests depend on it (Tasks 2-10 can go ahead without it; Tasks 11-13 can't).

- [ ] **Step 2: Bump the dev dependency**

Today the pin is `"cam-sim": "https://github.com/klaushofrichter/cam-sim/releases/download/v2026.10.01.1/cam-sim-v2026.10.01.1.tgz"`. Run, with `V` from Step 1:

```bash
npm i -D https://github.com/klaushofrichter/cam-sim/releases/download/$V/cam-sim-$V.tgz
```

Expected: `package.json` shows the new URL; `package-lock.json` changes.

- [ ] **Step 3: Check the assumed names against the release**

```bash
grep -n "baichuan" node_modules/cam-sim/dist/src/index.d.ts node_modules/cam-sim/dist/src/engine/faults.d.ts node_modules/cam-sim/dist/src/engine/counters.d.ts
grep -n "all()" node_modules/cam-sim/dist/src/engine/sdcard.d.ts
```

Expected: `baichuan` in `Ports`; the five `baichuan.*` fault names; `baichuanSessions`, `baichuanLogins`, `baichuanDownloads` in the counters; `max?: number` in `FaultSpec`. Compare with the "Assumed cam-sim API" table at the top of this plan. Where a name differs, note it and use the release's name in every place the table lists (Tasks 1, 11, 12, 13).

- [ ] **Step 4: Write the failing test**

```ts
// test/sim-baichuan.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import net from 'net';
import { startSim } from './helpers/sim';

let sim: Awaited<ReturnType<typeof startSim>>;
afterAll(() => sim?.close());

describe('cam-sim for the proxy tests', () => {
  it('listens on a Baichuan port and reports it', async () => {
    sim = await startSim();
    expect(sim.camera.baichuanPort).toBeGreaterThan(0);
    expect(sim.ports.baichuan).toBe(sim.camera.baichuanPort);
    await new Promise<void>((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port: sim.camera.baichuanPort }, () => (s.destroy(), resolve()));
      s.once('error', reject);
    });
  });
});
```

- [ ] **Step 5: Run it to see it fail**

Run: `npx vitest run test/sim-baichuan.test.ts`
Expected: FAIL (`baichuanPort` is undefined).

- [ ] **Step 6: Listen on the port in `startSim`**

In `test/helpers/sim.ts`, `startSim()`:

```ts
  const ports = await sim.listen({ http: 0, https: 0, control: 0, rtsp: 0, onvif: 0, baichuan: 0 }, '127.0.0.1');
  return {
    sim,
    ports,
    password,
    camera: { host: `127.0.0.1:${ports.http}`, protocol: 'http' as const, user: 'proxy', onvifPort: ports.onvif, rtspPort: ports.rtsp, baichuanPort: ports.baichuan },
    close: () => sim.close(),
  };
```

- [ ] **Step 7: Run the test, then the whole suite**

Run: `npx vitest run test/sim-baichuan.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS (the new cam-sim changes nothing the proxy uses today; a failure here is a cam-sim regression to report, not to work around).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json test/helpers/sim.ts test/sim-baichuan.test.ts
git commit
```
Subject: `test: cam-sim with its Baichuan server`.

---

### Task 2: Baichuan frames

**Files:**
- Create: `src/camera/baichuan/errors.ts`, `src/camera/baichuan/frame.ts`, `THIRD_PARTY_NOTICES`, `test/baichuan-frame.test.ts`

**Interfaces:**
- Produces:
  - `type BaichuanErrorCode = 'offline' | 'auth' | 'refused' | 'not_found' | 'timeout' | 'protocol'`
  - `class BaichuanError extends Error { readonly code: BaichuanErrorCode; readonly status?: number; constructor(code, message: string, status?: number) }`
  - `type FrameClass = '1464' | '1465' | '1466' | '0000'`
  - `interface Header { cmd: number; length: number; msgId: number; code: number; cls: FrameClass; payloadOffset: number }` (`msgId` = bytes 12-15 as u32 LE: channel byte | counter << 8; `code` = bytes 16-17 as u16 LE: the status, or the encryption offer/choice; `payloadOffset` 0 for 20-byte headers)
  - `interface Frame { header: Header; body: Buffer }` (`body` = everything after the header: extension, then payload)
  - `const MAGIC: Buffer`, `const HOST = 250`, `const MAX_BODY = 4 * 1024 * 1024`
  - `function msgIdOf(channel: number, counter: number): number`
  - `function headerSize(cls: FrameClass): 20 | 24`
  - `function encodeFrame(h: { cmd: number; msgId: number; code: number; cls: FrameClass }, ext: Buffer, payload: Buffer): Buffer`
  - `class FrameParser { push(chunk: Buffer): Frame[] }` (throws `BaichuanError('protocol')` on bad magic, an unknown class or a body over `MAX_BODY`)

- [ ] **Step 1: Write the failing tests**

The expected bytes are the camera's own headers from cam-sim `reference/rlc-1224a/baichuan/vod-nosearch.txt` and `login-proxy.txt`.

```ts
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/baichuan-frame.test.ts`
Expected: FAIL (cannot find module `../src/camera/baichuan/errors`).

- [ ] **Step 3: Write `errors.ts`, `frame.ts` and the notice**

```ts
// src/camera/baichuan/errors.ts
// Ported from reolink_aio 5d37cb3 and its PR #186 9a1bb52 (MIT; see THIRD_PARTY_NOTICES).
export type BaichuanErrorCode = 'offline' | 'auth' | 'refused' | 'not_found' | 'timeout' | 'protocol';

// Messages are for people and logs: never a path, a password, a nonce or a key.
export class BaichuanError extends Error {
  constructor(
    readonly code: BaichuanErrorCode,
    message: string,
    readonly status?: number, // the camera's status, when it answered
  ) {
    super(message);
    this.name = 'BaichuanError';
  }
}
```

```ts
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
```

`THIRD_PARTY_NOTICES` (repo root; the MIT text of reolink_aio's `LICENSE` at commit `5d37cb3`):

```text
cam-proxy includes code ported from third-party projects.

reolink_aio (https://github.com/starkillerOG/reolink_aio), commit
5d37cb3df2a49bb8eeafa93fa02513df88ad527a, and its pull request #186
(https://github.com/starkillerOG/reolink_aio/pull/186, commit
9a1bb5238b43ecc9d8fbe05c7e5679a7ad8a06f2): the Baichuan framing, ciphers,
login and VOD download in src/camera/baichuan/.

MIT License

Copyright (c) 2023 starkillerOG

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/baichuan-frame.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/camera/baichuan/errors.ts src/camera/baichuan/frame.ts THIRD_PARTY_NOTICES test/baichuan-frame.test.ts
git commit
```
Subject: `feat(baichuan): header codec and streaming parser`.

---

### Task 3: Baichuan ciphers

**Files:**
- Create: `src/camera/baichuan/cipher.ts`, `test/baichuan-cipher.test.ts`

**Interfaces:**
- Produces:
  - `const XML_KEY: readonly number[]`, `const AES_IV: Buffer`
  - `function bcXor(buf: Buffer, offset: number): Buffer` (symmetric)
  - `function md5_31(s: string): string`
  - `function aesKey(nonce: string, password: string): Buffer` (16 ASCII bytes)
  - `function aesEncrypt(key: Buffer, data: Buffer): Buffer`, `function aesDecrypt(key: Buffer, data: Buffer): Buffer` (a fresh IV per call)
  - `function decryptChunk(key: Buffer, payload: Buffer, encryptLen?: number): Buffer`
  - `function decodeText(key: Buffer | null, data: Buffer, offset: number): string` (AES, then XOR, then plain: the first that starts with `<?xml`)

- [ ] **Step 1: Write the failing tests**

The vectors were made with reolink_aio's own functions as the oracle (`encrypt_baichuan`, `md5_str_modern`, `Cryptodome` AES-CFB with `segment_size=128`), with a test password and nonce, never the camera's. cam-sim's plan pins the same vectors.

```ts
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
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/baichuan-cipher.test.ts`
Expected: FAIL (cannot find module `../src/camera/baichuan/cipher`).

- [ ] **Step 3: Write `cipher.ts`**

```ts
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
  if (!encryptLen) return payload;
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/baichuan-cipher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/camera/baichuan/cipher.ts test/baichuan-cipher.test.ts
git commit
```
Subject: `feat(baichuan): XOR and AES ciphers, pinned to reolink_aio vectors`.

---
### Task 4: The Baichuan session

**Files:**
- Create: `src/camera/baichuan/session.ts`, `test/helpers/bc-camera.ts`, `test/baichuan-session.test.ts`

**Interfaces:**
- Consumes: Task 2 (`BaichuanError`, `encodeFrame`, `FrameParser`, `HOST`, `msgIdOf`, `FrameClass`), Task 3 (`aesEncrypt`, `aesKey`, `bcXor`, `decodeText`, `decryptChunk`, `md5_31`).
- Produces:
  - `interface BaichuanTarget { host: string; port: number; user: string; password: string }`
  - `interface SessionOptions { idleMs?: number; connectMs?: number; loginMs?: number; loginGuardMs?: number; now?: () => number; log?: Logger }` (defaults 20 000, 5 000, 10 000, 15 000)
  - `interface Message { cmd: number; msgId: number; status: number; ext: string; payload: Buffer }` (`ext` decoded text; `payload` the raw bytes after the extension)
  - `interface Subscription { msgId: number; close(): void }`
  - `const OK_STATUS: Set<number>` (200, 201, 300)
  - `function loginXml(userHash: string, passwordHash: string): string`
  - `class BaichuanSession`:
    - `constructor(target: () => BaichuanTarget, opts?: SessionOptions)` (the target is read at every connect)
    - `ensure(): Promise<void>` (connect and log in unless open; concurrent callers share one attempt)
    - `connected(): boolean`
    - `open(cmd: number, xml: string, h: { onMessage: (m: Message) => void; onError: (e: BaichuanError) => void }): Subscription` (throws `offline` without a session; every message with this cmd and message id goes to `onMessage` until `close()`)
    - `call(cmd: number, xml: string, timeoutMs?: number): Promise<Message>` (the first reply; a 400 rejects `refused`, another non-OK status `protocol`)
    - `pause(): void`, `resume(): void` (the socket, for backpressure)
    - `text(m: Message): string`, `chunk(m: Message, encryptLen?: number): Buffer`
    - `close(): void` (a plain close; pending requests fail `offline`)
  - Test helper `test/helpers/bc-camera.ts`: `fakeCamera(o?: FakeOptions): Promise<FakeCamera>`, `NONCE`, `CAM_USER` (`proxy`), `CAM_PASSWORD` (`test-password`).

- [ ] **Step 1: Write the fake camera (test helper)**

A scripted camera for the client's unit tests. It uses the client's own frame and cipher code; cam-sim, written separately, is the independent check (Tasks 11-12).

```ts
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
```

- [ ] **Step 2: Write the failing tests**

```ts
// test/baichuan-session.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'net';
import { BaichuanSession, loginXml, type SessionOptions } from '../src/camera/baichuan/session';
import { BaichuanError } from '../src/camera/baichuan/errors';
import { CAM_PASSWORD, CAM_USER, fakeCamera, type FakeCamera, type FakeOptions } from './helpers/bc-camera';

const XML = '<?xml version="1.0" encoding="UTF-8" ?>\n<body/>\n';
const open: { cam?: FakeCamera; s?: BaichuanSession }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const x of open.splice(0)) {
    x.s?.close();
    await x.cam?.close();
  }
});

async function setup(o: FakeOptions = {}, so: SessionOptions = {}, password = CAM_PASSWORD) {
  const cam = await fakeCamera(o);
  const s = new BaichuanSession(() => ({ host: '127.0.0.1', port: cam.port, user: CAM_USER, password }), so);
  open.push({ cam, s });
  return { cam, s };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(BaichuanError);
    return (e as BaichuanError).code;
  }
  throw new Error('expected a BaichuanError');
};

describe('BaichuanSession: login', () => {
  it('the login body is aio LOGIN_XML (296 bytes with 31-character hashes, as traced)', () => {
    expect(Buffer.byteLength(loginXml('X'.repeat(31), 'Y'.repeat(31)))).toBe(296);
  });

  it('logs in once and answers requests, matched by cmd and message id', async () => {
    const { cam, s } = await setup();
    await Promise.all([s.ensure(), s.ensure()]);
    expect(cam.logins).toBe(1);
    expect(s.connected()).toBe(true);
    const m = await s.call(9, XML);
    expect(m.status).toBe(200);
    expect(cam.requests).toEqual([{ cmd: 9, xml: XML }]);
  });

  it('a wrong password is auth; within 15 s the next attempt fails fast without reaching the camera', async () => {
    let t = 1_000_000;
    const { cam, s } = await setup({}, { now: () => t }, 'wrong');
    expect(await code(s.ensure())).toBe('auth');
    expect(await code(s.ensure())).toBe('auth');
    expect(cam.loginAttempts).toBe(1);
    t += 15_000;
    expect(await code(s.ensure())).toBe('auth');
    expect(cam.loginAttempts).toBe(2);
  });

  it('a closed port is offline', async () => {
    const port = await new Promise<number>((r) => {
      const srv = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => r(p));
      });
    });
    const s = new BaichuanSession(() => ({ host: '127.0.0.1', port, user: CAM_USER, password: CAM_PASSWORD }));
    expect(await code(s.ensure())).toBe('offline');
  });

  it('a reset at the first message (the session limit) is refused', async () => {
    const { s } = await setup({ resetAtFirstMessage: true });
    expect(await code(s.ensure())).toBe('refused');
  });

  it('a login with no answer times out', async () => {
    const { s } = await setup({ noLoginReply: true }, { loginMs: 100 });
    expect(await code(s.ensure())).toBe('timeout');
    expect(s.connected()).toBe(false);
  });
});

describe('BaichuanSession: messages', () => {
  it('skips pushes (message id 0) that arrive between a request and its reply', async () => {
    const { s } = await setup({ pushBetween: true });
    await s.ensure();
    const m = await s.call(9, XML);
    expect([m.cmd, m.status]).toEqual([9, 200]);
  });

  it('an unknown cmd answers 405: the call fails, the session stays usable', async () => {
    const { s } = await setup();
    await s.ensure();
    const e = await s.call(93, XML).catch((x: BaichuanError) => x);
    expect([e.code, e.status]).toEqual(['protocol', 405]);
    expect((await s.call(9, XML)).status).toBe(200);
  });

  it('a lost connection fails every pending request; the next request logs in again', async () => {
    const { cam, s } = await setup({ silentCmds: [50] });
    await s.ensure();
    const pending = s.call(50, XML);
    await vi.waitFor(() => expect(cam.requests.some((r) => r.cmd === 50)).toBe(true));
    cam.dropAll();
    expect(await code(pending)).toBe('offline');
    expect(s.connected()).toBe(false);
    await s.ensure();
    expect(cam.logins).toBe(2);
  });

  it('a reply with bad magic is a protocol error and closes the session', async () => {
    const { s } = await setup({ badMagicOn: 9 });
    await s.ensure();
    expect(await code(s.call(9, XML))).toBe('protocol');
    expect(s.connected()).toBe(false);
  });

  it('a request without a session is offline (no reconnect inside open)', async () => {
    const { s } = await setup();
    expect(() => s.open(9, XML, { onMessage: () => undefined, onError: () => undefined })).toThrow(/no session/);
  });
});

describe('BaichuanSession: idle', () => {
  it('closes the socket 20 s after the last request, sends no keep-alive, and reconnects on demand', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { cam, s } = await setup();
    await s.ensure();
    await s.call(9, XML);
    vi.advanceTimersByTime(19_999);
    expect(s.connected()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(s.connected()).toBe(false);
    await vi.waitFor(() => expect(cam.open()).toBe(0));
    expect(cam.requests.map((r) => r.cmd)).toEqual([9]); // no cmd 93, no cmd 2
    await s.ensure();
    expect(cam.logins).toBe(2);
  });

  it('never closes while a request is open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { s } = await setup({ silentCmds: [50] });
    await s.ensure();
    const sub = s.open(50, XML, { onMessage: () => undefined, onError: () => undefined });
    vi.advanceTimersByTime(60_000);
    expect(s.connected()).toBe(true);
    sub.close();
    vi.advanceTimersByTime(20_000);
    expect(s.connected()).toBe(false);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run test/baichuan-session.test.ts`
Expected: FAIL (cannot find module `../src/camera/baichuan/session`).

- [ ] **Step 4: Write `session.ts`**

```ts
// src/camera/baichuan/session.ts
// One Baichuan session per camera, ported from reolink_aio 5d37cb3
// (baichuan.py L665-L692 nonce, L1707-L1757 login; base_protocol.py
// L119-L147, L250-L264, L381-L412) and its PR #186 9a1bb52 (MIT; see
// THIRD_PARTY_NOTICES). The session lasts as long as the TCP connection: no
// token; nonce and key are per connection. Always a plain close, never cmd 2
// (it would send the password). Never logs the password, the nonce, the key
// or a login body.
import net from 'node:net';
import type { Logger } from 'pino';
import { logger as rootLogger } from '../../log';
import { aesEncrypt, aesKey, bcXor, decodeText, decryptChunk, md5_31 } from './cipher';
import { BaichuanError } from './errors';
import { encodeFrame, FrameParser, HOST, msgIdOf, type FrameClass } from './frame';

export interface BaichuanTarget { host: string; port: number; user: string; password: string }
export interface SessionOptions {
  idleMs?: number; // close after this long without a request (20 s; the camera drops at about 32 s)
  connectMs?: number; // 5 s
  loginMs?: number; // nonce and login, 10 s
  loginGuardMs?: number; // after a rejected login, no new attempt for this long (15 s)
  now?: () => number;
  log?: Logger;
}
export interface Message { cmd: number; msgId: number; status: number; ext: string; payload: Buffer }
export interface Subscription { msgId: number; close(): void }
interface Handlers { onMessage: (m: Message) => void; onError: (e: BaichuanError) => void }

export const OK_STATUS = new Set([200, 201, 300]);

// aio's LOGIN_XML (xmls.py L3-L15); both values are md5_31 hashes.
export const loginXml = (userHash: string, passwordHash: string): string =>
  `<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<LoginUser version="1.1">\n<userName>${userHash}</userName>\n<password>${passwordHash}</password>\n<userVer>1</userVer>\n</LoginUser>\n<LoginNet version="1.1">\n<type>LAN</type>\n<udpPort>0</udpPort>\n</LoginNet>\n</body>\n`;

export class BaichuanSession {
  private socket: net.Socket | null = null;
  private parser = new FrameParser();
  private key: Buffer | null = null;
  private counter = 0;
  private readonly subs = new Map<number, Handlers & { cmd: number }>();
  private connecting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | undefined;
  private lastRejected = Number.NEGATIVE_INFINITY;
  private readonly log: Logger;

  constructor(
    private readonly target: () => BaichuanTarget,
    private readonly opts: SessionOptions = {},
  ) {
    this.log = opts.log ?? rootLogger;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  connected(): boolean {
    return this.socket !== null && this.key !== null;
  }

  // Connects and logs in unless a session is open; callers share one attempt.
  ensure(): Promise<void> {
    if (this.connected()) return Promise.resolve();
    this.connecting ??= this.open().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async open(): Promise<void> {
    // aio's guard: a bug must not lock the account.
    if (this.now() - this.lastRejected < (this.opts.loginGuardMs ?? 15_000)) throw new BaichuanError('auth', 'login recently rejected; waiting before the next attempt');
    const t = this.target();
    const socket = await this.connect(t);
    this.socket = socket;
    this.parser = new FrameParser();
    this.key = null;
    this.counter = 0;
    let answered = false;
    socket.on('data', (d: Buffer) => {
      answered = true;
      this.onData(socket, d);
    });
    socket.on('error', () => undefined); // 'close' follows
    // A reset before any answer is the camera's session limit (12 connections).
    socket.on('close', () =>
      this.lost(socket, answered ? new BaichuanError('offline', 'connection to the camera lost') : new BaichuanError('refused', 'the camera closed the connection before answering (session limit?)')),
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.login(t),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new BaichuanError('timeout', 'login timed out')), this.opts.loginMs ?? 10_000);
        }),
      ]);
    } catch (e) {
      this.close();
      throw e;
    } finally {
      clearTimeout(timer);
    }
    this.armIdle();
  }

  private connect(t: BaichuanTarget): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: t.host, port: t.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new BaichuanError('offline', 'connect timed out'));
      }, this.opts.connectMs ?? 5_000);
      const onError = (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new BaichuanError('offline', `connect failed (${e.code ?? 'error'})`));
      };
      s.once('error', onError);
      s.once('connect', () => {
        clearTimeout(timer);
        s.off('error', onError);
        s.setNoDelay(true);
        resolve(s);
      });
    });
  }

  private async login(t: BaichuanTarget): Promise<void> {
    const nonceReply = await this.exchange(1, '1465', 0xdc12, Buffer.alloc(0));
    const nonce = /<nonce>([^<]+)<\/nonce>/.exec(bcXor(nonceReply.payload, HOST).toString('utf8'))?.[1];
    if (!nonce) throw new BaichuanError('protocol', 'no nonce in the reply');
    const body = bcXor(Buffer.from(loginXml(md5_31(t.user + nonce), md5_31(t.password + nonce)), 'utf8'), HOST);
    const reply = await this.exchange(1, '1464', 0, body);
    if (reply.status === 401) {
      this.lastRejected = this.now();
      throw new BaichuanError('auth', 'the camera rejected the login', 401);
    }
    if (!OK_STATUS.has(reply.status)) throw new BaichuanError('protocol', `login answered ${reply.status}`, reply.status);
    this.key = aesKey(nonce, t.password);
  }

  // A handshake message and its reply (before the AES key exists).
  private exchange(cmd: number, cls: FrameClass, code: number, body: Buffer): Promise<Message> {
    return new Promise((resolve, reject) => {
      const msgId = this.nextId();
      this.subs.set(msgId, {
        cmd,
        onMessage: (m) => {
          this.subs.delete(msgId);
          resolve(m);
        },
        onError: reject,
      });
      this.socket?.write(encodeFrame({ cmd, msgId, code, cls }, Buffer.alloc(0), body));
    });
  }

  private nextId(): number {
    this.counter = this.counter >= 0xffffff ? 1 : this.counter + 1;
    return msgIdOf(HOST, this.counter);
  }

  // Every message with this cmd and message id goes to onMessage until close().
  open(cmd: number, xml: string, h: Handlers): Subscription {
    if (!this.socket || !this.key) throw new BaichuanError('offline', 'no session');
    const msgId = this.nextId();
    this.subs.set(msgId, { cmd, ...h });
    clearTimeout(this.idleTimer);
    this.socket.write(encodeFrame({ cmd, msgId, code: 0, cls: '1464' }, Buffer.alloc(0), aesEncrypt(this.key, Buffer.from(xml, 'utf8'))));
    return {
      msgId,
      close: () => {
        if (this.subs.delete(msgId) && this.subs.size === 0 && this.socket) this.armIdle();
      },
    };
  }

  // One request and its first reply. Never retried (a 400 is an answer).
  call(cmd: number, xml: string, timeoutMs = 10_000): Promise<Message> {
    return new Promise((resolve, reject) => {
      let sub: Subscription | undefined;
      const timer = setTimeout(() => {
        sub?.close();
        reject(new BaichuanError('timeout', `cmd ${cmd} timed out`));
      }, timeoutMs);
      try {
        sub = this.open(cmd, xml, {
          onMessage: (m) => {
            clearTimeout(timer);
            sub?.close();
            if (OK_STATUS.has(m.status)) resolve(m);
            else reject(new BaichuanError(m.status === 400 ? 'refused' : 'protocol', `cmd ${cmd} answered ${m.status}`, m.status));
          },
          onError: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
      } catch (e) {
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  pause(): void {
    this.socket?.pause();
  }

  resume(): void {
    this.socket?.resume();
  }

  text(m: Message): string {
    return decodeText(this.key, m.payload, m.msgId & 0xff);
  }

  chunk(m: Message, encryptLen?: number): Buffer {
    if (!this.key) throw new BaichuanError('offline', 'no session');
    return decryptChunk(this.key, m.payload, encryptLen);
  }

  // A plain close: the camera frees the session at once (measured).
  close(): void {
    const s = this.socket;
    if (!s) return;
    this.lost(s, new BaichuanError('offline', 'session closed'));
    s.destroy();
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.opts.idleMs ?? 20_000);
    this.idleTimer.unref?.();
  }

  private lost(socket: net.Socket, err: BaichuanError): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.key = null;
    clearTimeout(this.idleTimer);
    const subs = [...this.subs.values()];
    this.subs.clear();
    for (const s of subs) s.onError(err);
  }

  private onData(socket: net.Socket, d: Buffer): void {
    if (this.socket !== socket) return;
    let frames;
    try {
      frames = this.parser.push(d);
    } catch (e) {
      const err = e instanceof BaichuanError ? e : new BaichuanError('protocol', 'unreadable message');
      this.log.warn({ err: err.message }, 'baichuan_protocol_error');
      this.lost(socket, err);
      socket.destroy();
      return;
    }
    for (const f of frames) {
      if (this.socket !== socket) return; // a handler closed the session
      const { cmd, msgId, code, length, payloadOffset } = f.header;
      this.log.debug({ cmd, msgId, status: code, length }, 'baichuan_message'); // never a body
      const sub = this.subs.get(msgId);
      if (!sub || sub.cmd !== cmd) continue; // a push (message id 0), or a stale chunk of a stopped download
      const ext = payloadOffset ? decodeText(this.key, f.body.subarray(0, payloadOffset), msgId & 0xff) : '';
      sub.onMessage({ cmd, msgId, status: code, ext, payload: f.body.subarray(payloadOffset) });
    }
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/baichuan-session.test.ts`
Expected: PASS. If the idle test hangs on `ensure()` under fake timers, the platform's `net` uses the global `setTimeout`: move `vi.useFakeTimers(...)` to just after `await s.ensure()` and replace the `s.call(9, XML)` line with `s.open(9, XML, { onMessage: () => undefined, onError: () => undefined }).close()` (which arms the idle timer under fake timers); the assertions stay.

Run: `npm run lint:types`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/camera/baichuan/session.ts test/helpers/bc-camera.ts test/baichuan-session.test.ts
git commit
```
Subject: `feat(baichuan): session with login, reply matching and idle close`.

---

### Task 5: The download (cmd 8, then cmd 9)

**Files:**
- Create: `src/camera/baichuan/vod.ts`, `test/baichuan-vod.test.ts`

**Interfaces:**
- Consumes: Task 4 (`BaichuanSession`, `Message`, `OK_STATUS`), Task 2 (`BaichuanError`).
- Produces:
  - `const SAFE_PATH: RegExp` (`/^[A-Za-z0-9_./-]+\.mp4$/`)
  - `function downloadXml(path: string): string` (PR #186 `VodFileDownload` without `<name>`)
  - `function stopXml(): string` (PR #186 `VodFileStop`, `handle` 0)
  - `interface DownloadOptions { firstChunkMs?: number; stallMs?: number; stopMs?: number }` (defaults 15 000, 20 000, 5 000)
  - `function download(session: BaichuanSession, path: string, size: number, out: Writable, o?: DownloadOptions): Promise<number>` (resolves with the bytes written; an error event on `out` rejects with an `AbortError`)

- [ ] **Step 1: Write the failing tests**

```ts
// test/baichuan-vod.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'crypto';
import { PassThrough, Writable } from 'stream';
import { createLogger } from '../src/log';
import { aesKey, md5_31 } from '../src/camera/baichuan/cipher';
import { BaichuanError } from '../src/camera/baichuan/errors';
import { BaichuanSession, type SessionOptions } from '../src/camera/baichuan/session';
import { download, downloadXml, stopXml, type DownloadOptions } from '../src/camera/baichuan/vod';
import { CAM_PASSWORD, CAM_USER, fakeCamera, NONCE, type FakeCamera, type FakeOptions } from './helpers/bc-camera';

const PATH = '/mnt/sda/Mp4Record/2026-10-02/RecS0A_DST20261002_040758_040819_0_55148080000000_7224E.mp4';
const FILE = randomBytes(467_534); // the traced sub file's size
const open: { cam: FakeCamera; s: BaichuanSession }[] = [];
afterEach(async () => {
  for (const x of open.splice(0)) {
    x.s.close();
    await x.cam.close();
  }
});

async function setup(o: FakeOptions = {}, so: SessionOptions = {}) {
  const cam = await fakeCamera({ files: { [PATH]: FILE }, ...o });
  const s = new BaichuanSession(() => ({ host: '127.0.0.1', port: cam.port, user: CAM_USER, password: CAM_PASSWORD }), so);
  open.push({ cam, s });
  return { cam, s };
}
function sink(delayMs = 0) {
  const parts: Buffer[] = [];
  const w = new Writable({
    highWaterMark: 64 * 1024,
    write(chunk: Buffer, _e, cb) {
      parts.push(chunk);
      if (delayMs) setTimeout(cb, delayMs);
      else cb();
    },
  });
  return { w, bytes: () => Buffer.concat(parts) };
}
const run = (s: BaichuanSession, out: Writable, o?: DownloadOptions, size = FILE.length) => download(s, PATH, size, out, o);

describe('VOD message builders (as traced)', () => {
  it('cmd 8: Id and channelId, no name (247 bytes for the traced path)', () => {
    const x = downloadXml(PATH);
    expect(Buffer.byteLength(x)).toBe(247);
    expect(x).toContain(`<Id>${PATH}</Id>\n<channelId>0</channelId>\n</FileInfo>`);
    expect(x).not.toContain('<name>');
  });
  it('cmd 9: channelId and handle 0 (167 bytes)', () => {
    expect(Buffer.byteLength(stopXml())).toBe(167);
    expect(stopXml()).toContain('<channelId>0</channelId>\n<handle>0</handle>');
  });
});

describe('download', () => {
  it('skips the 32-byte info record, writes the file, ends at the size, then sends cmd 9', async () => {
    const { cam, s } = await setup();
    const out = sink();
    expect(await run(s, out.w)).toBe(FILE.length);
    expect(out.bytes()).toEqual(FILE);
    await vi.waitFor(() => expect(cam.requests.map((r) => r.cmd)).toEqual([8, 9]));
    expect(cam.requests[0].xml).toBe(downloadXml(PATH));
    expect(cam.requests[1].xml).toBe(stopXml());
  });

  it('ignores pushes between the request, the info record and the chunks', async () => {
    const { s } = await setup({ pushBetween: true });
    const out = sink();
    await run(s, out.w);
    expect(out.bytes()).toEqual(FILE);
  });

  it('a 400 on cmd 8 is refused, with the status; nothing is written', async () => {
    const { s } = await setup({ files: {} });
    const out = sink();
    const e = (await run(s, out.w).catch((x) => x)) as BaichuanError;
    expect([e.code, e.status]).toEqual(['refused', 400]);
    expect(out.bytes().length).toBe(0);
  });

  it('honours backpressure: a slow writer pauses the socket, and the file still comes out whole', async () => {
    const { s } = await setup({ chunkSize: 16_384 });
    await s.ensure();
    const pause = vi.spyOn(s, 'pause');
    const out = sink(2);
    await run(s, out.w);
    expect(pause).toHaveBeenCalled();
    expect(out.bytes()).toEqual(FILE);
  });

  it('no data within firstChunkMs after cmd 8 is a timeout, and cmd 9 is still sent', async () => {
    const { cam, s } = await setup({ firstChunkDelayMs: 300 });
    expect(((await run(s, sink().w, { firstChunkMs: 100 }).catch((x) => x)) as BaichuanError).code).toBe('timeout');
    await vi.waitFor(() => expect(cam.requests.map((r) => r.cmd)).toContain(9));
  });

  it('a stall between chunks is a timeout', async () => {
    const { s } = await setup({ stallAfterChunks: 2 });
    expect(((await run(s, sink().w, { stallMs: 100 }).catch((x) => x)) as BaichuanError).code).toBe('timeout');
  });

  it('more bytes than the size is a protocol error', async () => {
    const { s } = await setup();
    expect(((await run(s, sink().w, {}, 1000).catch((x) => x)) as BaichuanError).code).toBe('protocol');
  });

  it('a dropped connection mid-transfer fails the download', async () => {
    const { cam, s } = await setup({ delayMs: 20 });
    const p = run(s, sink().w);
    await vi.waitFor(() => expect(cam.downloads).toBe(1));
    cam.dropAll();
    expect(((await p.catch((x) => x)) as BaichuanError).code).toBe('offline');
  });

  it('after an abort, stale chunks with the old message id are dropped and the next download on the same connection is whole', async () => {
    const { cam, s } = await setup({ delayMs: 5, staleAfterStop: 13 });
    let n = 0;
    const failing = new Writable({
      write(_c, _e, cb) {
        cb(++n === 2 ? new Error('reader gone') : null);
      },
    });
    const e = await run(s, failing).catch((x: Error) => x);
    expect(e.name).toBe('AbortError');
    const out = sink();
    await run(s, out.w);
    expect(out.bytes()).toEqual(FILE);
    expect(cam.logins).toBe(1); // the same session
  });

  it('refuses a path that is not a plain recording path', async () => {
    const { s } = await setup();
    expect(((await download(s, '/mnt/sda/x;rm.mp4', 10, sink().w).catch((x) => x)) as BaichuanError).code).toBe('protocol');
  });
});

describe('no secrets in the logs', () => {
  it('a full session at trace level never logs the password, the nonce, the hashes or the key', async () => {
    const lines: string[] = [];
    const log = createLogger('trace', new PassThrough().on('data', (c: Buffer) => lines.push(String(c))));
    const { s } = await setup({ pushBetween: true }, { log });
    await run(s, sink().w);
    const bad = new BaichuanSession(() => ({ host: '127.0.0.1', port: open[0].cam.port, user: CAM_USER, password: 'wrong-password' }), { log });
    await bad.ensure().catch(() => undefined);
    const text = lines.join('');
    expect(text).toContain('baichuan_message'); // it did log at trace/debug
    for (const secret of [CAM_PASSWORD, 'wrong-password', NONCE, md5_31(CAM_USER + NONCE), md5_31(CAM_PASSWORD + NONCE), aesKey(NONCE, CAM_PASSWORD).toString('ascii')]) {
      expect(text).not.toContain(secret);
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/baichuan-vod.test.ts`
Expected: FAIL (cannot find module `../src/camera/baichuan/vod`).

- [ ] **Step 3: Write `vod.ts`**

```ts
// src/camera/baichuan/vod.ts
// The VOD download, ported from reolink_aio PR #186 9a1bb52 (xmls.py
// L281-L352, baichuan.py L4399-L4417; MIT, see THIRD_PARTY_NOTICES). As
// measured on the RLC-1224A: cmd 8 with <Id> only; the first reply carries a
// 32-byte info record (not file data); then chunks whose first encryptLen
// bytes are AES; no terminator: the end is the size; then cmd 9 (handle 0).
// Every frame of the download carries cmd 8's message id.
import type { Writable } from 'stream';
import { BaichuanError } from './errors';
import { OK_STATUS, type BaichuanSession, type Subscription } from './session';

export const SAFE_PATH = /^[A-Za-z0-9_./-]+\.mp4$/;

export const downloadXml = (path: string): string =>
  `\n<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<FileInfoList version="1.1">\n<FileInfo>\n<Id>${path}</Id>\n<channelId>0</channelId>\n</FileInfo>\n</FileInfoList>\n</body>`;

export const stopXml = (): string =>
  `\n<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<FileInfoList version="1.1">\n<FileInfo>\n<channelId>0</channelId>\n<handle>0</handle>\n</FileInfo>\n</FileInfoList>\n</body>`;

export interface DownloadOptions { firstChunkMs?: number; stallMs?: number; stopMs?: number }

const abortError = (why: string) => Object.assign(new Error(why), { name: 'AbortError' });

// Writes the file at `path` (size from its name) to `out`. Resolves with the
// bytes written. A broken download can't resume (cmd 8 has no offset).
export async function download(session: BaichuanSession, path: string, size: number, out: Writable, o: DownloadOptions = {}): Promise<number> {
  if (!SAFE_PATH.test(path)) throw new BaichuanError('protocol', 'unexpected recording path');
  await session.ensure();
  return new Promise<number>((resolve, reject) => {
    let received = 0;
    let first = true;
    let settled = false;
    let paused = false;
    let timer: NodeJS.Timeout | undefined;
    let sub: Subscription | undefined;
    const arm = (ms: number, why: string) => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new BaichuanError('timeout', why)), ms);
    };
    const stall = () => arm(o.stallMs ?? 20_000, 'the download stalled');
    const onDrain = () => {
      if (!paused || settled) return;
      paused = false;
      session.resume();
      stall();
    };
    const onOutError = () => finish(abortError('the output failed'));
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.off('drain', onDrain);
      out.off('error', onOutError);
      sub?.close();
      if (paused) session.resume();
      // Always release the camera's transfer; late chunks are dropped by message id.
      if (session.connected()) void session.call(9, stopXml(), o.stopMs ?? 5_000).catch(() => undefined);
      if (err) reject(err);
      else resolve(received);
    };
    out.on('error', onOutError);
    out.on('drain', onDrain);
    try {
      sub = session.open(8, downloadXml(path), {
        onError: (e) => finish(e),
        onMessage: (m) => {
          if (settled) return;
          if (!OK_STATUS.has(m.status)) return finish(new BaichuanError(m.status === 400 ? 'refused' : 'protocol', `the download answered ${m.status}`, m.status));
          if (first) {
            first = false; // the 32-byte info record
            if (size === 0) finish();
            return;
          }
          let data: Buffer;
          try {
            const len = /<encryptLen>(\d+)<\/encryptLen>/.exec(m.ext)?.[1];
            data = session.chunk(m, len ? Number(len) : undefined);
          } catch (e) {
            return finish(e as Error);
          }
          received += data.length;
          if (received > size) return finish(new BaichuanError('protocol', `more bytes than the size (${received} > ${size})`));
          if (out.destroyed) return finish(abortError('the output closed'));
          const ok = out.write(data);
          if (received === size) return finish();
          if (ok) return stall();
          paused = true;
          clearTimeout(timer);
          session.pause();
        },
      });
    } catch (e) {
      return finish(e as Error);
    }
    arm(o.firstChunkMs ?? 15_000, 'no data after the download request');
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/baichuan-vod.test.ts test/baichuan-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/camera/baichuan/vod.ts test/baichuan-vod.test.ts
git commit
```
Subject: `feat(baichuan): VOD download with backpressure, timeouts and stop`.

---

### Task 6: SD recording names

**Files:**
- Create: `src/recordings/names.ts`, `test/recording-names.test.ts`

**Interfaces:**
- Consumes: `TimeInfo`, `DstRule` (`src/camera/time.ts`); `dstBounds(year, rule, std, dst): [number, number]` (`src/clips/indexer.ts`, exported today).
- Produces:
  - `type Stream = 'main' | 'sub'`, `type Kind = 'person' | 'vehicle' | 'pet' | 'motion'`
  - `interface SdName { id: string; stream: Stream; dst: boolean; date: string /* camera-local YYYY-MM-DD */; start: string; end: string /* HHMMSS */; size: number; kinds: Kind[] }`
  - `const SD_ID: RegExp` (the spec's id pattern)
  - `function validId(id: string): boolean` (pattern and at most 128 characters)
  - `function parseSdName(nameOrPath: string): SdName | null` (a bare name or the camera's full path; `id` is the bare name)
  - `function decodeKinds(flagsHex: string): Kind[]` (14 hex digits, bit `55 − pos`: person 17, vehicle 19, pet 20, motion 24)
  - `function stillRecording(n: SdName): boolean`
  - `function recordingTimes(n: SdName, t: TimeInfo): { start: number; end: number }` (unix ms)
  - `function offsetAt(ts: number, t: TimeInfo): number` (minutes east of UTC at an instant)
  - `function localDate(ts: number, t: TimeInfo): string`
  - `function localDays(from: number, to: number, t: TimeInfo): string[]` (every camera-local date from `from`'s to `to`'s)

- [ ] **Step 1: Write the failing tests**

```ts
// test/recording-names.test.ts
import { describe, it, expect } from 'vitest';
import type { TimeInfo } from '../src/camera/time';
import { decodeKinds, localDate, localDays, parseSdName, recordingTimes, stillRecording, validId } from '../src/recordings/names';

// The camera's zone: America/Chicago (GetTime), DST second Sunday of March to first Sunday of November, 02:00.
const CHI: TimeInfo = { stdOffsetMinutes: -360, dstOffsetMinutes: 60, dstRule: { startMon: 3, startWeek: 2, startWeekday: 0, startHour: 2, startMin: 0, endMon: 11, endWeek: 1, endWeekday: 0, endHour: 2, endMin: 0 } };
const SUB = 'RecS0A_DST20261001_211129_211207_0_5514C080000000_108CE9.mp4';
const PATH = `/mnt/sda/Mp4Record/2026-10-01/${SUB}`;

describe('SD names', () => {
  it('parses the spec example: stream, DST, date, times, size from the last hex field, kinds', () => {
    expect(parseSdName(PATH)).toEqual({ id: SUB, stream: 'sub', dst: true, date: '2026-10-01', start: '211129', end: '211207', size: 1_084_649, kinds: ['person', 'motion'] });
    expect(parseSdName(SUB)?.id).toBe(SUB);
  });

  it('a main file, no animal-type field, no triggers', () => {
    expect(parseSdName('RecM0A_DST20261002_040758_040820_0_7B288200000000_667C2E.mp4')).toMatchObject({ stream: 'main', size: 6_716_462, kinds: [] });
    expect(parseSdName('RecS0A_20261002_040758_040819_55148080000000_7224E.mp4')).toMatchObject({ dst: false, size: 467_534, kinds: ['motion'] });
  });

  it('decodes the trigger flags (bit 55 − position)', () => {
    expect(decodeKinds('5514C080000000')).toEqual(['person', 'motion']);
    expect(decodeKinds('55148080000000')).toEqual(['motion']);
    expect(decodeKinds('nothex')).toEqual([]);
    expect(decodeKinds('5514C08000000')).toEqual([]); // 13 digits: an unknown name version
  });

  it('rejects names that are not SD recordings', () => {
    for (const n of ['RecS0A_DST20261340_211129_211207_0_5514C080000000_108CE9.mp4', 'RecS0A_DST20261001_256129_211207_0_5514C080000000_108CE9.mp4', 'RecS0A_DST20261001_211129_211207_0_5514C080000000_108CE9.MP4', 'Rec_x.mp4', 'snapshot.jpg']) {
      expect(parseSdName(n), n).toBeNull();
    }
  });

  it('validId: the spec pattern, at most 128 characters, no folder', () => {
    expect(validId(SUB)).toBe(true);
    expect(validId(PATH)).toBe(false);
    expect(validId('../' + SUB)).toBe(false);
    expect(validId(SUB.replace('.mp4', '.MP4'))).toBe(false);
    expect(validId(SUB.replace('_108CE9', `_${'A'.repeat(128 - SUB.length + 6)}`))).toBe(true); // exactly 128
    expect(validId(SUB.replace('_108CE9', `_${'A'.repeat(129 - SUB.length + 6)}`))).toBe(false); // 129
  });

  it('a recording still being written ends 000000, unless it starts in the last minutes before midnight', () => {
    expect(stillRecording(parseSdName('RecS0A_DST20261001_211129_000000_0_5514C080000000_0.mp4')!)).toBe(true);
    expect(stillRecording(parseSdName('RecS0A_DST20261001_235830_000000_0_5514C080000000_108CE9.mp4')!)).toBe(false);
    expect(stillRecording(parseSdName(SUB)!)).toBe(false);
  });
});

describe('times', () => {
  it('camera-local times with the name’s DST flag to unix ms', () => {
    expect(recordingTimes(parseSdName(SUB)!, CHI)).toEqual({ start: Date.UTC(2026, 9, 2, 2, 11, 29), end: Date.UTC(2026, 9, 2, 2, 12, 7) });
  });

  it('a recording past midnight ends the next day', () => {
    const n = parseSdName('RecS0A_DST20261001_235950_000020_0_5514C080000000_108CE9.mp4')!;
    expect(recordingTimes(n, CHI)).toEqual({ start: Date.UTC(2026, 9, 2, 4, 59, 50), end: Date.UTC(2026, 9, 2, 5, 0, 20) });
  });

  // Review Focus 1.
  it('the fall-back night: 01:30 with and without DST are an hour apart, and the window still finds the right days', () => {
    const a = recordingTimes(parseSdName('RecS0A_DST20261101_013000_013020_0_5514C080000000_3E8.mp4')!, CHI);
    const b = recordingTimes(parseSdName('RecS0A_20261101_013000_013020_0_5514C080000000_3E8.mp4')!, CHI);
    expect(a.start).toBe(Date.UTC(2026, 10, 1, 6, 30));
    expect(b.start - a.start).toBe(3_600_000);
    // 23:00 CDT Oct 31 to 23:30 CST Nov 1 (25.5 hours).
    expect(localDays(Date.UTC(2026, 10, 1, 4, 0), Date.UTC(2026, 10, 2, 5, 30), CHI)).toEqual(['2026-10-31', '2026-11-01']);
  });

  it('the camera-local date of an instant, summer and winter', () => {
    expect(localDate(Date.UTC(2026, 9, 2, 3, 0), CHI)).toBe('2026-10-01'); // 22:00 CDT
    expect(localDate(Date.UTC(2026, 9, 2, 5, 0), CHI)).toBe('2026-10-02'); // 00:00 CDT
    expect(localDate(Date.UTC(2026, 0, 15, 5, 30), CHI)).toBe('2026-01-14'); // 23:30 CST
    expect(localDate(Date.UTC(2026, 9, 1, 23, 30), { stdOffsetMinutes: 60, dstOffsetMinutes: 0 })).toBe('2026-10-02');
  });

  it('a 47-hour window touches three camera days', () => {
    expect(localDays(Date.UTC(2026, 9, 1, 4, 0), Date.UTC(2026, 9, 3, 3, 0), CHI)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
    expect(localDays(Date.UTC(2026, 9, 2, 12, 0), Date.UTC(2026, 9, 2, 13, 0), CHI)).toEqual(['2026-10-02']);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/recording-names.test.ts`
Expected: FAIL (cannot find module `../src/recordings/names`).

- [ ] **Step 3: Write `names.ts`**

```ts
// src/recordings/names.ts
// The camera's SD recording names (ported from cams
// server/recordings/clipNames.ts): RecS0A_DST20261001_211129_211207_0_5514C080000000_108CE9.mp4 =
// stream, name version, DST flag, camera-local date, start, end, an optional
// animal-type field, trigger flags (hex), size in bytes (hex).
import type { TimeInfo } from '../camera/time';
import { dstBounds } from '../clips/indexer';

export type Stream = 'main' | 'sub';
export type Kind = 'person' | 'vehicle' | 'pet' | 'motion';
export interface SdName { id: string; stream: Stream; dst: boolean; date: string; start: string; end: string; size: number; kinds: Kind[] }

export const SD_ID = /^Rec[MS][0-9A-Za-z]{2}_(DST)?\d{8}_\d{6}_\d{6}_[0-9A-Za-z_]+\.mp4$/;
const NAME = /^Rec([MS])[0-9A-Za-z]{2}_(DST)?(\d{8})_(\d{6})_(\d{6})_(?:\d+_)?([0-9A-Fa-f]+)_([0-9A-Fa-f]+)\.mp4$/;
const HMS = /^([01]\d|2[0-3])[0-5]\d[0-5]\d$/;
// Name versions 9 and 10 (14 hex digits): bit 55 − position (reolink_aio's layout, as in cams).
const POSITIONS: [Kind, number][] = [['person', 17], ['vehicle', 19], ['pet', 20], ['motion', 24]];
const DAY = 86_400_000;

export const validId = (id: string): boolean => id.length <= 128 && SD_ID.test(id);

export function decodeKinds(flagsHex: string): Kind[] {
  if (!/^[0-9A-Fa-f]{14}$/.test(flagsHex)) return [];
  const v = BigInt(`0x${flagsHex}`);
  return POSITIONS.filter(([, pos]) => ((v >> BigInt(55 - pos)) & 1n) === 1n).map(([k]) => k);
}

export function parseSdName(nameOrPath: string): SdName | null {
  const id = nameOrPath.slice(nameOrPath.lastIndexOf('/') + 1);
  if (!validId(id)) return null;
  const m = NAME.exec(id);
  if (!m) return null;
  const [, s, dst, ymd, start, end, flags, size] = m;
  const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date || !HMS.test(start) || !HMS.test(end)) return null;
  return { id, stream: s === 'M' ? 'main' : 'sub', dst: Boolean(dst), date, start, end, size: parseInt(size, 16), kinds: decodeKinds(flags) };
}

// A recording still being written is listed with end 000000; only one that
// starts in the last minutes before midnight really ends then (cams).
export const stillRecording = (n: SdName): boolean => n.end === '000000' && n.start < '235500';

const wall = (date: string, hms: string) =>
  Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), Number(hms.slice(0, 2)), Number(hms.slice(2, 4)), Number(hms.slice(4, 6)));

// The name's DST flag decides the offset, so the night the clocks change is right.
export function recordingTimes(n: SdName, t: TimeInfo): { start: number; end: number } {
  const off = (t.stdOffsetMinutes + (n.dst ? t.dstOffsetMinutes : 0)) * 60_000;
  const start = wall(n.date, n.start) - off;
  const end = wall(n.date, n.end) - off + (n.end < n.start ? DAY : 0);
  return { start, end };
}

export function offsetAt(ts: number, t: TimeInfo): number {
  if (!t.dstRule || !t.dstOffsetMinutes) return t.stdOffsetMinutes;
  const year = new Date(ts + t.stdOffsetMinutes * 60_000).getUTCFullYear();
  const [start, end] = dstBounds(year, t.dstRule, t.stdOffsetMinutes, t.dstOffsetMinutes);
  const inDst = start < end ? ts >= start && ts < end : ts >= start || ts < end;
  return t.stdOffsetMinutes + (inDst ? t.dstOffsetMinutes : 0);
}

export const localDate = (ts: number, t: TimeInfo): string => new Date(ts + offsetAt(ts, t) * 60_000).toISOString().slice(0, 10);

export function localDays(from: number, to: number, t: TimeInfo): string[] {
  const last = localDate(to, t);
  const out = [localDate(from, t)];
  while (out[out.length - 1] < last) {
    const d = new Date(`${out[out.length - 1]}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/recording-names.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recordings/names.ts test/recording-names.test.ts
git commit
```
Subject: `feat(recordings): SD names, kinds and camera-local times`.

---

### Task 7: The recordings cache

**Files:**
- Create: `src/recordings/cache.ts`, `test/recording-cache.test.ts`

**Interfaces:**
- Produces:
  - `interface CachedFile { id: string; path: string; bytes: number; used: number /* mtime ms */ }`
  - `class RecordingCache`:
    - `constructor(d: { dir: () => string; capBytes: () => number; now?: () => number })` (`dir` = `<dataDir>/recordings/<cam>`)
    - `path(id: string): string`, `partPath(id: string): string`, `capBytes(): number`
    - `init(): void` (creates the folder, deletes leftover `.part` files)
    - `has(id: string): boolean`
    - `open(id: string): (() => void) | null` (pins and touches a cached file for a reader; returns the unpin, null when not cached)
    - `pin(path: string): () => void` (idempotent unpin), `busy(path: string): boolean`
    - `touch(id: string): void`
    - `files(): CachedFile[]` (complete files, least recently used first)
    - `usage(): { bytes: number; files: number }`
    - `makeRoom(incoming: number): number` (deletes LRU files, never a pinned one, until `incoming` more bytes fit the cap; answers the bytes freed)
    - `commit(id: string): void` (`.part` → final name, touched), `discard(id: string): void` (deletes the `.part`)

- [ ] **Step 1: Write the failing tests**

```ts
// test/recording-cache.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RecordingCache } from '../src/recordings/cache';

const NOW = Date.UTC(2026, 9, 2, 12, 0);
function setup(cap = 3000) {
  const dir = join(mkdtempSync(join(tmpdir(), 'camproxy-rec-')), 'recordings', 'cam1');
  const clock = { t: NOW };
  const make = () => new RecordingCache({ dir: () => dir, capBytes: () => cap, now: () => clock.t });
  const cache = make();
  cache.init();
  const put = (id: string, bytes: number, usedAt: number) => {
    const p = join(dir, id);
    writeFileSync(p, Buffer.alloc(bytes, 1));
    utimesSync(p, new Date(usedAt), new Date(usedAt));
    return p;
  };
  return { dir, cache, make, put, clock };
}

describe('RecordingCache', () => {
  it('init deletes leftover .part files and keeps complete ones', () => {
    const { dir, make, put } = setup();
    put('a.mp4', 10, NOW);
    writeFileSync(join(dir, 'b.mp4.part'), 'x');
    make().init();
    expect(existsSync(join(dir, 'b.mp4.part'))).toBe(false);
    expect(existsSync(join(dir, 'a.mp4'))).toBe(true);
  });

  it('commit renames the .part and marks it used now; discard deletes the .part', () => {
    const { cache, clock } = setup();
    writeFileSync(cache.partPath('a.mp4'), 'data');
    expect(cache.has('a.mp4')).toBe(false);
    clock.t = NOW + 5000;
    cache.commit('a.mp4');
    expect(cache.has('a.mp4')).toBe(true);
    expect(Math.round(statSync(cache.path('a.mp4')).mtimeMs / 1000)).toBe(Math.round((NOW + 5000) / 1000));
    writeFileSync(cache.partPath('b.mp4'), 'x');
    cache.discard('b.mp4');
    expect(existsSync(cache.partPath('b.mp4'))).toBe(false);
  });

  it('keeps the least-recently-used order across a restart (mtime), and a read touches the file', () => {
    const { make, put, clock } = setup();
    put('old.mp4', 10, NOW - 3000_000);
    put('mid.mp4', 10, NOW - 2000_000);
    put('new.mp4', 10, NOW - 1000_000);
    const again = make();
    expect(again.files().map((f) => f.id)).toEqual(['old.mp4', 'mid.mp4', 'new.mp4']);
    clock.t = NOW;
    again.open('old.mp4')!();
    expect(again.files().map((f) => f.id)).toEqual(['mid.mp4', 'new.mp4', 'old.mp4']);
  });

  it('counts complete files only', () => {
    const { cache, put } = setup();
    put('a.mp4', 1000, NOW);
    writeFileSync(cache.partPath('b.mp4'), Buffer.alloc(500));
    expect(cache.usage()).toEqual({ bytes: 1000, files: 1 });
  });

  it('makeRoom deletes least-recently-used files until the new file fits the cap', () => {
    const { cache, put } = setup(3000);
    const a = put('a.mp4', 1000, NOW - 3000_000);
    const b = put('b.mp4', 1000, NOW - 2000_000);
    const c = put('c.mp4', 1000, NOW - 1000_000);
    expect(cache.makeRoom(1500)).toBe(2000);
    expect([existsSync(a), existsSync(b), existsSync(c)]).toEqual([false, false, true]);
    expect(cache.makeRoom(500)).toBe(0);
  });

  // Review Focus 3.
  it('never evicts a pinned file (being read); the next least-recently-used goes instead', () => {
    const { cache, put } = setup(3000);
    const a = put('a.mp4', 1000, NOW - 3000_000);
    const b = put('b.mp4', 1000, NOW - 2000_000);
    const c = put('c.mp4', 1000, NOW - 1000_000);
    const unpin = cache.open('a.mp4')!;
    expect(cache.busy(a)).toBe(true);
    cache.makeRoom(1500);
    expect([existsSync(a), existsSync(b), existsSync(c)]).toEqual([true, false, false]);
    unpin();
    unpin(); // idempotent
    expect(cache.busy(a)).toBe(false);
  });

  it('open answers null for a file that is not cached', () => {
    expect(setup().cache.open('nope.mp4')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/recording-cache.test.ts`
Expected: FAIL (cannot find module `../src/recordings/cache`).

- [ ] **Step 3: Write `cache.ts`**

```ts
// src/recordings/cache.ts
// The recordings cache (spec "The cache"): <dataDir>/recordings/<cam>/<id>,
// written as <id>.part and renamed when complete. Last use is the file's
// mtime, touched on every read, so the LRU order survives a restart. A pinned
// file (being read) is never deleted; a .part is never counted or evicted.
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync } from 'fs';
import { join } from 'path';

export interface CachedFile { id: string; path: string; bytes: number; used: number }

function safeDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export class RecordingCache {
  private readonly pins = new Map<string, number>();

  constructor(private readonly d: { dir: () => string; capBytes: () => number; now?: () => number }) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  path(id: string): string {
    return join(this.d.dir(), id);
  }

  partPath(id: string): string {
    return `${this.path(id)}.part`;
  }

  capBytes(): number {
    return this.d.capBytes();
  }

  init(): void {
    const dir = this.d.dir();
    mkdirSync(dir, { recursive: true });
    for (const name of safeDir(dir)) {
      if (!name.endsWith('.part')) continue;
      try {
        unlinkSync(join(dir, name));
      } catch {
        // gone
      }
    }
  }

  has(id: string): boolean {
    try {
      return statSync(this.path(id)).isFile();
    } catch {
      return false;
    }
  }

  pin(path: string): () => void {
    this.pins.set(path, (this.pins.get(path) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.pins.get(path) ?? 1) - 1;
      if (n <= 0) this.pins.delete(path);
      else this.pins.set(path, n);
    };
  }

  busy(path: string): boolean {
    return this.pins.has(path);
  }

  open(id: string): (() => void) | null {
    if (!this.has(id)) return null;
    const unpin = this.pin(this.path(id));
    this.touch(id);
    return unpin;
  }

  touch(id: string): void {
    const t = new Date(this.now());
    try {
      utimesSync(this.path(id), t, t);
    } catch {
      // gone
    }
  }

  files(): { id: string; path: string; bytes: number; used: number }[] {
    const dir = this.d.dir();
    const out: CachedFile[] = [];
    for (const id of safeDir(dir)) {
      if (id.endsWith('.part')) continue;
      const path = join(dir, id);
      try {
        const s = statSync(path);
        if (s.isFile()) out.push({ id, path, bytes: s.size, used: s.mtimeMs });
      } catch {
        // gone
      }
    }
    return out.sort((a, b) => a.used - b.used);
  }

  usage(): { bytes: number; files: number } {
    const f = this.files();
    return { bytes: f.reduce((n, x) => n + x.bytes, 0), files: f.length };
  }

  makeRoom(incoming: number): number {
    const files = this.files();
    const cap = this.d.capBytes();
    let total = files.reduce((n, f) => n + f.bytes, 0);
    let freed = 0;
    for (const f of files) {
      if (total + incoming <= cap) break;
      if (this.busy(f.path)) continue;
      try {
        unlinkSync(f.path);
        total -= f.bytes;
        freed += f.bytes;
      } catch {
        // gone
      }
    }
    return freed;
  }

  commit(id: string): void {
    renameSync(this.partPath(id), this.path(id));
    this.touch(id);
  }

  discard(id: string): void {
    try {
      unlinkSync(this.partPath(id));
    } catch {
      // gone
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/recording-cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recordings/cache.ts test/recording-cache.test.ts
git commit
```
Subject: `feat(recordings): disk cache with LRU by mtime, cap and pins`.

---

### Task 8: Settings and the `recordings` storage kind

**Files:**
- Modify: `src/config/schema.ts` (the `camera` node, a new `recordings` node after `ftp`), `src/config/defaults.ts` (`Config`, `DEFAULTS`), `src/config/load.ts` (`LIVE`), `config.schema.json` (generated), `config.example.json`, `src/storage.ts`, `src/api/metrics.ts` (disk gauges), `src/api/control-api.ts` (`/stats`), `src/proxy.ts` (the daily storage record's `kinds`), `web/src/lib/state.ts` (`Stats.disk`), `test/helpers/proxy.ts`
- Test: `test/config.test.ts`, `test/storage.test.ts`

**Interfaces:**
- Consumes: Task 7's on-disk layout (`<dataDir>/recordings/<cam>/<id>`, `.part` while written).
- Produces:
  - `Config.camera.baichuanPort: number` (9000), `Config.recordings: { cacheMB: number }` (2048)
  - `type FileKind = 'stills' | 'previews' | 'clips' | 'recordings'`; `storage.usage().recordings: KindUsage`; `storage.noteWritten('recordings', bytes, 1)`
  - `Storage` deps gain `recordingsBusy?: (path: string) => boolean`
  - `startProxy()` passes `camera.baichuanPort` from the sim

- [ ] **Step 1: Write the failing tests**

Add to `test/config.test.ts`:

```ts
describe('recordings settings', () => {
  beforeEach(() => write('config.json', { camera: { host: '192.0.2.10' } }));
  it('recordings.cacheMB defaults to 2048 (64 to 1,048,576); camera.baichuanPort to 9000 (1 to 65535)', () => {
    const l = load();
    expect(l.config.recordings.cacheMB).toBe(2048);
    expect(l.config.camera.baichuanPort).toBe(9000);
    for (const v of [63, 1_048_577]) expect(() => applyOverrides(l, { recordings: { cacheMB: v } })).toThrow(/recordings.cacheMB/);
    for (const v of [0, 65536]) expect(() => applyOverrides(l, { camera: { baichuanPort: v } })).toThrow(/camera.baichuanPort/);
    expect(applyOverrides(l, { recordings: { cacheMB: 64 }, camera: { baichuanPort: 9001 } }).config.camera.baichuanPort).toBe(9001);
  });

  it('both apply without a restart (the port at the next connection, the cap at the next fetch or storage run)', () => {
    expect(needsRestart('recordings.cacheMB')).toBe(false);
    expect(needsRestart('camera.baichuanPort')).toBe(false);
    expect(needsRestart('camera.host')).toBe(true);
  });
});
```

Add to `test/storage.test.ts` (it already imports `utimesSync`, `mkdirSync`, `writeFileSync`, `existsSync`, `dirname`, `join`):

```ts
describe('storage: the recordings cache', () => {
  const putRec = (dir: string, id: string, bytes: number, usedAt: number) => {
    const p = join(dir, 'recordings', 'cam1', id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, Buffer.alloc(bytes));
    utimesSync(p, new Date(usedAt), new Date(usedAt));
    return p;
  };
  const budget = (x: ReturnType<typeof setup>, files: number) => {
    delete x.config.storage.maxPercent;
    x.config.storage.maxBytes = x.catalog.sizeBytes() + files;
  };

  it('counts cached recordings (not .part files), least recently used as the oldest', () => {
    const x = setup();
    putRec(x.dir, 'RecS0A_A.mp4', 1000, NOW - DAY);
    putRec(x.dir, 'RecS0A_B.mp4', 500, NOW - HOUR);
    writeFileSync(join(x.dir, 'recordings', 'cam1', 'RecS0A_C.mp4.part'), Buffer.alloc(700));
    x.storage.recount();
    expect(x.storage.usage().recordings).toMatchObject({ bytes: 1500, files: 2, oldest: NOW - DAY, newest: NOW - HOUR });
  });

  it('never ages recordings out', () => {
    const x = setup();
    const old = putRec(x.dir, 'RecS0A_A.mp4', 1000, NOW - 300 * DAY);
    x.storage.recount();
    x.storage.run({});
    expect(existsSync(old)).toBe(true);
  });

  it('applies recordings.cacheMB at a storage run, least recently used first', () => {
    const x = setup((c) => (c.recordings.cacheMB = 1));
    const a = putRec(x.dir, 'RecS0A_A.mp4', 600_000, NOW - DAY);
    const b = putRec(x.dir, 'RecS0A_B.mp4', 600_000, NOW - HOUR);
    x.storage.recount();
    const r = x.storage.run({});
    expect([existsSync(a), existsSync(b)]).toEqual([false, true]);
    expect(r.deleted.recordings).toBe(1);
    expect(r.reason).toContain('cap');
  });

  it('over budget: recordings go first, least recently used, before any still; no keepHours', () => {
    const x = setup((c) => (c.storage.keepHours = { stills: 0, clips: 0, previews: 0 }));
    const still = x.put('stills', NOW - 5 * HOUR, 1000);
    const old = putRec(x.dir, 'RecS0A_A.mp4', 1000, NOW - 2 * DAY);
    const recent = putRec(x.dir, 'RecS0A_B.mp4', 1000, NOW - 60_000);
    x.storage.recount();
    budget(x, 2000);
    const r = x.storage.run({});
    expect([existsSync(old), existsSync(recent), existsSync(still)]).toEqual([false, true, true]);
    expect(r.deleted.recordings).toBe(1);
    expect(r.deleted.stills ?? 0).toBe(0);
  });

  // Review Focus 3.
  it('skips a file in use and takes the next least recently used', () => {
    const x = setup();
    const busyOne = putRec(x.dir, 'RecS0A_A.mp4', 1000, NOW - 2 * DAY);
    const next = putRec(x.dir, 'RecS0A_B.mp4', 1000, NOW - DAY);
    const storage = new Storage({ catalog: x.catalog, log: x.log, config: () => x.config, now: () => NOW, statfs: () => x.fs, recordingsBusy: (p) => p === busyOne });
    storage.recount();
    budget(x, 1000);
    storage.run({});
    expect([existsSync(busyOne), existsSync(next)]).toEqual([true, false]);
  });

  it('a dry run reports and deletes nothing; noteWritten counts until the next recount', () => {
    const x = setup((c) => (c.recordings.cacheMB = 1));
    const a = putRec(x.dir, 'RecS0A_A.mp4', 600_000, NOW - DAY);
    putRec(x.dir, 'RecS0A_B.mp4', 600_000, NOW - HOUR);
    x.storage.recount();
    expect(x.storage.run({ dryRun: true }).deleted.recordings).toBe(1);
    expect(existsSync(a)).toBe(true);
    x.storage.noteWritten('recordings', 300, 1);
    expect(x.storage.usage().recordings.bytes).toBe(1_200_300);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/config.test.ts test/storage.test.ts`
Expected: FAIL (`recordings` is undefined in the config; `usage().recordings` is undefined).

- [ ] **Step 3: The settings**

`src/config/schema.ts`, in `camera` after `rtspPort`:

```ts
    baichuanPort: port("camera Baichuan port (recordings over TCP); the host is camera.host's"),
```

and a new node after `ftp`:

```ts
  recordings: {
    cacheMB: int(64, 1_048_576, 'size cap of the recordings cache, MB; least recently used files go first'),
  },
```

`src/config/defaults.ts`: in `Config.camera` add `baichuanPort: number;` after `rtspPort: number;`; add `recordings: { cacheMB: number };` to `Config` (after `ftp`); in `DEFAULTS.camera` add `baichuanPort: 9000` after `rtspPort: 554`; add `recordings: { cacheMB: 2048 },` after `ftp`.

`src/config/load.ts`:

```ts
// Live although under a restart prefix: the PoE switch is read on every use;
// the Baichuan port at the next connection.
const LIVE = ['camera.poeSwitch.', 'camera.baichuanPort'];
export function needsRestart(path: string): boolean {
  if (LIVE.some((l) => (l.endsWith('.') ? path.startsWith(l) : path === l))) return false;
  return RESTART.some((r) => (r.endsWith('.') ? path.startsWith(r) : path === r));
}
```

`config.example.json`: in `camera` add `"baichuanPort": 9000` after `"rtspPort": 554`; add `"recordings": { "cacheMB": 2048 }` after the `ftp` object (keep the file's two-space formatting).

Run: `npm run schema` (regenerates `config.schema.json`).

`test/helpers/proxy.ts`, in the written `camera` object:

```ts
    camera: { host: sim.camera.host, protocol: 'http', user: 'proxy', onvifPort: sim.ports.onvif, rtspPort: sim.ports.rtsp || 554, baichuanPort: sim.camera.baichuanPort, statusPollS: 5 },
```

- [ ] **Step 4: The storage kind**

In `src/storage.ts`:

Replace the kind declarations:

```ts
export type FileKind = 'stills' | 'previews' | 'clips' | 'recordings';
type MinuteKind = Exclude<FileKind, 'recordings'>;
const MINUTE_KINDS: MinuteKind[] = ['stills', 'previews', 'clips'];
const KINDS: FileKind[] = [...MINUTE_KINDS, 'recordings'];
// After the recordings cache (always first, least recently used), what goes first when over budget.
const BUDGET_ORDER: MinuteKind[] = ['stills', 'clips', 'previews'];
```

The units field: `private readonly units: Record<FileKind, Unit[]> = { stills: [], previews: [], clips: [], recordings: [] };`

The constructor deps gain, after `statfs?`:

```ts
      recordingsBusy?: (path: string) => boolean; // a recording being read: never deleted
```

In `recount()`, loop the minute kinds only (`for (const kind of MINUTE_KINDS) {`), and after that loop add:

```ts
    // The recordings cache: one unit per file, its time the last use (mtime).
    const recs: Unit[] = [];
    const recDir = join(root, 'recordings');
    for (const cam of safeDir(recDir)) {
      for (const name of safeDir(join(recDir, cam))) {
        if (name.endsWith('.part')) continue; // being written
        const path = join(recDir, cam, name);
        try {
          const s = statSync(path);
          if (s.isFile()) recs.push({ ts: s.mtimeMs, files: [{ path, bytes: s.size }] });
        } catch {
          // gone
        }
      }
    }
    this.units.recordings = recs.sort((a, b) => a.ts - b.ts);
```

In `run()`:
- `const sim: Record<FileKind, Unit[]> = { stills: [...this.units.stills], previews: [...this.units.previews], clips: [...this.units.clips], recordings: [...this.units.recordings] };`
- In `drop`, delete a recording without touching folders:
  ```ts
      for (const f of u.files) {
        if (!f.path) continue;
        if (kind === 'recordings') {
          try { unlinkSync(f.path); } catch { /* gone */ }
          continue;
        }
        removeFile(f.path);
        if (kind === 'clips') deleteClip(this.d.catalog, f.path); // the row (or the snapshot link)
      }
  ```
- Age: `const days: Record<MinuteKind, number> = { … }` and `for (const kind of MINUTE_KINDS) {` (recordings have no age retention).
- `const dropOldestHour = (kind: MinuteKind): boolean => {` (unchanged body).
- `const caps: Partial<Record<MinuteKind, number | undefined>> = { … }` and `for (const kind of MINUTE_KINDS) {` in the caps loop. After that loop:
  ```ts
    // The recordings cache: its own cap, then first in line for the budget,
    // least recently used first, never a file in use.
    const dropRecording = (): boolean => {
      const i = sim.recordings.findIndex((u) => !u.files.some((f) => f.path && this.d.recordingsBusy?.(f.path)));
      if (i < 0) return false;
      drop('recordings', sim.recordings.splice(i, 1)[0]);
      return true;
    };
    const recCap = cfg.recordings.cacheMB * 2 ** 20;
    while (bytesOf('recordings') > recCap && dropRecording()) if (!reason.includes('cap')) reason.push('cap');
  ```
- The budget loop: `if (!(dropRecording() || BUDGET_ORDER.some((k) => dropOldestHour(k)))) {`
- In the non-dry block: `this.units.recordings = sim.recordings;`

`src/api/metrics.ts`: `const kinds = ['catalog', 'stills', 'previews', 'clips', 'recordings', 'audit'] as const;` and in `storage_growth_bytes_per_day` loop `['stills', 'previews', 'clips', 'recordings'] as const`.

`src/api/control-api.ts`, `/stats`: `disk: { catalog: u.catalog, audit: u.audit, stills: u.stills, previews: u.previews, clips: u.clips, recordings: u.recordings, free: u.free, size: u.size },`.

`src/proxy.ts`, the daily storage record: `kinds: { stills: u.stills, previews: u.previews, clips: u.clips, recordings: u.recordings, catalog: u.catalog, audit: u.audit }`.

`web/src/lib/state.ts`, `Stats.disk`: add `recordings?: Usage;`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/config.test.ts test/storage.test.ts test/control-api.test.ts`
Expected: PASS (the example and generated-schema checks included).

Run: `npm run lint:types && npm run check`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts src/config/defaults.ts src/config/load.ts config.schema.json config.example.json src/storage.ts src/api/metrics.ts src/api/control-api.ts src/proxy.ts web/src/lib/state.ts test/helpers/proxy.ts test/config.test.ts test/storage.test.ts
git commit
```
Subject: `feat(recordings): settings and the recordings storage kind (first for the budget)`.

---

### Task 9: The recordings list (HTTP Search)

**Files:**
- Create: `src/recordings/list.ts`, `test/recording-list.test.ts`
- Modify: `src/catalog/clips.ts` (`clipNear`)

**Interfaces:**
- Consumes: Task 6 (`parseSdName`, `stillRecording`, `recordingTimes`, `localDays`, `Kind`, `Stream`), `CameraError` (`src/camera/client.ts`: `code`, `rspCode`), `Semaphore` (`src/camera/semaphore.ts`), `SAFE_PATH` (Task 5).
- Produces:
  - `interface RecordingEntry { id: string; path: string /* the camera's, from Search */; start: number; end: number; stream: Stream; size: number; kinds: Kind[] }`
  - `class SearchError extends Error { readonly code: 'camera_offline' | 'search_failed' }`
  - `class RecordingList`:
    - `constructor(d: { search: (param: object) => Promise<unknown>; timeInfo: () => Promise<TimeInfo>; now?: () => number; sleep?: (ms: number) => Promise<void> })`
    - `day(date: string, stream: Stream, fresh?: boolean): Promise<RecordingEntry[]>`
    - `range(from: number, to: number, stream: Stream): Promise<RecordingEntry[]>`
    - `find(id: string): Promise<RecordingEntry | undefined>`
    - `stillListed(e: RecordingEntry): Promise<boolean>` (a fresh Search)
    - `monthDays(month: string): Promise<number[]>`
    - `clear(): void`
  - `function clipNear(c: Catalog, cam: string, stream: string, ts: number, slackMs: number): ClipRow | undefined`

- [ ] **Step 1: Write the failing tests**

```ts
// test/recording-list.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CameraError } from '../src/camera/client';
import type { TimeInfo } from '../src/camera/time';
import { openCatalog } from '../src/catalog/db';
import { clipNear, insertClip } from '../src/catalog/clips';
import { RecordingList, SearchError } from '../src/recordings/list';

const CHI: TimeInfo = { stdOffsetMinutes: -360, dstOffsetMinutes: 60, dstRule: { startMon: 3, startWeek: 2, startWeekday: 0, startHour: 2, startMin: 0, endMon: 11, endWeek: 1, endWeekday: 0, endHour: 2, endMin: 0 } };
const file = (date: string, start: string, end: string, s: 'S' | 'M' = 'S', flags = '5514C080000000', size = '3E8') =>
  `/mnt/sda/Mp4Record/${date}/Rec${s}0A_DST${date.replaceAll('-', '')}_${start}_${end}_0_${flags}_${size}.mp4`;
type Param = { Search: { onlyStatus: number; streamType: string; StartTime: { year: number; mon: number; day: number }; EndTime: { day: number; hour: number; min: number; sec: number } } };
const dateOf = (p: Param) => `${p.Search.StartTime.year}-${String(p.Search.StartTime.mon).padStart(2, '0')}-${String(p.Search.StartTime.day).padStart(2, '0')}`;

function fake(files: Record<string, string[]>, o: { fail?: unknown[]; time?: () => Promise<TimeInfo>; status?: { year: number; mon: number; table: string }[] } = {}) {
  const calls: Param[] = [];
  let running = 0;
  let maxRunning = 0;
  const clock = { t: Date.UTC(2026, 9, 2, 18, 0) };
  const slept: number[] = [];
  const list = new RecordingList({
    search: async (param) => {
      const p = param as Param;
      calls.push(p);
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      const f = o.fail?.shift();
      if (f) throw f;
      if (p.Search.onlyStatus === 1) return { SearchResult: { Status: o.status ?? [] } };
      return { SearchResult: { File: (files[`${dateOf(p)}|${p.Search.streamType}`] ?? []).map((name) => ({ name, size: 1000 })) } };
    },
    timeInfo: o.time ?? (async () => CHI),
    now: () => clock.t,
    sleep: async (ms) => void slept.push(ms),
  });
  return { list, calls, clock, slept, maxRunning: () => maxRunning };
}

describe('RecordingList.range', () => {
  it('one Search per camera-local day, merged, sorted, filtered to the window, without recordings still being written', async () => {
    const x = fake({
      '2026-10-01|sub': [file('2026-10-01', '211129', '211207'), file('2026-10-01', '080000', '080030')],
      '2026-10-02|sub': [file('2026-10-02', '010000', '010020'), file('2026-10-02', '120000', '000000'), file('2026-10-01', '090000', '090010')],
    });
    // 2026-10-01 20:00 CDT to 2026-10-02 12:00 CDT.
    const r = await x.list.range(Date.UTC(2026, 9, 2, 1, 0), Date.UTC(2026, 9, 2, 17, 0), 'sub');
    expect(x.calls.map((c) => [dateOf(c), c.Search.streamType, c.Search.onlyStatus])).toEqual([['2026-10-01', 'sub', 0], ['2026-10-02', 'sub', 0]]);
    expect(x.calls[0].Search.EndTime).toMatchObject({ day: 1, hour: 23, min: 59, sec: 59 });
    expect(r.map((e) => e.id)).toEqual(['RecS0A_DST20261001_211129_211207_0_5514C080000000_3E8.mp4', 'RecS0A_DST20261002_010000_010020_0_5514C080000000_3E8.mp4']);
    expect(r[0]).toEqual({ id: r[0].id, path: file('2026-10-01', '211129', '211207'), start: Date.UTC(2026, 9, 2, 2, 11, 29), end: Date.UTC(2026, 9, 2, 2, 12, 7), stream: 'sub', size: 1000, kinds: ['person', 'motion'] });
  });

  it('runs one Search at a time, even for parallel requests', async () => {
    const x = fake({});
    await Promise.all([x.list.day('2026-10-01', 'sub'), x.list.day('2026-10-01', 'main'), x.list.day('2026-10-02', 'sub')]);
    expect(x.calls).toHaveLength(3);
    expect(x.maxRunning()).toBe(1);
  });

  it('keeps a day 30 s; requests at the same time share one Search', async () => {
    const x = fake({ '2026-10-01|sub': [file('2026-10-01', '211129', '211207')] });
    await Promise.all([x.list.day('2026-10-01', 'sub'), x.list.day('2026-10-01', 'sub')]);
    expect(x.calls).toHaveLength(1);
    x.clock.t += 29_999;
    await x.list.day('2026-10-01', 'sub');
    expect(x.calls).toHaveLength(1);
    x.clock.t += 1;
    await x.list.day('2026-10-01', 'sub');
    expect(x.calls).toHaveLength(2);
  });

  it('retries -54 once after 1 s; a second -54 or any other failure is search_failed', async () => {
    const busy = () => new CameraError('camera_error', 'Search failed (rspCode -54)', false, -54);
    const x = fake({ '2026-10-01|sub': [file('2026-10-01', '211129', '211207')] }, { fail: [busy()] });
    expect(await x.list.day('2026-10-01', 'sub')).toHaveLength(1);
    expect(x.slept).toEqual([1000]);
    const y = fake({}, { fail: [busy(), busy()] });
    const e = (await y.list.day('2026-10-01', 'sub').catch((err) => err)) as SearchError;
    expect([e.name, e.code]).toEqual(['SearchError', 'search_failed']);
    const z = fake({}, { fail: [new CameraError('camera_error', 'Search failed (rspCode -17)', false, -17)] });
    expect(((await z.list.day('2026-10-01', 'sub').catch((err) => err)) as SearchError).code).toBe('search_failed');
    expect(z.calls).toHaveLength(1);
  });

  it('an unreachable camera is camera_offline', async () => {
    const x = fake({}, { fail: [new CameraError('camera_offline', 'camera unreachable (ECONNREFUSED)')] });
    expect(((await x.list.day('2026-10-01', 'sub').catch((err) => err)) as SearchError).code).toBe('camera_offline');
  });

  // Review Focus 4.
  it('a failed GetTime is search_failed, not a crash; an unreachable one camera_offline', async () => {
    const x = fake({}, { time: async () => { throw new CameraError('camera_error', 'GetTime failed (rspCode -1)'); } });
    expect(((await x.list.range(Date.UTC(2026, 9, 2, 1), Date.UTC(2026, 9, 2, 2), 'sub').catch((err) => err)) as SearchError).code).toBe('search_failed');
    const y = fake({}, { time: async () => { throw new CameraError('camera_offline', 'camera unreachable (ETIMEDOUT)'); } });
    expect(((await y.list.range(Date.UTC(2026, 9, 2, 1), Date.UTC(2026, 9, 2, 2), 'sub').catch((err) => err)) as SearchError).code).toBe('camera_offline');
  });

  it('skips Search entries that are not plain recording paths', async () => {
    const x = fake({ '2026-10-01|sub': ['/mnt/sda/x y/RecS0A_DST20261001_211129_211207_0_5514C080000000_3E8.mp4', file('2026-10-01', '211129', '211207')] });
    expect((await x.list.day('2026-10-01', 'sub')).map((e) => e.path)).toEqual([file('2026-10-01', '211129', '211207')]);
  });
});

describe('RecordingList.find and stillListed', () => {
  it('resolves an id through its own day and stream; the camera path comes from Search', async () => {
    const x = fake({ '2026-10-01|main': [file('2026-10-01', '211129', '211207', 'M')] });
    const id = 'RecM0A_DST20261001_211129_211207_0_5514C080000000_3E8.mp4';
    expect((await x.list.find(id))?.path).toBe(file('2026-10-01', '211129', '211207', 'M'));
    expect(x.calls.map((c) => [dateOf(c), c.Search.streamType])).toEqual([['2026-10-01', 'main']]);
    expect(await x.list.find(id.replace('211129', '211130'))).toBeUndefined();
    expect(await x.list.find('not-a-name.mp4')).toBeUndefined();
  });

  it('stillListed asks the camera again (no cache)', async () => {
    const files = { '2026-10-01|sub': [file('2026-10-01', '211129', '211207')] };
    const x = fake(files);
    const [e] = await x.list.day('2026-10-01', 'sub');
    files['2026-10-01|sub'] = [];
    expect(await x.list.stillListed(e)).toBe(false);
    expect(x.calls).toHaveLength(2);
  });
});

describe('RecordingList.monthDays', () => {
  it('the days with recordings from the month Search (onlyStatus 1, main stream), kept 5 minutes', async () => {
    const x = fake({}, { status: [{ year: 2026, mon: 10, table: '1100000000000000000000000000001' }, { year: 2026, mon: 9, table: '1' }] });
    expect(await x.list.monthDays('2026-10')).toEqual([1, 2, 31]);
    expect(x.calls[0].Search).toMatchObject({ onlyStatus: 1, streamType: 'main', StartTime: { year: 2026, mon: 10, day: 1 }, EndTime: { day: 31, hour: 23, min: 59, sec: 59 } });
    x.clock.t += 299_999;
    await x.list.monthDays('2026-10');
    expect(x.calls).toHaveLength(1);
    x.clock.t += 1;
    await x.list.monthDays('2026-10');
    expect(x.calls).toHaveLength(2);
  });
});

describe('clipNear', () => {
  it('the FTP copy: same camera and stream, start within the slack, the closest', () => {
    const c = openCatalog(join(mkdtempSync(join(tmpdir(), 'camproxy-near-')), 'catalog.sqlite'));
    const T = Date.UTC(2026, 9, 2, 2, 11, 29);
    const base = { cam: 'cam1', end_ts: null, path: '/x.mp4', size: 1, received_at: T, snapshot: null };
    const far = insertClip(c, { ...base, stream: 'sub', start_ts: T + 4000 });
    const near = insertClip(c, { ...base, stream: 'sub', start_ts: T - 2000 });
    insertClip(c, { ...base, stream: 'main', start_ts: T });
    expect(clipNear(c, 'cam1', 'sub', T, 5000)?.id).toBe(near.id);
    expect(clipNear(c, 'cam1', 'sub', T + 8000, 5000)?.id).toBe(far.id);
    expect(clipNear(c, 'cam1', 'sub', T + 10_000, 5000)).toBeUndefined();
    expect(clipNear(c, 'cam2', 'sub', T, 5000)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/recording-list.test.ts`
Expected: FAIL (cannot find module `../src/recordings/list`).

- [ ] **Step 3: Write `clipNear` and `list.ts`**

`src/catalog/clips.ts`, after `clipByPath`:

```ts
// The FTP copy of an SD recording: same camera and stream, the closest start
// within `slackMs` (cams' 5 s), or undefined.
export function clipNear(c: Catalog, cam: string, stream: string, ts: number, slackMs: number): ClipRow | undefined {
  return c.db
    .prepare('SELECT * FROM clips WHERE cam = ? AND stream = ? AND start_ts BETWEEN ? AND ? ORDER BY ABS(start_ts - ?), id LIMIT 1')
    .get(cam, stream, ts - slackMs, ts + slackMs, ts) as unknown as ClipRow | undefined;
}
```

```ts
// src/recordings/list.ts
// The SD recordings, from the camera's HTTP Search (spec "How the list is
// made"): one Search per camera-local day, one at a time per camera (an
// overlapping Search fails with -54 or comes back empty), each (day, stream)
// kept 30 s; the month's days kept 5 minutes.
import { CameraError } from '../camera/client';
import { Semaphore } from '../camera/semaphore';
import type { TimeInfo } from '../camera/time';
import { SAFE_PATH } from '../camera/baichuan/vod';
import { localDays, parseSdName, recordingTimes, stillRecording, type Kind, type Stream } from './names';

export interface RecordingEntry { id: string; path: string; start: number; end: number; stream: Stream; size: number; kinds: Kind[] }

export class SearchError extends Error {
  constructor(
    readonly code: 'camera_offline' | 'search_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SearchError';
  }
}

const DAY_TTL = 30_000;
const MONTH_TTL = 300_000;

// Messages from CameraError never carry URLs or tokens.
const toSearchError = (err: unknown, fallback: string): SearchError =>
  err instanceof CameraError && err.code === 'camera_offline' ? new SearchError('camera_offline', err.message) : new SearchError('search_failed', err instanceof CameraError ? err.message : fallback);

export class RecordingList {
  private readonly gate = new Semaphore(1);
  private readonly days = new Map<string, { at: number; entries: RecordingEntry[] }>();
  private readonly dayRuns = new Map<string, Promise<RecordingEntry[]>>();
  private readonly months = new Map<string, { at: number; days: number[] }>();
  private readonly monthRuns = new Map<string, Promise<number[]>>();

  constructor(
    private readonly d: {
      search: (param: object) => Promise<unknown>;
      timeInfo: () => Promise<TimeInfo>;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private async time(): Promise<TimeInfo> {
    try {
      return await this.d.timeInfo();
    } catch (err) {
      throw toSearchError(err, 'the camera time is unknown');
    }
  }

  // One Search, never two at once; -54 (busy) retried once after 1 s.
  private search(param: object): Promise<unknown> {
    return this.gate.run(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.d.search(param);
        } catch (err) {
          if (attempt === 0 && err instanceof CameraError && err.rspCode === -54) {
            await (this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(1000);
            continue;
          }
          throw toSearchError(err, 'Search failed');
        }
      }
    });
  }

  day(date: string, stream: Stream, fresh = false): Promise<RecordingEntry[]> {
    const key = `${date}|${stream}`;
    const hit = this.days.get(key);
    if (!fresh && hit && this.now() - hit.at < DAY_TTL) return Promise.resolve(hit.entries);
    const running = this.dayRuns.get(key);
    if (running) return running;
    const work = (async () => {
      const [year, mon, day] = date.split('-').map(Number);
      const v = (await this.search({
        Search: { channel: 0, onlyStatus: 0, streamType: stream, StartTime: { year, mon, day, hour: 0, min: 0, sec: 0 }, EndTime: { year, mon, day, hour: 23, min: 59, sec: 59 } },
      })) as { SearchResult?: { File?: { name?: unknown }[] } } | undefined;
      const t = await this.time();
      const out: RecordingEntry[] = [];
      for (const f of v?.SearchResult?.File ?? []) {
        if (typeof f?.name !== 'string' || !SAFE_PATH.test(f.name)) continue;
        const n = parseSdName(f.name);
        if (!n || n.date !== date || n.stream !== stream || stillRecording(n)) continue;
        out.push({ id: n.id, path: f.name, ...recordingTimes(n, t), stream, size: n.size, kinds: n.kinds });
      }
      out.sort((a, b) => a.start - b.start);
      this.days.set(key, { at: this.now(), entries: out });
      return out;
    })().finally(() => this.dayRuns.delete(key));
    this.dayRuns.set(key, work);
    return work;
  }

  // Recordings that overlap [from, to], by start; every day of the range or none.
  async range(from: number, to: number, stream: Stream): Promise<RecordingEntry[]> {
    const t = await this.time();
    const byId = new Map<string, RecordingEntry>();
    for (const date of localDays(from, to, t)) {
      for (const e of await this.day(date, stream)) if (e.start <= to && e.end >= from) byId.set(e.id, e);
    }
    return [...byId.values()].sort((a, b) => a.start - b.start);
  }

  async find(id: string): Promise<RecordingEntry | undefined> {
    const n = parseSdName(id);
    if (!n || n.id !== id) return undefined;
    return (await this.day(n.date, n.stream)).find((e) => e.id === id);
  }

  async stillListed(e: RecordingEntry): Promise<boolean> {
    const n = parseSdName(e.id);
    if (!n) return false;
    return (await this.day(n.date, n.stream, true)).some((x) => x.id === e.id);
  }

  monthDays(month: string): Promise<number[]> {
    const hit = this.months.get(month);
    if (hit && this.now() - hit.at < MONTH_TTL) return Promise.resolve(hit.days);
    const running = this.monthRuns.get(month);
    if (running) return running;
    const work = (async () => {
      const [year, mon] = month.split('-').map(Number);
      const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
      const v = (await this.search({
        Search: { channel: 0, onlyStatus: 1, streamType: 'main', StartTime: { year, mon, day: 1, hour: 0, min: 0, sec: 0 }, EndTime: { year, mon, day: last, hour: 23, min: 59, sec: 59 } },
      })) as { SearchResult?: { Status?: { year?: unknown; mon?: unknown; table?: unknown }[] } } | undefined;
      const days = new Set<number>();
      for (const s of v?.SearchResult?.Status ?? []) {
        if (Number(s?.year) !== year || Number(s?.mon) !== mon || typeof s?.table !== 'string') continue;
        [...s.table].forEach((c, i) => {
          if (c === '1' && i < last) days.add(i + 1);
        });
      }
      const out = [...days].sort((a, b) => a - b);
      this.months.set(month, { at: this.now(), days: out });
      return out;
    })().finally(() => this.monthRuns.delete(month));
    this.monthRuns.set(month, work);
    return work;
  }

  clear(): void {
    this.days.clear();
    this.months.clear();
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/recording-list.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recordings/list.ts src/catalog/clips.ts test/recording-list.test.ts
git commit
```
Subject: `feat(recordings): list from HTTP Search, per camera day, one at a time`.

---

### Task 10: The fetcher (one download at a time, the tee to the first client)

**Files:**
- Create: `src/recordings/fetcher.ts`, `test/recording-fetcher.test.ts`

**Interfaces:**
- Consumes: Task 7 (`RecordingCache`: `capBytes`, `makeRoom`, `partPath`, `commit`, `discard`), Task 9 (`RecordingEntry`), Task 2 (`BaichuanError`, `BaichuanErrorCode`), Task 6 (`Stream`).
- Produces:
  - `type Priority = 'high' | 'low'`
  - `type FetchResult = 'ok' | BaichuanErrorCode`
  - `interface FetchOutcome { id: string; at: number; result: FetchResult; stream: Stream; bytes: number; ms: number }`
  - `interface FetcherDeps { cache: RecordingCache; download: (path: string, size: number, out: Writable) => Promise<number>; stillListed: (e: RecordingEntry) => Promise<boolean>; paused: () => boolean; noteWritten: (bytes: number) => void; onDone: (o: FetchOutcome) => void; now?: () => number }`
  - `function abortError(why?: string): Error` (name `AbortError`), `function isAbort(e: unknown): boolean`
  - `class Fetch { readonly entry: RecordingEntry; readonly done: Promise<void>; state: 'queued' | 'running' | 'done'; attach(res: Writable, onStart: () => void): void }` (`onStart` runs once, right before the first byte goes to `res`; the tee ends `res` when the file is complete)
  - `class RecordingFetcher`:
    - `constructor(d: FetcherDeps)`
    - `get(entry: RecordingEntry, o: { priority: Priority; signal?: AbortSignal }): { fetch: Fetch; created: boolean }` (a running or queued fetch of the same id is joined: `created` false)
    - `queued(): string[]` (ids, in order)
    - `stop(): void` (queued fetches fail `offline`)

- [ ] **Step 1: Write the failing tests**

```ts
// test/recording-fetcher.test.ts
import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough, Writable } from 'stream';
import { randomBytes } from 'crypto';
import { BaichuanError } from '../src/camera/baichuan/errors';
import { RecordingCache } from '../src/recordings/cache';
import { abortError, RecordingFetcher, type FetchOutcome } from '../src/recordings/fetcher';
import type { RecordingEntry } from '../src/recordings/list';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const entry = (n: number, size: number): RecordingEntry => {
  const id = `RecS0A_DST20261001_21110${n}_211207_0_5514C080000000_${size.toString(16).toUpperCase()}.mp4`;
  return { id, path: `/mnt/sda/Mp4Record/2026-10-01/${id}`, start: 0, end: 1, stream: 'sub', size, kinds: [] };
};

interface DlOptions { chunk?: number; delayMs?: number; fail?: BaichuanError; gated?: boolean }
function downloader(files: Map<string, Buffer>, o: DlOptions) {
  const calls: string[] = [];
  const gates = new Map<string, () => void>();
  let fullWrites = 0;
  const download = async (path: string, _size: number, out: Writable): Promise<number> => {
    calls.push(path);
    if (o.gated) await new Promise<void>((r) => gates.set(path, r));
    if (o.fail) throw o.fail;
    const state = { failed: false };
    out.on('error', () => (state.failed = true));
    const data = files.get(path)!;
    const step = o.chunk ?? 10_000;
    for (let off = 0; off < data.length; off += step) {
      if (o.delayMs) await sleep(o.delayMs);
      if (state.failed) throw abortError();
      if (!out.write(data.subarray(off, off + step))) {
        fullWrites++;
        await new Promise<void>((r) => {
          out.once('drain', r);
          out.once('error', () => r());
        });
      }
    }
    if (state.failed) throw abortError();
    return data.length;
  };
  return { download, calls, release: (path: string) => gates.get(path)?.(), fullWrites: () => fullWrites };
}

function setup(o: DlOptions & { cap?: number; paused?: boolean; listed?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-fetch-'));
  const cache = new RecordingCache({ dir: () => dir, capBytes: () => o.cap ?? 10_000_000 });
  cache.init();
  const files = new Map<string, Buffer>();
  const add = (n: number, size = 50_000) => {
    const e = entry(n, size);
    files.set(e.path, randomBytes(size));
    return e;
  };
  const dl = downloader(files, o);
  const outcomes: FetchOutcome[] = [];
  const written: number[] = [];
  const state = { paused: o.paused ?? false, listed: o.listed ?? true };
  const fetcher = new RecordingFetcher({ cache, download: dl.download, stillListed: async () => state.listed, paused: () => state.paused, noteWritten: (b) => written.push(b), onDone: (x) => outcomes.push(x) });
  return { dir, cache, files, add, dl, outcomes, written, fetcher };
}
function collector(highWaterMark = 1 << 20, delayMs = 0) {
  const parts: Buffer[] = [];
  const w = new Writable({
    highWaterMark,
    write(c: Buffer, _e, cb) {
      parts.push(c);
      if (delayMs) setTimeout(cb, delayMs);
      else cb();
    },
  });
  return { w, bytes: () => Buffer.concat(parts) };
}

describe('RecordingFetcher', () => {
  it('fetches into the cache and streams to the first client while it arrives', async () => {
    const x = setup({ delayMs: 2 });
    const e = x.add(1);
    const { fetch, created } = x.fetcher.get(e, { priority: 'high' });
    expect(created).toBe(true);
    const c = collector();
    let atStart = -1;
    fetch.attach(c.w, () => (atStart = c.bytes().length));
    await fetch.done;
    expect(atStart).toBe(0);
    expect(c.bytes()).toEqual(x.files.get(e.path));
    await vi.waitFor(() => expect(c.w.writableEnded).toBe(true));
    expect(readFileSync(x.cache.path(e.id))).toEqual(x.files.get(e.path));
    expect(x.written).toEqual([e.size]);
    expect(x.outcomes).toMatchObject([{ id: e.id, result: 'ok', stream: 'sub', bytes: e.size }]);
  });

  it('a second request for the same id joins the running fetch: one transfer', async () => {
    const x = setup({ delayMs: 2 });
    const e = x.add(1);
    const a = x.fetcher.get(e, { priority: 'high' });
    const b = x.fetcher.get(e, { priority: 'high' });
    expect(b.created).toBe(false);
    expect(b.fetch).toBe(a.fetch);
    await b.fetch.done;
    expect(x.dl.calls).toHaveLength(1);
  });

  it('one download at a time; high goes ahead of every queued low, also when it joins one', async () => {
    const x = setup({ gated: true });
    const [a, b, c, d] = [x.add(1), x.add(2), x.add(3), x.add(4)];
    const fa = x.fetcher.get(a, { priority: 'low' }).fetch;
    await vi.waitFor(() => expect(x.dl.calls).toEqual([a.path]));
    x.fetcher.get(b, { priority: 'low' });
    x.fetcher.get(c, { priority: 'high' });
    x.fetcher.get(d, { priority: 'low' });
    expect(x.fetcher.queued()).toEqual([c.id, b.id, d.id]);
    x.fetcher.get(d, { priority: 'high' });
    expect(x.fetcher.queued()).toEqual([c.id, d.id, b.id]);
    x.dl.release(a.path);
    await fa.done;
    for (const next of [c, d, b]) {
      await vi.waitFor(() => expect(x.dl.calls[x.dl.calls.length - 1]).toBe(next.path));
      x.dl.release(next.path);
    }
    expect(x.dl.calls).toEqual([a.path, c.path, d.path, b.path]);
  });

  it('a request whose client leaves while queued leaves the queue (unless another still waits)', async () => {
    const x = setup({ gated: true });
    const [a, b] = [x.add(1), x.add(2)];
    x.fetcher.get(a, { priority: 'high' });
    await vi.waitFor(() => expect(x.dl.calls).toEqual([a.path]));
    const one = new AbortController();
    const two = new AbortController();
    const fb = x.fetcher.get(b, { priority: 'high', signal: one.signal }).fetch;
    x.fetcher.get(b, { priority: 'high', signal: two.signal });
    one.abort();
    expect(x.fetcher.queued()).toEqual([b.id]);
    two.abort();
    expect(x.fetcher.queued()).toEqual([]);
    await expect(fb.done).rejects.toMatchObject({ name: 'AbortError' });
    x.dl.release(a.path);
    await sleep(20);
    expect(x.dl.calls).toEqual([a.path]);
  });

  it('a failure before the first chunk: no headers, no .part, the outcome and the error', async () => {
    const x = setup({ fail: new BaichuanError('timeout', 'no data after the download request') });
    const e = x.add(1);
    const { fetch } = x.fetcher.get(e, { priority: 'high' });
    let started = false;
    fetch.attach(collector().w, () => (started = true));
    await expect(fetch.done).rejects.toMatchObject({ code: 'timeout' });
    expect(started).toBe(false);
    expect(existsSync(x.cache.partPath(e.id))).toBe(false);
    expect(x.cache.has(e.id)).toBe(false);
    expect(x.outcomes).toMatchObject([{ id: e.id, result: 'timeout' }]);
  });

  it('a 400: not_found when the camera no longer lists the file, refused when it still does', async () => {
    for (const [listed, code] of [[false, 'not_found'], [true, 'refused']] as const) {
      const x = setup({ fail: new BaichuanError('refused', 'the download answered 400', 400), listed });
      const e = x.add(1);
      await expect(x.fetcher.get(e, { priority: 'high' }).fetch.done).rejects.toMatchObject({ code });
      expect(x.outcomes[0].result).toBe(code);
    }
  });

  // Review Focus 2.
  it('a waiter gets the whole file after the first client left mid-stream', async () => {
    const x = setup({ delayMs: 3 });
    const e = x.add(1, 100_000);
    const first = x.fetcher.get(e, { priority: 'high' }).fetch;
    const client = new PassThrough();
    let got = 0;
    client.on('data', (c: Buffer) => {
      got += c.length;
      if (got > 20_000) client.destroy();
    });
    first.attach(client, () => undefined);
    const second = x.fetcher.get(e, { priority: 'high' });
    expect(second.created).toBe(false);
    await second.fetch.done;
    expect(readFileSync(x.cache.path(e.id))).toEqual(x.files.get(e.path));
    expect(x.outcomes[0].result).toBe('ok');
  });

  it('disk paused: streamed to the client, nothing kept', async () => {
    const x = setup({ paused: true });
    const e = x.add(1);
    const { fetch } = x.fetcher.get(e, { priority: 'high' });
    const c = collector();
    fetch.attach(c.w, () => undefined);
    await fetch.done;
    expect(c.bytes()).toEqual(x.files.get(e.path));
    expect(x.cache.has(e.id)).toBe(false);
    expect(existsSync(x.cache.partPath(e.id))).toBe(false);
    expect(x.written).toEqual([]);
  });

  it('disk paused and the client leaves: the download is aborted, no outcome', async () => {
    const x = setup({ paused: true, delayMs: 3 });
    const e = x.add(1, 100_000);
    const { fetch } = x.fetcher.get(e, { priority: 'high' });
    const client = new PassThrough();
    let got = 0;
    client.on('data', (c: Buffer) => {
      got += c.length;
      if (got >= 20_000) client.destroy();
    });
    fetch.attach(client, () => undefined);
    await expect(fetch.done).rejects.toMatchObject({ name: 'AbortError' });
    expect(x.outcomes).toEqual([]);
  });

  it('a file bigger than the cap is streamed, not kept', async () => {
    const x = setup({ cap: 10_000 });
    const e = x.add(1);
    const { fetch } = x.fetcher.get(e, { priority: 'high' });
    const c = collector();
    fetch.attach(c.w, () => undefined);
    await fetch.done;
    expect(c.bytes()).toEqual(x.files.get(e.path));
    expect(x.cache.has(e.id)).toBe(false);
  });

  it('makes room in the cache before the fetch', async () => {
    const x = setup({ cap: 120_000 });
    const old = join(x.dir, 'old.mp4');
    writeFileSync(old, Buffer.alloc(100_000));
    utimesSync(old, new Date(0), new Date(0));
    const e = x.add(1);
    await x.fetcher.get(e, { priority: 'high' }).fetch.done;
    expect(existsSync(old)).toBe(false);
    expect(x.cache.has(e.id)).toBe(true);
  });

  it('a slow client slows the download (the tee waits for it)', async () => {
    const x = setup({ chunk: 16_384 });
    const e = x.add(1, 2_000_000);
    const { fetch } = x.fetcher.get(e, { priority: 'high' });
    const c = collector(16_384, 1);
    fetch.attach(c.w, () => undefined);
    await fetch.done;
    expect(x.dl.fullWrites()).toBeGreaterThan(0);
    expect(c.bytes()).toEqual(x.files.get(e.path));
  });

  it('stop fails queued fetches as offline', async () => {
    const x = setup({ gated: true });
    const [a, b] = [x.add(1), x.add(2)];
    x.fetcher.get(a, { priority: 'high' });
    await vi.waitFor(() => expect(x.dl.calls).toHaveLength(1));
    const fb = x.fetcher.get(b, { priority: 'high' }).fetch;
    x.fetcher.stop();
    await expect(fb.done).rejects.toMatchObject({ code: 'offline' });
    x.dl.release(a.path);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/recording-fetcher.test.ts`
Expected: FAIL (cannot find module `../src/recordings/fetcher`).

- [ ] **Step 3: Write `fetcher.ts`**

```ts
// src/recordings/fetcher.ts
// One download at a time per camera (spec "One download at a time per
// camera"): a second cmd 8 on the one connection would end the first, and a
// second connection would use more of the camera's 12 sessions. Two
// priorities: client requests are high; low is for background work (#74).
// The file goes into the cache (as .part, renamed when complete) and, through
// the tee, to the request that started it, while it arrives.
import { createWriteStream, mkdirSync, type WriteStream } from 'fs';
import { dirname } from 'path';
import { Writable } from 'stream';
import { finished } from 'stream/promises';
import { BaichuanError, type BaichuanErrorCode } from '../camera/baichuan/errors';
import type { RecordingCache } from './cache';
import type { RecordingEntry } from './list';
import type { Stream } from './names';

export type Priority = 'high' | 'low';
export type FetchResult = 'ok' | BaichuanErrorCode;
export interface FetchOutcome { id: string; at: number; result: FetchResult; stream: Stream; bytes: number; ms: number }
export interface FetcherDeps {
  cache: RecordingCache;
  download: (path: string, size: number, out: Writable) => Promise<number>;
  stillListed: (e: RecordingEntry) => Promise<boolean>;
  paused: () => boolean; // the disk is below its floor: stream without keeping
  noteWritten: (bytes: number) => void;
  onDone: (o: FetchOutcome) => void;
  now?: () => number;
}

export const abortError = (why = 'aborted'): Error => Object.assign(new Error(why), { name: 'AbortError' });
export const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError';

const drained = (w: Writable) =>
  new Promise<void>((resolve) => {
    const done = () => {
      w.off('drain', done);
      w.off('close', done);
      w.off('error', done);
      resolve();
    };
    w.on('drain', done);
    w.on('close', done);
    w.on('error', done);
  });

// Every chunk to the cache file and to the first client, waiting for both, so
// TCP slows the camera down. A client that leaves is dropped; with no file
// (disk paused) and no client left, the download is aborted.
class Tee extends Writable {
  private client: { res: Writable; onStart: () => void; started: boolean } | null = null;

  constructor(private readonly file: WriteStream | null) {
    super({ highWaterMark: 1024 * 1024 });
  }

  attach(res: Writable, onStart: () => void): void {
    if (res.destroyed) return;
    const c = { res, onStart, started: false };
    this.client = c;
    res.once('close', () => {
      if (this.client === c) this.client = null;
    });
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const c = this.client && !this.client.res.destroyed ? this.client : null;
    if (!this.file && !c) return cb(abortError('no reader left'));
    const waits: Promise<void>[] = [];
    if (this.file && !this.file.write(chunk)) waits.push(drained(this.file));
    if (c) {
      if (!c.started) {
        c.started = true;
        c.onStart();
      }
      if (!c.res.write(chunk)) waits.push(drained(c.res));
    }
    if (!waits.length) return cb();
    void Promise.all(waits).then(() => cb());
  }

  override _final(cb: (err?: Error | null) => void): void {
    const c = this.client;
    if (c?.started && !c.res.destroyed) c.res.end();
    if (!this.file) return cb();
    let called = false;
    const done = (err?: Error | null) => {
      if (called) return;
      called = true;
      cb(err);
    };
    this.file.once('error', done);
    this.file.end(() => done());
  }
}

export class Fetch {
  readonly done: Promise<void>;
  state: 'queued' | 'running' | 'done' = 'queued';
  live: { res: Writable; onStart: () => void } | null = null;
  private waiters = 0;
  private settle!: { resolve: () => void; reject: (e: unknown) => void };

  constructor(
    readonly entry: RecordingEntry,
    public priority: Priority,
    private readonly abandoned: (f: Fetch) => void,
  ) {
    this.done = new Promise<void>((resolve, reject) => (this.settle = { resolve, reject }));
    this.done.catch(() => undefined); // waiters handle it; no unhandled rejection
  }

  join(signal?: AbortSignal): void {
    this.waiters++;
    const leave = () => {
      this.waiters--;
      if (this.waiters === 0 && this.state === 'queued') this.abandoned(this);
    };
    if (signal?.aborted) return leave();
    signal?.addEventListener('abort', leave, { once: true });
  }

  attach(res: Writable, onStart: () => void): void {
    this.live = { res, onStart };
  }

  finish(err?: unknown): void {
    this.state = 'done';
    if (err) this.settle.reject(err);
    else this.settle.resolve();
  }
}

export class RecordingFetcher {
  private readonly byId = new Map<string, Fetch>();
  private readonly queue: Fetch[] = [];
  private active: Fetch | null = null;
  private stopped = false;

  constructor(private readonly d: FetcherDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  get(entry: RecordingEntry, o: { priority: Priority; signal?: AbortSignal }): { fetch: Fetch; created: boolean } {
    const known = this.byId.get(entry.id);
    if (known) {
      if (o.priority === 'high' && known.priority === 'low' && known.state === 'queued') {
        known.priority = 'high';
        this.sort();
      }
      known.join(o.signal);
      return { fetch: known, created: false };
    }
    const f = new Fetch(entry, o.priority, (x) => this.abandon(x));
    if (this.stopped) {
      f.finish(new BaichuanError('offline', 'the proxy is stopping'));
      return { fetch: f, created: true };
    }
    this.byId.set(entry.id, f);
    this.queue.push(f);
    this.sort();
    f.join(o.signal);
    // After the caller attached its response (same tick).
    queueMicrotask(() => this.pump());
    return { fetch: f, created: true };
  }

  queued(): string[] {
    return this.queue.map((f) => f.entry.id);
  }

  stop(): void {
    this.stopped = true;
    for (const f of this.queue.splice(0)) {
      this.byId.delete(f.entry.id);
      f.finish(new BaichuanError('offline', 'the proxy is stopping'));
    }
  }

  private sort(): void {
    const high = this.queue.filter((f) => f.priority === 'high');
    const low = this.queue.filter((f) => f.priority === 'low');
    this.queue.splice(0, this.queue.length, ...high, ...low);
  }

  private abandon(f: Fetch): void {
    const i = this.queue.indexOf(f);
    if (i < 0) return;
    this.queue.splice(i, 1);
    this.byId.delete(f.entry.id);
    f.finish(abortError('every request left while queued'));
  }

  private pump(): void {
    if (this.active || this.stopped) return;
    const f = this.queue.shift();
    if (!f) return;
    this.active = f;
    void this.run(f).finally(() => {
      this.active = null;
      this.pump();
    });
  }

  private async run(f: Fetch): Promise<void> {
    const { entry } = f;
    const t0 = this.now();
    f.state = 'running';
    const keep = !this.d.paused() && entry.size <= this.d.cache.capBytes();
    let file: WriteStream | null = null;
    if (keep) {
      this.d.cache.makeRoom(entry.size);
      const part = this.d.cache.partPath(entry.id);
      mkdirSync(dirname(part), { recursive: true });
      file = createWriteStream(part);
    }
    const tee = new Tee(file);
    tee.on('error', () => undefined); // reaches the download through its own listener
    file?.on('error', (e) => tee.destroy(e));
    if (f.live) tee.attach(f.live.res, f.live.onStart);
    let bytes = 0;
    try {
      bytes = await this.d.download(entry.path, entry.size, tee);
      tee.end();
      await finished(tee);
      if (file) {
        this.d.cache.commit(entry.id);
        this.d.noteWritten(entry.size);
      }
      this.byId.delete(entry.id);
      this.d.onDone({ id: entry.id, at: this.now(), result: 'ok', stream: entry.stream, bytes, ms: this.now() - t0 });
      f.finish();
    } catch (err) {
      tee.destroy();
      file?.destroy();
      if (file) this.d.cache.discard(entry.id);
      this.byId.delete(entry.id);
      if (isAbort(err)) return f.finish(err);
      let e = err instanceof BaichuanError ? err : new BaichuanError('protocol', 'the download failed');
      // A 400 for a file the list had: gone from the card, or refused?
      if (e.code === 'refused' && e.status === 400 && !(await this.d.stillListed(entry).catch(() => true))) {
        e = new BaichuanError('not_found', 'the camera no longer has the recording', 400);
      }
      this.d.onDone({ id: entry.id, at: this.now(), result: e.code, stream: entry.stream, bytes, ms: this.now() - t0 });
      f.finish(e);
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/recording-fetcher.test.ts`
Expected: PASS.

Run: `npm run lint:types`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/recordings/fetcher.ts test/recording-fetcher.test.ts
git commit
```
Subject: `feat(recordings): one download at a time, priorities, the tee to the first client`.

---

### Task 11: The recordings side, wired into the proxy

**Files:**
- Create: `src/recordings/side.ts`, `test/recordings-side.test.ts`
- Modify: `src/proxy.ts`, `src/api/control-api.ts` (`ControlDeps`, `/status`), `src/api/metrics.ts` (the download counter)

**Interfaces:**
- Consumes: Tasks 4-5 (`BaichuanSession`, `BaichuanTarget`, `SessionOptions`, `download`, `DownloadOptions`), 7 (`RecordingCache`), 9 (`RecordingList`), 10 (`RecordingFetcher`, `FetchOutcome`), 8 (`running.camera.baichuanPort`, `running.recordings.cacheMB`, `storage.noteWritten('recordings', …)`, Storage's `recordingsBusy`).
- Produces:
  - `interface RecordingsStatus { last: { at: number; result: string; stream: Stream; bytes: number; ms: number } | null; cache: { bytes: number; files: number; capBytes: number } }`
  - `interface RecordingsSide { list: RecordingList; cache: RecordingCache; fetcher: RecordingFetcher; session: BaichuanSession; paused(): boolean; status(): RecordingsStatus; reset(): void; stop(): void }`
  - `function createRecordingsSide(d: RecordingsDeps): RecordingsSide` with `RecordingsDeps { dataDir: string; cam: () => string; target: () => BaichuanTarget; capBytes: () => number; search: (param: object) => Promise<unknown>; timeInfo: () => Promise<TimeInfo>; paused: () => boolean; noteWritten: (bytes: number) => void; onDownload?: (o: FetchOutcome) => void; session?: SessionOptions; vod?: DownloadOptions }`
  - `Proxy.recordings: RecordingsSide`
  - `ControlDeps.recordings: () => RecordingsStatus`; `/control/status` answers `recordings`
  - metrics: `onRecordingDownload(o: { stream: string; result: string }): void`; `camproxy_recording_downloads_total{cam,stream,result}`

- [ ] **Step 1: Write the failing test (against cam-sim)**

```ts
// test/recordings-side.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { logBuffer } from '../src/log';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
let recDir: string;
const CACHED = 'RecS0A_DST20201001_211129_211207_0_5514C080000000_3E8.mp4';
const LEFTOVER = 'RecS0A_DST20201001_211300_211330_0_5514C080000000_3E8.mp4.part';

beforeAll(async () => {
  sim = await startSim();
  const dir = mkdtempSync(join(tmpdir(), 'camproxy-recside-'));
  recDir = join(dir, 'data', 'recordings', 'cam1');
  mkdirSync(recDir, { recursive: true });
  writeFileSync(join(recDir, CACHED), Buffer.alloc(1000));
  writeFileSync(join(recDir, LEFTOVER), Buffer.alloc(10));
  p = await startProxy(sim, { dir });
  await until(() => p.proxy.status.state().online, 15_000);
}, 30_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('the recordings side', () => {
  it('deletes leftover .part files at start and reports the cache in /control/status', async () => {
    expect(existsSync(join(recDir, LEFTOVER))).toBe(false);
    const st = await request(p.base).get('/control/status').set(auth(ADMIN_TOKEN));
    expect(st.body.recordings).toEqual({ last: null, cache: { bytes: 1000, files: 1, capBytes: 2048 * 2 ** 20 } });
  });

  it('downloads a recording from cam-sim over Baichuan into the cache, and records the result', async () => {
    const rec = sim.sim.engine.sd.all().find((r) => r.end !== null)!;
    const id = basename(rec.files.sub.name);
    const entry = await p.proxy.recordings.list.find(id);
    expect(entry?.path).toBe(rec.files.sub.name);
    await p.proxy.recordings.fetcher.get(entry!, { priority: 'high' }).fetch.done;
    expect(p.proxy.recordings.cache.has(id)).toBe(true);
    const st = await request(p.base).get('/control/status').set(auth(ADMIN_TOKEN));
    expect(st.body.recordings.last).toMatchObject({ result: 'ok', stream: 'sub', bytes: rec.files.sub.size });
    const m = await request(p.base).get('/metrics');
    expect(m.text).toContain('camproxy_recording_downloads_total{cam="cam1",stream="sub",result="ok"} 1');
    expect(m.text).toContain('camproxy_disk_bytes{kind="recordings"}');
    expect(p.proxy.recordings.session.connected()).toBe(true);
    // One info line per download: camera, id, stream, bytes, ms, result.
    const line = logBuffer.recent(500).find((l) => l.msg === 'recording_download' && l.id === id);
    expect(line).toMatchObject({ camera: 'cam1', stream: 'sub', bytes: rec.files.sub.size, result: 'ok' });
    expect(typeof line?.ms).toBe('number');
  });

  it('stop() closes the Baichuan session (a plain close)', async () => {
    await p.proxy.stop();
    expect(p.proxy.recordings.session.connected()).toBe(false);
    await until(() => sim.sim.engine.counters.baichuanSessions === 0);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/recordings-side.test.ts`
Expected: FAIL (`st.body.recordings` is undefined; `p.proxy.recordings` is undefined).

- [ ] **Step 3: Write `side.ts`**

```ts
// src/recordings/side.ts
// The recordings side (spec 2026-10-02-baichuan-recordings-design): the
// list (HTTP Search), the cache, the fetcher and the Baichuan session, plus
// the status line and one info log line per download.
import { join } from 'path';
import type { Writable } from 'stream';
import { BaichuanSession, type BaichuanTarget, type SessionOptions } from '../camera/baichuan/session';
import { download, type DownloadOptions } from '../camera/baichuan/vod';
import type { TimeInfo } from '../camera/time';
import { logger } from '../log';
import { RecordingCache } from './cache';
import { RecordingFetcher, type FetchOutcome } from './fetcher';
import { RecordingList } from './list';
import type { Stream } from './names';

export interface RecordingsStatus {
  last: { at: number; result: string; stream: Stream; bytes: number; ms: number } | null;
  cache: { bytes: number; files: number; capBytes: number };
}

export interface RecordingsSide {
  list: RecordingList;
  cache: RecordingCache;
  fetcher: RecordingFetcher;
  session: BaichuanSession;
  paused(): boolean;
  status(): RecordingsStatus;
  reset(): void; // the camera side restarted: a new session, fresh lists
  stop(): void;
}

export interface RecordingsDeps {
  dataDir: string;
  cam: () => string;
  target: () => BaichuanTarget;
  capBytes: () => number;
  search: (param: object) => Promise<unknown>;
  timeInfo: () => Promise<TimeInfo>;
  paused: () => boolean;
  noteWritten: (bytes: number) => void;
  onDownload?: (o: FetchOutcome) => void;
  session?: SessionOptions;
  vod?: DownloadOptions;
}

export function createRecordingsSide(d: RecordingsDeps): RecordingsSide {
  const session = new BaichuanSession(d.target, d.session);
  const cache = new RecordingCache({ dir: () => join(d.dataDir, 'recordings', d.cam()), capBytes: d.capBytes });
  cache.init();
  const list = new RecordingList({ search: d.search, timeInfo: d.timeInfo });
  let last: RecordingsStatus['last'] = null;
  const fetcher = new RecordingFetcher({
    cache,
    download: (path: string, size: number, out: Writable) => download(session, path, size, out, d.vod),
    stillListed: (e) => list.stillListed(e),
    paused: d.paused,
    noteWritten: d.noteWritten,
    onDone: (o) => {
      last = { at: o.at, result: o.result, stream: o.stream, bytes: o.bytes, ms: o.ms };
      logger.info({ camera: d.cam(), id: o.id, stream: o.stream, bytes: o.bytes, ms: o.ms, result: o.result }, 'recording_download');
      d.onDownload?.(o);
    },
  });
  return {
    list,
    cache,
    fetcher,
    session,
    paused: d.paused,
    status: () => ({ last, cache: { ...cache.usage(), capBytes: d.capBytes() } }),
    reset: () => {
      session.close();
      list.clear();
    },
    stop: () => {
      fetcher.stop();
      session.close();
    },
  };
}
```

- [ ] **Step 4: The counter, the status and the wiring**

`src/api/metrics.ts`, with the other counters:

```ts
  const recordingDownloads = new Counter({ name: 'camproxy_recording_downloads_total', help: 'Recording downloads over Baichuan, by result', labelNames: ['cam', 'stream', 'result'], registers: [registry] });
```

and in the returned object:

```ts
    onRecordingDownload: (o: { stream: string; result: string }) => recordingDownloads.inc({ cam: cam(), stream: o.stream, result: o.result }),
```

`src/api/control-api.ts`: `import type { RecordingsStatus } from '../recordings/side';`; in `ControlDeps` after `stream: …`:

```ts
  recordings: () => RecordingsStatus; // SD recordings over Baichuan: the last download, the cache
```

and in `r.get('/status', …)` after `ftp: d.ftp(),`:

```ts
      recordings: d.recordings(),
```

`src/proxy.ts`:
- Import: `import { createRecordingsSide, type RecordingsSide } from './recordings/side';`
- `Proxy` interface: add `readonly recordings: RecordingsSide;` after `readonly clips: …`.
- The Storage line becomes:
  ```ts
  // A recording being read is never deleted (set once the recordings side exists).
  let recordingBusy: (path: string) => boolean = () => false;
  const storage = new Storage({ catalog, log, config: () => running, audit, recordingsBusy: (p) => recordingBusy(p) });
  ```
- Right after `buildCameraSide();`:
  ```ts
  // Recordings on the camera's SD card (spec 2026-10-02-baichuan-recordings-design):
  // listed by HTTP Search, fetched over Baichuan (host from camera.host,
  // camera.baichuanPort read at every connection) into the cache.
  const recordings = createRecordingsSide({
    dataDir: running.server.dataDir,
    cam: () => running.camera.id,
    target: () => ({ host: splitHost(running.camera.host).hostname.replace(/^\[(.*)\]$/, '$1'), port: running.camera.baichuanPort, user: running.camera.user, password: loaded.secrets.cameraPassword }),
    capBytes: () => running.recordings.cacheMB * 2 ** 20,
    search: (param) => client.command('Search', param),
    timeInfo: () => client.timeInfo(),
    paused: () => storage.paused(),
    noteWritten: (bytes) => storage.noteWritten('recordings', bytes, 1),
    onDownload: (o) => metrics.onRecordingDownload({ stream: o.stream, result: o.result }),
  });
  recordingBusy = (p) => recordings.cache.busy(p);
  ```
- The rate limiter's `IMAGE` pattern also covers recording files (a seeking player sends many Range requests):
  ```ts
  const IMAGE = /^\/api\/cameras\/[^/]+\/((stills|previews)\/\d{1,15}\.jpg|clips\/\d{1,15}\.(mp4|jpg)|recordings\/Rec[0-9A-Za-z_]+\.mp4|events\/\d{1,15}\/analysis\.jpg)$/;
  ```
- `controlApi({ … })`: add `recordings: () => recordings.status(),` after `stream: …`.
- `restartCameraSide`: after `await client.logout();` add `recordings.reset();`.
- The `proxy` object: add `recordings,` after the `clips` getter.
- `doStop`: after `await clips?.stop();` add `recordings.stop();`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/recordings-side.test.ts test/control-api.test.ts test/proxy.test.ts test/proxy-restart.test.ts`
Expected: PASS.

Run: `npm run lint:types`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/recordings/side.ts src/proxy.ts src/api/control-api.ts src/api/metrics.ts test/recordings-side.test.ts
git commit
```
Subject: `feat(recordings): wire the recordings side: status, metric, stop`.

---

### Task 12: The recordings API

**Files:**
- Modify: `src/api/client-api.ts`, `src/proxy.ts` (`clientApi` deps), `openapi.yaml`
- Create: `test/recordings-api.test.ts`

**Interfaces:**
- Consumes: Task 11 (`RecordingsSide`), Task 9 (`RecordingEntry`, `SearchError`, `clipNear`), Task 10 (`isAbort`), Task 6 (`validId`), Task 2 (`BaichuanError`).
- Produces: `GET /api/cameras/:cam/recordings`, `GET /api/cameras/:cam/recordings/days`, `GET`/`HEAD /api/cameras/:cam/recordings/:id`; `clientApi` deps gain `recordings: () => RecordingsSide`.

- [ ] **Step 1: Write the failing tests (against cam-sim)**

```ts
// test/recordings-api.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { existsSync } from 'fs';
import { basename, join } from 'path';
import { startSim } from './helpers/sim';
import { auth, startProxy, until } from './helpers/proxy';
import { insertClip } from '../src/catalog/clips';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
type SimFile = { name: string; size: number };
let recs: { date: string; files: { sub: SimFile; main: SimFile } }[];
const HOUR = 3_600_000;
const url = (id: string) => `/api/cameras/cam1/recordings/${id}`;
const binary = (r: request.Test) =>
  r.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
const downloads = () => sim.sim.engine.counters.baichuanDownloads;
// The whole camera-local day of a recording, and the days around it (47 h).
const windowOf = (date: string) => {
  const from = Date.parse(`${date}T00:00:00Z`) - 12 * HOUR;
  return { from, to: from + 47 * HOUR };
};

beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
  await until(() => p.proxy.status.state().online, 15_000);
  recs = sim.sim.engine.sd.all().filter((r) => r.end !== null) as typeof recs;
  expect(recs.length).toBeGreaterThanOrEqual(5);
}, 30_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('GET /recordings (the list)', () => {
  it('lists the SD recordings of a window: times, stream, size, kinds, clipId; no camera path', async () => {
    const rec = recs[0];
    const { from, to } = windowOf(rec.date);
    const r = await request(p.base).get(`/api/cameras/cam1/recordings?from=${from}&to=${to}&stream=sub`).set(auth());
    expect(r.status).toBe(200);
    const item = r.body.find((x: { id: string }) => x.id === basename(rec.files.sub.name));
    expect(item).toMatchObject({ stream: 'sub', size: rec.files.sub.size, clipId: null });
    expect(item.kinds.length).toBeGreaterThan(0);
    expect(item.end).toBeGreaterThan(item.start);
    expect(Object.keys(item).sort()).toEqual(['clipId', 'end', 'id', 'kinds', 'size', 'start', 'stream']);
    const starts = r.body.map((x: { start: number }) => x.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    // The FTP copy: same stream, start within 5 s.
    const clip = insertClip(p.proxy.catalog, { cam: 'cam1', start_ts: item.start + 3000, end_ts: item.end, path: '/x.mp4', stream: 'sub', size: 1, received_at: item.end, snapshot: null });
    const again = await request(p.base).get(`/api/cameras/cam1/recordings?from=${from}&to=${to}&stream=sub`).set(auth());
    expect(again.body.find((x: { id: string }) => x.id === item.id).clipId).toBe(clip.id);
    const main = await request(p.base).get(`/api/cameras/cam1/recordings?from=${from}&to=${to}&stream=main`).set(auth());
    expect(main.body.map((x: { id: string }) => x.id)).toContain(basename(rec.files.main.name));
  });

  it('checks the query: from/to required and ordered, at most 48 hours, stream sub or main; unknown camera 404', async () => {
    const get = (q: string, cam = 'cam1') => request(p.base).get(`/api/cameras/${cam}/recordings${q}`).set(auth());
    const T = Date.now();
    for (const q of ['', `?from=${T}&stream=sub`, `?from=${T}&to=${T - 1}&stream=sub`, `?from=${T}&to=${T + 48 * HOUR + 1}&stream=sub`, `?from=${T}&to=${T + 1}`, `?from=${T}&to=${T + 1}&stream=hd`]) {
      const r = await get(q);
      expect(r.status, q).toBe(400);
      expect(r.body.error).toBe('invalid');
    }
    expect((await get(`?from=${T}&to=${T + 48 * HOUR}&stream=sub`)).status).toBe(200);
    expect((await get(`?from=${T}&to=${T + 1}&stream=sub`, 'nope')).body).toEqual({ error: 'not_found' });
  });
});

describe('GET /recordings/days', () => {
  it('the days of a camera-local month with recordings; a bad month is 400 (and /days is not taken for an id)', async () => {
    const month = recs[0].date.slice(0, 7);
    const r = await request(p.base).get(`/api/cameras/cam1/recordings/days?month=${month}`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body.month).toBe(month);
    expect(r.body.days).toContain(Number(recs[0].date.slice(8, 10)));
    expect((await request(p.base).get('/api/cameras/cam1/recordings/days?month=2026-13').set(auth())).status).toBe(400);
    expect((await request(p.base).get('/api/cameras/nope/recordings/days?month=2026-10').set(auth())).status).toBe(404);
  });
});

describe('GET /recordings/:id (the file)', () => {
  it('fetches over Baichuan and streams it: 200, length, ranges, immutable; then the cache serves it', async () => {
    const f = recs[0].files.sub;
    const id = basename(f.name);
    const before = downloads();
    const r = await binary(request(p.base).get(url(id)).set(auth()));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('video/mp4');
    expect(Number(r.headers['content-length'])).toBe(f.size);
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers['cache-control']).toBe('private, max-age=604800, immutable');
    const body = r.body as Buffer;
    expect(body.length).toBe(f.size);
    expect(body.subarray(4, 8).toString()).toBe('ftyp');
    expect(downloads()).toBe(before + 1);
    expect(existsSync(join(p.dir, 'data', 'recordings', 'cam1', id))).toBe(true);
    // From the cache: no new transfer, Range, and 416.
    const again = await binary(request(p.base).get(url(id)).set(auth()));
    expect(again.body).toEqual(body);
    const part = await binary(request(p.base).get(url(id)).set(auth()).set('Range', 'bytes=0-99'));
    expect(part.status).toBe(206);
    expect(part.body).toEqual(body.subarray(0, 100));
    const bad = await request(p.base).get(url(id)).set(auth()).set('Range', `bytes=${f.size}-`);
    expect(bad.status).toBe(416);
    expect(bad.headers['content-range']).toBe(`bytes */${f.size}`);
    expect(downloads()).toBe(before + 1);
  });

  it('HEAD of a file not cached answers from the list, without a transfer', async () => {
    const f = recs[0].files.main;
    const before = downloads();
    const r = await request(p.base).head(url(basename(f.name))).set(auth());
    expect(r.status).toBe(200);
    expect(Number(r.headers['content-length'])).toBe(f.size);
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(downloads()).toBe(before);
  });

  it('a Range request for a file not yet cached waits for the fetch, then is served from the cache', async () => {
    const f = recs[0].files.main;
    const id = basename(f.name);
    const part = await binary(request(p.base).get(url(id)).set(auth()).set('Range', 'bytes=10-19'));
    expect(part.status).toBe(206);
    const whole = await binary(request(p.base).get(url(id)).set(auth()));
    expect(part.body).toEqual((whole.body as Buffer).subarray(10, 20));
  });

  it('two requests for one id at once: one transfer', async () => {
    const f = recs[1].files.sub;
    const before = downloads();
    const [a, b] = await Promise.all([binary(request(p.base).get(url(basename(f.name))).set(auth())), binary(request(p.base).get(url(basename(f.name))).set(auth()))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body).toEqual(b.body);
    expect(downloads()).toBe(before + 1);
  });

  // Review Focus 5.
  it('odd ids never reach the camera: 400 for a bad id, 404 for one the card does not have', async () => {
    const id = basename(recs[0].files.sub.name);
    const before = downloads();
    const cases: [string, number][] = [
      [`%2E%2E%2F${id}`, 400],
      [id.replace('.mp4', '.MP4'), 400],
      [`RecS0A_DST20261001_211129_211207_0_${'A'.repeat(90)}.mp4`, 400], // 129 characters
      ['RecS0A_DST20261340_211129_211207_0_5514C080000000_3E8.mp4', 404], // no such date
      ['RecS0A_DST20200101_211129_211207_0_5514C080000000_3E8.mp4', 404], // not on the card
    ];
    for (const [c, status] of cases) {
      const r = await request(p.base).get(url(c)).set(auth());
      expect(r.status, c).toBe(status);
      if (status === 404) expect(r.body).toEqual({ error: 'unknown_recording' });
    }
    expect((await request(p.base).get('/api/cameras/nope/recordings/' + id).set(auth())).body).toEqual({ error: 'not_found' });
    expect(downloads()).toBe(before);
  });

  it('HTTP Download refused (downloads.refuse) while Baichuan works', async () => {
    sim.sim.engine.faults.set({ name: 'downloads.refuse' });
    try {
      const f = recs[2].files.sub;
      const r = await binary(request(p.base).get(url(basename(f.name))).set(auth()));
      expect(r.status).toBe(200);
      expect((r.body as Buffer).length).toBe(f.size);
    } finally {
      sim.sim.engine.faults.clear('downloads.refuse');
    }
  });

  it('camera offline: the list and an uncached file answer 503, a cached file is still served', async () => {
    const cached = basename(recs[0].files.sub.name);
    const uncached = basename(recs[3].files.sub.name);
    const { from, to } = windowOf(recs[0].date);
    sim.sim.engine.faults.set({ name: 'offline' });
    try {
      await p.proxy.status.checkNow();
      await p.proxy.status.checkNow();
      expect(p.proxy.status.state().online).toBe(false);
      expect((await request(p.base).get(`/api/cameras/cam1/recordings?from=${from}&to=${to}&stream=sub`).set(auth())).body).toEqual({ error: 'camera_offline' });
      expect((await request(p.base).get(`/api/cameras/cam1/recordings/days?month=${recs[0].date.slice(0, 7)}`).set(auth())).status).toBe(503);
      const r = await request(p.base).get(url(uncached)).set(auth());
      expect([r.status, r.body]).toEqual([503, { error: 'camera_offline' }]);
      expect((await request(p.base).get(url(cached)).set(auth())).status).toBe(200);
    } finally {
      sim.sim.engine.faults.clear('offline');
      await p.proxy.status.checkNow();
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/recordings-api.test.ts`
Expected: FAIL (404 for every recordings route).

- [ ] **Step 3: Write the routes**

`src/api/client-api.ts`, imports:

```ts
import { clipById, clipNear, listClips, oldestClip, overlappingEvents, type ClipRow } from '../catalog/clips';
import { BaichuanError } from '../camera/baichuan/errors';
import { logger } from '../log';
import { isAbort } from '../recordings/fetcher';
import { SearchError, type RecordingEntry } from '../recordings/list';
import { validId } from '../recordings/names';
import type { RecordingsSide } from '../recordings/side';
```

The deps: `export function clientApi(d: { config: () => Config; catalog: Catalog; status: () => StatusPoller; sse: SseHandler; stills: () => StillsSide | undefined; recordings: () => RecordingsSide }): express.Router {`

After the clips routes, before `r.get('/stream', d.sse);`:

```ts
  // Recordings on the camera's SD card (spec 2026-10-02-baichuan-recordings-design):
  // listed by HTTP Search, fetched over Baichuan into the cache. /days is
  // registered before /:id.
  const IMMUTABLE = 'private, max-age=604800, immutable';
  const online = () => d.status().state().online;
  const offline = (res: Response) => void res.status(503).json({ error: 'camera_offline' });
  // `detail` is for people: never a path, a password or a key.
  const recordingError = (res: Response, err: unknown): void => {
    if (res.headersSent || isAbort(err)) return void res.destroy();
    if (err instanceof SearchError) {
      if (err.code === 'camera_offline') return offline(res);
      return void res.status(502).json({ error: 'recordings_unavailable', reason: 'search_failed', detail: err.message });
    }
    if (err instanceof BaichuanError) {
      if (err.code === 'offline') return offline(res);
      if (err.code === 'not_found') return void res.status(404).json({ error: 'unknown_recording' });
      return void res.status(502).json({ error: 'recordings_unavailable', reason: err.code, detail: err.message });
    }
    logger.error({ err: (err as Error).message }, 'recording_request_failed');
    res.status(500).json({ error: 'internal' });
  };
  const fileHeaders = (res: Response, size: number) => {
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', IMMUTABLE);
  };
  // From the cache, like clip files (Range, 416); pinned while it is read.
  const serveCached = (res: Response, side: RecordingsSide, id: string): boolean => {
    const unpin = side.cache.open(id);
    if (!unpin) return false;
    res.on('close', unpin);
    res.setHeader('Cache-Control', IMMUTABLE);
    res.sendFile(resolve(side.cache.path(id)), { cacheControl: false, acceptRanges: true, dotfiles: 'allow', headers: { 'Content-Type': 'video/mp4' } }, (err) => {
      unpin();
      if (!err || res.headersSent) return;
      const status = (err as { status?: number }).status;
      if (status === 416) return void res.status(416).end(); // carries Content-Range: bytes */size
      res.status(status === 404 ? 404 : 500).json({ error: status === 404 ? 'unknown_recording' : 'internal' });
    });
    return true;
  };

  r.get('/cameras/:cam/recordings', async (req, res) => {
    if (!known(req, res)) return;
    const from = intParam(req.query.from), to = intParam(req.query.to);
    if (from === undefined || to === undefined || from === null || to === null) return bad(res, 'from and to (unix ms) are required');
    if (to < from) return bad(res, 'to is before from');
    if (to - from > 2 * DAY) return bad(res, 'at most 48 hours per request');
    const stream = req.query.stream;
    if (stream !== 'sub' && stream !== 'main') return bad(res, 'stream is sub or main');
    if (!online()) return offline(res);
    try {
      const list = await d.recordings().list.range(from, to, stream);
      res.json(list.map((e) => ({ id: e.id, start: e.start, end: e.end, stream: e.stream, size: e.size, kinds: e.kinds, clipId: clipNear(d.catalog, cam().id, e.stream, e.start, 5000)?.id ?? null })));
    } catch (err) {
      recordingError(res, err);
    }
  });

  r.get('/cameras/:cam/recordings/days', async (req, res) => {
    if (!known(req, res)) return;
    const month = typeof req.query.month === 'string' ? req.query.month : '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return bad(res, 'month is YYYY-MM');
    if (!online()) return offline(res);
    try {
      res.json({ month, days: await d.recordings().list.monthDays(month) });
    } catch (err) {
      recordingError(res, err);
    }
  });

  // GET and HEAD (Express answers HEAD with this route).
  r.get('/cameras/:cam/recordings/:id', async (req, res) => {
    if (!known(req, res)) return;
    const id = req.params.id;
    if (!validId(id)) return bad(res, 'not a recording id');
    const side = d.recordings();
    if (serveCached(res, side, id)) return; // the cache needs no camera
    if (!online()) return offline(res);
    let entry: RecordingEntry | undefined;
    try {
      entry = await side.list.find(id); // the camera path comes from Search, never from the request
    } catch (err) {
      return recordingError(res, err);
    }
    if (!entry) return void res.status(404).json({ error: 'unknown_recording' });
    if (serveCached(res, side, id)) return;
    const size = entry.size;
    if (req.method === 'HEAD') {
      fileHeaders(res, size);
      return void res.status(200).end();
    }
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    // The plain GET that starts a fetch streams the file as it arrives; a
    // Range request, or a second request, waits and is served from the cache.
    for (let attempt = 0; attempt < 2; attempt++) {
      const { fetch, created } = side.fetcher.get(entry, { priority: 'high', signal: ac.signal });
      const live = created && (!req.headers.range || side.paused() || attempt > 0);
      if (live) fetch.attach(res, () => (res.status(200), fileHeaders(res, size)));
      try {
        await fetch.done;
      } catch (err) {
        if (res.headersSent || res.destroyed) return void res.destroy(); // a short body: the client sees the failure
        if (isAbort(err) && attempt === 0) continue; // the fetch it joined was abandoned: start one
        return recordingError(res, err);
      }
      if (res.headersSent || res.destroyed) return;
      if (serveCached(res, side, id)) return;
    }
    recordingError(res, new BaichuanError('protocol', 'the recording could not be kept or streamed'));
  });
```

`src/proxy.ts`: `clientApi({ config: () => running, catalog, status: () => status, sse, stills: () => stills, recordings: () => recordings })`.

`openapi.yaml`, after the `/api/cameras/{cam}/clips/{file}` block:

```yaml
  /api/cameras/{cam}/recordings:
    get:
      summary: The camera's SD-card recordings that overlap a time range (at most 48 hours), by start
      parameters:
        - { name: cam, in: path, required: true, schema: { type: string } }
        - { name: from, in: query, required: true, schema: { type: integer }, description: unix ms }
        - { name: to, in: query, required: true, schema: { type: integer }, description: unix ms }
        - { name: stream, in: query, required: true, schema: { type: string, enum: [sub, main] } }
      responses:
        '200': { description: '[{id (the camera file name), start, end (unix ms), stream, size (bytes), kinds (person, vehicle, pet, motion), clipId (the FTP copy: same stream, start within 5 s; or null)}]; recordings still being written are left out' }
        '400': { description: '{error: invalid, detail}: from/to missing or reversed, more than 48 hours apart, or stream not sub/main' }
        '404': { description: unknown camera }
        '502': { description: '{error: recordings_unavailable, reason: search_failed, detail}' }
        '503': { description: '{error: camera_offline}' }
  /api/cameras/{cam}/recordings/days:
    get:
      summary: The days of a camera-local month that have recordings (the camera's month Search, kept 5 minutes)
      parameters:
        - { name: cam, in: path, required: true, schema: { type: string } }
        - { name: month, in: query, required: true, schema: { type: string }, description: YYYY-MM }
      responses:
        '200': { description: '{ month, days: [day of month] }' }
        '400': { description: not YYYY-MM }
        '404': { description: unknown camera }
        '502': { description: '{error: recordings_unavailable, reason: search_failed, detail}' }
        '503': { description: '{error: camera_offline}' }
  /api/cameras/{cam}/recordings/{id}:
    get:
      summary: A recording as MP4 (HTTP Range; HEAD too). Fetched from the camera over Baichuan on the first request and streamed while it arrives; later and Range requests come from the cache
      parameters:
        - { name: cam, in: path, required: true, schema: { type: string } }
        - { name: id, in: path, required: true, schema: { type: string }, description: 'the file name from the list, e.g. RecS0A_DST20261001_211129_211207_0_5514C080000000_108CE9.mp4' }
        - { name: Range, in: header, schema: { type: string }, description: 'e.g. bytes=0-1023' }
      responses:
        '200': { description: 'video/mp4; Content-Length, Accept-Ranges: bytes; cached as immutable. A failure after the headers ends the body short' }
        '206': { description: the requested range, with Content-Range }
        '400': { description: '{error: invalid, detail}: not a recording id' }
        '404': { description: '{error: unknown_recording} (or not_found: unknown camera)' }
        '416': { description: 'range not satisfiable (Content-Range: bytes */size)' }
        '502': { description: '{error: recordings_unavailable, reason (refused, auth, timeout, protocol, search_failed), detail}' }
        '503': { description: '{error: camera_offline}' }
```

In the `/control/status` description, after the `ftp: {…}` part, add `, recordings: {last: {at, result (ok, offline, refused, auth, timeout, protocol, not_found), stream, bytes, ms} or null, cache: {bytes, files, capBytes}}`; in `/control/stats`, `disk: {catalog, stills, previews, clips, recordings}`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/recordings-api.test.ts test/openapi.test.ts test/clips-api.test.ts`
Expected: PASS.

Run: `npm run lint:types`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/api/client-api.ts src/proxy.ts openapi.yaml test/recordings-api.test.ts
git commit
```
Subject: `feat(recordings): the recordings API (list, month days, files with Range)`.

---

### Task 13: cam-sim's Baichuan faults, end to end

**Files:**
- Create: `test/recordings-faults.test.ts`

**Interfaces:**
- Consumes: Tasks 11-12 (`p.proxy.recordings`, the routes); cam-sim faults and counters (see "Assumed cam-sim API").
- Produces: tests only. If a test here fails, the fix goes into the module that owns the behaviour (session, vod, fetcher or route), with a unit test there too.

- [ ] **Step 1: Write the tests**

```ts
// test/recordings-faults.test.ts
// Every cam-sim Baichuan fault through the proxy (spec "Integration").
// Each test takes recordings no earlier test fetched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import net from 'net';
import request from 'supertest';
import { existsSync, readdirSync } from 'fs';
import { basename, join } from 'path';
import { startSim } from './helpers/sim';
import { ADMIN_TOKEN, auth, startProxy, until } from './helpers/proxy';

let sim: Awaited<ReturnType<typeof startSim>>;
let p: Awaited<ReturnType<typeof startProxy>>;
type SimFile = { name: string; size: number };
let files: SimFile[];
let next = 0;
const fresh = () => files[next++];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const faults = () => sim.sim.engine.faults;
const counters = () => sim.sim.engine.counters;
const cacheDir = () => join(p.dir, 'data', 'recordings', 'cam1');

// A GET that also reports a body cut short (the proxy destroys the response).
function grab(path: string, o: { abortAfterBytes?: number } = {}): Promise<{ status: number; body: Buffer; complete: boolean }> {
  return new Promise((resolve) => {
    const req = http.get(`${p.base}${path}`, { headers: auth() }, (res) => {
      const parts: Buffer[] = [];
      let n = 0;
      const done = (complete: boolean) => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts), complete });
      res.on('data', (c: Buffer) => {
        parts.push(c);
        n += c.length;
        if (o.abortAfterBytes !== undefined && n >= o.abortAfterBytes) {
          req.destroy();
          done(false);
        }
      });
      res.on('end', () => done(res.complete));
      res.on('error', () => done(false));
      res.on('close', () => done(res.complete));
    });
    req.on('error', () => resolve({ status: 0, body: Buffer.alloc(0), complete: false }));
  });
}
const fileUrl = (f: SimFile) => `/api/cameras/cam1/recordings/${basename(f.name)}`;
const lastResult = async () => (await request(p.base).get('/control/status').set(auth(ADMIN_TOKEN))).body.recordings.last?.result;

beforeAll(async () => {
  sim = await startSim();
  p = await startProxy(sim);
  await until(() => p.proxy.status.state().online, 15_000);
  // Main files first: the largest, for the faults that need a transfer in flight.
  const recs = sim.sim.engine.sd.all().filter((r) => r.end !== null) as { files: { sub: SimFile; main: SimFile } }[];
  files = [...recs.map((r) => r.files.main), ...recs.map((r) => r.files.sub)];
  expect(files.length).toBeGreaterThanOrEqual(10); // 7 fresh ones, plus the last two
}, 30_000);
afterAll(async () => {
  await p.proxy.stop();
  await sim.close();
});

describe('Baichuan faults through the proxy', () => {
  it('baichuan.refuse: 502 refused (the camera still lists it); the status and the counter say so', async () => {
    const f = files[files.length - 1]; // not fetched here; a later test may still use it
    faults().set({ name: 'baichuan.refuse' });
    try {
      const r = await request(p.base).get(fileUrl(f)).set(auth());
      expect(r.status).toBe(502);
      expect(r.body).toMatchObject({ error: 'recordings_unavailable', reason: 'refused' });
      expect(r.body.detail).not.toContain('/mnt/');
      expect(await lastResult()).toBe('refused');
      expect((await request(p.base).get('/metrics')).text).toContain('result="refused"} 1');
    } finally {
      faults().clear('baichuan.refuse');
    }
  });

  it('baichuan.dropMidway: the body ends short, nothing stays in the cache; the next request works', async () => {
    const f = fresh();
    faults().set({ name: 'baichuan.dropMidway' });
    const r = await grab(fileUrl(f)).finally(() => faults().clear('baichuan.dropMidway'));
    expect(r.complete).toBe(false);
    expect(r.body.length).toBeLessThan(f.size);
    expect(readdirSync(cacheDir()).filter((n) => n.startsWith(basename(f.name)))).toEqual([]);
    const ok = await grab(fileUrl(f));
    expect([ok.status, ok.complete, ok.body.length]).toEqual([200, true, f.size]);
  });

  it('baichuan.delayMs: a slow transfer completes', async () => {
    const f = files[files.length - 2]; // a sub file
    faults().set({ name: 'baichuan.delayMs', ms: 10 });
    try {
      const r = await grab(fileUrl(f));
      expect([r.status, r.complete, r.body.length]).toEqual([200, true, f.size]);
    } finally {
      faults().clear('baichuan.delayMs');
    }
  });

  it('pushes right after login do not disturb a download', async () => {
    p.proxy.recordings.session.close();
    const f = fresh();
    const r = await grab(fileUrl(f));
    expect([r.status, r.complete, r.body.length]).toEqual([200, true, f.size]);
    expect(r.body.subarray(4, 8).toString()).toBe('ftyp');
  });

  it('an abort mid-transfer (disk paused, client gone) sends cmd 9; stale chunks are dropped and the next download on the same session is whole', async () => {
    const big = fresh();
    const after = fresh();
    p.proxy.running.storage.minFreeBytes = Number.MAX_SAFE_INTEGER;
    p.proxy.storage.check();
    faults().set({ name: 'baichuan.delayMs', ms: 20 });
    try {
      const cut = await grab(fileUrl(big), { abortAfterBytes: 1 });
      expect(cut.complete).toBe(false);
      await sleep(300); // the abort reaches the camera, chunks still in flight arrive
    } finally {
      faults().clear('baichuan.delayMs');
      p.proxy.running.storage.minFreeBytes = 0;
      p.proxy.storage.check();
    }
    const logins = counters().baichuanLogins;
    const r = await grab(fileUrl(after));
    expect([r.status, r.complete, r.body.length]).toEqual([200, true, after.size]);
    expect(counters().baichuanLogins).toBe(logins); // the same session
    expect(existsSync(join(cacheDir(), basename(big.name)))).toBe(false);
  });

  it('a session the camera closed while idle (its 32 s drop) is replaced at the next request', async () => {
    await grab(fileUrl(files[files.length - 2])); // cached: no session needed, but make sure one is open
    if (!p.proxy.recordings.session.connected()) await p.proxy.recordings.session.ensure();
    const logins = counters().baichuanLogins;
    faults().set({ name: 'offline' }); // drops the Baichuan connections
    try {
      await until(() => !p.proxy.recordings.session.connected(), 5000);
    } finally {
      faults().clear('offline');
    }
    const f = fresh();
    const r = await grab(fileUrl(f));
    expect([r.status, r.complete, r.body.length]).toEqual([200, true, f.size]);
    expect(counters().baichuanLogins).toBe(logins + 1);
  });

  it('baichuan.sessionLimit: a connection over the limit is reset at its first message: 502 refused; it works once one closes', async () => {
    p.proxy.recordings.session.close();
    await until(() => counters().baichuanSessions === 0);
    faults().set({ name: 'baichuan.sessionLimit', max: 1 });
    const hold = net.connect({ host: '127.0.0.1', port: sim.camera.baichuanPort });
    await new Promise((r) => hold.once('connect', r));
    const f = fresh();
    try {
      await sleep(50);
      const r = await request(p.base).get(fileUrl(f)).set(auth());
      expect(r.status).toBe(502);
      expect(r.body.reason).toBe('refused');
    } finally {
      hold.destroy();
      faults().clear('baichuan.sessionLimit');
    }
    await sleep(100);
    const ok = await grab(fileUrl(f));
    expect([ok.status, ok.complete]).toEqual([200, true]);
  });

  // Last: after a rejected login the session waits 15 s before the next attempt.
  it('baichuan.loginFail: 502 auth; within 15 s the next request fails fast without another login', async () => {
    p.proxy.recordings.session.close();
    faults().set({ name: 'baichuan.loginFail', count: 1 }); // only the first login is rejected
    const f = fresh();
    try {
      const a = await request(p.base).get(fileUrl(f)).set(auth());
      expect([a.status, a.body.reason]).toEqual([502, 'auth']);
      const t0 = Date.now();
      const b = await request(p.base).get(fileUrl(f)).set(auth());
      expect([b.status, b.body.reason]).toEqual([502, 'auth']); // the camera would accept it now: the guard answered
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(await lastResult()).toBe('auth');
    } finally {
      faults().clear('baichuan.loginFail');
    }
  });
});
```

- [ ] **Step 2: Run them**

Run: `npx vitest run test/recordings-faults.test.ts`
Expected: PASS. A failure is a real gap in an earlier task: fix it in that task's module and add a unit test there that reproduces it (for example a fake-camera case in `test/baichuan-vod.test.ts`), then run this file again.

- [ ] **Step 3: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/recordings-faults.test.ts
git commit
```
Subject: `test(recordings): every cam-sim Baichuan fault through the proxy`. (Add the files of any fix from Step 2 to the same commit, or to a `fix(…)` commit before it.)

---

### Task 14: The Status page line

**Files:**
- Create: `web/src/lib/recordings.ts`
- Modify: `web/src/lib/state.ts` (`Status.recordings`), `web/src/pages/Status.svelte`, `test/status-ui.test.ts`

**Interfaces:**
- Consumes: `/control/status` `recordings` (Task 11).
- Produces:
  - `interface RecordingsLast { at: number; result: string; stream: 'main' | 'sub'; bytes: number; ms: number }`
  - `interface RecordingsStatus { last: RecordingsLast | null; cache: { bytes: number; files: number; capBytes: number } }`
  - `function recordingsLastText(last: RecordingsLast | null, now?: number): string`
  - `function recordingsClass(last: RecordingsLast | null): '' | 'ok' | 'bad'`
  - `function cacheFillText(c: RecordingsStatus['cache']): string`

- [ ] **Step 1: Write the failing tests**

Add to `test/status-ui.test.ts`:

```ts
import { cacheFillText, recordingsClass, recordingsLastText } from '../web/src/lib/recordings';

describe('Status page: recordings (SD card)', () => {
  const NOW = Date.UTC(2026, 9, 2, 12, 0);
  const MB = 1024 ** 2;
  it('the last download: result and when; size and time when it worked; — before the first', () => {
    expect(recordingsLastText(null, NOW)).toBe('—');
    expect(recordingsLastText({ at: NOW - 120_000, result: 'ok', stream: 'sub', bytes: 1_084_649, ms: 310 }, NOW)).toBe('ok, 2 min ago (sub, 1.0 MB in 0.3 s)');
    expect(recordingsLastText({ at: NOW - 3 * 3600_000, result: 'refused', stream: 'main', bytes: 0, ms: 40 }, NOW)).toBe('refused, 3 h ago');
    expect(recordingsLastText({ at: NOW - 5_000, result: 'auth', stream: 'main', bytes: 0, ms: 1 }, NOW)).toBe('auth, 5 s ago');
  });
  it('green for ok, red otherwise, plain before the first', () => {
    expect(recordingsClass(null)).toBe('');
    expect(recordingsClass({ at: NOW, result: 'ok', stream: 'sub', bytes: 1, ms: 1 })).toBe('ok');
    expect(recordingsClass({ at: NOW, result: 'timeout', stream: 'sub', bytes: 1, ms: 1 })).toBe('bad');
  });
  it('the cache fill, in MB', () => {
    expect(cacheFillText({ bytes: 312 * MB + 1000, files: 9, capBytes: 2048 * MB })).toBe('312 MB of 2048 MB');
    expect(cacheFillText({ bytes: 0, files: 0, capBytes: 64 * MB })).toBe('0 MB of 64 MB');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/status-ui.test.ts`
Expected: FAIL (cannot find module `../web/src/lib/recordings`).

- [ ] **Step 3: Write the helpers and the card**

```ts
// web/src/lib/recordings.ts
// The Status page's "Recordings (SD card)" card (spec: the last Baichuan
// result and when; the cache fill).
export interface RecordingsLast { at: number; result: string; stream: 'main' | 'sub'; bytes: number; ms: number }
export interface RecordingsStatus { last: RecordingsLast | null; cache: { bytes: number; files: number; capBytes: number } }

const MB = 1024 ** 2;

function agoText(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

export function recordingsLastText(last: RecordingsLast | null, now = Date.now()): string {
  if (!last) return '—';
  const head = `${last.result}, ${agoText(last.at, now)}`;
  return last.result === 'ok' ? `${head} (${last.stream}, ${(last.bytes / MB).toFixed(1)} MB in ${(last.ms / 1000).toFixed(1)} s)` : head;
}

export function recordingsClass(last: RecordingsLast | null): '' | 'ok' | 'bad' {
  if (!last) return '';
  return last.result === 'ok' ? 'ok' : 'bad';
}

export function cacheFillText(c: RecordingsStatus['cache']): string {
  return `${Math.round(c.bytes / MB)} MB of ${Math.round(c.capBytes / MB)} MB`;
}
```

`web/src/lib/state.ts`: `import type { RecordingsStatus } from './recordings';` and in `Status` after `ftp: …;` add `recordings?: RecordingsStatus;`.

`web/src/pages/Status.svelte`: in the script, `import { cacheFillText, recordingsClass, recordingsLastText } from '../lib/recordings';`; after the `card-ftp` card's closing `</div>`:

```svelte
      {#if $status.recordings}
        <div class="card" data-testid="card-recordings">
          <h3>Recordings (SD card)</h3>
          <dl>
            <dt>Last download</dt><dd class={recordingsClass($status.recordings.last)} data-testid="recordings-last" title={$status.recordings.last ? new Date($status.recordings.last.at).toLocaleString() : undefined}>{recordingsLastText($status.recordings.last)}</dd>
            <dt>Cache</dt><dd data-testid="recordings-cache">{cacheFillText($status.recordings.cache)}</dd>
            <dt>Files cached</dt><dd>{$status.recordings.cache.files}</dd>
          </dl>
        </div>
      {/if}
```

- [ ] **Step 4: Run the tests and the checks**

Run: `npx vitest run test/status-ui.test.ts`
Expected: PASS.

Run: `npm run check && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/recordings.ts web/src/lib/state.ts web/src/pages/Status.svelte test/status-ui.test.ts
git commit
```
Subject: `feat(ui): a Recordings (SD card) card on the Status page`.

---

### Task 15: Documentation

**Files:**
- Modify: `README.md` (the configuration table ~l.142, a new section "Recordings (SD card)" after "Clips (FTP)" ~l.241-316, the Client API list ~l.172-205, the Status page bullet in "Control API and admin UI" ~l.447-505, the metrics list ~l.521-545), `docs/audit-log.md` (the `storage-daily` row), `CHANGELOG.md` (`## Unreleased`), `deploy/cluster/REQUEST.md`

**Interfaces:** none.

- [ ] **Step 1: Write the docs**

**README.md**
- Configuration table, the `camera` row: after `rtspPort` (554), add `` `baichuanPort` (9000: the camera's Baichuan port for recordings; the host is `host`'s; applies at the next connection) ``. A new row after `ftp`:
  `| \`recordings\` | \`cacheMB\` (2048, 64–1,048,576): size cap of the recordings cache; least recently used files go first; applies at the next fetch or storage run |`
- New section "Recordings (SD card)" after "Clips (FTP)":

```markdown
## Recordings (SD card)

The camera keeps about 7 days of recordings on its SD card, in both streams (main at 12 MP, sub at 896×512). cam-proxy lists them and serves any of them as MP4, also the ones FTP never delivered.

- **List:** `GET /api/cameras/:cam/recordings?from=&to=&stream=sub|main` (unix ms, at most 48 hours) answers `[{id, start, end, stream, size, kinds, clipId}]`, from the camera's HTTP `Search` (one per camera-local day, one at a time, kept 30 s). `kinds` comes from the file name's trigger flags; `clipId` is the proxy's FTP copy of the same recording (same stream, start within 5 s), or null. Recordings still being written are left out.
- **Days:** `GET /api/cameras/:cam/recordings/days?month=YYYY-MM` answers `{month, days}` (kept 5 minutes). cams uses it for its calendar, so every camera Search goes through this proxy.
- **File:** `GET /api/cameras/:cam/recordings/:id` (and `HEAD`). The first request fetches the file over Reolink's Baichuan protocol (TCP `camera.baichuanPort`, 9000) and streams it while it arrives: a 15 MB main file takes about 2 s on the LAN. Later and `Range` requests come from the cache (`<dataDir>/recordings/<cam>/`). One download at a time per camera; a second request for the same file waits for the first.
- **Why Baichuan:** the RLC-1224A refuses every HTTP `cmd=Download` since 2026-10-01, while Baichuan downloads of the same files work (findings in the spec, `docs/superpowers/specs/2026-10-02-baichuan-recordings-design.md`). The client is ours (`src/camera/baichuan/`), ported from reolink_aio and its PR #186 (MIT, see `THIRD_PARTY_NOTICES`). It logs in as `camera.user` with `CAMPROXY_CAMERA_PASSWORD`, keeps one connection and closes it after 20 s without a request; the camera allows 12 Baichuan connections in all.
- **Cache:** `recordings.cacheMB` (2048). The cache counts in the storage budget as the kind `recordings`, and it is the first to go when the budget needs room, least recently used first. A file being read is never deleted. Below `storage.minFreeBytes` files are streamed without being kept.
- **Errors:** 400 `invalid`; 404 `unknown_recording`; 503 `camera_offline`; 502 `recordings_unavailable` with `reason` `refused`, `auth`, `timeout`, `protocol` or `search_failed`. A failure after the headers ends the body short.
- **Status:** the Status page's "Recordings (SD card)" card shows the last download's result and the cache fill; `/control/status` has `recordings`; the metric is `camproxy_recording_downloads_total{cam,stream,result}`, and the disk gauges have `kind="recordings"`.
```

- Client API list: add the three routes with one line each (as in the section above).
- Control API and admin UI: the Status page bullet gains "Recordings (SD card)".
- Metrics list: add `camproxy_recording_downloads_total` and `kind="recordings"` on `camproxy_disk_bytes`/`camproxy_disk_files`/`camproxy_storage_growth_bytes_per_day`.

**docs/audit-log.md**, the `storage-daily` row: `kinds` lists `stills`, `previews`, `clips`, `recordings`, `catalog`, `audit`. In the example record, add `"recordings":{"bytes":312000000,"files":9,"oldest":1790900000000,"newest":1790917000000,"growthPerDay":0}` to `kinds` (oldest/newest are the least and most recently used for this kind). Reading or downloading a recording writes no audit record.

**CHANGELOG.md**, under `## Unreleased`:

```markdown
- Recordings from the camera's SD card (spec 2026-10-02-baichuan-recordings-design): `GET /api/cameras/:cam/recordings?from=&to=&stream=` lists them (at most 48 hours; `id`, `start`, `end`, `stream`, `size`, `kinds`, and `clipId`, the FTP copy if there is one), `GET /api/cameras/:cam/recordings/days?month=YYYY-MM` the days with recordings, and `GET /api/cameras/:cam/recordings/:id` serves one as MP4 with Range. The file is fetched over Reolink's Baichuan protocol (TCP 9000), not HTTP `cmd=Download`, which the RLC-1224A refuses since 2026-10-01; full resolution on demand, also for recordings FTP never delivered. It streams while it arrives and is kept in a cache (`recordings.cacheMB`, default 2048), which counts in the storage budget as `recordings` and goes first when room is needed. New settings `camera.baichuanPort` (9000) and `recordings.cacheMB`. The Status page shows the last download and the cache fill; `/control/status` has `recordings`; new metric `camproxy_recording_downloads_total`. The Baichuan client is ported from reolink_aio (MIT, see THIRD_PARTY_NOTICES).
```

**deploy/cluster/REQUEST.md**: add a dated line: "2026-10-02: cam-proxy reaches `cam2.cam-sim.svc.cluster.local:9000` (TCP, Baichuan) for recordings. cam-sim asks kube-setup for the cluster-internal Service port 9000 on cam2 (no ingress, LoadBalancer or NodePort); if a NetworkPolicy limits cam-proxy's egress, it must allow that port."

- [ ] **Step 2: Run everything**

Run: `npx vitest run test/openapi.test.ts test/config.test.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS (the whole suite, apart from known flakes; rerun a flake once and name it in the report).

Run: `npm run lint:types && npm run check && npm run build`
Expected: clean.

Run: `CI=1 npx playwright test`
Expected: PASS (the Status page renders with the new card).

- [ ] **Step 3: Commit**

```bash
git add README.md docs/audit-log.md CHANGELOG.md deploy/cluster/REQUEST.md
git commit
```
Subject: `docs: recordings over Baichuan (README, audit log, CHANGELOG, cluster request)`.

---

## Decisions this plan makes where the spec is open

Reviewers: these are choices, not spec text. Each is small to change.

- **A cached file is served while the camera is offline.** The spec says the file answers 503 at once when the poller says offline; the cache needs no camera, so only uncached files answer 503 (Task 12).
- **A 400 on cmd 8** (the spec lists it under both `refused` and `not_found`): the fetcher asks Search again, bypassing the cache. Gone from the list: `not_found` (404); still listed: `refused` (502) (Task 10).
- **The 15 s login guard** starts after a rejected login (401). A reconnect after a successful session (idle close, a dropped connection) logs in at once; only rejected logins risk locking the account (Task 4).
- **A connection lost after login** (mid-transfer or while a request waits) is `offline`; before any answer it is `refused` (the session limit) (Task 4).
- **The search window** covers the camera-local days from `from`'s to `to`'s (at most three, as the spec says). A recording that starts before local midnight and ends after it is found only by a window that includes its start day, as in cams today.
- **The idle-drop integration case** makes cam-sim drop the session with its `offline` fault, since the sim's 32 s idle constant may not be settable from the proxy's tests; the client path (the next request logs in again) is the same, and Task 4 covers the idle timer itself.

## After the plan (not tasks for the implementer)

- **PR and merge:** one PR to `main` with the tasks' commits; merge only when every required check (`test`, `codeql`) passed (strict merge guard).
- **Release and the Pi update happen when Klaus asks**, not as part of this plan:
  - The release (PR `main` → `production`) deploys the cluster instance; the release workflow checks `/health`.
  - The cluster instance needs cam2's Service port 9000 first (cam-sim's kube-setup request). Until then its recordings answer 503/502 there; nothing else changes.
  - The Pi: `docker compose pull && docker compose up -d` in `/srv/cam-proxy`, as after every release. No compose or secret change: the Pi reaches the camera's port 9000 on the LAN, with the same `proxy` user and password.
- **The one-time real-camera check after that release** (spec "After each release"): through the Pi's proxy, list today's recordings and download one sub and one main file (`curl -H "Authorization: Bearer $TOKEN" -o /tmp/r.mp4 http://<pi>:8480/api/cameras/cam1/recordings/<id>`); check the size equals the list's `size`, the file plays, and the Status page shows "Recordings: ok". Delete the downloaded files afterwards; they are camera footage and never go to GitHub.
- **Obsidian** (vault `general-2026`, folder *Cameras*): add to the camera notes that cam-proxy fetches recordings over Baichuan, with the user, the port and the 12-session limit.
- **cams** switches its recordings and its month calendar to these routes under its own spec and plan (`docs/superpowers/specs/2026-10-02-recordings-via-proxy-design.md` in cams).
- **Review minors:** file them as one GitHub issue before deleting the review workspace.
