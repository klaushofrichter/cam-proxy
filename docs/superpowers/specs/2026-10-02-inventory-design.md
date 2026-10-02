# Inventories and repairs (design)

Status: approved by Klaus in chat on 2026-10-02 ("ok for inventory design"),
with all 13 recommendations of the draft accepted as written. This spec is the
draft checked against `main` at 87b9bfd and corrected where the code says
otherwise (listed below). Issues: #72 (stills), #74 (clips), #75 (events),
#73 (restore stills).

## Goal

The proxy can tell what it should have and doesn't: stills missing in the
retention window, clips missing locally or on the camera, events it never
saw. It reports them on the Maintenance page and in the audit log, and, where
the camera still has the recording, repairs them on request.

Klaus (2026-10-01, #72): "an inventory of the stills: do we have every still
we should have for the retention period?" (#74): "Do we have every clip we
should have locally? Does our store match the camera's recordings? Can lost
clips be fetched again?" (#75): "Find events we missed, for example while the
ONVIF subscription was down or the proxy was stopped, and add them to our
repository."

## Corrections to the draft

Checked against the code on `main`; each changes the text below.

1. **`ftp.stream` defaults to `main`, not `sub`** (`src/config/defaults.ts`).
   The cluster config and the e2e harness set `sub`; stills default to `sub`
   at 896×512. The checks use each clip row's own `stream` column, and the
   camera compare and repairs use `ftp.stream` as it is at run time.
2. **A minute without a pack has no footer.** Its expected slots come from
   the current `stills.intervalS`; a minute with a pack uses its footer's
   `intervalS`. A pack whose footer can't be read counts as fully missing at
   the current interval.
3. **The window is whole UTC days.** Retention deletes stills older than
   `dayStart(now − stillsDays)` (`src/storage.ts`), so the full window is 7 to
   8 days. It ends two minutes before now: the current minute is still in
   memory, and the previous one is written only when the next frame arrives.
4. **How a shorter window is explained** needed a rule (below): `retention`,
   `budget` (from the `storage-daily` records; it also covers `stills.maxGB`),
   `store-younger`, or `empty`.
5. **A crash leaves no `proxy-stop`.** The next `proxy-start` has
   `uncleanStop: true`. So a gap is explained by the `proxy-start` that falls
   inside it (clean or not), up to 120 s after that start, the time go2rtc and
   the grabber need. Gaps are not explained by `proxy-stop` alone.
6. **Clip times and still times come from different clocks.** Clip times are
   the camera's local file-name time converted to UTC; still times are the
   proxy's clock. "Restorable seconds" compares them as they are (the camera's
   `clockOffsetMs` is usually under a second) and says so.
7. **Every `POST /control/actions/:name` writes a `control-action` record**
   unless the route excludes it (`src/api/control-api.ts`). `inventory` is
   excluded, because the run writes its own `inventory` record when it ends;
   `inventory-cancel` stays a `control-action`. A refused start (400, 409)
   writes nothing, like a refused camera reboot.
8. **"Admin only" is the routes, not the records.** The `inventory` and
   `inventory-repair` records are read like every other record: admin token,
   admin session, or `CAMPROXY_AUDIT_TOKEN` on `GET /control/audit`.
9. **The RecordingFetcher writes into the recordings cache**
   (`<dataDir>/recordings/<cam>/<id>`, capped by `recordings.cacheMB`,
   least-recently-used), not into the clips folder. A clip repair pins the
   cached file, copies it into `clips/`, and indexes it through a new indexer
   entry: `ClipIndexer.add()` only takes an FTP upload named
   `<Name>_00_<local time>.mp4`.
10. **Recovered events need no migration, but the code needs changes.** The
    columns are TEXT, but `EventRow.source` (`'onvif' | 'poll'`) and
    `end_reason` are typed unions. Analytics' catch-up (`unanalysed()`, the
    last 10 minutes at start) would send a recovered event to Google Vision,
    and `clipsStalled()` and the daily activity record count events by kind.
    All three must leave `recovered` out (or count it apart).
11. The Pi run times in the draft are estimates; the stills one is measured in
    PR 1 (the report has `tookMs`).

## Decisions (Klaus, 2026-10-02)

The draft's section 7, accepted as written.

| # | Topic | Decision |
|---|---|---|
| 1 | Repair stream | **sub** (`ftp.stream`), not main |
| 2 | Repaired clips | **the same `clips` table plus an `origin` column**, not a separate kind |
| 3 | SSE or stream-log entries for repaired clips and recovered events | **none** |
| 4 | API | **asynchronous** for every kind (202 plus polling), not #72's synchronous 200 |
| 5 | One lock for all inventories and repairs | **yes** |
| 6 | Results | **JSON files, the last 10 per kind**, no catalog table |
| 7 | Tolerances | **±5 s on the start** for clips; **[−10 s, +5 s] same-kind overlap** for events |
| 8 | Timer-only recordings | **ignore them and count them** |
| 9 | Recovered event bounds | **the recording's start and end**, one event per kind, overlapping recordings merged |
| 10 | Repair caps | **50 clips or 200 MB per run**, 1 s apart, stop after 3 failures, a report less than 1 hour old |
| 11 | #73's source | **local clips only**, restored stills marked in the footer |
| 12 | Events window | **the SD card's reach (about 7 days)**, stated in the report |
| 13 | A running low-priority download | **no pre-emption** (one takes about 0.5 s on sub) |

## Background (verified on main)

- **Stills are not in the catalog.** Each minute is one file
  `<dataDir>/stills/<cam>/YYYY/MM/DD/HHMM.pack` (UTC): the JPEGs back to back,
  a JSON footer `{v: 1, minute, intervalS, size, quality, slots}` with one
  `[offset, length]` per slot (length 0: no still), the footer's length
  (uint32 LE) and the magic `CPK1`. A pack is written only when the minute
  has at least one still. The preview of a minute is a sprite
  `<dataDir>/previews/<cam>/YYYY/MM/DD/HHMM.jpg` with a sidecar `HHMM.json`
  (`present` per tile), written with every pack (`src/stills/store.ts`).
  #72's "rows without file, files without row" therefore becomes: unreadable
  packs, packs without a sprite, sprites without a pack.
- **Retention** (`src/storage.ts`): stills 7 days, previews 14, clips 7,
  events 30, audit 90, by age in whole UTC days. Over the size budget, the
  oldest hour of stills goes first, then clips, then previews, never inside
  `storage.keepHours` (stills 24 h). `stills.maxGB` caps stills on its own.
- **Clips** (`src/clips/indexer.ts`, `src/catalog/clips.ts`): one row per
  clip (`start_ts`, `end_ts`, `path`, `stream`, `size`, `received_at`,
  `snapshot`), the file at `clips/<cam>/YYYY/MM/DD/HHMM-<start>.mp4`, its
  picture `HHMM-<ts>.jpg` linked in `snapshot`. `listClips` stops at 2000 rows
  and `listEvents` at 1000, so the inventories query by time range
  themselves.
- **Events** (`src/catalog/events.ts`): `source` `onvif` or `poll`, kinds
  `motion`, `person`, `vehicle`, `pet` (and others the camera sends).
- **SD recordings** (`src/recordings/`): `RecordingList` runs one camera
  Search at a time (a semaphore), caches a day for 30 s and a month for 5
  minutes; names carry the stream, camera-local times with the DST flag, the
  size and the trigger kinds (`names.ts`). `RecordingFetcher` has a `high`
  and a `low` queue; nothing uses `low` yet.
- **The audit log** (`src/audit/audit-log.ts`): `proxy-start` carries
  `previousStop` and `uncleanStop`; `proxy-stop` is written first in a clean
  stop. `storage-daily` (00:05 camera time) has `kinds.stills.oldest`.
  `list()` pages by cursor and filters by action and time.
- **Maintenance page** (`web/src/pages/Maintenance.svelte`): action buttons,
  a result line, the log. **Audit page**: an action filter from
  `web/src/lib/audit.ts` `ACTIONS`.

## Design

### 1. The shared module (`src/inventory/`)

- **Files.**
  - `runner.ts`: the lock, progress, cancel, the result files and the audit
    record (PR 1);
  - `stills.ts` (PR 1), `clips.ts` (PR 2), `events.ts` (PR 3): the checks;
  - `camera-list.ts`: the SD recordings of the window, one Search per day,
    shared by the clips and events checks (PR 2);
  - `match.ts`: the pairing rules (PR 2);
  - `repair-clips.ts` (PR 2), `repair-events.ts` (PR 3), `restore-stills.ts`
    (PR 4).
- **A check** is `(ctx: {signal, progress, now}) => Promise<{window, counts,
  top, items, message}>`. The runner knows nothing about stills; a new kind
  is a new check in the runner's table.
- **One run at a time.** One lock per proxy covers every inventory and
  repair. A second start answers 409 `inventory_busy` with the running
  `runId`.
- **Cancellable.** An `AbortSignal`, checked between pages (a UTC day of
  stills, a camera day, a download). A cancelled run keeps its partial counts
  and is saved and audited like any other, with `outcome: cancelled` and
  `cancelledBy` (`request`, or `stop` when the proxy stops mid-run).
- **Progress.** `{phase, done, total, note}`; the UI polls about once a
  second. File reads are async, page by page, so the server stays responsive.
- **Results.** `<dataDir>/inventory/<kind>/<runId>.json`, written atomically,
  the last 10 per kind; they survive restarts. A run id is
  `<kind>-<startedAt ms>-<6 hex>`. The folder is a few hundred KB at most and
  is not a storage kind.
- **The report.** `{runId, kind, camera, startedAt, tookMs, outcome
  (ok|cancelled|failed), error?, cancelledBy?, requestedBy, window, counts,
  top (up to 10), items (up to 500), itemsTruncated, message}`.
- **Audit.** One `inventory` record per run when it ends (category host, type
  info, user admin): `runId`, `kind`, `outcome`, `requestedBy`,
  `cancelledBy`, `window`, `counts`, `top`, `tookMs`; outcome `success`,
  `unknown` (cancelled) or `failure`. One `inventory-repair` record per repair
  batch (PR 2, PR 3): requested, done, failed, skipped, bytes, up to 10
  failures.

### 2. The API

All under `/control`, so admin token or admin session (with
`X-CamProxy-UI`); a client token gets 403 `admin_only`, the audit token 403.

| Route | |
|---|---|
| `POST /control/actions/inventory` | `{kind, camera?}`: 202 `{runId}`; 400 `invalid` for an unknown kind; 409 `inventory_busy` `{runId}` while any inventory or repair runs. PR 1 knows `stills` only. `camera: true` (PR 2) adds the camera compare |
| `POST /control/actions/inventory-cancel` | 200 `{cancelled, runId}` (`false`, `null` when nothing runs); a `control-action` record |
| `GET /control/inventory` | `{running: {runId, kind, startedAt, outcome: 'running', progress} \| null, runs: {<kind>: [summary, newest first]}}`; a summary is `{runId, kind, startedAt, tookMs, outcome, counts, message}` |
| `GET /control/inventory/runs/:id` | the report, or the running view while it runs; 400 `invalid` for an id that isn't a run id, 404 `not_found` |
| `POST /control/actions/inventory-repair` | PR 2 and PR 3 (below) |

### 3. Stills (#72, PR 1), local only

**Window.**
- `retentionFrom` = `dayStart(now − retention.stillsDays)`; `to` = the start
  of the minute before the current one (exclusive).
- The oldest pack decides where the check starts:
  - no pack in `[retentionFrom, to)`: reason `empty`, nothing checked;
  - the oldest pack less than an hour after `retentionFrom`: reason
    `retention`, the window starts at `retentionFrom` (missing minutes at the
    start count);
  - else the window starts at the oldest pack, with reason `budget` when a
    `storage-daily` record since `retentionFrom` reported older stills
    (`kinds.stills.oldest` more than an hour before the oldest pack: deleted
    for space, by the budget or `stills.maxGB`), else `store-younger`.
- The report also gives `protectedFrom` = now − `storage.keepHours.stills`,
  the part the budget never deletes (#72).

**Walk.** UTC day by day, oldest first: one `readdir` of the day's stills
folder and one of its previews folder, then each pack's footer read async
(`readPackFooter` in `store.ts`, the store's own checks without its cache).
Per minute:
- with a readable pack: its slots at its `intervalS`;
- with an unreadable pack: all slots missing at the current `intervalS`, and
  an `unreadable-pack` item;
- without a pack: all slots missing at the current `intervalS`;
- a pack without both `HHMM.json` and `HHMM.jpg`: a `pack-without-sprite`
  item; a sprite file without a pack: `sprite-without-pack`.

**Gaps.** Runs of missing slots, across minute and day borders. Each gap gets:
- `explained`: `stop` or `crash` when a `proxy-start` record falls inside it
  (`uncleanStop: true` is `crash`), with `explainedSeconds` from the gap's
  start to that start + 120 s (capped at the gap's end); several starts in one
  gap: the last one counts; else `null`;
- the 10 longest are kept (`top`), longest first, then oldest first.

**Restorable seconds.** Missing seconds inside a local clip (`clips` rows with
an end, merged per day, `start ≤ t < end`). It is what #73 could restore; it
tells whether #73 is worth building.

**Counts.** `stillsDays`, `minutes`, `packs`, `expectedSeconds`,
`presentSeconds`, `missingSeconds`, `missingPct` (2 decimals), `gaps`,
`explainedSeconds`, `unexplainedSeconds`, `restorableSeconds`,
`unreadablePacks`, `packsWithoutSprite`, `spritesWithoutPack`.

**Message.** "Stills inventory: 220 s of 600 s missing (36.67%) since
2026-09-27T00:10:00.000Z, 4 gaps (longest 90 s), 150 s explained by proxy
stops, 20 s restorable from clips, 3 file problems"; for an empty store
"Stills inventory: no stills stored".

**Not counted as explained:** disk-full pauses (`storage_full_writing_paused`
is a log line, not an audit record), camera reboots and power-cycles, and a
camera-side `restart`. They show as unexplained gaps.

### 4. Clips (#74, PR 2)

**Part 1, local only.**
- Window: `dayStart(now − retention.clipsDays)` to now.
- Rows without a file, clip files without a row (an `.mp4` not in any row's
  `path`, a `.jpg` not in any row's `snapshot`).
- Recording-kind events (motion, person, vehicle, pet) with no overlapping
  clip; clips with no overlapping event.

**Part 2, against the camera** (`camera: true`).
- `camera-list.ts`: the month days (`monthDays`), then one Search per SD day
  in the window for `ftp.stream`, through `RecordingList` (its one-at-a-time
  gate and day cache). A day whose Search fails is `unknown`: its recordings
  are not counted as missing.
- Each recording is paired with a local clip of the same stream whose start is
  within ±5 s (`clipNear`).
- Reported: recordings on the camera but not local (the repair candidates),
  local clips gone from the SD, the SD's oldest day, timer-only recordings
  (counted, not paired).

**Part 3, repair: fetch lost clips over Baichuan.**
- `POST /control/actions/inventory-repair` `{kind: 'clips', runId}` with a
  clips report less than 1 hour old that compared with the camera.
- Stream `ftp.stream` (decision 1), so a repaired clip is what FTP would have
  delivered (about 1 MB, under 0.5 s per clip on sub).
- Through `RecordingFetcher` at `low` priority, one clip at a time, on the one
  Baichuan session. A `low` fetch waits while a viewer's fetch is queued or
  running; a running one is not pre-empted (decision 13). The fetched file is
  pinned in the recordings cache, copied into `clips/`, probed (ffprobe), and
  inserted with `origin: 'camera'` through a new indexer entry
  (`ClipIndexer.addRecording`), then counted in the budget.
- Migration 6: `ALTER TABLE clips ADD COLUMN origin TEXT NOT NULL DEFAULT
  'ftp'`. The Clips page shows "from camera".
- Before each clip it checks again that the recording is still on the SD, is
  still missing locally, and storage is not paused.
- Caps: 50 clips or 200 MB per run, 1 s between downloads; it stops after 3
  failures in a row, and at once on `refused` or `camera_offline`. Only
  recordings inside the clips retention, and never past `ftp.maxGB`.
- No `clip` stream-log message, so no SSE (decision 3). One
  `inventory-repair` record per run.

### 5. Events (#75, PR 3)

- **Window:** the SD card's reach (the oldest SD day to now, about 7 days),
  not the 30-day events retention; the report says so (decision 12).
- **Source:** the same camera list as the clips compare (`camera-list.ts`).
- **Matching:** per kind decoded from the name, overlapping recordings are
  merged; a merged span needs an event of the same kind overlapping
  [start − 10 s, end + 5 s]. A recording with both motion and person needs
  one event of each. Timer-only recordings are ignored and counted.
- **Reported:** recordings without an event, per kind; recording-kind events
  without a recording (report only); the number matched.
- **Repair** (`inventory-repair` `{kind: 'events', runId}`): a dry run is the
  check itself; the button reads "Add N missing events". Each missing span
  becomes one event: `source: 'recovered'`, start and end from the
  recording(s), `end_reason: 'recovered'`, `raw: {recordings: [ids], runId}`.
  At most 1000 per run, in one transaction. Existing rows are never changed
  or deleted; recovered rows can be removed by `runId` if needed.
- **Kept out of** SSE and the stream log (decision 3), analytics
  (`unanalysed()` skips `recovered`), `clipsStalled()` and the
  `activity-daily` counts (or counted apart as `recovered`).
- **Code:** `EventRow.source` and `end_reason` gain `recovered`; the Events
  page and the Timeline mark them.

### 6. Restore stills (#73, PR 4, later)

- Source: local clips only (decision 11), FTP copies or clips fetched by #74.
  Stills from SD recordings take two steps: fetch the clip, then restore.
- ffmpeg extracts frames with the grabber's filter; the store's merge adds
  them, keeping existing slots. The pack footer marks restored slots (a new
  optional footer field; old readers ignore it).
- Cost: about 5–10 s of CPU on the Pi per 40 s clip. One ffmpeg at a time,
  run with `nice`, at most 30 minutes of footage per run. Measured first; PR
  1's "restorable seconds" from the Pi decide whether it is built.

### 7. The admin UI

- **Maintenance page:** an "Inventory" box with one button per kind ("Check
  stills" in PR 1; "Check clips", "Compare clips with the camera", "Check
  events" later), a progress line with Cancel while a run is going, and a
  result panel for the newest run of each kind: the window and its reason,
  the counts, the top gaps or items. A Repair button in PR 2 and PR 3.
- **Audit page:** `inventory` and `inventory-repair` in the action filter.

## Error handling

- **A check throws:** the run ends `failed` with the message; the report and
  the audit record are written; the lock is released.
- **The result file can't be written:** logged (`inventory_save_failed`); the
  audit record is still written.
- **The proxy stops mid-run:** the run is cancelled (`cancelledBy: stop`),
  saved and audited before the catalog closes.
- **Camera errors (PR 2, PR 3):** a failed Search marks its day `unknown`; an
  offline camera fails the compare with `camera_offline` in the report.
- **Unknown kind:** 400 `invalid`; **a bad run id:** 400 `invalid` (the id is
  matched against `^[a-z]{1,16}-\d{1,15}-[0-9a-f]{6}$` before it touches the
  file system).

## Risks and how they're handled

- **Camera load:** every Search goes through `RecordingList`'s gate and day
  cache; all downloads share the one Baichuan session.
- **A repair storm:** repairs run only from a button, never on a schedule;
  one lock; caps per run; a recent report; every item is checked again before
  it is fetched; one audit record per batch.
- **Disk:** repairs fetch only inside the clips retention, refuse while
  storage is paused or `ftp.maxGB` would be exceeded, and are counted in the
  budget.
- **CPU (#73):** one ffmpeg at a time, with `nice` and a cap; measured first.
- **Wrong recovered events:** the check first, the rows are marked, nothing
  is ever deleted; recovered rows can be removed by run id.
- **Large audit days:** the stills check reads `proxy-start` and
  `storage-daily` records through `AuditLog.list()`, which reads whole day
  files; at most 8 days of them.

## Testing

- **Unit (PR 1):** the runner (lock, cancel, failure, progress, keeping 10,
  the audit record, items capped at 500, `stop()`); the stills check on a
  pack tree written by the store's own `MinuteStore` (gaps, explained by a
  clean and an unclean start, restorable from clips, an unreadable pack, a
  pack without sprite, a sprite without pack, a minute at another interval,
  the minutes being written left out, each window reason, an empty store,
  cancel); `readPackFooter`.
- **API (PR 1):** 202 and polling to the report, 400, 409 with a blocking
  check, cancel, 400 and 404 for run ids, 403 for the client and audit
  tokens, the `inventory` record and no `control-action` for the start.
- **e2e (PR 1):** the Maintenance button shows the result, and the audit log
  has the record.
- **PR 2, PR 3:** against cam-sim's SD recordings and its Baichuan server,
  including a failed Search day and a refused download; the Search time is
  measured on the real camera.

## Phasing

1. **PR 1: the module and stills (#72).** Plan:
   `docs/superpowers/plans/2026-10-02-inventory-stills.md`.
2. **PR 2: clips (#74, parts 1–3):** the local check, the camera compare, the
   `origin` migration and the repair.
3. **PR 3: events (#75):** the check, the recovered events and their marks.
4. **PR 4: stills restore (#73):** after a measurement, if PR 1's restorable
   seconds on the Pi make it worth it.

## Out of scope

- Scheduled inventories or repairs (button only).
- Explaining gaps by camera reboots, power-cycles or disk-full pauses.
- Restoring stills from SD recordings in one step.
- Multi-camera runs (one camera per proxy).

## References

- Issues #72, #73, #74, #75.
- `docs/superpowers/specs/2026-10-02-baichuan-recordings-design.md` (the
  fetcher, the list, the priorities).
- `docs/superpowers/specs/2026-10-01-audit-log-design.md`, `docs/audit-log.md`.
- cams `docs/reolink-api.md`: Search quirks, file names, trigger flags.
