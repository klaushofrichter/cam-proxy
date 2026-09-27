# cam-proxy Plan 2: Stills, previews and storage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a still every `stills.intervalS` (1 s) and a preview tile from the
camera's sub stream, through go2rtc's single connection. They are stored as
one pack and one sprite sheet per minute, served by the API, shown on an admin
UI timeline, and kept within the storage rules (age per kind, size budget,
hard floor).

**Architecture:**
- **Restream:** go2rtc (a supervised child process locally, or an external
  container via `go2rtc.url`) restreams the camera's RTSP on 127.0.0.1.
- **Frames:** one ffmpeg reads the restream and writes stills and tiles as two
  JPEG streams on pipes.
- **Storage:** a `MinuteStore` collects a minute in memory. At the minute's end
  it writes the pack (JPEGs, then a JSON footer) and the sprite (composed with
  `sharp`, plus a JSON sidecar).
- **Storage manager:** replaces Plan 1's `Retention`, adding files, the budget
  and the floor.

**Tech Stack:** as Plan 1, plus go2rtc 1.9.14 (a pinned binary; checksums in
the install script), ffmpeg, `sharp`, and cam-sim's RTSP (MediaMTX) in tests.

**Spec:** `docs/superpowers/specs/2026-09-27-cam-proxy-design.md` §4, §8, §8a,
§10, §13, §18 phase 2.

## Global Constraints

Plan 1's constraints, and:
- **Camera connection:** never more than one RTSP connection per camera
  stream. The frame grabber reads go2rtc, never the camera. go2rtc listens on
  127.0.0.1 only.
- **Credentials:** the camera password goes into go2rtc's config through its
  stdin or an environment variable, never on a command line (`ps` shows
  those), and never in logs.
- **Paths and times:**
  - folders are UTC days: `/data/stills/<cam>/YYYY/MM/DD/HHMM.pack`,
    `/data/previews/<cam>/YYYY/MM/DD/HHMM.jpg` + `HHMM.json`;
  - a still's time is the proxy's clock, rounded to the interval.
- **Self-describing data:** each pack and sprite records its interval, sizes,
  grid and quality, so a settings change keeps older data readable.
- No media committed. Test JPEGs are generated in the tests.

## Review Focus

1. **The camera or go2rtc goes away, then comes back** (a cam-sim `rtsp.reset`
   fault, a camera reboot): the grabber recovers by itself, and the gap shows as
   missing seconds, not as wrong times. → Task 3 test.
2. **The proxy stops mid-minute:** the partial minute is written on stop, and a
   restart never corrupts or overwrites an existing pack for the same minute
   (it merges or writes a second part). → Task 4 test.
3. **The disk fills up:** the hard floor pauses writing, and writing resumes
   when space is back. Budget deletions go oldest first and respect
   `keepHours`. → Task 5 tests (fake disk sizes).
4. **Hostile or odd requests:**
   - `/stills/<ts>.jpg` with a time far away, not on an interval, or not a
     number;
   - previews for a range with nothing.

   They answer 404/400, never a crash or a path outside the data folder.
   → Task 6 tests.
5. **A settings change** (still interval 1 → 2, size) followed by a restart:
   older minutes keep serving correctly, and new minutes use the new settings.
   → Task 4 and Task 7 tests.

---

### Task 1: Tooling (go2rtc, MediaMTX in tests)

**Files:** `scripts/install-go2rtc.sh`, `.github/workflows/pr-checks.yml`,
`vitest.config.mts`, `test/helpers/sim.ts`, `test/tools.test.ts`, `.gitignore`

- `scripts/install-go2rtc.sh [dir]`:
  - downloads go2rtc v1.9.14 for this OS/arch (mac arm64/amd64 zip, linux
    arm64/amd64 binary) into `tools/`;
  - checks the SHA-256 against values pinned in the script;
  - prints the binary path.

  `scripts/install-mediamtx.sh` (from cam-sim) installs MediaMTX into `tools/`.
- `vitest.config.mts` sets `CAMSIM_MEDIAMTX` and `CAMPROXY_TEST_GO2RTC` to the
  `tools/` binaries when they exist. The tests that need RTSP skip with a
  visible reason when they're missing locally, and CI installs both (it fails
  if they're missing).
- `startSim` keeps RTSP on (a nonzero port with MediaMTX).
- **Test:** `tools.test.ts`:
  - go2rtc `-version` runs;
  - cam-sim's RTSP sub stream is readable (ffprobe: h264 896x512).

### Task 2: go2rtc supervisor

**Files:** `src/stills/go2rtc.ts`, `test/go2rtc.test.ts`

**Interfaces — Produces:**
```ts
export interface Go2rtcOptions { binary?: string; url?: string; rtspPort: number; apiPort: number;
  source: { host: string; port: number; user: string; password: string }; cam: string }
export class Go2rtc extends EventEmitter {           // emits 'state' ({up, error?})
  constructor(o: Go2rtcOptions);
  start(): Promise<void>; stop(): Promise<void>; up(): boolean;
  streamUrl(stream: 'sub' | 'main'): string;         // rtsp://127.0.0.1:<rtspPort>/<cam>_<stream>
}
```
- **Binary mode:**
  - go2rtc starts with its config in YAML on stdin (`-config -`?); if go2rtc
    can't read stdin, a 0600 temp file that is deleted at stop;
  - streams `<cam>_sub` and `<cam>_main` point at the camera's RTSP
    (`rtsp://user:pass@host:554/h264Preview_01_sub`);
  - RTSP listens on `127.0.0.1:<rtspPort>`, the API on `127.0.0.1:<apiPort>`,
    and WebRTC, the web UI and the rest are off;
  - it restarts with backoff when it exits, and readiness is checked through
    `GET /api/streams`.
- **URL mode** (go2rtc as its own container): no process. The streams are
  registered through go2rtc's API (`PUT /api/streams?name=…&src=…`).
- Logs never contain the source URL (`streamUrl` is local and has no
  credentials).
- **Tests** (cam-sim with RTSP):
  - start, then ffprobe `streamUrl('sub')` → h264;
  - two ffprobes at once → cam-sim sees one reader (MediaMTX readers via
    cam-sim, or by checking that the camera path has one publisher-side
    reader);
  - kill the go2rtc process → it restarts;
  - `stop()` leaves no process;
  - the password appears in neither `ps` nor the logs.

### Task 3: Frame grabber

**Files:** `src/stills/grabber.ts`, `src/stills/jpeg-split.ts`, `test/grabber.test.ts`

**Interfaces — Produces:**
```ts
export interface Frame { ts: number; still: Buffer; tile: Buffer }
export class FrameGrabber extends EventEmitter {    // emits 'frame' (Frame), 'state' ({up, lastFrameTs})
  constructor(o: { input: string; intervalS: number; size: string; tileSize: string; quality: number; tileQuality: number; now?: () => number });
  start(): void; stop(): Promise<void>; up(): boolean; lastFrameTs(): number | null;
}
export function splitJpegs(): Transform;            // bytes → one JPEG per chunk (SOI…EOI)
```
- **ffmpeg:** `-rtsp_transport tcp -i <input>`, then two outputs from one
  decode through `-filter_complex` (fps, split, then scale for the still and
  scale for the tile), both `-f image2pipe -c:v mjpeg`. Stills go to stdout
  and tiles to fd 3.
- **Pairing:** stills and tiles are paired in order. Each pair is stamped with
  `now()` rounded down to the interval. A duplicate stamp (a burst after a
  stall) keeps the first frame.
- **Health:** `up` goes false after 10 s without a frame. On exit, ffmpeg
  restarts with backoff (1…30 s).
- **Tests** (go2rtc + cam-sim):
  - frames arrive at about 1 per second;
  - the still is 896x512 and the tile 160x90 (decoded with `sharp` metadata);
  - the `rtsp.reset` fault → `up` false, then clearing it → frames resume;
  - `stop()` ends ffmpeg;
  - `splitJpegs` unit test: chunks split anywhere (even inside the FF D9
    marker) give whole JPEGs.

### Task 4: Minute store (packs and sprites)

**Files:** `src/stills/store.ts`, `test/store.test.ts`

**Interfaces — Produces:**
```ts
export class MinuteStore {
  constructor(o: { dataDir: string; cam: string; intervalS: number; still: { size: string; quality: number }; tile: { size: string; grid: string; quality: number }; now?: () => number });
  add(f: Frame): void;                                  // into the current minute; a new minute flushes the old one
  flush(): Promise<void>;                               // writes the current minute (stop, restart)
  readStill(ts: number): Promise<Buffer | undefined>;   // also from the in-memory minute
  listStills(from: number, to: number): number[];       // timestamps that have a still
  listPreviews(from: number, to: number): PreviewMinute[];
  readSprite(minuteTs: number): Promise<Buffer | undefined>;
}
export interface PreviewMinute { minute: number; cols: number; rows: number; tileW: number; tileH: number; intervalS: number; present: boolean[] }
```
- **Pack:** JPEGs back to back, then a UTF-8 JSON footer, then 4 bytes
  (footer length, uint32 LE), then 4 bytes of magic `CPK1`. The footer is
  `{v:1, minute, intervalS, size, quality, slots:[[offset,len],…]}`, with
  `len 0` for a missing slot.
- **Existing pack for the same minute** (after a restart): the new frames are
  merged into it. It is read, the slots combined (existing ones kept), and
  rewritten through a temp file and a rename.
- **Sprite:** a `cols×rows` grid of tiles, composed with `sharp` (JPEG, the
  configured quality), with missing tiles dark. The sidecar is
  `HHMM.json` `{v:1, minute, cols, rows, tileW, tileH, intervalS, present}`.
- **Lists:** they read the folders (and the in-memory minute), not a
  database: stills from the pack footers, previews from the sidecars. Footers
  are cached, bounded to 5000 entries.
- **Tests** (synthetic JPEGs from `sharp`):
  - add 60 frames, then flush → read back each second;
  - a missing second → undefined;
  - a restart mid-minute (flush, a new store, the same minute) → merged, no
    loss;
  - reads from the in-memory minute;
  - sprite size and present flags;
  - intervals 1 and 2 side by side (Review Focus 5);
  - a corrupt pack (bad magic) → undefined and a warning, no crash.

### Task 5: Storage manager (age, budget, floor)

**Files:** `src/storage.ts` (replaces `src/retention.ts`), `test/storage.test.ts`,
`test/retention.test.ts` (folded in)

**Interfaces — Produces:**
```ts
export interface KindUsage { bytes: number; files: number; oldest: number | null; newest: number | null; growthPerDay: number }
export class Storage extends EventEmitter {          // emits 'run' (StorageRun), 'paused' (boolean), 'failed' (msg)
  constructor(d: { catalog: Catalog; log: StreamLog; config: () => Config; now?: () => number; statfs?: (dir: string) => { free: number; size: number } });
  recount(): void;                                    // walks the folders once (start, after runs)
  noteWritten(kind: 'stills' | 'previews', bytes: number, files: number): void;
  run(opts: { dryRun?: boolean }): StorageRun;        // age, then budget, then floor check
  paused(): boolean;                                  // below minFreeBytes: writers must not write
  usage(): Record<'stills' | 'previews' | 'clips' | 'catalog', KindUsage> & { free: number; size: number; budget: number; daysUntilFull: number | null };
  start(t?: { firstMs?: number; everyMs?: number }): void; stop(): void; lastRun(): number | null;
}
export interface StorageRun { dryRun: boolean; at: number; deleted: Record<string, number>; freedBytes: number; reason: string[] }
```
- **Age:** delete day folders (UTC) past `retention.<kind>Days` for stills and
  previews, and rows for events and the stream log (from Plan 1).
- **Budget:** while the usage (all kinds plus the catalog) is over the
  budget, delete the oldest hour of the kind next in the order stills →
  clips → previews. A kind is skipped once only `storage.keepHours[kind]`
  remains of it. An hour means the files `HH00`–`HH59` in the oldest day
  folder.
- **Per-kind caps:** `stills.maxGB`, `previews.maxGB` (and `clips.maxGB`
  later) apply the same way, per kind.
- **Floor:** `paused()` is true while free space is below
  `storage.minFreeBytes`. The store drops frames while paused (counted as
  missing) and `camera-status` carries `storage: 'full'`. Writing resumes on
  its own.
- **Growth:** bytes written per kind over the last 3 days, from
  `noteWritten`. Days until full = (budget − used) / total growth.
- **Tests** (a temp folder with fake packs, and an injected `statfs`):
  - age deletes old day folders only;
  - the budget deletes the oldest hour first in the right order;
  - `keepHours` is respected;
  - a dry run deletes nothing and reports the same;
  - the floor pauses, then unpauses;
  - the recount matches the files;
  - a failing run is logged and retried (from Plan 1).

### Task 6: API, SSE, stats and metrics for stills

**Files:** `src/api/client-api.ts`, `src/api/control-api.ts`, `src/api/metrics.ts`,
`openapi.yaml`, `test/stills-api.test.ts`

- **Routes:**
  - `GET /api/cameras/:cam/stills?from&to` → `[ts…]`, at most 1 day per
    request;
  - `GET /api/cameras/:cam/stills/:ts.jpg` → `image/jpeg`, `Cache-Control:
    private, max-age=604800, immutable` for completed minutes and `no-store`
    for the current one; 404 when missing, 400 for a non-numeric `ts`;
  - `GET /api/cameras/:cam/previews?from&to` → `[PreviewMinute + url]`, at
    most 1 day;
  - `GET /api/cameras/:cam/previews/:minute.jpg` → the sprite (`minute` is
    the unix ms of the minute).
- `GET /api/cameras` fills `stream: {up, lastFrameTs}`.
- **SSE `still`** (opt-in):
  `{ts, url:"/api/cameras/cam1/stills/<ts>.jpg", sprite:"…/previews/<minute>.jpg", tile}`.
  It isn't written to `stream_log`, because it fires every second; it goes
  out to live clients only, and SSE gains a live-only path.
- **Stats and metrics:** `/control/stats` gains `disk.stills`,
  `disk.previews` and `storage.{budget, used, daysUntilFull, paused, growth}`.
  The metrics from spec §13 for phase 2:
  - `stills_stored`, `stills_total`, `stills_missing_total`,
    `last_still_timestamp_seconds`;
  - `previews_stored`;
  - `frame_grabber_up`, `go2rtc_up`;
  - `disk_bytes{kind}`, `disk_files{kind}`;
  - `storage_budget_bytes`, `storage_growth_bytes_per_day{kind}`,
    `storage_days_until_full`, `storage_writing_paused`.
- **Tests:**
  - route answers with an in-process store;
  - bad `ts` → 400, no path traversal (`..%2F`) → 404;
  - more than a day → 400;
  - the SSE `still` only with `types=still`;
  - openapi matches.

### Task 7: Wiring, restart, admin UI timeline

**Files:** `src/proxy.ts`, `web/src/pages/Timeline.svelte`, `web/src/pages/Status.svelte`,
`web/src/lib/router.ts`, `web/src/components/Sidebar.svelte`, `e2e/timeline.spec.ts`,
`e2e/start.ts`

- **Proxy:**
  - go2rtc, the grabber and the store are part of the camera side (rebuilt by
    `restart`);
  - `stills.enabled` false → none of them runs;
  - `stop()` flushes the store;
  - the storage manager replaces retention.
- **Status page:** stream (up, last frame), stills and previews cards, storage
  (usage per kind, budget, days until full, paused).
- **Timeline page:** a UTC day picker (in local time), the day's minutes as
  sprite strips grouped by hour, and events as marks. Hovering shows the
  second; clicking shows the still. This is the prototype for cams.
- **e2e:** the Timeline shows today's minute strips after about 70 s of
  running, or with a shortened test interval, and clicking one shows a still.
  e2e runs cam-sim with MediaMTX and the proxy with go2rtc (CI installs
  both).

### Task 8: Real camera, docs, finish

**Files:** `scripts/verify-camera.ts`, `README.md`, `CHANGELOG.md`, spec (phase 2
built)

- The verify script also runs the stills pipeline against the real camera for
  its duration, and reports frames per minute, sizes, packs written and
  go2rtc's single connection. Its temporary data is deleted afterwards (no
  footage kept).
- **README:** stills and previews (paths, formats, API), storage management,
  go2rtc and ffmpeg requirements, and the install scripts.
- **Final:** the whole-branch review and fixes, then the PR and merge when
  green.
