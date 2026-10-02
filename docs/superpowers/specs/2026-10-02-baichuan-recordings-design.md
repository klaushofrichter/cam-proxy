# On-demand recordings over Baichuan (design)

Status: approved by Klaus in chat, section by section (2026-10-02). This spec
is for review. It is the main spec of three: cam-sim
(`docs/superpowers/specs/2026-10-02-baichuan-server-design.md`) and cams
(`docs/superpowers/specs/2026-10-02-recordings-via-proxy-design.md`) refer to
it for the protocol, the message flow and the API shapes.

## Goal

cam-proxy lists the camera's SD-card recordings and serves any of them as
MP4 on request. It fetches the file over Reolink's proprietary Baichuan
protocol (TCP 9000), not over the camera's HTTP `cmd=Download`. A small
TypeScript Baichuan client in cam-proxy does the transfer.

Klaus: "The more important API is the proxy: it abstracts from the camera. So
whatever works to make the proxy api better or more functional is ok,
including proprietary API to the camera. I prefer node over Python."

## Decisions (Klaus, 2026-10-02)

| Topic | Decision |
|---|---|
| **Scope** | On-demand recordings: list the SD recordings, stream any of them as MP4 on request. Gap-filling (#74) comes later and builds on this. |
| **Client** | Our own small TypeScript client in `src/camera/baichuan/`, ported from reolink_aio and its PR #186 (both MIT). Only `node:net` and `node:crypto`. No new runtime dependency: not nodelink-js, not Python. |
| **List source** | The camera's HTTP `Search`, which works. |
| **Transfer** | Baichuan cmd 8, into a disk cache, streamed to the client while it arrives. |
| **Order of work** | Phase 0 (measurements), then cam-sim's Baichuan server, then this, then cams. Each piece has its own spec, plan, reviews and PRs. |

## Background

**Why.**
- On 2026-10-01 the RLC-1224A refused every HTTP `cmd=Download`; the camera's
  own web UI could not download either. Nothing cleared it: reboots, power
  cycles, a new SD card, an HTTP/RTMP toggle.
- Baichuan downloads of the same files worked: sub 2.8 MB/s, main 8.9 MB/s,
  complete and playable. HTTP Download managed about 150 KB/s when it still
  worked.
- The FTP copies are sub stream only (896×512). FTP missed 37 hours (it was
  off on the camera). The SD card keeps 7 days.

**Gains.**
1. Recordings FTP never delivered are fetchable: the SD card keeps 7 days; FTP
   misses outages.
2. Full resolution (12 MP main) on demand, without storing every clip at full
   size.
3. Not depending on FTP alone.
4. It unblocks #73 (restore stills), #74 (clip repair) and #76 (download
   status).

**Sources.**
- Measured findings: `~/Development/reolink/baichuan-download.md`; the VOD
  trace: `~/Development/reolink/baichuan-vod-trace.txt` (RLC-1224A, firmware
  v3.2.0.6011).
- Protocol notes with source links: the research brief of 2026-10-02 (its
  links are repeated below where they matter).
- **[aio]** reolink_aio `5d37cb3` (MIT):
  https://github.com/starkillerOG/reolink_aio/blob/5d37cb3df2a49bb8eeafa93fa02513df88ad527a/reolink_aio/baichuan/
- **[pr]** PR #186 `9a1bb52` (MIT), "Add VOD file download over Baichuan":
  https://github.com/1eft0ver/reolink_aio/blob/9a1bb5238b43ecc9d8fbe05c7e5679a7ad8a06f2/reolink_aio/baichuan/
- Cross-references only, never copied: Neolink (AGPL-3.0) and nodelink-js
  (MIT, but too heavy to depend on, and it uses other download commands).

## Phase 0: measurements on the real camera

Done on 2026-10-02 (cam-sim PR #63; the answers are in this spec's Design).
Half a day, before any code. A measurement script in the reolink workspace,
using the scratch reolink_aio setup plus raw socket captures, run against the
real camera (cam1). Klaus allowed real-camera work; settings are not changed.

1. Login framing, header lengths and status codes; whether the `proxy` user
   can log in.
2. Main and sub downloads, with and without the search step (14/15/16) first.
3. Failures:
   - a nonexistent name;
   - a wrong password;
   - a second download while one runs (on the same connection, and on a
     second one);
   - a close without logout, repeated (the session limit);
   - idle until the camera drops the connection;
   - aborting a download midway, then whether the next download works (last,
     carefully, with the PoE power cycle ready).

**Output.**
- Scrubbed traces go into cam-sim `reference/rlc-1224a/baichuan/` (no
  credentials, keys or nonces; see the cam-sim spec for the format).
- The results are folded into the Design below. Traces hold lengths only, no
  media bytes. No point stays open.

## Design

### 1. Protocol summary

Only what the client needs: log in, download, stop. All integers are
little-endian. Measured on the RLC-1224A (firmware v3.2.0.6011) in phase 0.

**Header** ([aio base_protocol.py L321-L375](https://github.com/starkillerOG/reolink_aio/blob/5d37cb3df2a49bb8eeafa93fa02513df88ad527a/reolink_aio/baichuan/base_protocol.py#L321-L375)):

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `f0 de bc 0a` ([aio util.py L15](https://github.com/starkillerOG/reolink_aio/blob/5d37cb3df2a49bb8eeafa93fa02513df88ad527a/reolink_aio/baichuan/util.py#L15)) |
| 4 | 4 | cmd id (u32) |
| 8 | 4 | body length (u32): everything after the header |
| 12 | 1 | channel byte `ch_id`: 250 = host. Also the XOR offset. |
| 13 | 3 | message counter. Bytes 12–15 together are the message id that replies echo. |
| 16 | 2 | request: `00 00` (modern) or the encryption offer `12 dc` (nonce request). Reply: status as u16 (`c8 00` = 200), or `XX dd` (chosen encryption) on the nonce reply. |
| 18 | 2 | message class. Client: `14 65` (nonce request, 20-byte header) and `14 64` (everything else, 24 bytes). Camera: `14 66` (nonce reply only, 20 bytes) and `00 00` with a 24-byte header for every other reply and push. The parser takes the header size from the class: `14 66` and `14 65` are 20 bytes, `14 64` and `00 00` are 24. |
| 20 | 4 | 24-byte header only: payload offset, the length of the extension XML (0 = none). |

The body is `[extension XML: payload offset bytes][body XML or binary]`. The
body is binary when the extension says `<binaryData>1</binaryData>`. VOD
requests go to ch_id 250 with no extension; the channel is in the body XML.

**Statuses.** 200, 201 and 300 are OK; 400 is a bad request (on cmd 8: not
found or refused); 401 is bad credentials at login (the body is
`<LoginErrInfo><remainTimes>10</remainTimes></LoginErrInfo>`, and the
connection stays open); 405 is an unknown cmd (the session stays usable)
([aio base_protocol.py L381-L392](https://github.com/starkillerOG/reolink_aio/blob/5d37cb3df2a49bb8eeafa93fa02513df88ad527a/reolink_aio/baichuan/base_protocol.py#L381-L392)).
Unlike aio, the client never retries a 400. A request before login, or bad
magic, makes the camera close the connection without a reply.

**Login** (cmd 1; [aio baichuan.py L665-L692](https://github.com/starkillerOG/reolink_aio/blob/5d37cb3df2a49bb8eeafa93fa02513df88ad527a/reolink_aio/baichuan/baichuan.py#L665-L692), [L1707-L1757](https://github.com/starkillerOG/reolink_aio/blob/5d37cb3df2a49bb8eeafa93fa02513df88ad527a/reolink_aio/baichuan/baichuan.py#L1707-L1757)):
1. Nonce request: cmd 1, 20-byte header, class `14 65`, bytes 16–17 `12 dc`,
   ch_id 250, no body.
2. Nonce reply: 20-byte header, class `14 66`, bytes 16–17 `XX dd`. The body is
   XOR-encoded (below) and reads `<Encryption version="1.1"><type>md5</type><nonce>…</nonce></Encryption>`.
3. Login: cmd 1, 24-byte header, class `14 64`, ch_id 250. The body is aio's
   `LOGIN_XML` ([aio xmls.py L3-L15](https://github.com/starkillerOG/reolink_aio/blob/5d37cb3df2a49bb8eeafa93fa02513df88ad527a/reolink_aio/baichuan/xmls.py#L3-L15))
   with `userName = md5_31(user + nonce)` and `password = md5_31(password + nonce)`,
   XOR-encoded, not AES.
4. Login reply: 200 with `<DeviceInfo>…` (about 5 KB), or 401. The
   `proxy` user logs in (200); it is admin level on this camera, by Klaus's
   decision.

`md5_31(s)` is the uppercase hex MD5 of `s`, truncated to 31 characters
([aio util.py L112-L118](https://github.com/starkillerOG/reolink_aio/blob/5d37cb3df2a49bb8eeafa93fa02513df88ad527a/reolink_aio/baichuan/util.py#L112-L118)).

**Ciphers** (constants from [aio util.py L17-L22](https://github.com/starkillerOG/reolink_aio/blob/5d37cb3df2a49bb8eeafa93fa02513df88ad527a/reolink_aio/baichuan/util.py#L17-L22)):
- XOR ("BC"), for the nonce reply, the login and the login reply: `out[i] = in[i] ^ XML_KEY[(off + i) % 8] ^ off`,
  with `XML_KEY = 1F 2D 3C 4B 5A 69 78 FF` and `off = ch_id`. It is symmetric.
- After login, AES-128-CFB with 128-bit segments (Node's `aes-128-cfb`). The
  key is the first 16 characters of `md5_31(nonce + "-" + password)`, as ASCII
  bytes. The IV is the fixed `0123456789abcdef`, restarted for every encrypted
  part: the extension and the body are encrypted separately
  ([aio baichuan.py L432-L458](https://github.com/starkillerOG/reolink_aio/blob/5d37cb3df2a49bb8eeafa93fa02513df88ad527a/reolink_aio/baichuan/baichuan.py#L432-L458)).
- Replies: decrypt with AES; if the result doesn't start with `<?xml`, try XOR,
  then plain text ([aio L460-L500](https://github.com/starkillerOG/reolink_aio/blob/5d37cb3df2a49bb8eeafa93fa02513df88ad527a/reolink_aio/baichuan/baichuan.py#L460-L500)).
- Download chunks: only the first `encryptLen` bytes (from the extension; 1024
  in our trace) are AES-encrypted, from a fresh IV; the rest is plain. Without
  `encryptLen` the payload is plain ([aio L527-L532](https://github.com/starkillerOG/reolink_aio/blob/5d37cb3df2a49bb8eeafa93fa02513df88ad527a/reolink_aio/baichuan/baichuan.py#L527-L532)).

**Session.** It lasts as long as the TCP connection. There is no token; the
nonce and key are per connection. Logout is cmd 2 and sends the plain user
name and password inside AES ([aio xmls.py L17-L25](https://github.com/starkillerOG/reolink_aio/blob/5d37cb3df2a49bb8eeafa93fa02513df88ad527a/reolink_aio/baichuan/xmls.py#L17-L25)).
The client does not use it: a plain close frees the session at once, so there
is no logout (measured: the session leaves HTTP `GetOnline` within 0.3 s, and
32 closes in a row left nothing behind). A logout answers 200, then the camera
closes the connection.

**Camera limits (measured).**
- **Session limit: 12 TCP connections on port 9000**, counting connections
  that never logged in. The 13th is accepted, then reset at its first message
  with no reply; it works again as soon as one closes. HTTP is unaffected.
  Baichuan sessions show in HTTP `GetOnline`. The proxy keeps one connection
  per camera, so it stays far from the limit; other Baichuan clients (the
  Reolink app, other tools) share the 12.
- **Idle timeout: about 32 s after the client's last message**; 12.5 s for a
  connection that never sends. Any request resets it (cmd 93 `LinkType`
  answers 200, an unknown cmd answers 405, both count).

**Pushes.** After login the camera sends unsolicited messages (message id 0,
channel 0, status 200): cmds 78, 79, 464, 547, 291, 677, 600 and 669. They
arrive 0.04–0.5 s after login, sometimes in a second batch about 32 s later,
and **can arrive between a request and its reply**. The session layer skips
every message whose message id doesn't belong to a pending request; it never
interprets pushes.

**VOD messages** (templates: [pr xmls.py L281-L352](https://github.com/1eft0ver/reolink_aio/blob/9a1bb5238b43ecc9d8fbe05c7e5679a7ad8a06f2/reolink_aio/baichuan/xmls.py#L281-L352)).
All are AES, ch_id 250, no extension, body
`<body><FileInfoList version="1.1"><FileInfo>…</FileInfo></FileInfoList></body>`:

| cmd | Purpose | `FileInfo` children sent | Reply |
|---|---|---|---|
| 8 | download | `Id`, `channelId` (no `name`) | streamed chunks (below) |
| 9 | stop | `channelId`, `handle` = `0` | 200, no body |

**Not used (measured).**
- **14/15/16 (search)**: not needed. cmd 8 with `<Id>` alone gives
  byte-identical files to the search path.
- **13 (file info)**: not used. Its `handle` is always 0, and with `<name>` it
  reports the main file's size for a sub `<Id>` (6,716,462 for a 467,534 B sub
  file). Size comes from the file name, as the list already does.

- **`Id`** is the absolute path the camera's HTTP `Search` returns as `name`,
  e.g. `/mnt/sda/Mp4Record/2026-10-01/RecS0A_DST20261001_211129_211207_0_5514C080000000_108CE9.mp4`.
  It is exactly the HTTP Search `name`.
- **`name`** (the PR's `{channel+1:02d}{start}`) is optional and not sent.
- **Size** is the file name's last hex field (`0x108CE9` = 1,084,649 B in the
  trace). It equals HTTP Search `size` and the bytes received, on all 8 files
  checked.

**The download stream** (trace; [pr L4399-L4417](https://github.com/1eft0ver/reolink_aio/blob/9a1bb5238b43ecc9d8fbe05c7e5679a7ad8a06f2/reolink_aio/baichuan/baichuan.py#L4399-L4417)):
1. The first cmd-8 reply has extension `<binaryData>1</binaryData>` and a
   32-byte payload that is **not** file data (an info record: `"1002"`, the
   size, width, height, fps, start and end, a main/sub flag). Skip it.
2. Every later cmd-8 frame has extension `<binaryData>1</binaryData><encryptLen>1024</encryptLen>`
   and a chunk of the file (39,400 B and 12,872 B in the trace).
3. There is no terminator, even 3 s after the last byte. The transfer ends
   when the bytes received reach the size. The client then sends cmd 9
   (answers 200, no body).
4. A refusal or a missing file is a cmd-8 reply with status 400, no body and
   no chunks.
5. **Every frame of the download carries cmd 8's message id**, the first
   32-byte one included. The client accepts a frame only if cmd and message id
   match the running download.
6. Throughput (LAN): main 10.8–10.9 MB/s (6.7 MB in 0.6 s), sub 0.05–0.08 s
   per file; the first chunk comes 9–39 ms after cmd 8.

### 2. The recordings API

Next to `/api/cameras/:cam/clips` in `src/api/client-api.ts`, with the same
client-token access. An unknown `:cam` answers `404 {"error":"not_found"}`,
like the other routes.

#### `GET /api/cameras/:cam/recordings?from=&to=&stream=`

Lists the SD recordings that overlap `[from, to]`.

| Query | Meaning |
|---|---|
| `from`, `to` | unix ms, required; `to` ≥ `from`; at most 48 hours apart (a camera-local day, DST days included) |
| `stream` | `sub` or `main`, required |

```json
[{"id":"RecS0A_DST20261001_211129_211207_0_5514C080000000_108CE9.mp4",
  "start":1790000000000,"end":1790000038000,"stream":"sub","size":1084649,
  "kinds":["person","motion"],"clipId":1312}]
```

- `id`: the camera's file name without the folder.
- `start`, `end`: unix ms, from the name's camera-local times, its DST flag and
  the camera's `TimeInfo` (`src/camera/time.ts`), as cams converts them today.
- `stream`: `sub` or `main` (from the name's `RecS`/`RecM`).
- `size`: bytes, from the name's last hex field.
- `kinds`: decoded from the name's trigger flags: any of `person`, `vehicle`,
  `pet`, `motion`. The decoding is cams' (`server/recordings/clipNames.ts`,
  bit `55 − pos`), ported to `src/recordings/names.ts`.
- `clipId`: the id of the proxy's FTP copy of the same recording (same stream,
  start within 5 s, the slack cams uses), else `null`.

Sorted by `start`. A recording still being written (end `000000` in its name,
not a midnight clip) is left out until it ends, as in cams.

**How the list is made.**
- The camera's `Search` (`onlyStatus: 0`, the chosen `streamType`) through the
  existing HTTP client. The camera searches only the start day of a window
  (cams `docs/reolink-api.md`), so the proxy runs one Search per camera-local
  day the range touches (at most three).
- **One Search at a time per camera**: a Search overlapping another fails
  (`-54`) or comes back empty. A mutex in the recordings module serialises
  them.
- **Cache**: each (camera day, stream) result is kept about 30 s. Concurrent
  requests for the same key share one Search.

#### `GET /api/cameras/:cam/recordings/days?month=YYYY-MM`

The days of a camera-local month that have recordings, from the camera's
month Search (`Search` with `onlyStatus: 1`, main stream), as
`{ "month": "2026-10", "days": [1, 2] }`. cams uses it for its calendar
instead of searching the camera itself, so every camera Search for a proxied
camera goes through this proxy's single searcher (overlapping Searches fail
with an empty answer and no error). Cached 5 minutes; the same one-at-a-time
search queue as the list. Errors: `400` for a bad month, `503 camera_offline`.

#### `GET /api/cameras/:cam/recordings/:id` (and `HEAD`)

Delivers the file as `video/mp4`, with `Range` support.

- **The id** must match the SD name pattern
  (`^Rec[MS][0-9A-Za-z]{2}_(DST)?\d{8}_\d{6}_\d{6}_[0-9A-Za-z_]+\.mp4$`, at
  most 128 characters), else 400. It is resolved through the list of its day
  and stream (from the name). The camera path for `<Id>` always comes from the
  camera's Search result, never from the request. Not in the list: 404.
- **First request (not cached)**: the proxy fetches the file over Baichuan into
  the disk cache and streams it to the client while it arrives: `200`,
  `Content-Length` = the size, `Accept-Ranges: bytes`. A 15 MB main file takes
  about 2 s.
- **Later and `Range` requests** come from the cache, served like the clip
  files (`sendFile`, `Accept-Ranges`; an unsatisfiable `Range` answers 416
  with `Content-Range: bytes */size`). A `Range` request for a file not yet
  cached waits for the fetch to finish, then is served from the cache.
  Exception: `Range: bytes=0-` (how every `<video>` opens) on a file not yet
  cached is treated like a plain GET, streamed while it arrives as a `200`
  with the whole file (RFC 9110 lets a server ignore `Range`).
- **A second request for an id being fetched** waits for that fetch; there is
  never a second transfer of the same file.
- **`HEAD`**: from the cache when cached; otherwise the headers from the list
  (`Content-Length` = the size), without a transfer.
- `Cache-Control: private, max-age=604800, immutable`, as for clips.

**One download at a time per camera.** The camera would allow more: on the
same connection a new cmd 8 silently replaces the running one (the old one
stops with no message), and on two connections both run in parallel. So the
rule is ours, for two reasons: a second cmd 8 on the one connection would
kill the first transfer, and a second connection would use more of the
camera's 12 sessions and share its bandwidth. A per-camera queue with two
priorities: requests from the client API are `high`; `low` is for background
work (#74's gap-fill, later) and is not used yet. A `high` request goes ahead
of every queued `low` one. A request whose client disconnects while queued
leaves the queue.

#### The cache

- Files go to `<dataDir>/recordings/<cam>/<id>`, written as `<id>.part` and
  renamed when complete. Leftover `.part` files are deleted at start.
- A new storage kind `recordings`, counted in the budget. When the budget needs
  room, recordings are deleted **first** (before stills, clips and previews),
  least-recently-used first. No `keepHours` applies to them.
- Bounded on its own by `recordings.cacheMB`: before a fetch, least-recently-
  used files are deleted until the new file fits. Last use is the file's mtime,
  touched on every read, so the order survives a restart.
- A file being written or read is never deleted.
- No age retention: the cap and the budget bound it.
- `storage.usage()` reports the kind, so the Status page, the
  `camproxy_disk_bytes`/`camproxy_disk_files` gauges and the audit log's
  `storage-daily` record include it.

#### Errors

| Status | Body | When |
|---|---|---|
| 400 | `{"error":"invalid","detail":"…"}` | bad `from`/`to`/`stream`, a range over 48 hours, a malformed id |
| 404 | `{"error":"unknown_recording"}` | the id isn't in the camera's list, or the camera reports it gone |
| 503 | `{"error":"camera_offline"}` | the status poller says offline, or neither HTTP nor Baichuan connect |
| 502 | `{"error":"recordings_unavailable","reason":"…","detail":"…"}` | the camera answers but refuses; `reason` is `refused`, `auth`, `timeout`, `protocol` or `search_failed` |

`detail` is for people and never contains a path, a password or a key.

#### Settings

| Setting | Default | Meaning |
|---|---|---|
| `recordings.cacheMB` | 2048 | size cap of the recordings cache, MB (64 to 1,048,576) |
| `camera.baichuanPort` | 9000 | the camera's Baichuan port (1 to 65535) |

The Baichuan host is the host part of `camera.host`. Both settings are in the
Settings page and `config.schema.json` (`npm run schema`). A changed port
applies to the next connection; a changed cap at the next fetch or storage
run.

#### Status page, metrics, audit

- **`GET /control/status`** gains
  `recordings: { last: { at, result, stream, bytes, ms } | null, cache: { bytes, files, capBytes } }`.
  `result` is `ok` or the error reason (`offline`, `refused`, `auth`,
  `timeout`, `protocol`, `not_found`).
- **The Status page** gets a "Recordings" line: the last Baichuan result and
  when (green for `ok`, red otherwise, `—` before the first), and the cache
  fill ("312 MB of 2048 MB"). This feeds #76.
- **Metrics**: `camproxy_recording_downloads_total{cam,stream,result}`, with
  the same `result` values. The disk gauges gain `kind="recordings"`.
- **Audit**: no record per download (reads aren't audited).

### 3. The Baichuan client (`src/camera/baichuan/`)

Fresh TypeScript; only `node:net` and `node:crypto`.

**`frame.ts`**
- Encodes and decodes headers: magic, cmd, length, message id, status/offer,
  class, payload offset (20- and 24-byte forms).
- A streaming parser: messages split across reads and several in one read.
  Bad magic: the connection is closed with a protocol error (no resync).
- It reads the header size from the class (see the header table). The session
  layer, not the parser, drops pushes and stale messages by message id.

**`cipher.ts`**
- The login XOR (fixed key, offset = channel byte).
- AES-128-CFB after login, key from `md5_31(nonce + "-" + password)`, IV
  `0123456789abcdef` restarted per part.
- Chunk decryption: only the first `encryptLen` bytes.
- Unit tests pin these against known bytes: fixtures generated with
  reolink_aio's functions as the oracle (a test password, never the camera's),
  and the trace's XML.

**`session.ts`**
- One TCP connection per camera, opened on demand.
- The handshake: nonce, then login. Replies are matched by cmd and message id.
- **Idle: it closes the socket after 20 s without a request**, and reconnects
  on demand (nonce and login take well under a second). It sends no keep-alive
  (no cmd 93): the camera drops an idle session after about 32 s, and a long
  download keeps it alive by itself. Always a plain close, never cmd 2.
- The same camera user and password as the HTTP client (`camera.user`,
  `CAMPROXY_CAMERA_PASSWORD`). The `proxy` user logs in over Baichuan; it is
  admin level on this camera by Klaus's decision (2026-10-02), and there will
  be no non-admin user.
- At most one login attempt per 15 s per camera (aio's guard), so a bug can't
  lock the account. Within the 15 s, a failed login fails fast with `auth`.
- A reset at the first message (the 12-session limit) is a `refused` error,
  not `offline`.
- A lost connection fails every pending request. The next request reconnects
  and logs in again (a new nonce and key).

**`vod.ts`**
- `download(path, size, writable)`: cmd 8 with `<Id>` = the camera path;
  `size` is the name's last hex field. Skips the first reply's 32 extra bytes,
  accepts only frames with cmd 8 and its message id, writes chunks, ends when
  the received bytes reach the size.
  Honours backpressure: when `writable.write()` returns false, the socket is
  paused until `drain`, so TCP slows the camera down.
- `stop()`: cmd 9 (`handle` 0). About 400 KB of chunks still arrive afterwards
  with the old message id; they are dropped by message id, so no drain is
  needed, and the next cmd 8 on the same connection works. Closing the socket
  mid-transfer is fine too.
- The flow: 8, then 9 once the bytes reach the size. No cmd 13, no search.

**Errors.** `BaichuanError` with a code: `offline` (connect refused or timed
out), `auth` (401 at login), `refused` (a reset at the first message, or a
400 on cmd 8), `not_found` (a 400 on cmd 8 for a file whose name the list
had), `timeout`, `protocol` (bad magic, an unknown class, a
reply that doesn't parse). Timeouts: connect 5 s, login 10 s, first chunk 15 s
after cmd 8, a stall of 20 s between chunks. A broken download can't resume
(cmd 8 has no offset); the `.part` is deleted and the next request starts over.

**No logging of secrets.** Never the password, the nonce, the derived key, or
login/logout bodies, at any level. Other message bodies only at debug level.
Info level gets one line per download: camera, id, stream, bytes, ms, result.

**License.** The files say they are ported from reolink_aio and PR #186 (MIT),
with the pinned commits. A new `THIRD_PARTY_NOTICES` file at the repo root
carries reolink_aio's MIT notice. Nothing is ported from Neolink (AGPL).

### Other code

- `src/recordings/`: `names.ts` (parse SD names, decode triggers),
  `list.ts` (Search, per-day split, the 30 s cache, the Search mutex),
  `cache.ts` (files, LRU, the cap), `fetcher.ts` (the per-camera queue,
  `vod.ts` into the cache, the tee to the first client).
- `src/storage.ts`: the `recordings` kind, first in the budget order.
- `src/config/schema.ts`: the two settings.
- `src/api/client-api.ts`: the routes; `src/api/control-api.ts` and
  `web/src/pages/Status.svelte`: the status; `src/api/metrics.ts`: the
  counter.

## Error handling

- **Camera offline** (status poller): list and file answer 503 at once.
- **HTTP Search fails**: `-54` is retried once after 1 s; any other failure is
  502 `search_failed`. The other days of a multi-day range are not served
  partly: the whole request fails.
- **Baichuan refuses or fails before the first chunk**: the `.part` is deleted,
  the client gets 502 (or 404 for `not_found`, 503 for `offline`), and the
  Status line and the counter record it.
- **Failure after headers were sent**: the response is destroyed (the client
  sees a short body), the `.part` is deleted, and waiting requests for the same
  id get the same error.
- **Client disconnects mid-transfer**: the fetch continues into the cache, so
  a retry or a later Range request finds the file there.
- **Disk paused** (below `storage.minFreeBytes`): the fetch streams to the
  client without being kept.
- **Abort and next download**: cmd 9 leaves the session usable, with stale
  chunks dropped by message id (measured). HTTP `cmd=Download` stays refused
  before and after, unchanged.

## Testing

**Unit tests.**
- The frame parser: split messages, merged messages, both header sizes, bad
  magic.
- The ciphers, pinned to known bytes (the aio oracle fixtures).
- The message builders against the trace's XML (cmds 8 and 9).
- Pushes (message id 0) between a request and its reply are skipped; stale
  chunks with an old message id after cmd 9 are dropped.
- The idle close at 20 s (fake timers).
- The download loop: end at the size, the 32-byte first payload, backpressure
  (a slow writable pauses the socket), the first-chunk and stall timeouts.
- The cache: LRU order across a restart, the cap, the budget (recordings go
  first), `.part` cleanup, Range.
- The list: name parsing and kinds, the per-day split, the 30 s cache, Search
  serialisation, `clipId` matching.
- The API: every status code in the error table, `HEAD`, the id pattern, a
  second request during a fetch, high priority ahead of low.
- No secrets: the log output of a full session never contains the password,
  the nonce or the key.

**Integration** (`npm test`, cam-sim in process, the release with its
Baichuan server): login, list, sub and main downloads, and every cam-sim fault
(refused download, a drop mid-transfer, a slow transfer, a rejected login, the
session limit, the 32 s idle drop, pushes between request and reply, stale
chunks after an abort), plus HTTP Download refused while Baichuan works.

**e2e across the stack** (in cams' spec): cam-sim refuses HTTP Download,
cam-proxy fetches over Baichuan, cams plays the clip.

**After each release**: a one-time real-camera check of a download through the
Pi's proxy, with `/control/status` showing "Recordings: ok".

**Docs**: `openapi.yaml`, README (a section "Recordings (SD card)"),
`docs/audit-log.md` (the new kind in `storage-daily`), CHANGELOG.

## Out of scope

- Gap-filling (#74): fetching recordings FTP missed into the clips catalog.
  It builds on this (the `low` priority).
- Restoring stills (#73) and the download-status work in cams (#76), beyond the
  Status line here.
- Baichuan search (14/15/16) and file info (13), live video, events or settings over Baichuan.
- Resuming a broken transfer.
- Multi-channel cameras (channel 0 only).

**Known risk.** cams still runs its own month Search against the
camera. A proxy Search that overlaps it can come back empty without an error.
The 30 s list cache bounds the effect; if it shows up, cams' month list moves
to the proxy too, in a later step.

## References

- cam-sim spec: `docs/superpowers/specs/2026-10-02-baichuan-server-design.md`
  (cam-sim repo).
- cams spec: `docs/superpowers/specs/2026-10-02-recordings-via-proxy-design.md`
  (cams repo).
- Findings and trace: `~/Development/reolink/baichuan-download.md`,
  `~/Development/reolink/baichuan-vod-trace.txt`.
- cams `docs/reolink-api.md`: Search quirks, file names, trigger flags.
- reolink_aio `5d37cb3` and PR #186 `9a1bb52` (links above).
- Issues: #73, #74, #76.
