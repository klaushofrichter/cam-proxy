# cam-proxy Plan 3: Clips (FTP intake) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the camera uploads each recorded clip to the proxy by FTP(S). The
proxy stores it, indexes it with its time range and the events it overlaps,
announces it on the event stream, and serves it with HTTP Range. The camera's
FTP settings are written by the proxy (whole object), and clips fall under
storage management.

**Architecture:**
- **FTP server:** a small upload-only FTP server inside the process
  (`node:net` and `node:tls`, no dependency). It speaks explicit FTPS
  (`AUTH TLS`), passive mode, one user, and only folder creation and file
  storage.
- **Uploads:** each file goes to a temp file first. On a complete upload, the
  clip indexer turns the camera's file name into a UTC time (with the camera's
  time zone from `GetTime`), moves the file to
  `data/clips/<cam>/YYYY/MM/DD/HHMM-<startMs>.mp4` (plus `.jpg`), probes its
  duration, adds a `clips` row and appends a `clip` stream message.

**Tech Stack:** as Plans 1–2. The FTPS certificate is `selfsigned` (as in
cam-sim), or the files `ftp.certFile`/`keyFile`. Tests use cam-sim's FTP
uploader and `basic-ftp`.

**Spec:** §9, §8a, §10, §15; requirements §9.

## Global Constraints

Plans 1–2's constraints, and:
- **The FTP server is upload-only:**
  - no RETR, LIST, DELE or RNFR (answered `502`);
  - paths are confined to the upload root (`..` and absolute paths refused);
  - one login at a time per IP after 5 failures a minute;
  - at most 4 simultaneous sessions;
  - files up to 500 MB.
- **TLS:** with `ftp.tls` true, `USER` before `AUTH TLS` answers `530`, and
  data connections need `PROT P`.
- **Passive ports** come from `ftp.passive`. The address announced in PASV
  replies is `ftp.publicHost` (a new setting: the address the camera
  connects to), or the control connection's local address.
- **Camera FTP setup** writes the whole `Ftp` object (`SetFtpV20`) and never
  sets `server: ""` (refused with `-4`). "Off" is `enable: 0` with the server
  kept.
- No clip or other media is committed. Tests make clips with ffmpeg test
  patterns.

## Review Focus

1. **A broken or half-uploaded file:** the connection drops mid-STOR, or the
   file isn't MP4. It is never indexed as a clip, and the temp file is removed.
   → Task 2 and Task 3 tests.
2. **Hostile FTP input:** path traversal in STOR/MKD/CWD, a very long line,
   commands before login, an unknown command, a flood of connections. The
   answer is a refusal, never a file outside the root or a crash. → Task 1
   tests.
3. **Camera time zone and DST:** a clip named in the camera's local time
   indexes at the right UTC time, including the DST hour (the camera's DST
   rules from `GetTime`). → Task 3 test.
4. **Range requests:** partial, open-ended and invalid ranges give 206/416
   with the right headers, so browsers can seek. → Task 4 test.
5. **Storage:** clips count toward the budget and are deleted oldest first
   after stills. A clip being uploaded is never deleted. → Task 5 test.

---

### Task 1: Upload-only FTP(S) server

**Files:** `src/clips/ftp-server.ts`, `test/ftp-server.test.ts`, config (`ftp.publicHost`,
`ftp.certFile`, `ftp.keyFile`; schema regenerated), `package.json` (`selfsigned`)

**Interfaces — Produces:**
```ts
export interface Upload { path: string; name: string; dir: string; bytes: number; tmpFile: string }
export class FtpServer extends EventEmitter {        // emits 'upload' (Upload) when a STOR completes; 'failed' ({name, reason})
  constructor(o: { port: number; host?: string; passive: [number, number]; publicHost?: string; user: string; password: string;
                   tls?: { cert: string; key: string }; root: string; maxBytes?: number; log?: (line: string) => void });
  start(): Promise<number>; stop(): Promise<void>; sessions(): number;
}
```
- **Commands:**
  - USER, PASS, AUTH TLS, PBSZ, PROT, SYST, FEAT, OPTS UTF8, PWD, CWD, CDUP,
    MKD, TYPE, MODE S, STRU F, PASV, EPSV, STOR, SIZE (of a finished upload),
    NOOP, QUIT;
  - everything else answers `502`.
- STOR writes to `<root>/.incoming/<random>`, then emits `upload`. The path
  is the normalized virtual path.
- **The command log** (`log`) records command names and virtual paths, never
  the password.
- **Tests** (`basic-ftp` as the client, plain and TLS):
  - login and upload into nested folders;
  - a wrong password → 530;
  - STOR before login → 530;
  - `..` traversal → 550 and nothing outside the root;
  - a line longer than 4 KB → closed;
  - RETR and LIST → 502;
  - an interrupted STOR → no `upload`, and the temp file removed;
  - `ftp.tls` → USER before AUTH TLS refused;
  - more than 4 sessions → 421;
  - `stop()` closes the sessions.

### Task 2: Clip indexer

**Files:** `src/clips/indexer.ts`, `src/catalog/clips.ts`, `test/clips-indexer.test.ts`

**Interfaces — Produces:**
```ts
export interface ClipRow { id: number; cam: string; start_ts: number; end_ts: number | null; path: string; stream: string; size: number; received_at: number; snapshot: string | null }
export function parseClipName(name: string): { local: string /* YYYYMMDDHHMMSS */; ext: 'mp4' | 'jpg' } | null;  // <Name>_00_YYYYMMDDHHMMSS.(mp4|jpg)
export function localToUtc(local: string, t: TimeInfo & { dstRule?: unknown }): number;
export class ClipIndexer { constructor(d: { catalog; log; config; timeInfo: () => Promise<TimeInfo>; dataDir: string; cam: string }); add(u: Upload): Promise<ClipRow | null> }
export function insertClip / listClips(from,to) / clipById / deleteClip(path)   // src/catalog/clips.ts
```
- **An `.mp4`:**
  - probed with ffprobe (duration, codec). Not a video → dropped, with a
    warning and a `failed` count;
  - moved to `clips/<cam>/YYYY/MM/DD/HHMM-<startMs>.mp4`;
  - stored as a row with `end_ts = start + duration`;
  - announced as the stream message `clip {clipId, start, end, stream, size, url, events:[ids]}`.
- **A `.jpg`** with the same stem becomes the clip's snapshot, whichever of
  the two arrives first.
- **Tests:**
  - name parsing;
  - UTC conversion across the DST change (the Chicago rules from a cam-sim
    `GetTime`);
  - a valid clip is indexed with its duration and the overlapping event ids;
  - a garbage `.mp4` → dropped, not indexed;
  - the jpg before or after the mp4.

### Task 3: Camera FTP setup (control API)

**Files:** `src/clips/camera-ftp.ts`, `src/api/control-api.ts`, `test/camera-ftp.test.ts`

- **Actions:**
  - `camera-ftp-setup`: reads `GetFtpV20`, sets server (`ftp.publicHost`),
    port, user, password, remote dir `/`, the `stream` choice and the
    schedule (all hours, for motion and the AI types), and `enable: 1`.
    It writes the whole object with `SetFtpV20`, then reads it back.
  - `camera-ftp-test`: runs `TestFtp` with the whole object and reports the
    camera's answer.
  - `camera-ftp-off`: `enable: 0` with the rest kept.
- **Tests** (cam-sim):
  - setup → cam-sim's settings show the proxy as the server;
  - an event makes cam-sim upload a clip that gets indexed end to end;
  - `camera-ftp-test` → 0 while the proxy listens, `-454` when it doesn't;
  - off → no upload.

### Task 4: Clips API

**Files:** `src/api/client-api.ts`, `openapi.yaml`, `test/clips-api.test.ts`

- **Routes:**
  - `GET /api/cameras/:cam/clips?from&to` → `[{id, start, end, stream, size, events, url, snapshotUrl}]`
    (at most 31 days);
  - `GET /api/cameras/:cam/clips/:id.mp4` → Range (206, 416),
    `Accept-Ranges`, `Content-Length`, `video/mp4`, immutable caching;
  - `GET /api/cameras/:cam/clips/:id.jpg` → the snapshot.
- **Tests:**
  - list;
  - a full GET;
  - a partial range, an open range and an invalid range (416);
  - an unknown id → 404;
  - the images limiter covers clip files too (1200+ range requests while
    seeking).

### Task 5: Storage, wiring, UI, real camera

**Files:** `src/storage.ts` (clips kind: file names `HHMM-*.mp4|jpg`), `src/proxy.ts`
(FTP server + indexer in the camera side; `ftp.enabled`), `web/src/pages/Clips.svelte`
(a list with playback), Status page FTP card, `scripts/verify-camera.ts` (`--ftp`),
README, CHANGELOG

- **Storage:**
  - clips count, age out by `clipsDays` and follow `clips.maxGB`
    (`ftp.maxGB`);
  - the budget order is stills, then clips, then previews;
  - `.incoming` is never counted or deleted except stale temp files older
    than a day.
- **UI:** a Clips page (the day's clips with event chips, a `<video>` player,
  the snapshot) and an FTP card on Status (server listening, last upload,
  failures).
- **Real camera** (Klaus allowed camera changes in development):
  1. `verify-camera.ts --ftp` points the camera's FTP at this Mac
     (`ftp.publicHost` = the Mac's LAN address), runs `camera-ftp-test`, and
     waits up to N minutes for a real motion clip;
  2. it reports the clip (size, duration, codec) and the camera's FTP command
     sequence (from the server log);
  3. at the end it sets the camera's FTP back to off (`enable: 0`).

  The clip itself is deleted with the temporary data folder and never
  committed.
- **Final:** the whole-branch review, fixes, then the PR and merge.
